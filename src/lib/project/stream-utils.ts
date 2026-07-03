/**
 * Stream-reading guards shared by the OpenAI-compatible (`llm.ts`) and Responses
 * (`openai-responses.ts`) streaming readers.
 *
 * Some providers accept `stream_options: { include_usage: true }` but never send
 * a terminating `data: [DONE]` line and never close the connection — the read
 * loop would then hang on `await reader.read()` forever. `readWithIdleTimeout`
 * races each read against an idle timer and cancels the reader when it fires, so
 * a silent provider terminates the turn instead of stalling the whole chat.
 */

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;

/**
 * Read one chunk from `reader`, but resolve with `{ done: true }` if no chunk
 * arrives within `idleTimeoutMs`. On timeout the reader is cancelled so any
 * pending `read()` resolves promptly. Pass `idleTimeoutMs <= 0` (or an
 * already-aborted `signal`) to disable the guard and behave like a plain
 * `reader.read()`.
 */
export async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (idleTimeoutMs <= 0 || signal?.aborted) return reader.read();

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout: Promise<ReadableStreamReadResult<Uint8Array>> = new Promise((resolve) => {
    timer = setTimeout(() => {
      // Cancelling makes the in-flight read() resolve; the chat loop then
      // treats this as a normal end-of-stream.
      reader.cancel().catch(() => {});
      resolve({ done: true, value: undefined });
    }, idleTimeoutMs);
  });

  const read = reader.read();
  // If the timeout cancels the reader, the in-flight read() may reject late;
  // swallow it so it never surfaces as an unhandled rejection.
  read.catch(() => {});

  return Promise.race([read, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}
