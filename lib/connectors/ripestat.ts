import { z } from "zod";

import brand from "@/config/brand";
import type { Connector } from "@/db/schema";
import {
  abuseContactSchema,
  combineIpIntelligence,
  prefixOverviewSchema,
  rirGeoSchema,
  routingStatusSchema,
  type IpIntelligence,
} from "@/lib/toolbench/ip-intel";
import { connectorHost, normalisePublicIp } from "@/lib/toolbench/net-target";

import { UpstreamStatusError } from "./runtime";
import { decodeJson, upstreamGet } from "./toolbench";
import type { ConnectorDriver } from "./types";

/**
 * `/toolbench/ip-intelligence` — ASN, netblock, registry country and BGP status, via RIPEstat.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT WAS CONFIRMED, AND HOW — 2026-09-01
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **Endpoints.** `https://stat.ripe.net/data/<endpoint>/data.json?resource=<ip>`, the form
 *    documented in "About the Data API". Four are used: `prefix-overview`, `routing-status`,
 *    `rir-geo` and `abuse-contact-finder`. All four exercised live for an IPv4 address, an
 *    IPv6 address and an address whose covering prefix is less specific than itself.
 *
 * 2. **`maxmind-geolite` is gone.** It is still listed in the endpoint index but returned
 *    HTTP 404 with an empty `data` object on 2026-09-01. Geolocation therefore comes from
 *    `rir-geo`, which reports the country **the Regional Internet Registry recorded for the
 *    allocation** — a registry fact, not a measurement. That distinction is not a footnote
 *    and the tool page leads with it. A commercial geolocation database would also have meant
 *    a MaxMind attribution obligation we would have had to carry separately.
 *
 * 3. **Rules of usage, quoted from their own documentation.** "No limit on the amount of
 *    requests but please register if you plan to regularly do more than 1000 requests/day"
 *    and "the system limits the usage to 8 concurrent requests coming from one IP address".
 *    Both are respected: one lookup makes **four** requests in parallel, well inside the
 *    concurrency limit, and the ceiling below keeps a saturated day inside the registration
 *    threshold. **If this row is enabled and used regularly, an operator must email
 *    stat@ripe.net** — this is a documented obligation, not a courtesy.
 *
 * 4. **`sourceapp` is sent.** RIPEstat asks regular users to identify themselves with it so
 *    they can help when something breaks. It carries the product name and nothing about the
 *    person querying.
 *
 * 5. **Terms — and the one clause an operator must read before enabling this.** The RIPEstat
 *    Service Terms and Conditions make the service available "for purposes such as network
 *    analysis, network monitoring and debugging and research" (Art. 3.1), which is precisely
 *    what this tool is for, and require attribution of the RIPE NCC when research results are
 *    published (Art. 3.2). But **Art. 3.3 states that a user "may not re-package, compile,
 *    re-distribute the RIPEstat Service and any (or all) of the RIPEstat Data", and forbids
 *    commercial use without written permission.**
 *
 *    Our reading is that answering one reader's own lookup and showing them the result, with
 *    attribution, is use of the service rather than redistribution of it — we hold nothing,
 *    publish no dataset, and offer no derived product. That reading is *ours*, it is not a
 *    legal opinion, and it is exactly the kind of judgement §2 criterion 2 requires to be
 *    recorded rather than assumed. The row seeds disabled and draft, and `legal_basis` says
 *    an operator should obtain written confirmation from stat@ripe.net before enabling it.
 *
 * 6. **robots.txt.** `https://stat.ripe.net/robots.txt` returns 200 and contains only
 *    `Sitemap:` lines — no `User-agent`, no `Disallow`. Nothing is being circumvented.
 *
 * NONE OF THIS IS A LEGAL OPINION. See `docs/content/legal-review.md`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const RIPESTAT_CONNECTOR_SLUG = "ripestat";

export const ripeStatParamsSchema = z.object({ resource: z.string() });

export type RipeStatParams = { resource: string };

/**
 * The identifier RIPEstat asks regular users to send. Alphanumerics, hyphens and underscores
 * only, per their documentation. Derived from `config/brand.ts` — never a hardcoded name.
 */
function sourceApp(): string {
  return `${brand.nameLower.replace(/[^a-z0-9_-]/gi, "")}-toolbench`;
}

