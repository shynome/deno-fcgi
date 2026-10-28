/** 字节工具：拼接与跨线程转移，主线程和 Worker 共用 */

export function concatChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0];
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

/**
 * 只有「独占整个 ArrayBuffer」的视图才能安全转移。
 * 转移后原视图会变成 detached，所以调用方必须确定自己不再使用。
 */
export function transferablesOf(bytes: Uint8Array): ArrayBuffer[] {
  if (bytes.byteLength === 0) return [];
  if (bytes.byteOffset !== 0) return [];
  if (bytes.byteLength !== bytes.buffer.byteLength) return [];
  return [bytes.buffer as ArrayBuffer];
}
