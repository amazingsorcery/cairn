import { fail, ok, type ToolResult } from "./result";

/**
 * Validation and normalisation of user-supplied network targets. This is the SSRF boundary.
 *
 *  1. The main defence: connectors build URLs from the operator-controlled `baseUrl` and put
 *     user input in an encoded query parameter. Nothing calls `fetch(userSuppliedUrl)`. The
 *     Wayback snapshot fetch pins the host to `web.archive.org` and re-checks every redirect.
 *  2. Defence in depth (this file): reject private, special-use and malformed targets, with
 *     an explanation rather than an empty result.
 *
 * No DNS resolution here: we never connect to the user's host, and resolving would leak the
 * query.
 */

/* ------------------------------------------------------------------ *
 * Hostnames
 * ------------------------------------------------------------------ */

/** RFC 1035 label syntax, after IDNA conversion to ASCII. Underscores are not accepted. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Non-public names: `.local` (mDNS, RFC 6762), `.internal` (ICANN private-use) and RFC
 * 6761/8375 special-use names. Public sources can't answer these.
 */
const SPECIAL_USE_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "home.arpa",
  "onion",
  "invalid",
  "test",
  "example",
  "localdomain",
  "intranet",
  "lan",
  "corp",
  "private",
] as const;

/** The longest a wire-format domain name can be, in presentation form. */
const MAX_NAME_LENGTH = 253;

/**
 * IDNA conversion via the WHATWG host parser in `new URL()` (handles punycode and lowercasing).
 * Returns null when the host is rejected.
 */
