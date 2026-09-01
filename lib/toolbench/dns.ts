import { z } from "zod";

/**
 * DNS-over-HTTPS answers, decoded.
 *
 * The wire format is not involved anywhere in this product: DoH's JSON mode is a plain
 * HTTPS GET returning a JSON object, so no privileged socket, no UDP, no DNS library and no
 * partially-parsed binary from a stranger. What arrives is a small object whose `data` field
 * is the record's *presentation form* — the text you would see in a zone file — and this
 * module turns those strings into typed records.
 *
 * The JSON DoH format has no RFC. Cloudflare's own documentation says so, and says it
 * follows Google's schema; both are checked here because a field that is optional on one and
 * present on the other is exactly what a schema is for. Everything in this module is pure —
 * the HTTP call lives in `lib/connectors/dns.ts`.
 */

/* ------------------------------------------------------------------ *
 * Record types
 * ------------------------------------------------------------------ */

export const RECORD_TYPES = ["A", "AAAA", "MX", "NS", "TXT", "CAA"] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

/** Numeric RR type codes, so a response can be matched to the question that produced it. */
export const RECORD_TYPE_CODES: Readonly<Record<RecordType | "CNAME" | "SOA", number>> = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  CAA: 257,
};

/** What each record is for, in one sentence, rendered next to its results. */
export const RECORD_TYPE_PURPOSE: Readonly<Record<RecordType, string>> = {
  A: "IPv4 addresses the name points at. This is what a browser resolves before connecting.",
  AAAA: "IPv6 addresses. A domain with no AAAA record is IPv4-only, which is itself a fact about its hosting.",
  MX: "Where mail for this domain is delivered. The mail host is frequently operated by somebody other than the web host.",
  NS: "The authoritative nameservers. A change of nameserver often marks a change of operator, and is one of the most useful dated facts in an infrastructure timeline.",
  TXT: "Free-form text. In practice: SPF and DMARC mail policy, DKIM keys, and verification tokens proving somebody controls the domain at a named service.",
  CAA: "Which certificate authorities are permitted to issue for this domain. Absence means any CA may issue.",
};

/* ------------------------------------------------------------------ *
 * The upstream shape
 * ------------------------------------------------------------------ */

const resourceRecordSchema = z
  .object({
    name: z.string(),
    type: z.number(),
    TTL: z.number().nullish(),
    data: z.string(),
  })
  .passthrough();

/**
 * `Status` is required: it is the DNS RCODE, and defaulting it would turn a SERVFAIL into a
 * confident "no records", which is the single worst thing this tool could do. An
 * investigator reading "no MX records" when the truth is "the resolver could not answer"
 * draws a conclusion about a domain from our bug.
 */
export const dohResponseSchema = z
  .object({
    Status: z.number(),
    TC: z.boolean().nullish(),
    RD: z.boolean().nullish(),
    RA: z.boolean().nullish(),
    AD: z.boolean().nullish(),
    CD: z.boolean().nullish(),
    Question: z.array(z.object({ name: z.string(), type: z.number() }).passthrough()).nullish(),
    Answer: z.array(resourceRecordSchema).nullish(),
    Authority: z.array(resourceRecordSchema).nullish(),
    Comment: z.union([z.string(), z.array(z.string())]).nullish(),
  })
  .passthrough();

export type DohResponse = z.infer<typeof dohResponseSchema>;

/* ------------------------------------------------------------------ *
 * RCODE
 * ------------------------------------------------------------------ */

export type Rcode = "NOERROR" | "FORMERR" | "SERVFAIL" | "NXDOMAIN" | "NOTIMP" | "REFUSED" | "OTHER";

export function rcodeName(status: number): Rcode {
  switch (status) {
    case 0:
      return "NOERROR";
    case 1:
      return "FORMERR";
    case 2:
      return "SERVFAIL";
    case 3:
      return "NXDOMAIN";
    case 4:
      return "NOTIMP";
    case 5:
      return "REFUSED";
    default:
      return "OTHER";
  }
}

/**
 * What an RCODE means for an investigation, which is not the same as what it means to a
 * protocol implementer. The distinction that matters over and over: **NXDOMAIN is a fact
 * about the domain; SERVFAIL is a fact about the lookup.**
 */
