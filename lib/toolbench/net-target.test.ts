import { describe, expect, it } from "vitest";

import {
  blockedIpReason,
  connectorHost,
  isPinnedHost,
  normaliseHostname,
  normaliseLookupUrl,
  normaliseNetworkTarget,
  normalisePublicIp,
  parseIpAddress,
} from "./net-target";

/**
 * The SSRF test suite. ADR 0019 names server-side request forgery the top risk of v2, so
 * these assertions are written the way an attacker would write them: every bypass in the
 * standard repertoire gets its own case, and each one asserts the *refusal*, not merely
 * that something was returned.
 *
 * The bypasses below are the ones that have historically defeated real filters:
 * decimal and hexadecimal IPv4, octal-padded octets, short-form `127.1`, IPv4-mapped and
 * 6to4 and Teredo IPv6, userinfo before the host, a trailing dot, uppercase, and the cloud
 * instance-metadata address.
 */

describe("hostnames", () => {
  it("accepts an ordinary domain and normalises it", () => {
    for (const [input, expected] of [
      ["example.com", "example.com"],
      ["EXAMPLE.COM", "example.com"],
      ["  example.com.  ", "example.com"],
      ["sub.domain.example.co.uk", "sub.domain.example.co.uk"],
      ["xn--bcher-kva.de", "xn--bcher-kva.de"],
    ] as const) {
      const result = normaliseHostname(input);
      expect(result.ok, `${input}: ${result.ok ? "" : result.error}`).toBe(true);
      if (result.ok) expect(result.value).toBe(expected);
    }
  });

  it("converts an internationalised name to punycode rather than passing unicode through", () => {
    // A query string carrying raw unicode is a different string on every upstream. Fixing
    // the encoding here means the cache key and the certificate log see the same name a
    // certificate authority would have issued for.
    const result = normaliseHostname("bücher.de");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("xn--bcher-kva.de");
  });

  it("refuses anything carrying a scheme, path, port or credentials", () => {
    for (const input of [
      "https://example.com",
      "example.com/path",
      "example.com:8080",
      "user:pass@example.com",
      "example.com@169.254.169.254",
      "//example.com",
    ]) {
      expect(normaliseHostname(input).ok, input).toBe(false);
    }
  });

  it("refuses single-label and special-use names, which no public source can answer", () => {
    for (const input of [
      "localhost",
      "LOCALHOST",
      "printer",
      "server.local",
      "db.internal",
      "thing.home.arpa",
      "site.onion",
      "box.lan",
      "host.localdomain",
    ]) {
      expect(normaliseHostname(input).ok, input).toBe(false);
    }
  });

  it("refuses an IP literal with a message pointing at the right tool", () => {
    const result = normaliseHostname("8.8.8.8");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/IP intelligence/);
  });

  it("refuses malformed labels and numeric top-level domains", () => {
    for (const input of [
      "-leading.example.com",
      "trailing-.example.com",
      "under_score.example.com",
      "a..b.com",
      "1.2.3.4.5",
      `${"a".repeat(64)}.example.com`,
      `${"a".repeat(250)}.example.com`,
      "example.c",
    ]) {
      expect(normaliseHostname(input).ok, input).toBe(false);
    }
  });
});

