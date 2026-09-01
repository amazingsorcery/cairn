import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { upstreamGet } from "@/lib/connectors/toolbench";
import { UpstreamStatusError } from "@/lib/connectors/runtime";

/**
 * QA attack suite for the one outbound HTTP path the Toolbench uses.
 *
 * Owned by qa-adversary. `lib/connectors/toolbench.ts` documents `upstreamGet` as the control
 * that stops a server-side request forgery: it pins the host before the request and again on
 * every redirect hop, and it caps the bytes it will read. Each block below is one attack
 * against one of those claims, driven through a stubbed `globalThis.fetch` so the assertion is
 * about our code and not about a third party's mood.
 *
 * Where a test documents a DEFECT rather than a defence, it is named `DEFECT (QA-nn)` and
 * asserts the behaviour as it is today, so the finding cannot be closed without the assertion
 * being deliberately inverted.
 */

const PIN = "web.archive.org";
const BASE = `https://${PIN}/web/20200101000000id_/https://example.com/`;

type Call = { url: string; init: RequestInit | undefined };

let calls: Call[] = [];
const realFetch = globalThis.fetch;

function stub(responder: (url: string, hop: number) => Response): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return responder(url, calls.length - 1);
  }) as unknown as typeof fetch;
}

function redirectTo(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

function body(text: string, headers: Record<string, string> = {}): Response {
  return new Response(text, { status: 200, headers: { "content-type": "text/html", ...headers } });
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const signal = (): AbortSignal => new AbortController().signal;

describe("upstreamGet — the pin holds on the first request", () => {
  it("refuses a URL that is not on the pinned host, before any request", async () => {
    stub(() => body("never"));
    await expect(
      upstreamGet({ url: "https://169.254.169.254/latest/meta-data/", pinnedHost: PIN, signal: signal() }),
    ).rejects.toBeInstanceOf(UpstreamStatusError);
    expect(calls).toHaveLength(0);
  });

  it("refuses http:// even on the right host (no scheme downgrade)", async () => {
    stub(() => body("never"));
    await expect(
      upstreamGet({ url: `http://${PIN}/x`, pinnedHost: PIN, signal: signal() }),
    ).rejects.toBeInstanceOf(UpstreamStatusError);
    expect(calls).toHaveLength(0);
  });

  it("refuses userinfo smuggling", async () => {
    stub(() => body("never"));
    await expect(
      upstreamGet({ url: `https://${PIN}@169.254.169.254/`, pinnedHost: PIN, signal: signal() }),
    ).rejects.toBeInstanceOf(UpstreamStatusError);
    expect(calls).toHaveLength(0);
  });
});

describe("upstreamGet — the pin holds on every redirect hop", () => {
  const offHost = [
    "https://169.254.169.254/latest/meta-data/",
    "//169.254.169.254/latest/meta-data/",
    "https://web.archive.org.attacker.example/x",
    "https://evil-archive.org/x",
    "http://web.archive.org/x",
    "https://web.archive.org:8443/x",
    "https://user:pw@web.archive.org/x",
    "https://[::1]/x",
    "https://127.0.0.1/x",
    "https://metadata.google.internal/computeMetadata/v1/",
  ];

  for (const location of offHost) {
    it(`refuses a Location to ${location}`, async () => {
      stub((_url, hop) => (hop === 0 ? redirectTo(location) : body("SECRET")));
      await expect(
        upstreamGet({ url: BASE, pinnedHost: PIN, signal: signal(), maxRedirects: 3 }),
      ).rejects.toBeInstanceOf(UpstreamStatusError);
      // Exactly one request: the first. The off-host hop was never made.
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(BASE);
    });
  }

  it("follows a same-host relative redirect and re-pins it", async () => {
    stub((_url, hop) => (hop === 0 ? redirectTo("/web/20200102000000id_/https://example.com/") : body("PAGE")));
    const result = await upstreamGet({
      url: BASE,
      pinnedHost: PIN,
      signal: signal(),
      maxRedirects: 3,
    });
    expect(result.text).toBe("PAGE");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe(`https://${PIN}/web/20200102000000id_/https://example.com/`);
  });

  it("stops walking a redirect loop at maxRedirects", async () => {
    stub(() => redirectTo(`https://${PIN}/loop`));
    await expect(
      upstreamGet({ url: BASE, pinnedHost: PIN, signal: signal(), maxRedirects: 3 }),
    ).rejects.toBeInstanceOf(UpstreamStatusError);
    expect(calls.length).toBe(4);
  });

  it("treats a 3xx as an error when maxRedirects is 0 (the default for three of four tools)", async () => {
    stub(() => redirectTo(`https://${PIN}/elsewhere`));
    await expect(upstreamGet({ url: BASE, pinnedHost: PIN, signal: signal() })).rejects.toBeInstanceOf(
      UpstreamStatusError,
    );
    expect(calls).toHaveLength(1);
  });

  it("does not send our User-Agent to an off-host destination (nothing is sent at all)", async () => {
    stub((_url, hop) => (hop === 0 ? redirectTo("https://169.254.169.254/") : body("x")));
    await expect(
      upstreamGet({ url: BASE, pinnedHost: PIN, signal: signal(), maxRedirects: 3 }),
    ).rejects.toThrow();
    expect(calls.map((c) => c.url)).toEqual([BASE]);
  });
});

describe("upstreamGet — the byte cap", () => {
  it("refuses when Content-Length declares more than the cap, without reading the body", async () => {
    stub(() => body("x", { "content-length": String(50 * 1024 * 1024) }));
    await expect(
      upstreamGet({ url: BASE, pinnedHost: PIN, signal: signal(), maxBytes: 1024 }),
    ).rejects.toBeInstanceOf(UpstreamStatusError);
  });

  /**
   * QV-03, fixed. The cap is now applied to the STREAM: `readCappedText` pulls chunk by
   * chunk and cancels the reader the moment the running total passes `maxBytes`.
   *
   * This test was written by QA against the defect — a body 8x the cap was fully buffered
   * and only then refused — and is inverted here. It asserts the property that matters for a
   * memory-exhaustion control: how many bytes actually reached this process. An upstream
   * that omits `Content-Length` (every chunked response, and what `web.archive.org` sends
   * for an `id_` capture) must not be able to spend more than the cap plus what the stream
   * had already queued.
   */
  it("QA-V2-03: stops pulling a chunked oversize body within a chunk or two of the cap", async () => {
    const CAP = 64 * 1024;
    const CHUNK = 8 * 1024;
    const OVERSIZE = CAP * 8;
    let bytesPulled = 0;

    stub(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (bytesPulled >= OVERSIZE) {
                controller.close();
                return;
              }
              const chunk = new Uint8Array(CHUNK).fill(97);
              bytesPulled += chunk.byteLength;
              controller.enqueue(chunk);
            },
          }),
          // No content-length. This is the whole point.
          { status: 200, headers: { "content-type": "text/html" } },
        ),
    );

    await expect(
      upstreamGet({ url: BASE, pinnedHost: PIN, signal: signal(), maxBytes: CAP }),
    ).rejects.toBeInstanceOf(UpstreamStatusError);

    expect(bytesPulled).toBeLessThan(OVERSIZE);
    expect(bytesPulled).toBeLessThanOrEqual(CAP + CHUNK * 4);
  });

  /**
   * QV-03, the compression variant, inverted. `fetch` transparently decodes
   * `Content-Encoding: gzip`, and `Content-Length` describes the COMPRESSED size — so a
   * declared length far under the cap can decode to far over it. The declared-length gate is
   * now an optimisation rather than the control, and the streaming gate catches this.
   */
  it("QA-V2-03: a small declared Content-Length does not license an unbounded read", async () => {
    const CAP = 64 * 1024;
    const CHUNK = 8 * 1024;
    const OVERSIZE = CAP * 8;
    let bytesPulled = 0;

    stub(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (bytesPulled >= OVERSIZE) {
                controller.close();
                return;
              }
              const chunk = new Uint8Array(CHUNK).fill(97);
              bytesPulled += chunk.byteLength;
              controller.enqueue(chunk);
            },
          }),
          { status: 200, headers: { "content-length": "1024", "content-encoding": "gzip" } },
        ),
    );

    await expect(
      upstreamGet({ url: BASE, pinnedHost: PIN, signal: signal(), maxBytes: CAP }),
    ).rejects.toBeInstanceOf(UpstreamStatusError);

    expect(bytesPulled).toBeLessThan(OVERSIZE);
  });

  /**
   * The Wayback capture fetch asks for the original bytes. QV-03: transfer compression buys
   * us nothing on a path we then have to bound, and it makes any declared length meaningless.
   */
  it("sends accept-encoding: identity when the caller asks for it", async () => {
    stub(() => body("PAGE"));
    await upstreamGet({
      url: BASE,
      pinnedHost: PIN,
      signal: signal(),
      acceptEncoding: "identity",
    });
    const headers = calls[0]?.init?.headers as Record<string, string> | undefined;
    expect(headers?.["accept-encoding"]).toBe("identity");
  });

  it("sends no accept-encoding header when the caller does not ask", async () => {
    stub(() => body("PAGE"));
    await upstreamGet({ url: BASE, pinnedHost: PIN, signal: signal() });
    const headers = calls[0]?.init?.headers as Record<string, string> | undefined;
    expect(headers && "accept-encoding" in headers).toBe(false);
  });
});

describe("upstreamGet — what leaves the building", () => {
  it("never returns an upstream error body to the caller", async () => {
    stub(() => new Response("YOUR QUERY WAS: secret-domain.example", { status: 500 }));
    await upstreamGet({ url: BASE, pinnedHost: PIN, signal: signal() }).then(
      () => expect.unreachable("should have thrown"),
      (error: unknown) => {
        expect(error).toBeInstanceOf(UpstreamStatusError);
        expect(String(error)).not.toContain("secret-domain.example");
      },
    );
  });

  it("carries Retry-After off a 429 so the cooldown can open", async () => {
    stub(() => new Response("slow down", { status: 429, headers: { "retry-after": "120" } }));
    await upstreamGet({ url: BASE, pinnedHost: PIN, signal: signal() }).then(
      () => expect.unreachable("should have thrown"),
      (error: unknown) => {
        expect(error).toBeInstanceOf(UpstreamStatusError);
        expect((error as UpstreamStatusError).status).toBe(429);
        expect((error as UpstreamStatusError).retryAfterSeconds).toBe(120);
      },
    );
  });
});
