/**
 * deno-fcgi CLI 入口。
 *
 * 用法：
 *   deno run --allow-read --allow-net --allow-env --unstable-worker-options \
 *     jsr:@shynome/deno-fcgi --listen unix:/run/deno-fcgi.sock
 *
 * 可执行范围由 Caddy 传来的 DOCUMENT_ROOT 决定，不需要额外配置。
 */
import { FcgiServer, type Logger } from "./fcgi/server.ts";
import { Router } from "./router.ts";
import { WorkerPool } from "./runtime/pool.ts";

const VERSION = "0.2.1";

interface CliOptions {
  listen: string;
  maxWorkers: number;
  prewarm: number;
  timeoutMs: number;
  residentConcurrency: number;
  residentIdleMs: number;
  maxBodyBytes: number;
  logLevel: "debug" | "info" | "error";
  help: boolean;
  version: boolean;
}

export class ConsoleLogger implements Logger {
  constructor(private readonly level: CliOptions["logLevel"]) {}

  #write(level: string, message: string, fields?: Record<string, unknown>) {
    const suffix = fields ? ` ${JSON.stringify(fields)}` : "";
    console.error(`[${new Date().toISOString()}] ${level} ${message}${suffix}`);
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    if (this.level === "debug") this.#write("DEBUG", message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    if (this.level !== "error") this.#write("INFO", message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.#write("ERROR", message, fields);
  }
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    listen: "unix:/tmp/deno-fcgi.sock",
    maxWorkers: 16,
    prewarm: 1,
    timeoutMs: 30_000,
    residentConcurrency: 4,
    residentIdleMs: 30_000,
    maxBodyBytes: 32 * 1024 * 1024,
    logLevel: "info",
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--listen":
      case "-l":
        options.listen = next();
        break;
      case "--max-workers":
        options.maxWorkers = Number(next());
        break;
      case "--prewarm":
        options.prewarm = Number(next());
        break;
      case "--timeout":
        options.timeoutMs = Number(next());
        break;
      case "--resident-concurrency":
        options.residentConcurrency = Number(next());
        break;
      case "--resident-idle":
        options.residentIdleMs = Number(next());
        break;
      case "--max-body":
        options.maxBodyBytes = Number(next());
        break;
      case "--log-level":
        options.logLevel = next() as CliOptions["logLevel"];
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--version":
      case "-v":
        options.version = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`deno-fcgi ${VERSION}

用法: deno-fcgi [选项]

选项:
  -l, --listen <addr>     unix:/path 或 tcp:host:port（默认 unix:/tmp/deno-fcgi.sock）
      --max-workers <n>   同时运行的 Worker 上限（默认 16）
      --prewarm <n>       每个脚本保留的空壳数（默认 1）
      --timeout <ms>      单请求超时（默认 30000）
      --resident-concurrency <n> 单脚本常驻 Worker 上限（默认 4）
      --resident-idle <ms>       空闲 Worker 回收时间（默认 30000，负数=不回收；最后一个按 5 倍）
      --max-body <bytes>  请求体上限（默认 33554432）
      --log-level <level> debug | info | error（默认 info）
  -h, --help              显示帮助
  -v, --version           显示版本

可执行范围由 Caddy 传来的 DOCUMENT_ROOT 决定，不需要额外目录配置。

运行脚本需要权限:
  --allow-read --allow-net --allow-env --unstable-worker-options
`);
}

function createListener(spec: string): Deno.Listener {
  if (spec.startsWith("unix:")) {
    const path = spec.slice("unix:".length);
    try {
      const stat = Deno.statSync(path);
      if (stat.isSocket) Deno.removeSync(path);
    } catch {
      // 不存在就跳过
    }
    return Deno.listen({ transport: "unix", path });
  }

  if (spec.startsWith("tcp:")) {
    const rest = spec.slice("tcp:".length);
    const colon = rest.lastIndexOf(":");
    if (colon <= 0) throw new Error(`invalid tcp address: ${spec}`);
    return Deno.listen({
      transport: "tcp",
      hostname: rest.slice(0, colon),
      port: Number(rest.slice(colon + 1)),
    });
  }

  // 裸路径按 unix socket 处理
  try {
    const stat = Deno.statSync(spec);
    if (stat.isSocket) Deno.removeSync(spec);
  } catch {
    // ignore
  }
  return Deno.listen({ transport: "unix", path: spec });
}

async function main(): Promise<void> {
  const options = parseArgs(Deno.args);

  if (options.help) {
    printHelp();
    return;
  }
  if (options.version) {
    console.log(VERSION);
    return;
  }

  const logger = new ConsoleLogger(options.logLevel);

  logger.info("starting deno-fcgi", {
    version: VERSION,
    listen: options.listen,
  });

  // 默认零权限。脚本自身的 read 由 pool 按实际脚本路径追加，
  // 因此脚本能加载自己，但 import "./x.ts"、读其他文件、联网都需要显式放开。
  const defaultPermissions: Deno.PermissionOptions = {};

  const pool = new WorkerPool({
    workerUrl: new URL("./runtime/worker-entry.ts", import.meta.url),
    maxWorkers: options.maxWorkers,
    prewarm: options.prewarm,
    requestTimeoutMs: options.timeoutMs,
    residentConcurrency: options.residentConcurrency,
    residentIdleMs: options.residentIdleMs,
    defaultPermissions,
    onEvict: (scriptPath, reason) =>
      logger.debug("resident evicted", { script: scriptPath, reason }),
  });

  const server = new FcgiServer({
    listener: createListener(options.listen),
    router: new Router(),
    pool,
    logger,
    maxBodyBytes: options.maxBodyBytes,
  });

  const shutdown = async () => {
    logger.info("shutting down");
    await server.close();
    Deno.exit(0);
  };
  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);

  logger.info("listening", { listen: options.listen });
  await server.serve();
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("fatal:", error);
    Deno.exit(1);
  });
}
