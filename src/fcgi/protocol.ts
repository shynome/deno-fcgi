/**
 * FastCGI 1.0 协议编解码。
 *
 * 帧头固定 8 字节：
 *   version:1 type:1 requestId:2(BE) contentLength:2(BE) paddingLength:1 reserved:1
 */
export const FCGI_VERSION = 1;

export const FCGI_BEGIN_REQUEST = 1;
export const FCGI_ABORT_REQUEST = 2;
export const FCGI_END_REQUEST = 3;
export const FCGI_PARAMS = 4;
export const FCGI_STDIN = 5;
export const FCGI_STDOUT = 6;
export const FCGI_STDERR = 7;
export const FCGI_DATA = 8;
export const FCGI_GET_VALUES = 9;
export const FCGI_GET_VALUES_RESULT = 10;
export const FCGI_UNKNOWN_TYPE = 11;

export const FCGI_RESPONDER = 1;
export const FCGI_AUTHORIZER = 2;
export const FCGI_FILTER = 3;

export const FCGI_REQUEST_COMPLETE = 0;
export const FCGI_CANT_MPX_CONN = 1;
export const FCGI_OVERLOADED = 2;
export const FCGI_UNKNOWN_ROLE = 3;

export const HEADER_SIZE = 8;
export const MAX_CONTENT_LENGTH = 0xffff;
/** 单帧响应体大小的经验值，过大增加对端缓冲压力 */
export const RECORD_CHUNK_SIZE = 32 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface Frame {
  type: number;
  requestId: number;
  content: Uint8Array;
}

export interface BeginRequestBody {
  role: number;
  keepConn: boolean;
}

/** 增量解码器：TCP 是字节流，一次 read 可能拿到半个帧或多个帧 */
export class FrameDecoder {
  #buffer: Uint8Array = new Uint8Array(0);