describe("IP parsing refuses every alternative encoding of an address", () => {
  it("accepts only strict dotted-quad IPv4", () => {
    expect(parseIpAddress("198.51.100.7").ok).toBe(true);
    expect(parseIpAddress("0.0.0.0").ok).toBe(true);
    expect(parseIpAddress("255.255.255.255").ok).toBe(true);
  });

  it("rejects decimal, hex, octal and short forms of 127.0.0.1", () => {
    // Every one of these resolves to loopback in `inet_aton` and in several HTTP clients.
    for (const input of [
      "2130706433",
      "0x7f000001",
      "0x7f.0.0.1",
      "0177.0.0.1",
      "127.1",
      "127.0.1",
      "017700000001",
      "127.000.000.001",
    ]) {
      expect(parseIpAddress(input).ok, input).toBe(false);
    }
  });

  it("rejects an octet above 255 and a malformed quad", () => {
    for (const input of ["256.1.1.1", "1.2.3.4.5", "1.2.3", "1.2.3.-1", "a.b.c.d", ""]) {
      expect(parseIpAddress(input).ok, input).toBe(false);
    }
  });

  it("parses IPv6 including compression and a trailing dotted quad", () => {
    const cases: readonly (readonly [string, readonly number[]])[] = [
      ["::1", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]],
      ["::", new Array<number>(16).fill(0)],
      [
        "2001:db8::1",
        [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
      ],
      [
        "::ffff:127.0.0.1",
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 127, 0, 0, 1],
      ],
      ["[2606:4700:4700::1111]", [0x26, 0x06, 0x47, 0x00, 0x47, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0x11, 0x11]],
    ];
    for (const [input, bytes] of cases) {
      const result = parseIpAddress(input);
      expect(result.ok, input).toBe(true);
      if (result.ok) {
        expect(result.value.version, input).toBe(6);
        expect([...result.value.bytes], input).toEqual([...bytes]);
      }
    }
  });

  it("rejects malformed IPv6", () => {
    for (const input of [
      "2001:db8:::1",
      "1:2:3:4:5:6:7:8:9",
      "2001:db8::1::2",
      "fe80::1%eth0",
      "gggg::1",
      "12345::1",
    ]) {
      expect(parseIpAddress(input).ok, input).toBe(false);
    }
  });
});

describe("the blocked-range list", () => {
  const blocked: readonly (readonly [string, RegExp])[] = [
    ["127.0.0.1", /loopback/i],
    ["127.255.255.254", /loopback/i],
    ["10.0.0.1", /private/i],
    ["10.255.255.255", /private/i],
    ["172.16.0.1", /private/i],
    ["172.31.255.255", /private/i],
    ["192.168.1.1", /private/i],
    ["169.254.1.1", /link-local/i],
    ["169.254.169.254", /instance-metadata|metadata/i],
    ["0.0.0.0", /this network/i],
    ["100.64.0.1", /carrier-grade/i],
    ["192.0.0.1", /IETF/i],
    ["192.0.2.1", /documentation/i],
    ["198.18.0.1", /benchmark/i],
    ["198.51.100.1", /documentation/i],
    ["203.0.113.1", /documentation/i],
    ["224.0.0.1", /multicast/i],
    ["240.0.0.1", /reserved/i],
    ["255.255.255.255", /reserved/i],
    ["::1", /loopback/i],
    ["::", /unspecified/i],
    ["fc00::1", /unique-local/i],
    ["fd00::1", /unique-local/i],
    ["fe80::1", /link-local/i],
    ["ff02::1", /multicast/i],
    ["2001:db8::1", /documentation/i],
    ["2002:7f00:1::1", /6to4/i],
    ["2001:0:53aa:64c:1:2:3:4", /Teredo/i],
    ["64:ff9b::7f00:1", /NAT64/i],
    ["100::1", /discard/i],
  ];

  it.each(blocked)("refuses %s", (address, pattern) => {
    const parsed = parseIpAddress(address);
    expect(parsed.ok, address).toBe(true);
    if (!parsed.ok) return;
    const reason = blockedIpReason(parsed.value);
    expect(reason, address).not.toBeNull();
    expect(reason ?? "", address).toMatch(pattern);
  });

  it("unwraps an IPv4-mapped IPv6 address and applies the IPv4 rules to it", () => {
    // ::ffff:127.0.0.1 must be refused as loopback, not accepted as "some IPv6 address".
    const loopback = parseIpAddress("::ffff:127.0.0.1");
    expect(loopback.ok).toBe(true);
    if (loopback.ok) expect(blockedIpReason(loopback.value)).toMatch(/loopback/i);

    const metadata = parseIpAddress("::ffff:169.254.169.254");
    expect(metadata.ok).toBe(true);
    if (metadata.ok) expect(blockedIpReason(metadata.value)).toMatch(/metadata/i);

    // A mapped *public* address is still refused, because the unambiguous form exists.
    const mapped = parseIpAddress("::ffff:8.8.8.8");
    expect(mapped.ok).toBe(true);
    if (mapped.ok) expect(blockedIpReason(mapped.value)).toMatch(/IPv4-mapped/i);
  });

  it("allows genuinely public addresses", () => {
    for (const address of [
      "8.8.8.8",
      "1.1.1.1",
      "193.0.6.139",
      "172.15.255.255",
      "172.32.0.1",
      "100.63.255.255",
      "100.128.0.1",
      "2606:4700:4700::1111",
      "2a00:1450:4009:80f::200e",
    ]) {
      const parsed = parseIpAddress(address);
      expect(parsed.ok, address).toBe(true);
      if (parsed.ok) expect(blockedIpReason(parsed.value), address).toBeNull();
      expect(normalisePublicIp(address).ok, address).toBe(true);
    }
  });

  it("checks the boundaries of 172.16.0.0/12 rather than the whole of 172/8", () => {
    // The classic off-by-one: 172.15 and 172.32 are public, 172.16 and 172.31 are not.
    expect(normalisePublicIp("172.15.0.1").ok).toBe(true);
    expect(normalisePublicIp("172.16.0.0").ok).toBe(false);
    expect(normalisePublicIp("172.31.255.255").ok).toBe(false);
    expect(normalisePublicIp("172.32.0.0").ok).toBe(true);
  });
});

