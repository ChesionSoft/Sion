import { ReadableStream } from "node:stream/web";
import { describe, expect, it } from "vitest";
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS, readWithIdleTimeout } from "./stream-utils";

function makeStream(chunks: string[], close: boolean): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (close) controller.close();
    },
  });
}

function decode(value: Uint8Array | undefined): string {
  return value ? new TextDecoder().decode(value) : "";
}

describe("readWithIdleTimeout", () => {
  it("returns chunks then done for a normally-closing stream", async () => {
    const reader = makeStream(["a", "b"], true).getReader();
    const r1 = await readWithIdleTimeout(reader, 1000);
    expect(r1.done).toBe(false);
    expect(decode(r1.value)).toBe("a");
    const r2 = await readWithIdleTimeout(reader, 1000);
    expect(r2.done).toBe(false);
    expect(decode(r2.value)).toBe("b");
    const r3 = await readWithIdleTimeout(reader, 1000);
    expect(r3.done).toBe(true);
  });

  it("returns done after the idle timeout when the stream goes silent", async () => {
    // One chunk, then the stream never closes and never sends more.
    const reader = makeStream(["x"], false).getReader();
    const r1 = await readWithIdleTimeout(reader, 50);
    expect(r1.done).toBe(false);
    expect(decode(r1.value)).toBe("x");

    const start = Date.now();
    const r2 = await readWithIdleTimeout(reader, 50);
    const elapsed = Date.now() - start;
    expect(r2.done).toBe(true);
    // Fires around the 50ms mark, well under the 60s production default.
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(1500);
  });

  it("exposes a 60s default idle timeout constant", () => {
    expect(DEFAULT_STREAM_IDLE_TIMEOUT_MS).toBe(60_000);
  });
});
