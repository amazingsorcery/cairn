import { z } from "zod";

/**
 * Certificate transparency, turned from a list of certificates into a list of hostnames.
 *
 * crt.sh answers with one row per certificate. An investigator wants the opposite shape:
 * one row per *hostname*, with the date it first appeared in a public certificate — because
 * that date is when the infrastructure was stood up, and dating an operation is most of what
 * certificate transparency is good for.
 *
 * Everything in this module is pure. The HTTP call lives in `lib/connectors/crtsh.ts`.
 */

/* ------------------------------------------------------------------ *
 * The upstream shape
 * ------------------------------------------------------------------ */

/**
 * crt.sh's JSON row, validated at the boundary (product-brief §5).
 *
 * `.passthrough()` and the nullish optionals are deliberate: crt.sh is a free service run by
 * one CA with no published API contract, and an added field must not break us. Only
 * `name_value` is genuinely required — a row without it names no hostname and is the one
 * thing this tool cannot work around.
 *
 * DATES ARE NAIVE AND ARE UTC. crt.sh emits `2017-07-26T11:06:02` with no zone. Feeding that
 * to `new Date()` in a browser parses it as *local* time (ECMA-262 makes a date-time form
 * without an offset local), which would shift every first-seen date by the reader's offset
 * and, near midnight, by a day. `toInstant` appends the `Z`.
 */
export const crtShRowSchema = z
  .object({
    issuer_ca_id: z.number().nullish(),
    issuer_name: z.string().nullish(),
    common_name: z.string().nullish(),
    name_value: z.string(),
    id: z.number().nullish(),
    entry_timestamp: z.string().nullish(),
    not_before: z.string().nullish(),
    not_after: z.string().nullish(),
    serial_number: z.string().nullish(),
  })
  .passthrough();

export const crtShResponseSchema = z.array(crtShRowSchema);

export type CrtShRow = z.infer<typeof crtShRowSchema>;

