/**
 * Read a `Response` body as text, refusing at a byte ceiling **while it is still arriving**.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS — QA finding QV-03
 * ─────────────────────────────────────────────────────────────────────────────
 * `lib/connectors/toolbench.ts` and `lib/sources/http.ts` each had the same shape:
 *
 *     const declared = Number(response.headers.get("content-length") ?? NaN);
 *     if (Number.isFinite(declared) && declared > maxBytes) { ... }   // only when declared
 *     const text = await response.text();                            // whole body, unbounded
 *     if (text.length > maxBytes) { ... }                            // too late
 *
 * Both gates miss the case that matters. `Content-Length` is absent on every chunked
 * response — which is what `web.archive.org` sends for an `id_` capture, the one path in
 * this product where a reader influences which URL is fetched — and when it *is* present it
 * describes the **compressed** size, while `fetch` transparently gunzips. So the ceiling was
 * only ever checked against a string that was already resident in the heap. QA measured 8x
 * the cap pulled before the refusal.
 *
 * The comment above `DEFAULT_MAX_BYTES` in both callers states the intent exactly right —
 * "a response with no ceiling is a way to exhaust a small VPS's memory from a text field" —
 * so this is the code delivering what the comment already promised.
 *
 * ONE HELPER, TWO CALLERS, deliberately. The two layers already shared the byte cap, the
 * `Retry-After` parse and the cooldown map as three pairs of copies, and QV-18 records what
 * that costs: one copy gets fixed and the other does not. This is the first of the three to
 * be merged.
 *
 * It returns a value rather than throwing, because its two callers disagree about what a
 * refusal *is*: `upstreamGet` throws `UpstreamStatusError`, `fetchUpstream` returns a typed
 * `SourceFailure`. Neither vocabulary belongs in here.
 */

export type CappedBody =
  | { readonly ok: true; readonly text: string; readonly bytes: number }
  | {
      readonly ok: false;
      /**
       * `declared` — the upstream told us up front that it was over the cap, so nothing was
       * read. `streamed` — we stopped mid-body; `bytes` is what had arrived when we stopped,
       * which is at most one chunk past the cap and never the whole payload.
       */
      readonly reason: "declared" | "streamed";
      readonly bytes: number;
      readonly maxBytes: number;
    };

export async function readCappedText(response: Response, maxBytes: number): Promise<CappedBody> {
  /*
   * The declared length is still worth checking: when it is present and honest it saves us
   * opening the stream at all. It is an optimisation, NOT the control — it is absent on a
   * chunked response and it counts compressed bytes when the body is encoded. Everything
   * below assumes it told us nothing.
   */
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    return { ok: false, reason: "declared", bytes: declared, maxBytes };
  }

  const reader = response.body?.getReader();
  // No body at all (a 204, or a `Response` constructed with null). Not an error: an empty
  // body is a body of zero bytes, and the caller's parser will say what it makes of it.
  if (!reader) return { ok: true, text: "", bytes: 0 };

  /*
   * Decoded incrementally rather than buffered and joined, so the peak heap is one chunk
   * plus the text so far rather than twice the payload. `stream: true` carries a multi-byte
   * character split across a chunk boundary into the next call instead of emitting U+FFFD.
   */
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        /*
         * Cancel rather than break. Cancelling closes the underlying socket, so the upstream
         * stops sending; breaking would leave the rest of the body arriving into a buffer
         * nobody drains. The whole point of this function is that the bytes never arrive.
         */
        await reader.cancel();
        return { ok: false, reason: "streamed", bytes, maxBytes };
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    // Releasing an already-cancelled reader is a no-op; not releasing one holds the stream.
    reader.releaseLock();
  }

  text += decoder.decode();
  return { ok: true, text, bytes };
}