export const ripeStatDriver: ConnectorDriver<RipeStatParams, IpIntelligence> = {
  kind: "infrastructure",
  slug: RIPESTAT_CONNECTOR_SLUG,

  normalise(raw: unknown): RipeStatParams {
    const parsed = ripeStatParamsSchema.parse(raw);
    const ip = normalisePublicIp(parsed.resource);
    if (!ip.ok) throw new Error("invalid address");
    return { resource: ip.value.address };
  },

  cacheKey: (params) => params.resource,

  async fetch(connector: Connector, params, signal) {
    const base = connector.baseUrl.replace(/\/+$/, "");
    const pinnedHost = connectorHost(connector.baseUrl);

    /**
     * One call per endpoint, in parallel — four, against RIPEstat's documented limit of eight
     * concurrent requests from one address. A failure in any one leaves that section null and
     * `combineIpIntelligence` names the gap; only a total failure fails the lookup.
     */
    const call = async <T extends z.ZodTypeAny>(
      endpoint: string,
      schema: T,
    ): Promise<z.infer<T> | null> => {
      const query = new URLSearchParams({ resource: params.resource, sourceapp: sourceApp() });
      try {
        const response = await upstreamGet({
          url: `${base}/data/${endpoint}/data.json?${query.toString()}`,
          pinnedHost,
          signal,
          maxBytes: 4 * 1024 * 1024,
        });
        const parsed = schema.safeParse(decodeJson(response.text));
        return parsed.success ? (parsed.data as z.infer<T>) : null;
      } catch (error) {
        // A rate-limit refusal must reach `runtime.ts` so the cooldown opens; everything
        // else degrades one section of the answer.
        if (error instanceof UpstreamStatusError && (error.status === 429 || error.status === 420)) {
          throw error;
        }
        if (signal.aborted) throw error;
        return null;
      }
    };

    const [prefixOverview, routingStatus, rirGeo, abuseContact] = await Promise.all([
      call("prefix-overview", prefixOverviewSchema),
      call("routing-status", routingStatusSchema),
      call("rir-geo", rirGeoSchema),
      call("abuse-contact-finder", abuseContactSchema),
    ]);

    if (!prefixOverview && !routingStatus && !rirGeo && !abuseContact) {
      // Not "this address has no data" — RIPEstat did not answer at all.
      throw new UpstreamStatusError(502);
    }

    return {
      data: combineIpIntelligence({
        resource: params.resource,
        prefixOverview,
        routingStatus,
        rirGeo,
        abuseContact,
      }),
      upstreamStatus: 200,
    };
  },
};

export const RIPESTAT_CONNECTOR_SEED = {
  slug: RIPESTAT_CONNECTOR_SLUG,
  name: "RIPEstat",
  kind: "infrastructure" as const,
  operatorName: "RIPE NCC (Réseaux IP Européens Network Coordination Centre)",
  homepageUrl: "https://stat.ripe.net/",
  termsUrl: "https://www.ripe.net/about-us/legal/ripestat-service-terms-and-conditions/",
  attribution:
    "Routing, allocation and abuse-contact data from RIPEstat, a service of the RIPE NCC.",
  attributionRequired: true,
  legalBasis:
    "RIPEstat Service Terms and Conditions (read 2026-09-01) Art. 3.1 make the service " +
    "available 'for purposes such as network analysis, network monitoring and debugging and " +
    "research', which is what this tool is for; Art. 3.2 requires attribution of the RIPE NCC " +
    "and of the underlying data source when research results are published, and attribution " +
    "is rendered next to every result. " +
    "THE CLAUSE AN OPERATOR MUST READ BEFORE ENABLING THIS ROW: Art. 3.3 says a user 'may not " +
    "re-package, compile, re-distribute the RIPEstat Service and any (or all) of the RIPEstat " +
    "Data', and forbids commercial use without written permission. OUR READING is that " +
    "answering one reader's own lookup and displaying the result with attribution is use of " +
    "the service rather than redistribution of it: we retain no dataset, publish no derived " +
    "product and charge nothing. THAT READING IS OURS AND IS NOT A LEGAL OPINION. Obtain " +
    "written confirmation from stat@ripe.net before enabling this row. " +
    "RATE, quoted from their Data API documentation: 'No limit on the amount of requests but " +
    "please register if you plan to regularly do more than 1000 requests/day', and 'the system " +
    "limits the usage to 8 concurrent requests coming from one IP address'. One lookup makes " +
    "FOUR requests in parallel - inside the concurrency limit - accounted as one call against " +
    "these quotas, so the global ceiling of 6/min is at most 24 upstream requests a minute. " +
    "REGISTRATION IS AN OBLIGATION, NOT A COURTESY: if this is enabled and used regularly, " +
    "email stat@ripe.net with the sourceapp identifier we already send. " +
    "robots.txt at stat.ripe.net contains only Sitemap lines, so no crawl directive is being " +
    "circumvented. NOT A LEGAL OPINION - see docs/content/legal-review.md.",
  baseUrl: "https://stat.ripe.net",
  requiresApiKey: false,
  apiKeyEnvVar: null,
  perUserQuota: 3,
  globalCeiling: 6,
  windowSeconds: 60,
  /**
   * 15s. A single call measured 35-150ms warm and 2.1s cold (TLS plus DNS), and one lookup
   * makes four in parallel; 10s proved tight enough to abort a cold first request during
   * verification, which is a failure caused by our own budget rather than by the source.
   */
  timeoutMs: 15_000,
  /**
   * 15 minutes. RIPEstat's own `query_time` on `prefix-overview` and `routing-status` moves
   * on the hour, so a shorter TTL would re-fetch the same numbers — the freshness we would
   * be buying does not exist upstream.
   */
  cacheTtlSeconds: 900,
  staleWhileRevalidateSeconds: 3600,
  enabled: false,
  status: "draft" as const,
  notes:
    "Four endpoints verified live 2026-09-01: prefix-overview, routing-status, rir-geo, " +
    "abuse-contact-finder. maxmind-geolite is still listed in their index but returns 404, so " +
    "geolocation is REGISTRY country from rir-geo, not a measurement. Read Art. 3.3 of the " +
    "terms in legal_basis before setting enabled = true. See docs/sources/ripestat.md.",
};
