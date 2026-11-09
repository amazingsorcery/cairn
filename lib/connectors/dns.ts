import { z } from "zod";

import type { Connector } from "@/db/schema";
import {
  decodeRecordSet,
  dohResponseSchema,
  RECORD_TYPES,
  type DnsLookup,
  type DnsRecordSet,
} from "@/lib/toolbench/dns";
import { connectorHost, normaliseHostname } from "@/lib/toolbench/net-target";

import { UpstreamStatusError } from "./runtime";
import { decodeJson, upstreamGet } from "./toolbench";
import type { ConnectorDriver } from "./types";

/**
 * `/toolbench/dns-lookup` — A, AAAA, MX, NS, TXT and CAA over DNS-over-HTTPS.
 *
 * DoH (JSON over HTTPS) avoids a binary DNS parser and needs no outbound port 53.
 *
 * Notes (verified 2026-09-01):
 * - `GET /dns-query?name=&type=` requires `Accept: application/dns-json`; `application/json`
 *   returns 400.
 * - No key and no published rate limit; our quota columns bound our own traffic.
 * - Attribution is rendered next to results (terms only require it of ISPs, but it's free).
 * - JSON DoH has no RFC, so responses are Zod-validated. Google Public DNS uses the same
 *   schema; switching is a `base_url` change.
 *
 * One lookup = six parallel requests (one per type), counted as one quota call. A failed type
 * shows as `unknown`; only a total failure fails the lookup.
 */

export const DNS_CONNECTOR_SLUG = "cloudflare-doh";

export const dnsParamsSchema = z.object({ name: z.string() });

export type DnsParams = { name: string };

/** A record type that could not be queried at all. Rendered as "unknown", never as "none". */
const UNKNOWN_STATUS = -1;

export const dnsDriver: ConnectorDriver<DnsParams, DnsLookup> = {
  kind: "infrastructure",
  slug: DNS_CONNECTOR_SLUG,

  normalise(raw: unknown): DnsParams {
    const parsed = dnsParamsSchema.parse(raw);
    const name = normaliseHostname(parsed.name);
    if (!name.ok) throw new Error("invalid name");
    return { name: name.value };
  },

  /** The name the reader typed is a private query; quota is charged before cache reads. */
  cacheKey: (params) => params.name,

  async fetch(connector: Connector, params, signal) {
    const base = connector.baseUrl.replace(/\/+$/, "");
    const pinnedHost = connectorHost(connector.baseUrl);

    const results = await Promise.all(
      RECORD_TYPES.map(async (type): Promise<{ set: DnsRecordSet; status: number | null }> => {
        const query = new URLSearchParams({ name: params.name, type });
        try {
          const response = await upstreamGet({
            url: `${base}/dns-query?${query.toString()}`,
            pinnedHost,
            signal,
            // Cloudflare answers 400 to anything else. Verified 2026-09-01.
            accept: "application/dns-json",
            // A DoH answer is a few KB.
            maxBytes: 1024 * 1024,
          });
          const parsed = dohResponseSchema.safeParse(decodeJson(response.text));
          if (!parsed.success) {
            return { set: unknownSet(type), status: 502 };
          }
          return { set: decodeRecordSet(type, parsed.data), status: response.status };
        } catch (error) {
          // Rate limits must propagate so `runtime.ts` opens the cooldown; other failures
          // degrade just this row.
          if (error instanceof UpstreamStatusError && (error.status === 429 || error.status === 420)) {
            throw error;
          }
          if (signal.aborted) throw error;
          return {
            set: unknownSet(type),
            status: error instanceof UpstreamStatusError ? error.status : null,
          };
        }
      }),
    );

    // All types failed: the resolver is unreachable, not "no records".
    if (results.every((result) => result.set.rcodeStatus === UNKNOWN_STATUS)) {
      throw new UpstreamStatusError(results[0]?.status ?? 502);
    }

    return {
      data: {
        name: params.name,
        resolver: connector.name,
        records: results.map((result) => result.set),
      },
      upstreamStatus: results.find((result) => result.status !== null)?.status ?? 200,
    };
  },
};

function unknownSet(type: (typeof RECORD_TYPES)[number]): DnsRecordSet {
  return {
    type,
    rcode: "OTHER",
    rcodeStatus: UNKNOWN_STATUS,
    dnssecValidated: false,
    truncated: false,
    cnameChain: [],
    answers: [],
    comment: "The resolver did not answer this query. Treat this row as unknown, not as “no records”.",
  };
}

export const DNS_CONNECTOR_SEED = {
  slug: DNS_CONNECTOR_SLUG,
  name: "Cloudflare 1.1.1.1 (DNS over HTTPS)",
  kind: "infrastructure" as const,
  operatorName: "Cloudflare, Inc.",
  homepageUrl: "https://developers.cloudflare.com/1.1.1.1/",
  termsUrl: "https://developers.cloudflare.com/1.1.1.1/terms-of-use/",
  attribution: "DNS answers resolved by Cloudflare's 1.1.1.1 public resolver.",
  attributionRequired: true,
  legalBasis:
    "Cloudflare's 1.1.1.1 terms-of-use page (read 2026-09-01, last updated 2026-04-30) binds " +
    "use of the public resolver to the Cloudflare Website and Online Services Terms of Use, " +
    "and asks ISPs and network-equipment providers integrating 1.1.1.1 to attribute " +
    "Cloudflare. We are neither, but attribution is recorded as required and rendered next to " +
    "every result, because over-attributing costs nothing. The JSON DoH interface is " +
    "documented publicly, needs no key and no registration. " +
    "robots.txt at cloudflare-dns.com returns 200 with a file containing only comments and " +
    "content-signal definitions - no User-agent and no Disallow directives - so there is no " +
    "crawl directive being circumvented, and we crawl nothing: one documented API request per " +
    "record type. " +
    "RATE: Cloudflare publishes no numeric limit for the public resolver, which is built for " +
    "internet-scale query volume; 12 consecutive requests during verification all returned 200 " +
    "in 17-195ms. THE COLUMNS HERE ARE OURS AND BOUND OUR OWN TRAFFIC, not a limit they " +
    "stated. NOTE FOR OPERATORS: one lookup issues SIX upstream requests in parallel, one per " +
    "record type, accounted as one call against these quotas - so a global ceiling of 20 is up " +
    "to 120 requests a minute. A 429 or 420 opens the per-connector cooldown and we stop. " +
    "PRIVACY: the resolver is queried from our server, never the reader's browser, so the " +
    "reader's IP never reaches Cloudflare - but the NAME they asked about does, and the tool " +
    "page states that plainly. NOT A LEGAL OPINION.",
  baseUrl: "https://cloudflare-dns.com",
  requiresApiKey: false,
  apiKeyEnvVar: null,
  perUserQuota: 10,
  globalCeiling: 20,
  windowSeconds: 60,
  timeoutMs: 8000,
  /** Short: a stale DNS answer is a wrong answer. Per-record TTLs are displayed too. */
  cacheTtlSeconds: 60,
  staleWhileRevalidateSeconds: 300,
  enabled: false,
  status: "draft" as const,
  notes:
    "Verified 2026-09-01 against live requests for all six record types plus an NXDOMAIN. " +
    "The Accept header must be application/dns-json; application/json returns 400. Google " +
    "Public DNS implements the same schema at https://dns.google and is the documented " +
    "fallback - changing base_url is enough.",
};