export function rcodeMeaning(status: number): string {
  switch (rcodeName(status)) {
    case "NOERROR":
      return "The name exists. An empty answer for this record type means the name exists but has no record of this type — which is a different finding from the name not existing.";
    case "NXDOMAIN":
      return "The name does not exist, authoritatively. Not “no records of this type” — no name at all.";
    case "SERVFAIL":
      return "The resolver could not complete the lookup. This is a fact about the lookup, not about the domain: it commonly means a broken DNSSEC chain or unreachable authoritative servers. Treat it as “unknown”, never as “no records”.";
    case "REFUSED":
      return "The resolver declined to answer. Nothing can be concluded about the domain from this.";
    case "FORMERR":
      return "The resolver rejected the query as malformed. That is our fault, not the domain's.";
    case "NOTIMP":
      return "The resolver does not implement this query. Nothing can be concluded about the domain.";
    default:
      return `The resolver returned response code ${status}, which this tool does not have a description for. Treat the result as unknown.`;
  }
}

/* ------------------------------------------------------------------ *
 * Record decoding
 * ------------------------------------------------------------------ */

export interface MxRecord {
  readonly preference: number;
  readonly exchange: string;
}

export interface CaaRecord {
  readonly flags: number;
  readonly tag: string;
  readonly value: string;
}

/** Strip the trailing root dot for display. `example.com.` and `example.com` are one name. */
export function stripRootDot(name: string): string {
  return name.replace(/\.$/, "").toLowerCase();
}

/**
 * A TXT record is a sequence of character-strings, each at most 255 bytes, and the JSON DoH
 * format renders them as quoted strings separated by spaces. **They concatenate with no
 * separator** — a 400-byte DKIM key arrives as two quoted chunks and is one value, so
 * joining them with a space silently corrupts the key.
 */
export function decodeTxtData(data: string): string {
  const chunks = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) =>
    (match[1] ?? "").replace(/\\(.)/g, "$1"),
  );
  return chunks.length > 0 ? chunks.join("") : data.trim();
}

/** `10 mail.example.com.` → preference 10, exchange `mail.example.com`. */
export function decodeMxData(data: string): MxRecord | null {
  const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(data);
  if (!match) return null;
  const preference = Number(match[1]);
  const exchange = stripRootDot(match[2] ?? "");
  if (!Number.isFinite(preference)) return null;
  // A single "." exchange is RFC 7505's null MX: the domain accepts no mail, deliberately.
  return { preference, exchange: exchange === "" ? "." : exchange };
}

/** `0 issue "letsencrypt.org"` → flags 0, tag `issue`, value `letsencrypt.org`. */
export function decodeCaaData(data: string): CaaRecord | null {
  const match = /^\s*(\d+)\s+([a-z0-9]+)\s+"?((?:[^"\\]|\\.)*)"?\s*$/i.exec(data);
  if (!match) return null;
  const flags = Number(match[1]);
  if (!Number.isFinite(flags)) return null;
  return {
    flags,
    tag: (match[2] ?? "").toLowerCase(),
    value: (match[3] ?? "").replace(/\\(.)/g, "$1"),
  };
}

/**
 * What a TXT record is, where that can be told from its own text.
 *
 * Purely a reading aid. It reports the prefix the record declares about itself and claims
 * nothing beyond that — a record starting `v=spf1` says it is an SPF policy, and this
 * function repeats that rather than validating it.
 */
export function classifyTxt(value: string): string | null {
  const lower = value.toLowerCase();
  if (lower.startsWith("v=spf1")) return "SPF — which hosts may send mail as this domain";
  if (lower.startsWith("v=dmarc1")) return "DMARC — what receivers should do with mail that fails authentication";
  if (lower.startsWith("v=dkim1") || lower.includes("p=mig") || lower.startsWith("k=rsa")) {
    return "DKIM public key";
  }
  if (lower.startsWith("_domainkey")) return "DKIM selector";
  if (/^(google-site-verification|ms|facebook-domain-verification|apple-domain-verification|atlassian-domain-verification|docusign|adobe-idp-site-verification|stripe-verification|shopify|zoom|slack|openai-domain-verification|_?globalsign|amazonses|have-i-been-pwned-verification)[=-]/.test(lower)) {
    return "A verification token — somebody proved control of this domain at a named service. The service name is a lead in itself.";
  }
  if (lower.startsWith("mongodb-site-verification")) return "A verification token for a named service.";
  return null;
}

/* ------------------------------------------------------------------ *
 * One lookup, decoded
 * ------------------------------------------------------------------ */

export interface DnsAnswer {
  readonly name: string;
  readonly ttlSeconds: number | null;
  /** The record's presentation form, exactly as the resolver rendered it. */
  readonly raw: string;
  /** A decoded value where the type has structure, else the presentation form. */
  readonly value: string;
  readonly mx?: MxRecord;
  readonly caa?: CaaRecord;
  /** Set on a TXT record whose own text declares what it is. */
  readonly note?: string;
}

