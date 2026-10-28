/**
 * FastCGI 连接与请求状态机。
 *
 * 一条 TCP/unix 连接上可能同时有多个 requestId，各自独立推进：
 *   BEGIN_REQUEST → PARAMS* → STDIN* → 执行 → STDOUT/END_REQUEST
 */
import {
  decodeBeginRequestBody,
  decodeParams,
  encodeEndRequest,
  encodeFrame,
  encodeStreamFrames,
  FCGI_ABORT_REQUEST,
  FCGI_BEGIN_REQUEST,
  FCGI_GET_VALUES,
  FCGI_OVERLOADED,
  FCGI_PARAMS,
  FCGI_RESPONDER,
  FCGI_STDERR,
  FCGI_STDIN,
  FCGI_STDOUT,
  FCGI_UNKNOWN_ROLE,
  type Frame,
  FrameDecoder,
} from "./protocol.ts";
import {
  errorResponse,
  parseCgiOutput,
  serializeCgiParts,
  serializeScriptParts,
} from "./response.ts";
import { RouteError, Router } from "../router.ts";
import { RequestTimeoutError, WorkerPool } from "../runtime/pool.ts";
import { concatChunks } from "../bytes.ts";

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** 关闭时等待在途请求的宽限时间，超时后强制回收 Worker */
const SHUTDOWN_GRACE_MS = 3_000;

const utf8Decoder = new TextDecoder();
const utf8Encoder = new TextEncoder();

export interface FcgiServerOptions {
  listener: Deno.Listener;
  router: Router;
  pool: WorkerPool;
  logger: Logger;
  /** 单请求体上限，默认 32MB */
  maxBodyBytes?: number;
  /** 单连接并发请求上限，默认 64 */
  maxRequestsPerConnection?: number;
}

interface PendingRequest {
  id: number;
  keepConn: boolean;
  paramsChunks: Uint8Array[];
  bodyChunks: Uint8Array[];
  bodyBytes: number;
  paramsClosed: boolean;
  stdinClosed: boolean;
  started: boolean;
  aborted: boolean;
  task?: Promise<void>;
}

export class FcgiServer {
  readonly #connections = new Set<Deno.Conn>();
  readonly #tasks = new Set<Promise<void>>();
  readonly #maxBodyBytes: number;
  readonly #maxRequestsPerConnection: number;
  #closing = false;

  constructor(private readonly options: FcgiServerOptions) {
    this.#maxBodyBytes = options.maxBodyBytes ?? 32 * 1024 * 1024;
    this.#maxRequestsPerConnection = options.maxRequestsPerConnection ?? 64;
  }

  async serve(): Promise<void> {
    for await (const conn of this.options.listener) {
      if (this.#closing) {
        try {
          conn.close();
        } catch { /* ignore */ }
        break;
      }
      this.#track(this.#handleConnection(conn));
    }
  }

  async close(): Promise<void> {
    this.#closing = true;
    try {
      this.options.listener.close();
    } catch { /* ignore */ }
    for (const conn of this.#connections) {
      try {
        conn.close();
      } catch { /* ignore */ }
    }

    // 给在途请求一小段优雅收尾时间，超时就强制回收 Worker，
    // 否则一个卡住的脚本会让进程退出一直等到 requestTimeoutMs
    const drained = Promise.allSettled([...this.#tasks]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
    });
    await Promise.race([drained, grace]);
    if (timer !== undefined) clearTimeout(timer);

    this.options.pool.close();
    await drained;
  }

  #track(task: Promise<void>): void {
    this.#tasks.add(task);
    task.finally(() => this.#tasks.delete(task));
  }

  async #handleConnection(conn: Deno.Conn): Promise<void> {
    this.#connections.add(conn);
    const remote = describeAddr(conn.remoteAddr);
    const decoder = new FrameDecoder();
    const writer = new ConnectionWriter(conn);
    const pending = new Map<number, PendingRequest>();
    const buffer = new Uint8Array(64 * 1024);

    this.options.logger.debug("connection opened", { remote });

