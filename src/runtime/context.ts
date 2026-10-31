/**
 * Worker 内的 CGI 上下文注入。
 *
 * 注入目标：
 *   process.env / process.stdout / process.stderr / process.stdin
 *   Deno.env / Deno.stdout / Deno.stderr / Deno.stdin / Deno.exit
 *   console
 *   全局 Buffer（Node 兼容）
 *
 * 两种脚本形态都会调到这里：
 *   - 顶层执行式：Worker 用完即弃，每请求一次注入
 *   - `export default { fetch }`：Worker 常驻，**每请求重新注入**
 *
 * 所以这里把「替换掉的全局对象」做成模块级常驻壳子（Proxy / console / 各个
 * 流对象只创建一次），每请求只换内部指向的 RequestState。这样常驻模式下
 * 每请求省掉一次 Proxy + console 对象 + 若干 defineProperty 的开销。
 */
import { Buffer } from "node:buffer";
import { concatChunks } from "../bytes.ts";

export interface CgiContextInput {
  env: Record<string, string>;
  body: Uint8Array;
}

export interface CapturedContext {
  stdout(): Uint8Array;
  stderr(): Uint8Array;
}

/** 脚本主动终止（process.exit / Deno.exit）时抛出，由 worker-entry 当作正常结束 */
export class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`script exited with code ${code}`);
    this.name = "ExitSignal";
  }
}

const encoder = new TextEncoder();

// 捕获原始全局：常驻 Worker 下每请求都要重新安装上下文，
// 必须基于原始对象而不是上一次替换后的代理。
const ORIGINAL_DENO = globalThis.Deno;
const ORIGINAL_CONSOLE = globalThis.console;
const ORIGINAL_PROCESS = (globalThis as { process?: Record<string, unknown> })
  .process;

/** 单次请求的可变状态。可读流会直接闭包捕获它，避免跨请求串数据 */
interface RequestState {
  body: Uint8Array;
  offset: number;
  out: Uint8Array[];
  err: Uint8Array[];
  readable: ReadableStream<Uint8Array>;
}

const state = {
  /** 复用同一个 env 对象，保证 process.env 引用稳定 */
  env: {} as Record<string, string>,
  current: null as RequestState | null,
  installed: false,
};

/** Deno 默认不注入全局 Buffer，而很多 Node 生态的 CGI 适配器直接用它 */
function ensureNodeGlobals(): void {
  const scope = globalThis as { Buffer?: unknown };
  if (scope.Buffer) return;
  scope.Buffer = Buffer;
}

function current(): RequestState {
  const req = state.current;
  if (!req) throw new Error("CGI context is not installed");
  return req;
}

function makeStdinReadable(req: RequestState): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (req.offset >= req.body.length) {
        controller.close();
        return;
      }
      const size = Math.min(64 * 1024, req.body.length - req.offset);
      controller.enqueue(req.body.subarray(req.offset, req.offset + size));
      req.offset += size;
    },
  });
}

/** 所有读者共享同一个读取游标 */
function readInto(req: RequestState, buffer: Uint8Array): number | null {
  if (req.offset >= req.body.length) return null;
  const size = Math.min(buffer.length, req.body.length - req.offset);
  buffer.set(req.body.subarray(req.offset, req.offset + size));
  req.offset += size;
  return size;
}

// ---- 下面这些壳子都在模块级创建一次，跨请求复用 ----

const envFacade = {
  get: (key: string) => state.env[key],
  set: (key: string, value: string) => {
    state.env[key] = value;
  },
  delete: (key: string) => {
    delete state.env[key];
  },
  has: (key: string) => Object.hasOwn(state.env, key),
  toObject: () => ({ ...state.env }),
};

const stdinShell = {
  rid: 0,
  get readable() {
    return current().readable;
  },
  read: (buffer: Uint8Array) => Promise.resolve(readInto(current(), buffer)),
  readSync: (buffer: Uint8Array) => readInto(current(), buffer),
  close() {},
  isTerminal: () => false,
  setRaw() {},
};

function makeWriterShell(target: "out" | "err") {
  return {
    rid: 1,
    write: (chunk: Uint8Array) => {
      current()[target].push(chunk.slice());
      return Promise.resolve(chunk.length);
    },
    writeSync: (chunk: Uint8Array) => {
      current()[target].push(chunk.slice());
      return chunk.length;
    },
    close() {},
    isTerminal: () => false,
  };
}

