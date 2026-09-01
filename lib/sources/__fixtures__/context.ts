import { createMemoryCache } from "../cache";
import type { SourceCache, SourceContext } from "../types";

/**
 * Test support: a `SourceContext` with its own cache and no `process.env`.
 *
 * The whole point of the revised contract is that an adapter takes its cache and its
 * environment as arguments, so a test can hand it a plain map and an object literal. Nothing
 * here mutates global state, which means these tests can run in any order.
 */
export function testContext(
  options: {
    readonly env?: Readonly<Record<string, string>>;
    readonly cache?: SourceCache;
    readonly signal?: AbortSignal;
  } = {},
): SourceContext & { readonly cache: SourceCache } {
  const env = options.env ?? {};
  return {
    signal: options.signal ?? new AbortController().signal,
    cache: options.cache ?? createMemoryCache(),
    env: (name: string) => env[name],
  };
}

/** A JSON response, for stubbing `globalThis.fetch` in an adapter round-trip test. */
export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}