    try {
      while (!this.#closing) {
        const size = await conn.read(buffer);
        if (size === null) break;
        for (const frame of decoder.feed(buffer.subarray(0, size))) {
          this.#onFrame(frame, pending, writer);
        }
      }
    } catch (error) {
      if (!isClosedError(error)) {
        this.options.logger.error("connection error", {
          remote,
          error: String(error),
        });
      }
    } finally {
      for (const request of pending.values()) request.aborted = true;
      await Promise.allSettled(
        [...pending.values()].map((request) => request.task),
      );
      pending.clear();
      this.#connections.delete(conn);
      try {
        conn.close();
      } catch { /* ignore */ }
      this.options.logger.debug("connection closed", { remote });
    }
  }

  #onFrame(
    frame: Frame,
    pending: Map<number, PendingRequest>,
    writer: ConnectionWriter,
  ): void {
    const requestId = frame.requestId;

    switch (frame.type) {
      case FCGI_BEGIN_REQUEST: {
        if (pending.size >= this.#maxRequestsPerConnection) {
          void writer.overloaded(requestId);
          return;
        }
        const body = decodeBeginRequestBody(frame.content);
        if (body.role !== FCGI_RESPONDER) {
          void writer.endRequest(requestId, 0, FCGI_UNKNOWN_ROLE);
          return;
        }
        pending.set(requestId, {
          id: requestId,
          keepConn: body.keepConn,
          paramsChunks: [],
          bodyChunks: [],
          bodyBytes: 0,
          paramsClosed: false,
          stdinClosed: false,
          started: false,
          aborted: false,
        });
        return;
      }

      case FCGI_PARAMS: {
        const request = pending.get(requestId);
        if (!request) return;
        if (frame.content.length === 0) {
          request.paramsClosed = true;
          this.#maybeStart(request, pending, writer);
          return;
        }
        request.paramsChunks.push(frame.content.slice());
        return;
      }

      case FCGI_STDIN: {
        const request = pending.get(requestId);
        if (!request) return;
        if (frame.content.length === 0) {
          request.stdinClosed = true;
          this.#maybeStart(request, pending, writer);
          return;
        }
        request.bodyBytes += frame.content.length;
        if (request.bodyBytes > this.#maxBodyBytes) {
          request.aborted = true;
          pending.delete(requestId);
          this.options.logger.error("request body too large", { requestId });
          void writer.respond(
            requestId,
            413,
            errorResponse(413, "request body too large"),
          );
          return;
        }
        request.bodyChunks.push(frame.content.slice());
        return;
      }

      case FCGI_ABORT_REQUEST: {
        const request = pending.get(requestId);
        if (!request) return;
        request.aborted = true;
        pending.delete(requestId);
        this.options.logger.debug("request aborted by client", { requestId });
        return;
      }

      case FCGI_GET_VALUES: {
        // 暂不支持能力协商，回空结果即可
        void writer.endRequest(requestId);
        return;
      }

      default:
        return;
    }
  }

  #maybeStart(
    request: PendingRequest,
    pending: Map<number, PendingRequest>,
    writer: ConnectionWriter,
  ): void {
    if (request.started) return;
    if (!request.paramsClosed || !request.stdinClosed) return;
    request.started = true;
    request.task = this.#runRequest(request, pending, writer);
    this.#track(request.task);
  }

  async #runRequest(
    request: PendingRequest,
    pending: Map<number, PendingRequest>,
    writer: ConnectionWriter,
  ): Promise<void> {
    const startedAt = performance.now();
    let scriptPath = "";

    try {
      const params = decodeParams(concatChunks(request.paramsChunks));
      request.paramsChunks.length = 0;
      const permissions = extractPermissions(params);
      this.options.logger.debug("script permissions", { permissions });

      if (request.aborted) return;

      const route = await this.options.router.resolve(params);
      scriptPath = route.scriptPath;
      const env = buildEnv(params, route);
      const body = concatChunks(request.bodyChunks);
      request.bodyChunks.length = 0;

      const result = await this.options.pool.run(
        {
          scriptUrl: toFileUrl(route.scriptPath),
          scriptPath: route.scriptPath,
          env,
          body,
        },
        permissions,
      );

      if (request.aborted) return;

      if (result.stderr.length > 0) {
        await writer.frames(FCGI_STDERR, request.id, result.stderr);
      }

      if (result.status === "error") {
        this.options.logger.error("script failed", {
          script: scriptPath,
          error: result.error?.name,
          message: result.error?.message,
          stack: result.error?.stack,
        });
        await writer.respond(
          request.id,
          500,
          errorResponse(
            500,
            "script error",
            result.error ? `${result.error.name}: ${result.error.message}` : undefined,
          ),
        );
      } else if (result.response) {
        // export default { fetch } 形式：Worker 直接返回结构化响应
        await writer.respond(
          request.id,
          result.response.status,
          serializeScriptParts(result.response),
        );
        this.options.logger.info("request", {
          method: env["REQUEST_METHOD"],
          uri: env["REQUEST_URI"],
          script: route.scriptName,
          mode: result.mode,
          status: result.response.status,
          bytes: result.response.body.length,
          ms: Math.round(performance.now() - startedAt),
        });
      } else {
        const parsed = parseCgiOutput(result.stdout);
        if (!parsed) {
          this.options.logger.error("malformed CGI output", {
            script: scriptPath,
            head: utf8Decoder.decode(result.stdout.subarray(0, 200)),
          });
          await writer.respond(
            request.id,
            500,
            errorResponse(500, "malformed CGI output: missing header block"),
          );
        } else {
          await writer.respond(
            request.id,
            parsed.status,
            serializeCgiParts(parsed),
          );
          this.options.logger.info("request", {
            method: env["REQUEST_METHOD"],
            uri: env["REQUEST_URI"],
            script: route.scriptName,
            mode: result.mode,
            status: parsed.status,
            bytes: parsed.body.length,
            ms: Math.round(performance.now() - startedAt),
          });
        }
      }
    } catch (error) {
      if (request.aborted) return;

      if (error instanceof RouteError) {
        this.options.logger.info("route rejected", {
          status: error.status,
          message: error.message,
        });
        await writer.respond(
          request.id,
          error.status,
          errorResponse(error.status, error.message),
        );
      } else if (error instanceof RequestTimeoutError) {
        this.options.logger.error("script timed out", {
          script: scriptPath,
          timeoutMs: error.timeoutMs,
        });
        await writer.respond(
          request.id,
          504,
          errorResponse(504, "script timed out"),
        );
      } else {
        this.options.logger.error("request failed", {
          script: scriptPath,
          error: String(error),
        });
        await writer.respond(
          request.id,
          500,
          errorResponse(500, "internal error", String(error)),
        );
      }
    } finally {
      if (request.started && !request.aborted) {
        await writer.endRequest(request.id);
      }
      pending.delete(request.id);
      if (!request.keepConn) writer.close();
    }
  }
}