describe("normaliseNetworkTarget", () => {
  it("routes a private address to the IP explanation, not the hostname one", () => {
    const result = normaliseNetworkTarget("192.168.0.1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/RFC 1918/);
  });

  it("routes a name to the hostname rules", () => {
    const result = normaliseNetworkTarget("example.com");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("hostname");
      expect(result.value.kind === "hostname" ? result.value.value : null).toBe("example.com");
    }
  });
});

describe("URL normalisation for the archive lookup", () => {
  it("accepts a bare host and defaults it to https", () => {
    const result = normaliseLookupUrl("example.com/news");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.href).toBe("https://example.com/news");
  });

  it("keeps the query string, because two captures of the same path can differ by it", () => {
    const result = normaliseLookupUrl("https://example.com/search?q=cats");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.href).toBe("https://example.com/search?q=cats");
  });

  it("drops the fragment, which is never sent to a server and is never archived", () => {
    const result = normaliseLookupUrl("https://example.com/a#section");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.href).toBe("https://example.com/a");
  });

  it("refuses non-web schemes", () => {
    for (const input of [
      "file:///etc/passwd",
      "gopher://example.com/",
      "ftp://example.com/",
      "javascript:alert(1)",
      "data:text/html,<b>x</b>",
    ]) {
      expect(normaliseLookupUrl(input).ok, input).toBe(false);
    }
  });

  it("refuses credentials in the URL, the classic host-disguise", () => {
    const result = normaliseLookupUrl("https://web.archive.org@169.254.169.254/latest/meta-data/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/credentials|metadata/i);
  });

  it("refuses an explicit port", () => {
    expect(normaliseLookupUrl("https://example.com:8080/").ok).toBe(false);
  });

  it("refuses a private or loopback host inside the URL", () => {
    for (const input of [
      "http://127.0.0.1/admin",
      "http://localhost:80/",
      "http://10.0.0.5/",
      "http://[::1]/",
      "http://169.254.169.254/latest/meta-data/iam/",
      "http://2130706433/",
    ]) {
      expect(normaliseLookupUrl(input).ok, input).toBe(false);
    }
  });
});

describe("upstream host pinning", () => {
  it("requires exact host equality over https", () => {
    expect(isPinnedHost("https://web.archive.org/web/2020id_/http://x.com/", "web.archive.org")).toBe(true);
    expect(isPinnedHost("https://WEB.ARCHIVE.ORG/web/", "web.archive.org")).toBe(true);
  });

  it("refuses the suffix and prefix tricks a naive endsWith check accepts", () => {
    for (const url of [
      "https://evil-web.archive.org.attacker.example/",
      "https://webarchive.org/",
      "https://web.archive.org.attacker.example/",
      "https://attacker.example/web.archive.org/",
      "http://web.archive.org/",
      "https://web.archive.org:8443/",
      "https://user@web.archive.org/",
      "not a url",
    ]) {
      expect(isPinnedHost(url, "web.archive.org"), url).toBe(false);
    }
  });

  it("reads the host out of a connector base URL", () => {
    expect(connectorHost("https://stat.ripe.net")).toBe("stat.ripe.net");
    expect(connectorHost("https://crt.sh/")).toBe("crt.sh");
  });
});
