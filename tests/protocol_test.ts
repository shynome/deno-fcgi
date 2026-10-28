import {
  decodeBeginRequestBody,
  decodeParams,
  encodeBeginRequestBody,
  encodeEndRequest,
  encodeFrame,
  encodeParams,
  FCGI_END_REQUEST,
  FCGI_PARAMS,
  FCGI_STDOUT,
  FrameDecoder,
} from "../src/fcgi/protocol.ts";

function assertEquals(actual: unknown, expected: unknown, message?: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message ?? "assertion failed"}: ${a} !== ${b}`);
}

Deno.test("encodeFrame / FrameDecoder 往返", () => {
  const payload = new Uint8Array([1, 2, 3, 4]);
  const encoded = encodeFrame(FCGI_STDOUT, 7, payload);
  const frames = new FrameDecoder().feed(encoded);
  assertEquals(frames.length, 1);
  assertEquals(frames[0].type, FCGI_STDOUT);
  assertEquals(frames[0].requestId, 7);
  assertEquals([...frames[0].content], [1, 2, 3, 4]);
});

Deno.test("FrameDecoder 支持逐字节投喂", () => {
  const encoded = encodeFrame(FCGI_STDOUT, 1, new Uint8Array([9, 9]));
  const decoder = new FrameDecoder();
  const collected: number[] = [];
  for (const byte of encoded) {
    for (const frame of decoder.feed(new Uint8Array([byte]))) {
      collected.push(...frame.content);
    }
  }
  assertEquals(collected, [9, 9]);
});

Deno.test("FrameDecoder 不持有调用方读缓冲的引用", () => {
  // 服务端用同一个 buffer 反复 conn.read(buffer)，帧跨两次读取时
  // 解码器不能依赖第一段数据还在原处
  const encoded = encodeFrame(FCGI_STDOUT, 1, new Uint8Array(100).fill(0x41));
  const shared = new Uint8Array(encoded.length);
  shared.set(encoded);

  const decoder = new FrameDecoder();
  // 第一次只读到 20 字节（帧头 + 部分内容）
  assertEquals(decoder.feed(shared.subarray(0, 20)).length, 0);

  // 第二次读取会从头覆盖同一块内存
  const rest = encoded.subarray(20);
  shared.fill(0x42);
  shared.set(rest, 0);

  const frames = decoder.feed(shared.subarray(0, rest.length));
  assertEquals(frames.length, 1);
  const content = [...frames[0].content];
  if (content.length !== 100 || content.some((byte) => byte !== 0x41)) {
    throw new Error(`content 被后续 read 覆盖：${content.slice(0, 8).join(",")}...`);
  }
});

Deno.test("FrameDecoder 一次投喂多帧", () => {
  const merged = new Uint8Array([
    ...encodeFrame(FCGI_STDOUT, 1, new Uint8Array([1])),
    ...encodeFrame(FCGI_STDOUT, 1, new Uint8Array([2])),
  ]);
  const frames = new FrameDecoder().feed(merged);
  assertEquals(frames.length, 2);
  assertEquals([...frames[0].content, ...frames[1].content], [1, 2]);
});

Deno.test("PARAMS 编解码往返", () => {
  const params = {
    REQUEST_METHOD: "GET",
    SCRIPT_FILENAME: "/srv/site/api/hello.ts",
    LONG_VALUE: "x".repeat(300),
    ["HTTP_X_LONG_NAME_".repeat(10)]: "v",
  };
  const frames = encodeParams(params, 3);
  assertEquals(frames.at(-1)?.length, 8, "最后一帧应为空 PARAMS");

  const decoder = new FrameDecoder();
  const chunks: Uint8Array[] = [];
  for (const frame of frames) {
    for (const decoded of decoder.feed(frame)) {
      if (decoded.type === FCGI_PARAMS && decoded.content.length > 0) {
        chunks.push(decoded.content);
      }
    }
  }
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  assertEquals(decodeParams(merged), params);
});

Deno.test("BEGIN_REQUEST 编解码", () => {
  const encoded = encodeBeginRequestBody(1, true);
  const decoded = decodeBeginRequestBody(encoded);
  assertEquals(decoded.role, 1);
  assertEquals(decoded.keepConn, true);

  const noKeepAlive = decodeBeginRequestBody(encodeBeginRequestBody(1, false));
  assertEquals(noKeepAlive.keepConn, false);
});

Deno.test("END_REQUEST 帧头正确", () => {
  const frame = encodeEndRequest(5, 0, 0);
  const decoder = new FrameDecoder().feed(frame);
  assertEquals(decoder.length, 1);
  assertEquals(decoder[0].type, FCGI_END_REQUEST);
  assertEquals(decoder[0].requestId, 5);
  assertEquals(decoder[0].content.length, 8);
});