  feed(chunk: Uint8Array): Frame[] {
    if (this.#buffer.length === 0) {
      // 必须拷贝：调用方通常复用同一块读缓冲（conn.read(buffer)），
      // 下一次 read 会覆盖它，残留的半帧会被写坏
      this.#buffer = chunk.slice();
    } else {
      const merged = new Uint8Array(this.#buffer.length + chunk.length);
      merged.set(this.#buffer);
      merged.set(chunk, this.#buffer.length);
      this.#buffer = merged;
    }

    const frames: Frame[] = [];
    let offset = 0;

    while (this.#buffer.length - offset >= HEADER_SIZE) {
      const view = new DataView(
        this.#buffer.buffer,
        this.#buffer.byteOffset + offset,
        HEADER_SIZE,
      );
      const version = view.getUint8(0);
      const type = view.getUint8(1);
      const requestId = view.getUint16(2);
      const contentLength = view.getUint16(4);
      const paddingLength = view.getUint8(6);
      const total = HEADER_SIZE + contentLength + paddingLength;

      if (version !== FCGI_VERSION) {
        throw new Error(`unsupported FastCGI version: ${version}`);
      }
      if (this.#buffer.length - offset < total) break;

      const contentStart = offset + HEADER_SIZE;
      frames.push({
        type,
        requestId,
        content: this.#buffer.subarray(contentStart, contentStart + contentLength),
      });
      offset += total;
    }

    // 用 slice 而不是 subarray：避免残留的几字节继续持有整个读缓冲
    this.#buffer = offset === 0 ? this.#buffer : this.#buffer.slice(offset);
    return frames;
  }
}

export function encodeFrame(
  type: number,
  requestId: number,
  content: Uint8Array = new Uint8Array(0),
): Uint8Array {
  const paddingLength = 0;
  const out = new Uint8Array(HEADER_SIZE + content.length + paddingLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, FCGI_VERSION);
  view.setUint8(1, type);
  view.setUint16(2, requestId);
  view.setUint16(4, content.length);
  view.setUint8(6, paddingLength);
  view.setUint8(7, 0);
  out.set(content, HEADER_SIZE);
  return out;
}

/** 把任意长度的数据拆成多个 STDOUT/STDERR 记录 */
export function encodeStreamFrames(
  type: number,
  requestId: number,
  data: Uint8Array,
): Uint8Array[] {
  if (data.length === 0) return [encodeFrame(type, requestId)];
  const frames: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += RECORD_CHUNK_SIZE) {
    frames.push(
      encodeFrame(type, requestId, data.subarray(i, i + RECORD_CHUNK_SIZE)),
    );
  }
  return frames;
}

export function encodeBeginRequestBody(
  role: number,
  keepConn: boolean,
): Uint8Array {
  const body = new Uint8Array(8);
  const view = new DataView(body.buffer);
  view.setUint16(0, role);
  view.setUint8(2, keepConn ? 1 : 0);
  return body;
}

export function decodeBeginRequestBody(content: Uint8Array): BeginRequestBody {
  const view = new DataView(content.buffer, content.byteOffset, content.length);
  return {
    role: view.getUint16(0),
    keepConn: view.getUint8(2) !== 0,
  };
}

export function encodeEndRequest(
  requestId: number,
  appStatus = 0,
  protocolStatus = FCGI_REQUEST_COMPLETE,
): Uint8Array {
  const body = new Uint8Array(8);
  const view = new DataView(body.buffer);
  view.setUint32(0, appStatus, false);
  view.setUint8(4, protocolStatus);
  return encodeFrame(FCGI_END_REQUEST, requestId, body);
}

function encodeLength(length: number): Uint8Array {
  if (length < 128) return new Uint8Array([length]);
  return new Uint8Array([
    ((length >> 24) & 0x7f) | 0x80,
    (length >> 16) & 0xff,
    (length >> 8) & 0xff,
    length & 0xff,
  ]);
}

/** PARAMS 使用 name-value pair 编码，长度 <128 时 1 字节，否则 4 字节（最高位 1） */
export function encodeParams(
  params: Record<string, string>,
  requestId: number,
): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let payload = new Uint8Array(0);
  // 单帧上限 65535，留点余量
  const limit = MAX_CONTENT_LENGTH - 1024;

  const push = (part: Uint8Array) => {
    if (payload.length + part.length > limit) {
      chunks.push(encodeFrame(FCGI_PARAMS, requestId, payload));
      payload = new Uint8Array(0);
    }
    const merged = new Uint8Array(payload.length + part.length);
    merged.set(payload);
    merged.set(part, payload.length);
    payload = merged;
  };

  for (const [name, value] of Object.entries(params)) {
    const nameBytes = encoder.encode(name);
    const valueBytes = encoder.encode(value);
    push(encodeLength(nameBytes.length));
    push(encodeLength(valueBytes.length));
    push(nameBytes);
    push(valueBytes);
  }
  chunks.push(encodeFrame(FCGI_PARAMS, requestId, payload));
  // 空帧表示结束
  chunks.push(encodeFrame(FCGI_PARAMS, requestId));
  return chunks;
}

export function decodeParams(content: Uint8Array): Record<string, string> {
  const params: Record<string, string> = {};
  let offset = 0;

  const readLength = (): number => {
    if (offset >= content.length) throw new Error("truncated params");
    const first = content[offset];
    if ((first & 0x80) === 0) {
      offset += 1;
      return first;
    }
    if (offset + 3 >= content.length) throw new Error("truncated params length");
    const length = ((first & 0x7f) << 24) |
      (content[offset + 1] << 16) |
      (content[offset + 2] << 8) |
      content[offset + 3];
    offset += 4;
    return length;
  };

  while (offset < content.length) {
    const nameLength = readLength();
    const valueLength = readLength();
    if (offset + nameLength + valueLength > content.length) {
      throw new Error("truncated params pair");
    }
    const name = decoder.decode(content.subarray(offset, offset + nameLength));
    offset += nameLength;
    const value = decoder.decode(content.subarray(offset, offset + valueLength));
    offset += valueLength;
    params[name] = value;
  }

  return params;
}

export { decoder as textDecoder, encoder as textEncoder };
