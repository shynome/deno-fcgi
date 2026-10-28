/**
 * Worker 入口。
 *
 * 支持两种脚本形态：
 *
 * 1. 顶层执行式（PHP 风格）
 *    用 console.log 输出 CGI 响应。每次请求都要重新执行顶层代码，
 *    因此 Worker 用完即弃（ephemeral）。
 *
 * 2. `export default { fetch }`（Deno.serve / Hono 风格）
 *    宿主构造标准 Request 调用它，Worker 可常驻复用（resident），
 *    省掉每请求的 isolate 初始化与模块加载。
 */
import type { ScriptJob, ScriptResponse, ScriptResult } from "../types.ts";
import { concatChunks as concat, transferablesOf } from "../bytes.ts";
import { ExitSignal, installCgiContext } from "./context.ts";

interface FetchHandler {
  fetch(request: Request, env?: unknown): Response | Promise<Response>;
}

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ScriptJob>) => void) | null;
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
};

// 预热池靠这条消息判断 Worker 已完成 isolate 初始化
scope.postMessage({ type: "ready" });

let handler: FetchHandler | undefined;
let initialized = false;

scope.onmessage = async (event) => {
  const job = event.data;
  const bootStderr: Uint8Array[] = [];

  try {
    if (!initialized) {
      // 首次：注入上下文后加载脚本，顶层代码在此执行一次
      const boot = installCgiContext({ env: job.env, body: job.body });
      const mod = await import(job.scriptUrl);
      initialized = true;

      const candidate = (mod as { default?: FetchHandler }).default;
      if (candidate && typeof candidate.fetch === "function") {
        handler = candidate;
        bootStderr.push(boot.stderr());
      } else {
        // 顶层执行式：import 产生的输出就是本次响应
        scope.postMessage(
          {
            status: "ok",
            mode: "ephemeral",
            stdout: boot.stdout(),
            stderr: boot.stderr(),
          } satisfies ScriptResult,
        );
        return;
      }
    }

    // resident：每请求重新安装上下文，构造 Request 调用 fetch
    const context = installCgiContext({ env: job.env, body: job.body });
    const request = buildRequest(job.env, job.body);
    const response = await handler!.fetch(request, job.env);
    const scriptResponse = await toScriptResponse(response);

    scope.postMessage(
      {
        status: "ok",
        mode: "resident",
        stdout: new Uint8Array(0),
        stderr: concat([...bootStderr, context.stderr()]),
        response: scriptResponse,
      } satisfies ScriptResult,
      // 响应体直接转移给主线程，省一次结构化克隆拷贝
      transferablesOf(scriptResponse.body),
    );
  } catch (error) {
    const stderr = concat(bootStderr);
    if (error instanceof ExitSignal || isExitSignalLike(error)) {
      scope.postMessage(
        {
          status: "ok",
          mode: handler ? "resident" : "ephemeral",
          stdout: new Uint8Array(0),
          stderr,
        } satisfies ScriptResult,
      );
      return;
    }
    scope.postMessage(
      {
        status: "error",
        mode: handler ? "resident" : "ephemeral",
        stdout: new Uint8Array(0),
        stderr,
        error: toErrorInfo(error),
      } satisfies ScriptResult,
    );
  }
};

/** 把 CGI 环境变量还原成标准 Request */
function buildRequest(
  env: Record<string, string>,
  body: Uint8Array,
): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("HTTP_")) {
      headers.set(key.slice(5).replace(/_/g, "-"), value);
    }
  }
  if (env["CONTENT_TYPE"]) headers.set("content-type", env["CONTENT_TYPE"]);

  const method = env["REQUEST_METHOD"] ?? "GET";
  const host = env["HTTP_HOST"] ?? env["SERVER_NAME"] ?? "localhost";
  const uri = env["REQUEST_URI"] ?? env["SCRIPT_NAME"] ?? "/";
  const url = new URL(uri, `http://${host}`);

  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD" && body.length > 0) {
    init.body = body;
  }
  return new Request(url.href, init);
}

async function toScriptResponse(response: Response): Promise<ScriptResponse> {
  const headers: Array<[string, string]> = [];
  response.headers.forEach((value, key) => headers.push([key, value]));
  const body = new Uint8Array(await response.arrayBuffer());
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body,
  };
}

function isExitSignalLike(error: unknown): boolean {
  return error instanceof Error && error.name === "ExitSignal";
}

function toErrorInfo(error: unknown): {
  name: string;
  message: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: "Error", message: String(error) };
}
