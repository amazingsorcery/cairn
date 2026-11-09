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
 * Notes (verified 2026-09-01):
 * - Endpoints `/data/<name>/data.json?resource=<ip>`: prefix-overview, routing-status, rir-geo,
 *   abuse-contact-finder.
 * - `maxmind-geolite` is listed but returns 404, so country comes from `rir-geo`: what the
 *   registry recorded for the allocation, not a measured location.
 * - Usage rules: register if doing >1000 requests/day regularly (email stat@ripe.net if this
 *   is enabled and used); max 8 concurrent requests per IP. One lookup makes four.
 * - `sourceapp` identifies the product, nothing about the user.
 * - Terms Art. 3.3 forbids re-packaging/redistributing data and commercial use without
 *   permission. Our (non-legal) reading is that showing one reader their own lookup is use,
 *   not redistribution; get written confirmation from RIPE before enabling.
 * - robots.txt has only `Sitemap:` lines.
 *
 * Not a legal opinion.
 */

export const RIPESTAT_CONNECTOR_SLUG = "ripestat";

export const ripeStatParamsSchema = z.object({ resource: z.string() });

export type RipeStatParams = { resource: string };

/** RIPEstat `sourceapp` id: [A-Za-z0-9_-] only, derived from `config/brand.ts`. */
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

  /** The address the reader typed is a private query; quota is charged before cache reads. */
  cacheKey: (params) => params.resource,

  async fetch(connector: Connector, params, signal) {
    const base = connector.baseUrl.replace(/\/+$/, "");
    const pinnedHost = connectorHost(connector.baseUrl);

    // Four parallel calls (limit is eight). A failed one leaves its section null; only a
    // total failure fails the lookup.
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
        // Rate limits propagate so `runtime.ts` opens the cooldown.
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
    "circumvented. NOT A LEGAL OPINION.",
  baseUrl: "https://stat.ripe.net",
  requiresApiKey: false,
  apiKeyEnvVar: null,
  perUserQuota: 3,
  globalCeiling: 6,
  windowSeconds: 60,
  /** 10s aborted some cold first requests (four in parallel, ~2s cold each). */
  timeoutMs: 15_000,
  /** Upstream data refreshes hourly, so a shorter TTL buys nothing. */
  cacheTtlSeconds: 900,
  staleWhileRevalidateSeconds: 3600,
  enabled: false,
  status: "draft" as const,
  notes:
    "Four endpoints verified live 2026-09-01: prefix-overview, routing-status, rir-geo, " +
    "abuse-contact-finder. maxmind-geolite is still listed in their index but returns 404, so " +
    "geolocation is REGISTRY country from rir-geo, not a measurement. Read Art. 3.3 of the " +
    "terms in legal_basis before setting enabled = true.",
};
