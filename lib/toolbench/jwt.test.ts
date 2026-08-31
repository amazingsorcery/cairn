import { describe, expect, it } from "vitest";

import { decodeJwt, validityState } from "./jwt";

/**
 * The example JWS from RFC 7515 Appendix A.1, which RFC 7519 section 3.1 reuses as its
 * example JWT. Its header is `{"typ":"JWT",\r\n "alg":"HS256"}` and its payload is
 * `{"iss":"joe",\r\n "exp":1300819380,\r\n "http://example.com/is_root":true}`.
 */
const RFC_EXAMPLE =
  "eyJ0eXAiOiJKV1QiLA0KICJhbGciOiJIUzI1NiJ9" +
  ".eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ" +
  ".dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

describe("the RFC 7515 example token", () => {
  it("decodes the header", () => {
    const decoded = decodeJwt(RFC_EXAMPLE);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.header).toEqual({ typ: "JWT", alg: "HS256" });
    expect(decoded.value.alg).toBe("HS256");
    expect(decoded.value.typ).toBe("JWT");
  });

  it("decodes the payload and its claims", () => {
    const decoded = decodeJwt(RFC_EXAMPLE);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.issuer).toBe("joe");
    expect(decoded.value.times.exp).toBe(1_300_819_380);
    expect(decoded.value.payload["http://example.com/is_root"]).toBe(true);
  });

  it("keeps the signature untouched and never claims to have checked it", () => {
    const decoded = decodeJwt(RFC_EXAMPLE);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.signature).toBe("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    // There is deliberately no `verified` field on the result. If one ever appears, this
    // test is the place the reviewer should stop and ask where the key came from.
    expect(Object.keys(decoded.value)).not.toContain("verified");
  });

  it("strips a Bearer prefix, because that is how tokens are copied out of a header", () => {
    const decoded = decodeJwt(`Bearer ${RFC_EXAMPLE}`);
    expect(decoded.ok && decoded.value.issuer).toBe("joe");
  });
});

describe("the validity window the token claims for itself", () => {
  const times = { exp: 1_300_819_380, nbf: null, iat: 1_300_819_320 };

  it("reports expiry against the given instant", () => {
    expect(validityState(times, new Date(1_300_819_379_000))).toBe("withinWindow");
    expect(validityState(times, new Date(1_300_819_381_000))).toBe("expired");
  });

  it("reports a not-yet-valid token", () => {
    expect(validityState({ exp: null, nbf: 2_000_000_000, iat: null }, new Date(1_000_000_000_000))).toBe(
      "notYetValid",
    );
  });

  it("distinguishes 'no window stated' from 'valid'", () => {
    expect(validityState({ exp: null, nbf: null, iat: 1 }, new Date())).toBe("noWindowStated");
  });
});

describe("refusals that stop the tool from lying", () => {
  it("refuses a JWE rather than decoding half of it", () => {
    const result = decodeJwt("a.b.c.d.e");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("JWE");
    expect(result.error).toContain("encrypted");
  });

  it("names the segment count when it is not three", () => {
    const result = decodeJwt("only.two");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("this has 2");
  });

  it("says which segment failed and what it decoded to", () => {
    // "aGVsbG8" is base64url for "hello", which is not JSON.
    const result = decodeJwt("aGVsbG8.aGVsbG8.sig");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("header");
    expect(result.error).toContain("hello");
  });

  it("refuses a payload that is JSON but not an object", () => {
    // "WzEsMiwzXQ" is base64url for "[1,2,3]".
    const result = decodeJwt("eyJhbGciOiJIUzI1NiJ9.WzEsMiwzXQ.sig");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("not to an object");
  });
});

describe("alg: none", () => {
  it("flags the unsecured algorithm", () => {
    // {"alg":"none"} . {"sub":"admin"} . (empty signature)
    const token = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJhZG1pbiJ9.";
    const decoded = decodeJwt(token);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.isUnsecured).toBe(true);
    expect(decoded.value.subject).toBe("admin");
    expect(decoded.value.signature).toBe("");
  });
});

describe("audience, which is a string or an array", () => {
  it("normalises both shapes to an array", () => {
    // {"aud":"one"} and {"aud":["one","two"]}
    const single = decodeJwt("eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJvbmUifQ.s");
    const many = decodeJwt("eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOlsib25lIiwidHdvIl19.s");
    expect(single.ok && single.value.audience).toEqual(["one"]);
    expect(many.ok && many.value.audience).toEqual(["one", "two"]);
  });
});