class ConnectionWriter {
  #chain: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(private readonly conn: Deno.Conn) {}

  frames(type: number, requestId: number, data: Uint8Array): Promise<void> {
    for (const frame of encodeStreamFrames(type, requestId, data)) {
      this.#enqueue(frame);
    }
    return this.#chain;
  }

  /** 写响应体（失败时同时写一段 STDERR 方便 Caddy 日志），不负责结束请求 */
  async respond(
    requestId: number,
    status: number,
    payload: Uint8Array | Uint8Array[],
  ): Promise<void> {
    const parts = Array.isArray(payload) ? payload : [payload];
    for (const part of parts) {
      // 空段跳过：结束空帧由 endRequest 统一发
      if (part.length > 0) this.frames(FCGI_STDOUT, requestId, part);
    }
    if (status >= 500) {
      const head = parts[0] ?? new Uint8Array(0);
      const text = utf8Decoder.decode(head.subarray(0, 200));
      this.frames(FCGI_STDERR, requestId, utf8Encoder.encode(text));
    }
    await this.#chain;
  }

  endRequest(
    requestId: number,
    appStatus = 0,
    protocolStatus = 0,
  ): Promise<void> {
    this.#enqueue(encodeFrame(FCGI_STDOUT, requestId));
    this.#enqueue(encodeEndRequest(requestId, appStatus, protocolStatus));
    return this.#chain;
  }

