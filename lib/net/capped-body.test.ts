import { describe, expect, it } from "vitest";

import { readCappedText } from "./capped-body";

/**
 * The cap must apply while the body streams. Cases use a counting `ReadableStream` so
 * assertions check how many bytes were actually pulled.
 */

/** A stream of `chunkBytes`-sized chunks, up to `totalBytes`, that records what it emitted. */
function countingStream(totalBytes: number, chunkBytes: number) {
  const state = { produced: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.produced >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkBytes, totalBytes - state.produced);
      state.produced += size;
      controller.enqueue(new Uint8Array(size).fill(97));
    },
  });
  return { stream, state };
}

describe("readCappedText", () => {
  it("returns the body when it is inside the cap", async () => {
    const response = new Response("hello");
    const result = await readCappedText(response, 1024);
    expect(result).toEqual({ ok: true, text: "hello", bytes: 5 });
  });

  it("refuses on a declared length over the cap without opening the stream", async () => {
    const { stream, state } = countingStream(4096, 512);
    const response = new Response(stream, { headers: { "content-length": "999999" } });

    const result = await readCappedText(response, 1024);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("declared");
    expect(state.produced).toBe(0);
  });

  /** Chunked response with no `Content-Length` and a body far over the cap. */
  it("stops pulling a chunked oversize body within one chunk of the cap", async () => {
    const CAP = 64 * 1024;
    const CHUNK = 8 * 1024;
    const { stream, state } = countingStream(CAP * 8, CHUNK);
    const response = new Response(stream, { headers: { "content-type": "text/html" } });

    const result = await readCappedText(response, CAP);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("streamed");
    // Slack is bounded by chunk size plus whatever the stream queued ahead.
    expect(state.produced).toBeLessThan(CAP * 8);
    expect(state.produced).toBeLessThanOrEqual(CAP + CHUNK * 4);
  });

  /** With gzip, Content-Length is the compressed size, so a small value proves nothing. */
  it("stops pulling when a small declared length is followed by an oversize body", async () => {
    const CAP = 64 * 1024;
    const CHUNK = 8 * 1024;
    const { stream, state } = countingStream(CAP * 8, CHUNK);
    const response = new Response(stream, {
      headers: { "content-length": "1024", "content-encoding": "gzip" },
    });

    const result = await readCappedText(response, CAP);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("streamed");
    expect(state.produced).toBeLessThan(CAP * 8);
  });

  it("accepts a body exactly at the cap", async () => {
    const { stream } = countingStream(1024, 256);
    const result = await readCappedText(new Response(stream), 1024);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.bytes).toBe(1024);
  });

  it("does not mangle a multi-byte character split across a chunk boundary", async () => {
    // "€" is E2 82 AC. Split it so a naive per-chunk decode would emit replacement chars.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xe2, 0x82]));
        controller.enqueue(new Uint8Array([0xac]));
        controller.close();
      },
    });
    const result = await readCappedText(new Response(stream), 1024);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.text).toBe("\u20ac");
  });

  it("treats a null body as an empty one rather than an error", async () => {
    const result = await readCappedText(new Response(null, { status: 204 }), 1024);
    expect(result).toEqual({ ok: true, text: "", bytes: 0 });
  });
});
