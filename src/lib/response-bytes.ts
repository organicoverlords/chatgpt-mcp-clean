export type ResponseByteCounter = {
  readonly total: number;
  count(chunk: unknown, encoding?: BufferEncoding): number;
  finish(): void;
};

export function createResponseByteCounter(onFinish: (bytes: number) => void): ResponseByteCounter {
  let total = 0;
  let finished = false;
  return {
    get total() { return total; },
    count(chunk: unknown, encoding: BufferEncoding = "utf8") {
      let bytes = 0;
      if (typeof chunk === "string") bytes = Buffer.byteLength(chunk, encoding);
      else if (Buffer.isBuffer(chunk)) bytes = chunk.byteLength;
      else if (ArrayBuffer.isView(chunk)) bytes = chunk.byteLength;
      total += bytes;
      return bytes;
    },
    finish() {
      if (finished) return;
      finished = true;
      onFinish(total);
    },
  };
}
