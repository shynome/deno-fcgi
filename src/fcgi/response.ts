/** 解析脚本 stdout 中的 CGI 响应（头部 + 空行 + body） */

import type { ScriptResponse } from "../types.ts";

export interface CgiResponse {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: Uint8Array;
}

const CRLF_CRLF = [13, 10, 13, 10];
const LF_LF = [10, 10];

/** 头部区搜索上限：超过这个长度只可能是畸形输出，没必要扫全量 body */
const MAX_HEADER_BYTES = 64 * 1024;

const utf8Decoder = new TextDecoder("utf-8", { fatal: false });
const utf8Encoder = new TextEncoder();

export function parseCgiOutput(raw: Uint8Array): CgiResponse | null {
  const split = findHeaderEnd(raw);
  if (!split) return null;

  const headerBytes = raw.subarray(0, split.headerEnd);
  const body = raw.subarray(split.bodyStart);
  const text = utf8Decoder.decode(headerBytes);

  let status = 200;
  let statusText = "OK";
  const headers: Array<[string, string]> = [];

  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();

    if (name.toLowerCase() === "status") {
      const match = /^(\d{3})\s*(.*)$/.exec(value);
      if (match) {
        status = Number(match[1]);
        statusText = match[2] || defaultStatusText(status);
        continue;
      }
    }
    headers.push([name, value]);
  }

  // 有 Location 无 Status 时按 CGI 规范视为 302
  if (
    status === 200 &&
    headers.some(([name]) => name.toLowerCase() === "location")
  ) {
    status = 302;
    statusText = "Found";
  }

  return { status, statusText, headers, body };
}

function findHeaderEnd(
  raw: Uint8Array,
): { headerEnd: number; bodyStart: number } | null {
  const head = raw.length > MAX_HEADER_BYTES ? raw.subarray(0, MAX_HEADER_BYTES) : raw;
  const crlf = indexOf(head, CRLF_CRLF);
  if (crlf >= 0) return { headerEnd: crlf, bodyStart: crlf + 4 };
  const lf = indexOf(head, LF_LF);
  if (lf >= 0) return { headerEnd: lf, bodyStart: lf + 2 };
  return null;
}

function indexOf(haystack: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** CGI 头部（不含 body），可和 body 分段发送以省一次合并拷贝 */
export function serializeCgiHead(response: CgiResponse): Uint8Array {
  const lines: string[] = [];
  // PHP-FPM 惯例：200 不输出 Status，否则 Caddy 会把该头原样透传给客户端
  if (response.status !== 200) {
    lines.push(`Status: ${response.status} ${response.statusText}`);
  }
  for (const [name, value] of response.headers) {
    lines.push(`${name}: ${value}`);
  }
  return utf8Encoder.encode(`${lines.join("\r\n")}\r\n\r\n`);
}

/** 分段形式：`[head, body]`，发帧时不必先拼成一块 */
export function serializeCgiParts(response: CgiResponse): Uint8Array[] {
  return [serializeCgiHead(response), response.body];
}

export function serializeCgiResponse(response: CgiResponse): Uint8Array {
  const head = serializeCgiHead(response);
  if (response.body.length === 0) return head;
  const merged = new Uint8Array(head.length + response.body.length);
  merged.set(head);
  merged.set(response.body, head.length);
  return merged;
}

/** `export default { fetch }` 返回的 Response，转成 CGI 字节流 */
export function serializeScriptResponse(response: ScriptResponse): Uint8Array {
  return serializeCgiResponse(toCgiResponse(response));
}

/** 同上，但返回 `[head, body]` 分段，大响应省一次拷贝 */
export function serializeScriptParts(
  response: ScriptResponse,
): Uint8Array[] {
  return serializeCgiParts(toCgiResponse(response));
}

function toCgiResponse(response: ScriptResponse): CgiResponse {
  return {
    status: response.status,
    statusText: response.statusText || defaultStatusText(response.status),
    headers: response.headers,
    body: response.body,
  };
}

export function errorResponse(
  status: number,
  message: string,
  detail?: string,
): Uint8Array {
  const body = utf8Encoder.encode(
    `deno-fcgi: ${message}\n${detail ? `${detail}\n` : ""}`,
  );
  return serializeCgiResponse({
    status,
    statusText: defaultStatusText(status),
    headers: [
      ["Content-Type", "text/plain; charset=utf-8"],
      ["Content-Length", String(body.length)],
      ["Cache-Control", "no-store"],
    ],
    body,
  });
}

export function defaultStatusText(status: number): string {
  const map: Record<number, string> = {
    200: "OK",
    201: "Created",
    204: "No Content",
    301: "Moved Permanently",
    302: "Found",
    304: "Not Modified",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    405: "Method Not Allowed",
    413: "Payload Too Large",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
    504: "Gateway Timeout",
  };
  return map[status] ?? "Unknown";
}
