import { errorResponse, parseCgiOutput, serializeCgiResponse } from "../src/fcgi/response.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function assertEquals(actual: unknown, expected: unknown, message?: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message ?? "assertion failed"}: ${a} !== ${b}`);
}

Deno.test("解析标准 CGI 输出", () => {
  const raw = encoder.encode(
    'Content-Type: application/json\r\nX-Test: 1\r\n\r\n{"ok":true}',
  );
  const parsed = parseCgiOutput(raw);
  if (!parsed) throw new Error("should parse");
  assertEquals(parsed.status, 200);
  assertEquals(parsed.headers, [["Content-Type", "application/json"], ["X-Test", "1"]]);
  assertEquals(decoder.decode(parsed.body), '{"ok":true}');
});

Deno.test("解析 Status 头", () => {
  const raw = encoder.encode("Status: 404 Not Found\r\nContent-Type: text/plain\r\n\r\nnope");
  const parsed = parseCgiOutput(raw);
  if (!parsed) throw new Error("should parse");
  assertEquals(parsed.status, 404);
  assertEquals(parsed.statusText, "Not Found");
});

Deno.test("只给 Location 时按 302 处理", () => {
  const raw = encoder.encode("Location: /login\r\n\r\n");
  const parsed = parseCgiOutput(raw);
  if (!parsed) throw new Error("should parse");
  assertEquals(parsed.status, 302);
});

Deno.test("缺头块返回 null", () => {
  assertEquals(parseCgiOutput(encoder.encode("plain body")), null);
});

Deno.test("支持 LF 分隔", () => {
  const raw = encoder.encode("Content-Type: text/plain\n\nhi");
  const parsed = parseCgiOutput(raw);
  if (!parsed) throw new Error("should parse");
  assertEquals(decoder.decode(parsed.body), "hi");
});

Deno.test("200 响应不输出 Status 行", () => {
  const encoded = decoder.decode(
    serializeCgiResponse({
      status: 200,
      statusText: "OK",
      headers: [["Content-Type", "text/plain"]],
      body: encoder.encode("hi"),
    }),
  );
  assertEquals(encoded.startsWith("Content-Type: text/plain"), true);
  assertEquals(encoded.includes("Status:"), false);
  assertEquals(encoded.includes("\r\n\r\nhi"), true);
});

Deno.test("非 200 响应带 Status 行", () => {
  const encoded = decoder.decode(
    serializeCgiResponse({
      status: 404,
      statusText: "Not Found",
      headers: [["Content-Type", "text/plain"]],
      body: encoder.encode("nope"),
    }),
  );
  assertEquals(encoded.startsWith("Status: 404 Not Found\r\n"), true);
});

Deno.test("错误响应可被重新解析", () => {
  const parsed = parseCgiOutput(errorResponse(500, "boom"));
  if (!parsed) throw new Error("should parse");
  assertEquals(parsed.status, 500);
  assertEquals(decoder.decode(parsed.body).startsWith("deno-fcgi: boom"), true);
});
