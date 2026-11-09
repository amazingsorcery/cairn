/**
 * Read a `Response` body as text, aborting once it passes a byte cap while streaming.
 *
 * `Content-Length` alone isn't enough: chunked responses (e.g. web.archive.org `id_`
 * captures) omit it, and with gzip it describes the compressed size.
 *
 * Returns a result instead of throwing; the two callers (`upstreamGet`, `fetchUpstream`)
 * report refusals differently.
 */

export type CappedBody =
  | { readonly ok: true; readonly text: string; readonly bytes: number }
  | {
      readonly ok: false;
      /**
       * `declared`: Content-Length was over the cap, nothing read. `streamed`: stopped
       * mid-body; `bytes` is at most one chunk past the cap.
       */
      readonly reason: "declared" | "streamed";
      readonly bytes: number;
      readonly maxBytes: number;
    };

export async function readCappedText(response: Response, maxBytes: number): Promise<CappedBody> {
  // Fast path only; the streaming check below is the real control.
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    return { ok: false, reason: "declared", bytes: declared, maxBytes };
  }

  const reader = response.body?.getReader();
  // No body (e.g. 204) is treated as empty, not an error.
  if (!reader) return { ok: true, text: "", bytes: 0 };

  // Decode incrementally; `stream: true` handles multi-byte chars split across chunks.
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        // Cancel (not break) so the socket closes and the upstream stops sending.
        await reader.cancel();
        return { ok: false, reason: "streamed", bytes, maxBytes };
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    // Safe on a cancelled reader.
    reader.releaseLock();
  }

  text += decoder.decode();
  return { ok: true, text, bytes };
}