function toAsciiHost(raw: string): string | null {
  try {
    // Dummy scheme to reach the host parser; never fetched.
    const url = new URL(`https://${raw}`);
    // Reject anything beyond the host (path, port, credentials, query).
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
    if (url.port !== "" || url.username !== "" || url.password !== "") return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Normalise a hostname a human typed into the ASCII form we may put in a query string.
 *
 * Accepts a unicode/IDN name and returns punycode. Rejects: IP literals (use the IP tool),
 * single-label names, special-use suffixes, numeric TLDs, and anything with a scheme, a
 * port, a path or credentials attached.
 */
export function normaliseHostname(raw: string): ToolResult<string> {
  const trimmed = raw.trim().replace(/\.$/, "");
  if (trimmed.length === 0) return fail("Enter a domain name.");
  if (trimmed.includes("/") || trimmed.includes("@") || trimmed.includes(":")) {
    return fail(
      "Enter a bare domain name — no scheme, no path, no port and no credentials. For example: example.com",
    );
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    return fail(`A domain name cannot be longer than ${MAX_NAME_LENGTH} characters.`);
  }

  const ascii = toAsciiHost(trimmed);
  if (ascii === null) return fail("That is not a valid domain name.");

  // IP literals belong in the IP tool.
  if (ascii.startsWith("[") || parseIpAddress(ascii).ok) {
    return fail("That is an IP address. Use the IP intelligence tool for addresses.");
  }

  const labels = ascii.split(".");
  if (labels.length < 2) {
    return fail(
      "Enter a full domain name including its top-level domain, such as example.com. A single-label name is not a public domain.",
    );
  }
  for (const label of labels) {
    if (!LABEL.test(label)) {
      return fail(
        `"${label}" is not a valid label in a domain name. Labels are 1–63 characters of letters, digits and hyphens, and cannot start or end with a hyphen.`,
      );
    }
  }

  const tld = labels[labels.length - 1] ?? "";
  if (/^\d+$/.test(tld)) return fail("A top-level domain cannot be all digits.");
  if (tld.length < 2) return fail("A top-level domain is at least two characters.");

  for (const suffix of SPECIAL_USE_SUFFIXES) {
    if (ascii === suffix || ascii.endsWith(`.${suffix}`)) {
      return fail(
        `".${suffix}" is a special-use name that exists only inside a private network. Public certificate logs, public resolvers and routing registries have nothing to say about it.`,
      );
    }
  }

  return ok(ascii);
}

/* ------------------------------------------------------------------ *
 * IP addresses
 * ------------------------------------------------------------------ */

export type IpVersion = 4 | 6;

export interface ParsedIp {
  readonly version: IpVersion;
  /** Canonical text form. IPv6 is lowercased and left in the form the caller supplied. */
  readonly address: string;
  /** IPv4 octets, or the 16 bytes of an IPv6 address. */
  readonly bytes: readonly number[];
}

/**
 * Strict dotted-quad: four decimal octets, no leading zeros. Rejects `inet_aton` forms
 * (`2130706433`, `0x7f000001`, `0177.0.0.1`, `127.1`), which are classic filter bypasses.
 */
function parseIpv4(raw: string): readonly number[] | null {
  const parts = raw.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

/** RFC 4291 text form, including `::` compression and a trailing dotted-quad. */
function parseIpv6(raw: string): readonly number[] | null {
  const lower = raw.toLowerCase();
  if (!lower.includes(":")) return null;
  if ((lower.match(/::/g) ?? []).length > 1) return null;
  if (lower.includes(":::")) return null;
  // A zone index (`%eth0`) is a link-local scope, never a public address.
  if (lower.includes("%")) return null;

  const [headText = "", tailText] = lower.split("::");
  const expand = (text: string): (readonly number[] | null) => {
    if (text === "") return [];
    const out: number[] = [];
    const groups = text.split(":");
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index] ?? "";
      // A dotted quad is only legal as the final element.
      if (group.includes(".")) {
        if (index !== groups.length - 1) return null;
        const quad = parseIpv4(group);
        if (!quad) return null;
        out.push(...quad);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      const value = Number.parseInt(group, 16);
      out.push((value >> 8) & 0xff, value & 0xff);
    }
    return out;
  };

  const head = expand(headText);
  if (head === null) return null;

  if (tailText === undefined) return head.length === 16 ? head : null;

  const tail = expand(tailText);
  if (tail === null) return null;
  const gap = 16 - head.length - tail.length;
  if (gap < 1) return null;
  return [...head, ...new Array<number>(gap).fill(0), ...tail];
}

/** Parse an IPv4 or IPv6 literal. Brackets around an IPv6 address are accepted and stripped. */
export function parseIpAddress(raw: string): ToolResult<ParsedIp> {
  const trimmed = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (trimmed.length === 0) return fail("Enter an IP address.");

  const v4 = parseIpv4(trimmed);
  if (v4) return ok({ version: 4, address: v4.join("."), bytes: v4 });

  const v6 = parseIpv6(trimmed);
  if (v6) return ok({ version: 6, address: trimmed.toLowerCase(), bytes: v6 });

  return fail(
    "That is not an IP address. IPv4 is four decimal octets (198.51.100.7); IPv6 uses colons (2001:db8::1).",
  );
}

/**
 * Why an address isn't public, or null if it is. Covers the usual SSRF ranges plus 0.0.0.0/8,
 * CGNAT, and IPv4-embedding IPv6 forms (mapped, 6to4, Teredo). 169.254.169.254 (cloud
 * metadata) is in link-local but named explicitly for a clearer message.
 */
export function blockedIpReason(ip: ParsedIp): string | null {
  const b = ip.bytes;

  if (ip.version === 4) return blockedIpv4Reason(b);

  const hex = (index: number): number => b[index] ?? 0;

  // ::  and ::1
  if (b.slice(0, 15).every((byte) => byte === 0)) {
    if (hex(15) === 0) return ":: is the unspecified address, not a host.";
    if (hex(15) === 1) return "::1 is the IPv6 loopback address — this machine.";
  }
  // ::ffff:0:0/96 — an IPv4 address wearing an IPv6 costume.
  if (b.slice(0, 10).every((byte) => byte === 0) && hex(10) === 0xff && hex(11) === 0xff) {
    const inner = blockedIpv4Reason(b.slice(12));
    return (
      inner ??
      "That is an IPv4-mapped IPv6 address. Enter the IPv4 address itself so the result is unambiguous."
    );
  }
  // 64:ff9b::/96 — NAT64.
  if (hex(0) === 0x00 && hex(1) === 0x64 && hex(2) === 0xff && hex(3) === 0x9b) {
    return "64:ff9b::/96 is the NAT64 translation prefix; it carries an embedded IPv4 address rather than naming a host.";
  }
  // 2002::/16 — 6to4, and 2001::/32 — Teredo. Both embed an IPv4 address.
  if (hex(0) === 0x20 && hex(1) === 0x02) {
    return "2002::/16 is the 6to4 transition prefix, which embeds an IPv4 address rather than naming a host.";
  }
  if (hex(0) === 0x20 && hex(1) === 0x01 && hex(2) === 0x00 && hex(3) === 0x00) {
    return "2001::/32 is the Teredo tunnelling prefix, which embeds an IPv4 address rather than naming a host.";
  }
  // 2001:db8::/32 — documentation (RFC 3849).
  if (hex(0) === 0x20 && hex(1) === 0x01 && hex(2) === 0x0d && hex(3) === 0xb8) {
    return "2001:db8::/32 is reserved for documentation and examples. It is not routed.";
  }
  // 100::/64 — discard-only (RFC 6666).
  if (hex(0) === 0x01 && hex(1) === 0x00 && b.slice(2, 8).every((byte) => byte === 0)) {
    return "100::/64 is the discard-only prefix. Nothing is reachable there by design.";
  }
  // fc00::/7 — unique local.
  if ((hex(0) & 0xfe) === 0xfc) {
    return "fc00::/7 is unique-local address space — the IPv6 equivalent of a private network.";
  }
  // fe80::/10 — link-local.
  if (hex(0) === 0xfe && (hex(1) & 0xc0) === 0x80) {
    return "fe80::/10 is link-local address space, valid only on one network segment.";
  }
  // ff00::/8 — multicast.
  if (hex(0) === 0xff) return "ff00::/8 is multicast address space, not a single host.";

  return null;
}

function blockedIpv4Reason(bytes: readonly number[]): string | null {
  const [a = 0, b = 0, c = 0, d = 0] = bytes;

  if (a === 0) return "0.0.0.0/8 means “this network” and does not name a host.";
  if (a === 10) return "10.0.0.0/8 is private address space (RFC 1918).";
  if (a === 127) return "127.0.0.0/8 is loopback — it means this machine, whichever machine is asking.";
  if (a === 100 && b >= 64 && b <= 127) {
    return "100.64.0.0/10 is carrier-grade NAT space, shared inside an ISP and not globally routed.";
  }
  if (a === 169 && b === 254) {
    return c === 169 && d === 254
      ? "169.254.169.254 is the cloud instance-metadata endpoint. It is link-local, it means something different on every machine, and it is the classic target of a server-side request forgery."
      : "169.254.0.0/16 is link-local address space, valid only on one network segment.";
  }
  if (a === 172 && b >= 16 && b <= 31) return "172.16.0.0/12 is private address space (RFC 1918).";
  if (a === 192 && b === 168) return "192.168.0.0/16 is private address space (RFC 1918).";
  if (a === 192 && b === 0 && c === 0) return "192.0.0.0/24 is reserved for IETF protocol assignments.";
  if (a === 192 && b === 0 && c === 2) return "192.0.2.0/24 is reserved for documentation (RFC 5737). It is not routed.";
  if (a === 198 && (b === 18 || b === 19)) return "198.18.0.0/15 is reserved for network benchmarking.";
  if (a === 198 && b === 51 && c === 100) {
    return "198.51.100.0/24 is reserved for documentation (RFC 5737). It is not routed.";
  }
  if (a === 203 && b === 0 && c === 113) {
    return "203.0.113.0/24 is reserved for documentation (RFC 5737). It is not routed.";
  }
  if (a >= 224 && a <= 239) return "224.0.0.0/4 is multicast address space, not a single host.";
  if (a >= 240) return "240.0.0.0/4 is reserved and is not routed on the public internet.";

  return null;
}

/** Parse and reject in one step: a public, globally routable address, or a reason it is not. */
export function normalisePublicIp(raw: string): ToolResult<ParsedIp> {
  const parsed = parseIpAddress(raw);
  if (!parsed.ok) return parsed;
  const blocked = blockedIpReason(parsed.value);
  if (blocked !== null) return fail(blocked);
  return ok(parsed.value);
}

/**
 * A public hostname or public IP. IP is tried first so `127.0.0.1` gets "loopback" rather than
 * "invalid domain".
 */
export type NetworkTarget =
  | { readonly kind: "hostname"; readonly value: string }
  | { readonly kind: "ip"; readonly value: ParsedIp };

export function normaliseNetworkTarget(raw: string): ToolResult<NetworkTarget> {
  const trimmed = raw.trim();
  if (parseIpAddress(trimmed).ok || /^[0-9.]+$/.test(trimmed) || trimmed.includes(":")) {
    const ip = normalisePublicIp(trimmed);
    return ip.ok ? ok({ kind: "ip", value: ip.value }) : fail(ip.error);
  }
  const host = normaliseHostname(trimmed);
  return host.ok ? ok({ kind: "hostname", value: host.value }) : fail(host.error);
}

/* ------------------------------------------------------------------ *
 * URLs
 * ------------------------------------------------------------------ */

export interface NormalisedUrl {
  /** The URL, re-serialised from the parsed parts. Never the raw string the user typed. */
  readonly href: string;
  readonly hostname: string;
}

/**
 * A URL to look up in the archive. Never fetched; passed encoded as the CDX `url=` param.
 * Still narrowed so e.g. `file:` or credentialed private URLs get an explanation.
 */
export function normaliseLookupUrl(raw: string): ToolResult<NormalisedUrl> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fail("Enter a URL.");
  if (trimmed.length > 2000) return fail("That URL is too long to look up.");

  // A bare host is the common paste. Default to https rather than rejecting it.
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return fail("That is not a URL this tool can read.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return fail(
      `Only http and https URLs can be looked up. "${url.protocol.replace(":", "")}" is not a web scheme.`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    return fail(
      "Remove the credentials from the URL. A username or password before the @ is not part of an archived address, and it is a classic way of disguising which host a URL points at.",
    );
  }
  if (url.port !== "") {
    return fail(
      "Remove the port from the URL. Archived captures are indexed under the default port for the scheme.",
    );
  }

  const target = normaliseNetworkTarget(url.hostname);
  if (!target.ok) return fail(target.error);

  const hostname =
    target.value.kind === "hostname" ? target.value.value : target.value.value.address;
  url.hostname = hostname;
  url.hash = "";

  return ok({ href: url.toString(), hostname });
}

/* ------------------------------------------------------------------ *
 * Pinning our own upstreams
 * ------------------------------------------------------------------ */

/**
 * Assert a URL is on the intended host. Checked on the built URL and every Wayback redirect
 * hop (the archive redirects between snapshots, so redirects can't just be forbidden).
 * Exact host equality, not a suffix match.
 */
export function isPinnedHost(url: string, expectedHost: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    if (parsed.username !== "" || parsed.password !== "") return false;
    if (parsed.port !== "" && parsed.port !== "443") return false;
    return parsed.hostname.toLowerCase() === expectedHost.toLowerCase();
  } catch {
    return false;
  }
}

/** The hostname of a connector's `base_url`, for the pin check. Throws only on a bad row. */
export function connectorHost(baseUrl: string): string {
  return new URL(baseUrl).hostname.toLowerCase();
}