/** Parse a crt.sh naive timestamp as UTC. Returns null for a missing or unparseable value. */
export function toInstant(value: string | null | undefined): Date | null {
  if (!value) return null;
  const normalised = /[Zz]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`;
  const parsed = new Date(normalised);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/* ------------------------------------------------------------------ *
 * Scope
 * ------------------------------------------------------------------ */

/**
 * Is `name` the queried domain or a subdomain of it?
 *
 * This matters more than it looks. crt.sh's identity search is a SQL `ILIKE`, so a query for
 * `example.com` also matches `example.com.attacker.example`, `notexample.com` and
 * `example.community`. Presenting those as "subdomains we found" would be wrong, and
 * silently dropping them would throw away the most interesting rows in the set — a
 * lookalike domain certificated by somebody else is a finding in an impersonation
 * investigation. So they are separated and both are shown, labelled.
 */
export function isWithinDomain(name: string, domain: string): boolean {
  const host = name.toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
  const base = domain.toLowerCase().replace(/\.$/, "");
  return host === base || host.endsWith(`.${base}`);
}

/** Split crt.sh's newline-delimited `name_value` into distinct lowercase names. */
export function splitNameValue(value: string): readonly string[] {
  return [
    ...new Set(
      value
        .split(/[\n\r]+/)
        .map((entry) => entry.trim().toLowerCase().replace(/\.$/, ""))
        .filter((entry) => entry.length > 0),
    ),
  ];
}

/**
 * Pull the organisation out of an X.500 issuer string, e.g.
 * `C=US, O=Let's Encrypt, CN=R11` → `Let's Encrypt`.
 *
 * Deliberately simple. An RDN value containing an escaped comma would be split wrongly here;
 * the consequence is a slightly truncated issuer label on a summary row, which is a cosmetic
 * defect rather than a wrong answer, and the full issuer string is kept alongside it.
 */
export function issuerOrganisation(issuerName: string | null | undefined): string | null {
  if (!issuerName) return null;
  const match = /(?:^|,)\s*O\s*=\s*([^,]+)/.exec(issuerName);
  return match?.[1]?.trim() ?? null;
}

/* ------------------------------------------------------------------ *
 * The summary
 * ------------------------------------------------------------------ */

export interface HostnameFinding {
  /** Lowercase, trailing dot stripped. A wildcard keeps its `*.` prefix. */
  readonly name: string;
  readonly wildcard: boolean;
  /** How many logged certificates covered this name. */
  readonly certificateCount: number;
  /** Earliest `not_before` across those certificates — when this name first appeared. */
  readonly firstSeen: string | null;
  /** Latest `not_before` — the most recent certificate issued for it. */
  readonly lastIssued: string | null;
  /** Latest `not_after` — when the last certificate covering it expires or expired. */
  readonly lastExpiry: string | null;
  /** True when at least one certificate covering this name is inside its validity window. */
  readonly currentlyValid: boolean;
}

export interface IssuerFinding {
  readonly name: string;
  readonly organisation: string | null;
  readonly certificateCount: number;
}

export interface CertificateSummary {
  readonly domain: string;
  /** Names at or under the queried domain, most recently issued first. */
  readonly hostnames: readonly HostnameFinding[];
  /** Names crt.sh matched that are NOT under the queried domain. Often the interesting ones. */
  readonly outOfScope: readonly HostnameFinding[];
  readonly issuers: readonly IssuerFinding[];
  readonly certificateCount: number;
  readonly firstSeen: string | null;
  readonly lastIssued: string | null;
  /** True when the connector stopped reading rows before the upstream stopped sending them. */
  readonly truncated: boolean;
}

interface Accumulator {
  count: number;
  firstSeen: number | null;
  lastIssued: number | null;
  lastExpiry: number | null;
  currentlyValid: boolean;
}

function fold(acc: Accumulator | undefined, row: CrtShRow, now: number): Accumulator {
  const current = acc ?? {
    count: 0,
    firstSeen: null,
    lastIssued: null,
    lastExpiry: null,
    currentlyValid: false,
  };
  const notBefore = toInstant(row.not_before)?.getTime() ?? null;
  const notAfter = toInstant(row.not_after)?.getTime() ?? null;

  current.count += 1;
  if (notBefore !== null) {
    current.firstSeen = current.firstSeen === null ? notBefore : Math.min(current.firstSeen, notBefore);
    current.lastIssued = current.lastIssued === null ? notBefore : Math.max(current.lastIssued, notBefore);
  }
  if (notAfter !== null) {
    current.lastExpiry = current.lastExpiry === null ? notAfter : Math.max(current.lastExpiry, notAfter);
  }
  if ((notBefore === null || notBefore <= now) && notAfter !== null && notAfter > now) {
    current.currentlyValid = true;
  }
  return current;
}

function toFinding(name: string, acc: Accumulator): HostnameFinding {
  const iso = (value: number | null): string | null =>
    value === null ? null : new Date(value).toISOString();
  return {
    name,
    wildcard: name.startsWith("*."),
    certificateCount: acc.count,
    firstSeen: iso(acc.firstSeen),
    lastIssued: iso(acc.lastIssued),
    lastExpiry: iso(acc.lastExpiry),
    currentlyValid: acc.currentlyValid,
  };
}

/**
 * Fold crt.sh rows into one entry per hostname.
 *
 * Sorted by most recently issued first, then alphabetically, so the newest infrastructure is
 * at the top — which is where an investigation usually starts — and the order is stable for
 * a snapshot pasted into notes.
 */
export function summariseCertificates(
  rows: readonly CrtShRow[],
  domain: string,
  options: { readonly now?: Date; readonly truncated?: boolean } = {},
): CertificateSummary {
  const now = (options.now ?? new Date()).getTime();
  const inScope = new Map<string, Accumulator>();
  const outOfScope = new Map<string, Accumulator>();
  const issuers = new Map<string, { organisation: string | null; count: number }>();

  let firstSeen: number | null = null;
  let lastIssued: number | null = null;

  for (const row of rows) {
    const names: string[] = [...splitNameValue(row.name_value)];
    // The common name is sometimes absent from the SAN list on very old certificates.
    if (row.common_name) {
      for (const extra of splitNameValue(row.common_name)) {
        if (!names.includes(extra)) names.push(extra);
      }
    }

    for (const name of names) {
      // crt.sh occasionally carries an email address or an IP in an identity row; neither is
      // a hostname and neither belongs in a subdomain list.
      if (name.includes("@") || name.includes(" ")) continue;
      const bucket = isWithinDomain(name, domain) ? inScope : outOfScope;
      bucket.set(name, fold(bucket.get(name), row, now));
    }

    const issuerName = row.issuer_name?.trim();
    if (issuerName) {
      const existing = issuers.get(issuerName);
      issuers.set(issuerName, {
        organisation: existing?.organisation ?? issuerOrganisation(issuerName),
        count: (existing?.count ?? 0) + 1,
      });
    }

    const notBefore = toInstant(row.not_before)?.getTime() ?? null;
    if (notBefore !== null) {
      firstSeen = firstSeen === null ? notBefore : Math.min(firstSeen, notBefore);
      lastIssued = lastIssued === null ? notBefore : Math.max(lastIssued, notBefore);
    }
  }

  const order = (a: HostnameFinding, b: HostnameFinding): number => {
    const at = a.lastIssued ?? "";
    const bt = b.lastIssued ?? "";
    if (at !== bt) return at < bt ? 1 : -1;
    return a.name.localeCompare(b.name);
  };

  const build = (map: Map<string, Accumulator>): HostnameFinding[] =>
    [...map.entries()].map(([name, acc]) => toFinding(name, acc)).sort(order);

  return {
    domain,
    hostnames: build(inScope),
    outOfScope: build(outOfScope),
    issuers: [...issuers.entries()]
      .map(([name, value]) => ({
        name,
        organisation: value.organisation,
        certificateCount: value.count,
      }))
      .sort((a, b) => b.certificateCount - a.certificateCount || a.name.localeCompare(b.name)),
    certificateCount: rows.length,
    firstSeen: firstSeen === null ? null : new Date(firstSeen).toISOString(),
    lastIssued: lastIssued === null ? null : new Date(lastIssued).toISOString(),
    truncated: options.truncated ?? false,
  };
}

/**
 * The hostnames worth resolving next, as a plain list a reader can paste into the DNS tool
 * or a passive-DNS source. Wildcards are dropped: `*.example.com` is not a name you can look
 * up, and including it in a list somebody feeds to a resolver produces a confusing failure.
 */
export function resolvableHostnames(summary: CertificateSummary): readonly string[] {
  return summary.hostnames.filter((entry) => !entry.wildcard).map((entry) => entry.name);
}
