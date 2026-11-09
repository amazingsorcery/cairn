import { z } from "zod";

/**
 * Turns crt.sh's one-row-per-certificate output into one row per hostname with its
 * first-seen date. Pure; the HTTP call is in `lib/connectors/crtsh.ts`.
 */

/* ------------------------------------------------------------------ *
 * The upstream shape
 * ------------------------------------------------------------------ */

/**
 * crt.sh JSON row. Lenient (no published API contract); only `name_value` is required.
 *
 * Dates are zone-less UTC (`2017-07-26T11:06:02`), which `new Date()` would parse as local
 * time, so `toInstant` appends `Z`.
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
 * Is `name` the queried domain or a subdomain? crt.sh matches with `ILIKE`, so results also
 * include lookalikes (`notexample.com`, `example.com.attacker.example`); those are shown
 * separately rather than dropped.
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
 * Organisation from an X.500 issuer, e.g. `C=US, O=Let's Encrypt, CN=R11` -> `Let's Encrypt`.
 * Escaped commas aren't handled; the full issuer string is kept alongside.
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

/** Fold crt.sh rows into one entry per hostname, newest issued first, then alphabetical. */
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
      // Identity rows sometimes hold an email or IP; skip those.
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

/** Hostnames to resolve next, as a pasteable list. Wildcards are dropped (not resolvable). */
export function resolvableHostnames(summary: CertificateSummary): readonly string[] {
  return summary.hostnames.filter((entry) => !entry.wildcard).map((entry) => entry.name);
}
