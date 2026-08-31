import { base64ToBytes, bytesToUtf8 } from "./bytes";
import { fail, ok, type ToolResult } from "./result";

/**
 * JWT decoding — and only decoding.
 *
 * THIS DOES NOT VERIFY ANYTHING. A JWT signature can only be checked with the key that
 * signed it, and we do not have it and will not ask for it. Everything below is the
 * attacker-controlled half of the token: anybody can mint a token containing any claims they
 * like, so a decoded `"role": "admin"` tells you what the token *says*, never what is true.
 *
 * The tool exists because reading the claims is genuinely useful — issuer, audience, key id,
 * timestamps, and whether the token was already expired when it was captured — and because
 * doing it on a paste-a-token website hands somebody else a live credential.
 */

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Narrow `unknown` from `JSON.parse` into a JSON value. Rejects nothing except cycles. */
function toJsonValue(input: unknown): JsonValue {
  if (input === null) return null;
  switch (typeof input) {
    case "string":
    case "number":
    case "boolean":
      return input;
    case "object": {
      if (Array.isArray(input)) return input.map(toJsonValue);
      const out: Record<string, JsonValue> = {};
      for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        out[key] = toJsonValue(value);
      }
      return out;
    }
    default:
      // undefined, function, symbol, bigint — none can come out of JSON.parse.
      return null;
  }
}

export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * A declared predicate rather than an inline check: `Array.isArray` does not narrow a
 * `readonly` array out of a union, so the negative branch of an inline test still leaves the
 * array in the type and the object case never materialises.
 */
function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSegment(segment: string, label: string): ToolResult<JsonObject> {
  const bytes = base64ToBytes(segment);
  if (!bytes.ok) return fail(`The ${label} is not valid base64url: ${bytes.error}`);
  const text = bytesToUtf8(bytes.value);
  if (!text.ok) return fail(`The ${label} does not decode to UTF-8 text.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.value);
  } catch {
    return fail(`The ${label} is not JSON. Decoded to: ${text.value.slice(0, 80)}`);
  }
  const value = toJsonValue(parsed);
  if (!isJsonObject(value)) {
    return fail(`The ${label} decoded to JSON, but not to an object.`);
  }
  return ok(value);
}

function stringClaim(source: JsonObject, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

function numberClaim(source: JsonObject, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** `aud` is a string or an array of strings (RFC 7519 section 4.1.3). */
function audienceClaim(source: JsonObject): readonly string[] {
  const value = source["aud"];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

export interface JwtTimes {
  /** Seconds since the Unix epoch, as the token states them. */
  readonly exp: number | null;
  readonly nbf: number | null;
  readonly iat: number | null;
}

export type JwtValidityState = "expired" | "notYetValid" | "withinWindow" | "noWindowStated";

export interface DecodedJwt {
  readonly header: JsonObject;
  readonly payload: JsonObject;
  /** The third segment, exactly as it appeared. Never checked against anything. */
  readonly signature: string;
  readonly alg: string | null;
  readonly kid: string | null;
  readonly typ: string | null;
  readonly issuer: string | null;
  readonly subject: string | null;
  readonly audience: readonly string[];
  readonly jwtId: string | null;
  readonly times: JwtTimes;
  /**
   * `alg: "none"` is a real, specified value (RFC 7519 section 6) and also the oldest JWT
   * vulnerability: a server that honours it accepts a token anybody can write.
   */
  readonly isUnsecured: boolean;
}

/**
 * Splits and decodes a compact-serialisation JWS. A five-segment token is a JWE — encrypted,
 * not merely encoded — and is refused rather than half-decoded into something misleading.
 */
export function decodeJwt(token: string): ToolResult<DecodedJwt> {
  const trimmed = token.trim().replace(/^Bearer\s+/i, "");
  if (trimmed.length === 0) return fail("Paste a token first.");

  const segments = trimmed.split(".");
  if (segments.length === 5) {
    return fail(
      "That is a JWE (five segments), not a JWS. Its payload is encrypted, not encoded, and cannot be read without the decryption key.",
    );
  }
  if (segments.length !== 3) {
    return fail(
      `A JWT has three dot-separated segments; this has ${segments.length}. Check for a truncated copy-paste or a stray line break.`,
    );
  }

  const [headerSegment = "", payloadSegment = "", signatureSegment = ""] = segments;

  const header = parseSegment(headerSegment, "header");
  if (!header.ok) return fail(header.error);
  const payload = parseSegment(payloadSegment, "payload");
  if (!payload.ok) return fail(payload.error);

  const alg = stringClaim(header.value, "alg");

  return ok({
    header: header.value,
    payload: payload.value,
    signature: signatureSegment,
    alg,
    kid: stringClaim(header.value, "kid"),
    typ: stringClaim(header.value, "typ"),
    issuer: stringClaim(payload.value, "iss"),
    subject: stringClaim(payload.value, "sub"),
    audience: audienceClaim(payload.value),
    jwtId: stringClaim(payload.value, "jti"),
    times: {
      exp: numberClaim(payload.value, "exp"),
      nbf: numberClaim(payload.value, "nbf"),
      iat: numberClaim(payload.value, "iat"),
    },
    isUnsecured: alg !== null && alg.toLowerCase() === "none",
  });
}

/**
 * Where `at` falls relative to the window the token claims for itself.
 *
 * This is a reading of the token's own text, not a verdict. An unverified token's `exp` is
 * as forgeable as the rest of it.
 */
export function validityState(times: JwtTimes, at: Date = new Date()): JwtValidityState {
  const seconds = at.getTime() / 1000;
  if (times.exp !== null && seconds >= times.exp) return "expired";
  if (times.nbf !== null && seconds < times.nbf) return "notYetValid";
  if (times.exp === null && times.nbf === null) return "noWindowStated";
  return "withinWindow";
}
