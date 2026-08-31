/**
 * The one result shape every Toolbench conversion returns.
 *
 * These functions take text a human typed. Malformed input is the normal case, not an
 * exceptional one, so a bad base32 string returns a message the UI can render next to the
 * field rather than throwing into an error boundary and losing everything else on the page.
 */
export type ToolResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export function ok<T>(value: T): ToolResult<T> {
  return { ok: true, value };
}

export function fail<T = never>(error: string): ToolResult<T> {
  return { ok: false, error };
}

/** Narrow a caught `unknown` into a message without ever producing `[object Object]`. */
export function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return "Unknown error";
}
