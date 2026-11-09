import { z } from "zod";

import type { Connector } from "@/db/schema";
import {
  crtShResponseSchema,
  summariseCertificates,
  type CertificateSummary,
} from "@/lib/toolbench/ct";
import { normaliseHostname, connectorHost } from "@/lib/toolbench/net-target";

import { UpstreamStatusError } from "./runtime";
import { decodeJson, upstreamGet } from "./toolbench";
import type { ConnectorDriver } from "./types";

/**
 * `/toolbench/certificate-transparency` — subdomain discovery from public CT logs, via crt.sh.
 *
 * Notes (verified 2026-09-01):
 * - Endpoint `https://crt.sh/?q=<identity>&output=json`; output modes are only documented via
 *   links on the results page.
 * - `exclude=expired` cuts a large query from ~58s/1.35 MB to ~4s, so it's the default.
 * - The search is SQL `ILIKE`, not a suffix match; `lib/toolbench/ct.ts` separates in-scope
 *   names from lookalikes.
 * - A 404 is NOT an empty result: crt.sh also returns 404 when the backend query fails under
 *   load. We treat it as an upstream failure; only a 200 with `[]` means "nothing found".
 * - 502s are routine under load. Generous timeout, no retries.
 * - No published terms, AUP or rate limit; robots.txt returned 502. CT logs themselves are
 *   public (RFC 6962). Weakest basis of the Toolbench sources, so it seeds disabled; SSLMate's
 *   Cert Spotter API (explicit terms, needs a key) is the alternative.
 *
 * Not a legal opinion.
 */

export const CRTSH_CONNECTOR_SLUG = "crt-sh";

/** Max rows read per lookup (large domains return thousands). Result is marked `truncated`. */
const MAX_ROWS = 3000;

export const crtShParamsSchema = z.object({
  domain: z.string(),
  /** Default true. Unfiltered searches routinely take a minute and often time out. */
  excludeExpired: z.boolean().default(true),
});

export type CrtShParams = { domain: string; excludeExpired: boolean };

export const crtShDriver: ConnectorDriver<CrtShParams, CertificateSummary> = {
  kind: "infrastructure",
  slug: CRTSH_CONNECTOR_SLUG,

  /** Re-validates the hostname even though the Server Action does too; last stop before the URL. */
  normalise(raw: unknown): CrtShParams {
    const parsed = crtShParamsSchema.parse(raw);
    const domain = normaliseHostname(parsed.domain);
    if (!domain.ok) throw new Error("invalid domain");
    return { domain: domain.value, excludeExpired: parsed.excludeExpired };
  },

  /** The domain the reader typed is a private query; quota is charged before cache reads. */
  cacheKey: (params) => `${params.domain}|${params.excludeExpired ? "unexpired" : "all"}`,

  async fetch(connector: Connector, params, signal) {
    const base = connector.baseUrl.replace(/\/+$/, "");
    const query = new URLSearchParams({ q: params.domain, output: "json" });
    if (params.excludeExpired) query.set("exclude", "expired");

    // A 404 is not caught: it may be a backend failure, so it degrades to "unavailable".
    const response = await upstreamGet({
      url: `${base}/?${query.toString()}`,
      pinnedHost: connectorHost(connector.baseUrl),
      signal,
    });

    const parsed = crtShResponseSchema.safeParse(decodeJson(response.text));
    if (!parsed.success) {
      // Parse error isn't logged: it would quote the body, which contains the query.
      throw new UpstreamStatusError(502);
    }

    const truncated = parsed.data.length > MAX_ROWS;
    return {
      data: summariseCertificates(parsed.data.slice(0, MAX_ROWS), params.domain, { truncated }),
      upstreamStatus: response.status,
    };
  },
};

/** Registry row. Seeds disabled/draft; review the terms gap above before enabling. */
export const CRTSH_CONNECTOR_SEED = {
  slug: CRTSH_CONNECTOR_SLUG,
  name: "crt.sh",
  kind: "infrastructure" as const,
  operatorName: "Sectigo Limited",
  homepageUrl: "https://crt.sh/",
  termsUrl: "https://github.com/crtsh",
  attribution:
    "Certificate data via crt.sh, operated by Sectigo Limited, from public Certificate Transparency logs.",
  attributionRequired: true,
  legalBasis:
    "Certificate Transparency logs are public and append-only by design (RFC 6962); the " +
    "certificates in them are published by the CAs that issued them, and reading them " +
    "circumvents no access control. crt.sh is Sectigo's free public index over those logs, " +
    "and its JSON, CSV and Atom output modes are linked from its own results page, which is " +
    "how the service publishes them. " +
    "GAP, STATED PLAINLY: Sectigo publishes NO terms of service, NO acceptable-use policy " +
    "and NO rate limit for crt.sh, and crt.sh/robots.txt returned HTTP 502 on every attempt " +
    "on 2026-09-01, so no crawl directive could be read in either direction. The page footer " +
    "asserts '(c) Sectigo Limited 2015-2026. All rights reserved.' over the site. This is the " +
    "weakest recorded basis of the four Toolbench sources and an operator must decide it " +
    "deliberately before enabling this row. " +
    "RATE: no published limit, so the columns here are OURS, set conservatively, and are not " +
    "a rate anyone told us was permitted. Measured 2026-09-01: an unfiltered query took 58s " +
    "and returned 1.35 MB; the same query with exclude=expired took 4s; and a ten-request " +
    "burst returned HTTP 502 every time, the first after a 60s hang. The service is visibly " +
    "under load, so the tool defaults to exclude=expired, makes exactly one request per " +
    "lookup, never retries, and caches for 15 minutes across all readers. " +
    "ALTERNATIVE ON FILE: SSLMate's Cert Spotter API publishes explicit terms and a free tier " +
    "(10 full-domain queries/hour) but requires an API key. " +
    "NOT A LEGAL OPINION.",
  baseUrl: "https://crt.sh",
  requiresApiKey: false,
  apiKeyEnvVar: null,
  /** Tight: one request can occupy crt.sh's database for up to a minute. */
  perUserQuota: 3,
  globalCeiling: 5,
  windowSeconds: 60,
  /**
   * 40s: slow queries under load often complete in 25-40s. Still shorter than the ~60s hang
   * that precedes a 502. No retries.
   */
  timeoutMs: 40_000,
  /** CT logs are append-only and a new certificate is not urgent; 15 minutes is generous. */
  cacheTtlSeconds: 900,
  staleWhileRevalidateSeconds: 3600,
  enabled: false,
  status: "draft" as const,
  notes:
    "Endpoint and behaviour verified 2026-09-01 against live requests. NO TERMS ARE " +
    "PUBLISHED for crt.sh; read legal_basis in full before setting enabled = true.",
};
