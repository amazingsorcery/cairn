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
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY DNS-OVER-HTTPS RATHER THAN A RESOLVER
 * ─────────────────────────────────────────────────────────────────────────────
 * A plain HTTPS GET returning JSON. No UDP socket, no DNS library parsing a binary message
 * from a stranger, no privileged port, and it works unchanged inside a container with no
 * outbound port 53. The attack surface of "parse a JSON object with four known fields" is
 * enormously smaller than that of a wire-format DNS parser.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT WAS CONFIRMED, AND HOW — 2026-09-01
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **Endpoint.** `https://cloudflare-dns.com/dns-query?name=<name>&type=<type>` with
 *    `Accept: application/dns-json`. Documented by Cloudflare at
 *    developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/.
 *    **The Accept header is not optional**: with `application/json` the endpoint answered 400
 *    on every request during verification. Exercised live for A, AAAA, MX, NS, TXT and CAA,
 *    and for a name that does not exist.
 *
 * 2. **No key, no registration, no published request limit.** 1.1.1.1 is a public resolver
 *    built for the whole internet's query volume; twelve back-to-back requests all returned
 *    200 in 17–195 ms. The connector's quota columns are ours, and they exist to bound *our*
 *    traffic rather than to approximate a limit they published.
 *
 * 3. **Terms.** Cloudflare's 1.1.1.1 terms-of-use page (last updated 2026-04-30) binds use of
 *    the resolver to the Cloudflare Website and Online Services Terms of Use, and asks ISPs
 *    and network-equipment providers that integrate 1.1.1.1 to attribute Cloudflare. We are
 *    neither, but attribution costs nothing and under-attributing does not, so it is rendered
 *    next to every result.
 *
 * 4. **robots.txt.** `https://cloudflare-dns.com/robots.txt` returns 200 with a file
 *    containing only comments and content-signal definitions — no `User-agent` and no
 *    `Disallow` lines at all. There is no crawl directive to respect or violate, and we are
 *    not crawling: we make one documented API request per record type.
 *
 * 5. **The JSON DoH format has no RFC**, which Cloudflare's own documentation states, and
 *    behaviour may differ between providers. `lib/toolbench/dns.ts` Zod-validates every
 *    response for that reason. Google Public DNS implements the same schema and is the
 *    documented fallback if this row is ever switched off; changing `base_url` on the
 *    registry row is enough, no deploy required.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SIX REQUESTS, ONE LOOKUP
 * ─────────────────────────────────────────────────────────────────────────────
 * One lookup is six upstream requests, issued in parallel — one per record type. They are
 * accounted as **one** call against the quota because they are one user action, and the
 * legal basis says so explicitly rather than leaving an operator to discover it from the
 * traffic. A record type that fails degrades to an `unknown` row in the table; only a total
 * failure fails the lookup.
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

  /** The cache key is the name the reader typed — a private query. See QV-02. */
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
            // A DoH answer is a few kilobytes. A megabyte would already be pathological.
            maxBytes: 1024 * 1024,
          });
          const parsed = dohResponseSchema.safeParse(decodeJson(response.text));
          if (!parsed.success) {
            return { set: unknownSet(type), status: 502 };
          }
          return { set: decodeRecordSet(type, parsed.data), status: response.status };
        } catch (error) {
          /**
           * A 429 must propagate: `runtime.ts` opens the per-connector cooldown on it, and
           * swallowing it here would leave us calling a resolver that asked us to stop.
           * Every other per-type failure degrades that one row.
           */
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

    // Every single type failed: that is the resolver being unreachable, not the domain
    // having no records, and the surface must say so.
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
    "page states that plainly. NOT A LEGAL OPINION - see docs/content/legal-review.md.",
  baseUrl: "https://cloudflare-dns.com",
  requiresApiKey: false,
  apiKeyEnvVar: null,
  perUserQuota: 10,
  globalCeiling: 20,
  windowSeconds: 60,
  timeoutMs: 8000,
  /**
   * 60s. Deliberately short: DNS is the one thing here that genuinely changes minute to
   * minute, and a stale answer to "what does this resolve to now" is a wrong answer rather
   * than an old one. The per-record TTL is displayed so a reader can see the resolver's own
   * freshness alongside ours.
   */
  cacheTtlSeconds: 60,
  staleWhileRevalidateSeconds: 300,
  enabled: false,
  status: "draft" as const,
  notes:
    "Verified 2026-09-01 against live requests for all six record types plus an NXDOMAIN. " +
    "The Accept header must be application/dns-json; application/json returns 400. Google " +
    "Public DNS implements the same schema at https://dns.google and is the documented " +
    "fallback - changing base_url is enough. See docs/sources/cloudflare-doh.md.",
};