export interface DnsRecordSet {
  readonly type: RecordType;
  readonly rcode: Rcode;
  readonly rcodeStatus: number;
  /** True when the resolver validated the DNSSEC chain for this answer. */
  readonly dnssecValidated: boolean;
  /** True when the response was truncated; the answer may be incomplete. */
  readonly truncated: boolean;
  /** CNAMEs encountered on the way to the answer, in the order the resolver returned them. */
  readonly cnameChain: readonly string[];
  readonly answers: readonly DnsAnswer[];
  /** The resolver's own comment, when it sent one. Usually a DNSSEC explanation. */
  readonly comment: string | null;
}

/**
 * Decode one DoH response into a record set.
 *
 * The `Answer` array holds every record the resolver returned, which for an aliased name
 * includes the CNAME hops as well as the final records. Filtering by the requested type and
 * reporting the chain separately is the honest rendering: `www.example.com` having an A
 * record *through* a CNAME to a CDN is a materially different fact from it having one
 * directly, and it is the fact that tells you the IP belongs to the CDN and not the target.
 */
export function decodeRecordSet(type: RecordType, response: DohResponse): DnsRecordSet {
  const wanted = RECORD_TYPE_CODES[type];
  const all = response.Answer ?? [];

  const cnameChain = all
    .filter((record) => record.type === RECORD_TYPE_CODES.CNAME)
    .map((record) => stripRootDot(record.data));

  const answers: DnsAnswer[] = [];
  for (const record of all) {
    if (record.type !== wanted) continue;
    const base = {
      name: stripRootDot(record.name),
      ttlSeconds: typeof record.TTL === "number" ? record.TTL : null,
      raw: record.data,
    };

    if (type === "MX") {
      const mx = decodeMxData(record.data);
      answers.push(
        mx
          ? { ...base, value: mx.exchange === "." ? "(null MX — this domain accepts no mail)" : `${mx.preference} ${mx.exchange}`, mx }
          : { ...base, value: record.data },
      );
      continue;
    }
    if (type === "CAA") {
      const caa = decodeCaaData(record.data);
      answers.push(
        caa ? { ...base, value: `${caa.tag} ${caa.value}`, caa } : { ...base, value: record.data },
      );
      continue;
    }
    if (type === "TXT") {
      const value = decodeTxtData(record.data);
      const note = classifyTxt(value);
      answers.push(note === null ? { ...base, value } : { ...base, value, note });
      continue;
    }
    if (type === "NS") {
      answers.push({ ...base, value: stripRootDot(record.data) });
      continue;
    }
    answers.push({ ...base, value: record.data });
  }

  const comment = Array.isArray(response.Comment)
    ? response.Comment.join(" ")
    : (response.Comment ?? null);

  return {
    type,
    rcode: rcodeName(response.Status),
    rcodeStatus: response.Status,
    dnssecValidated: response.AD === true,
    truncated: response.TC === true,
    cnameChain,
    answers: sortAnswers(type, answers),
    comment: comment === null || comment.trim() === "" ? null : comment,
  };
}

/**
 * A stable order, so two lookups a week apart can be diffed by eye.
 *
 * Resolvers deliberately rotate the order of A records to spread load, so the order they
 * arrive in carries no information and preserving it would make every re-run look changed.
 * MX is the exception: preference order is meaningful and is preserved.
 */
function sortAnswers(type: RecordType, answers: readonly DnsAnswer[]): readonly DnsAnswer[] {
  if (type === "MX") {
    return [...answers].sort(
      (a, b) => (a.mx?.preference ?? 0) - (b.mx?.preference ?? 0) || a.value.localeCompare(b.value),
    );
  }
  return [...answers].sort((a, b) => a.value.localeCompare(b.value));
}

/** Every record set for one name, in the order the UI renders them. */
export interface DnsLookup {
  readonly name: string;
  readonly resolver: string;
  readonly records: readonly DnsRecordSet[];
}

/**
 * Does the name exist at all?
 *
 * NXDOMAIN on *any* record type is authoritative for the name, so one NXDOMAIN settles it
 * even when other queries returned NOERROR from a cache. A name where every query
 * SERVFAILed is `unknown`, and calling that "does not exist" would be a false negative on
 * the most consequential question the tool answers.
 */
export function nameExistence(lookup: DnsLookup): "exists" | "nxdomain" | "unknown" {
  if (lookup.records.some((set) => set.rcode === "NXDOMAIN")) return "nxdomain";
  if (lookup.records.some((set) => set.rcode === "NOERROR")) return "exists";
  return "unknown";
}

/** Every record set that came back empty, which the UI must show rather than omit. */
export function emptyRecordTypes(lookup: DnsLookup): readonly RecordType[] {
  return lookup.records
    .filter((set) => set.rcode === "NOERROR" && set.answers.length === 0)
    .map((set) => set.type);
}