const stdoutShell = makeWriterShell("out");
const stderrShell = makeWriterShell("err");

const denoProxy = new Proxy(ORIGINAL_DENO, {
  get(target, prop, receiver) {
    switch (prop) {
      case "env":
        return envFacade;
      case "stdin":
        return stdinShell;
      case "stdout":
        return stdoutShell;
      case "stderr":
        return stderrShell;
      case "exit":
        return (code = 0) => {
          throw new ExitSignal(code);
        };
      default: {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }
  },
});

const consoleShell = Object.create(ORIGINAL_CONSOLE) as Console;

const format = (args: unknown[]): string =>
  args.map((arg) => typeof arg === "string" ? arg : ORIGINAL_DENO.inspect(arg, { colors: false }))
    .join(" ") + "\n";

consoleShell.log = (...args: unknown[]) => current().out.push(encoder.encode(format(args)));
consoleShell.info = consoleShell.log;
consoleShell.debug = consoleShell.log;
consoleShell.warn = (...args: unknown[]) => current().err.push(encoder.encode(format(args)));
consoleShell.error = consoleShell.warn;
consoleShell.trace = (...args: unknown[]) =>
  current().err.push(
    encoder.encode(`${format(args)}${new Error().stack ?? ""}\n`),
  );

const processStdout = {
  write: (chunk: unknown) => {
    current().out.push(toBytes(chunk));
    return true;
  },
  // hono-cgi-adapter 0.1.x 会把 push 当 write 用（0.2.0 起改用 write + drain）
  push: (chunk: unknown) => {
    current().out.push(toBytes(chunk));
    return true;
  },
  end: () => {},
  columns: 80,
  isTTY: false,
};

const processStderr = {
  write: (chunk: unknown) => {
    current().err.push(toBytes(chunk));
    return true;
  },
  push: (chunk: unknown) => {
    current().err.push(toBytes(chunk));
    return true;
  },
  end: () => {},
  columns: 80,
  isTTY: false,
};

const processStdin = {
  get readable() {
    return current().readable;
  },
  on() {
    return this;
  },
  once() {
    return this;
  },
  off() {
    return this;
  },
  removeListener() {
    return this;
  },
  pause() {
    return this;
  },
  resume() {
    return this;
  },
  isTTY: false,
  [Symbol.asyncIterator]: async function* () {
    const reader = current().readable.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  },
};

/** 只执行一次：把壳子挂到全局上 */
function installGlobals(): void {
  ensureNodeGlobals();

  Object.defineProperty(globalThis, "Deno", {
    value: denoProxy,
    configurable: true,
    writable: true,
  });

  if (ORIGINAL_PROCESS) {
    // env 对象是复用的，引用不变，只需在首次挂上
    ORIGINAL_PROCESS.env = state.env;
    ORIGINAL_PROCESS.stdout = processStdout;
    ORIGINAL_PROCESS.stderr = processStderr;
    ORIGINAL_PROCESS.stdin = processStdin;
    ORIGINAL_PROCESS.exit = (code = 0) => {
      throw new ExitSignal(code);
    };
  }

  globalThis.console = consoleShell;
}

export function installCgiContext(input: CgiContextInput): CapturedContext {
  // 复用 env 对象：清空再填充，保持 process.env 的引用稳定
  for (const key of Object.keys(state.env)) delete state.env[key];
  Object.assign(state.env, input.env);

  const req: RequestState = {
    body: input.body,
    offset: 0,
    out: [],
    err: [],
    readable: null as unknown as ReadableStream<Uint8Array>,
  };
  req.readable = makeStdinReadable(req);
  state.current = req;

  if (!state.installed) {
    installGlobals();
    state.installed = true;
  }

  // 闭包捕获本次的 req，不读 state.current，
  // 这样上一次请求的 stdout()/stderr() 在被延迟调用时也不会串到新请求
  return {
    stdout: () => concatChunks(req.out),
    stderr: () => concatChunks(req.err),
  };
}

function toBytes(chunk: unknown): Uint8Array {
  if (typeof chunk === "string") return encoder.encode(chunk);
  if (chunk instanceof Uint8Array) return chunk;
  return encoder.encode(String(chunk));
}