  async overloaded(requestId: number): Promise<void> {
    this.#enqueue(encodeEndRequest(requestId, 0, FCGI_OVERLOADED));
    await this.#chain;
  }

  close(): void {
    this.#closed = true;
  }

  #enqueue(bytes: Uint8Array): void {
    if (this.#closed) return;
    this.#chain = this.#chain.then(async () => {
      if (this.#closed) return;
      try {
        await writeAll(this.conn, bytes);
      } catch {
        this.#closed = true;
      }
    });
  }
}

const PERMISSION_FIELDS: Array<[string, string]> = [
  ["FCGI_ALLOW_READ", "read"],
  ["FCGI_ALLOW_WRITE", "write"],
  ["FCGI_ALLOW_NET", "net"],
  ["FCGI_ALLOW_ENV", "env"],
  ["FCGI_ALLOW_RUN", "run"],
  ["FCGI_ALLOW_SYS", "sys"],
  ["FCGI_ALLOW_FFI", "ffi"],
  ["FCGI_ALLOW_HREAD", "hread"],
  ["FCGI_ALLOW_HWRITE", "hwrite"],
];

/**
 * 从 CGI 变量中提取脚本级权限。
 *
 * 优先支持逗号分隔的 FCGI_ALLOW_*（Caddyfile 里的 JSON 会被当作 placeholder 替换）；
 * 同时兼容 FCGI_PERMISSIONS 的 JSON 写法（适合从环境变量注入）。
 */
function extractPermissions(
  params: Record<string, string>,
): Deno.PermissionOptions | undefined {
  const permissions: Record<string, boolean | string[]> = {};
  let hasAny = false;

  const json = params["FCGI_PERMISSIONS"];
  delete params["FCGI_PERMISSIONS"];
  if (json) {
    try {
      Object.assign(permissions, JSON.parse(json));
      hasAny = true;
    } catch (error) {
      throw new RouteError(500, `invalid FCGI_PERMISSIONS: ${error}`);
    }
  }

  for (const [key, field] of PERMISSION_FIELDS) {
    const raw = params[key];
    delete params[key];
    if (raw === undefined) continue;
    hasAny = true;

    const value = raw.trim();
    if (value === "" || value === "none" || value === "false") {
      permissions[field] = false;
    } else if (value === "*" || value === "all" || value === "true") {
      permissions[field] = true;
    } else {
      const list = value.split(",").map((item) => item.trim()).filter(Boolean);
      permissions[field] = list.length > 0 ? list : false;
    }
  }

  return hasAny ? (permissions as Deno.PermissionOptions) : undefined;
}

function buildEnv(
  params: Record<string, string>,
  route: {
    scriptPath: string;
    scriptName: string;
    documentRoot: string;
    pathInfo: string;
  },
): Record<string, string> {
  const env: Record<string, string> = { ...params };
  delete env["FCGI_ROLE"];
  env["GATEWAY_INTERFACE"] ??= "CGI/1.1";
  env["SERVER_SOFTWARE"] ??= "deno-fastcgi";
  env["SCRIPT_FILENAME"] = route.scriptPath;
  env["SCRIPT_NAME"] = route.scriptName;
  env["DOCUMENT_ROOT"] = route.documentRoot;
  if (route.pathInfo) {
    env["PATH_INFO"] = route.pathInfo;
    env["PATH_TRANSLATED"] = `${route.documentRoot}${route.pathInfo}`;
  }
  return env;
}

function toFileUrl(path: string): string {
  const url = new URL("file:///");
  url.pathname = path;
  return url.href;
}

async function writeAll(
  conn: { write(p: Uint8Array): Promise<number> },
  data: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    offset += await conn.write(data.subarray(offset));
  }
}

function describeAddr(addr: Deno.Addr): string {
  if ("path" in addr) return addr.path;
  if ("hostname" in addr) return `${addr.hostname}:${addr.port}`;
  return String(addr.transport);
}

function isClosedError(error: unknown): boolean {
  return error instanceof Deno.errors.BadResource ||
    error instanceof Deno.errors.Interrupted ||
    error instanceof Deno.errors.ConnectionReset ||
    error instanceof Deno.errors.BrokenPipe;
}
