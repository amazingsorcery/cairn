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
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT WAS CONFIRMED, AND HOW — 2026-09-01
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **Endpoint.** `https://crt.sh/?q=<identity>&output=json`. The JSON, CSV and Atom output
 *    modes are linked from crt.sh's own results page (`json?q=`, `csv?q=`, `atom?q=`), which
 *    is how the service publishes them — there is no separate API document. Exercised live
 *    against `ripe.net`, `sectigo.com` and `bbc.co.uk`.
 *
 * 2. **`exclude=expired` is supported and matters enormously.** `sectigo.com` unfiltered took
 *    58 s and returned 1.35 MB; with `exclude=expired` it took 4 s and returned 287 kB. The
 *    tool defaults to excluding expired certificates and says so, because the alternative is
 *    a timeout the reader cannot diagnose.
 *
 * 3. **The identity search is a SQL `ILIKE`, not a suffix match.** `q=example.com` also
 *    returns `notexample.com` and `example.com.attacker.example`. `lib/toolbench/ct.ts`
 *    separates in-scope names from the rest rather than presenting all of them as subdomains.
 *
 * 4. **A 404 IS NOT AN EMPTY RESULT, and treating it as one was a real bug.** crt.sh answers
 *    an identity search that matched nothing with HTTP 404 — and it *also* answers 404 from
 *    its Apache front end when the query fails behind it. During verification a search for
 *    `ripe.net`, a domain with over four thousand logged certificates, returned 404 while the
 *    service was under load; the tool rendered "no logged certificates mention ripe.net",
 *    which is the exact false negative this product exists not to produce.
 *
 *    CONFIRMED BY MEASUREMENT, 2026-09-01 05:16: the identical query for `ripe.net` returned
 *    **404 in 2.6 s and then 502 within seconds**, and had returned 200 with 4,375 rows
 *    earlier the same hour. A 404 from this service is a failure mode, not a negative result,
 *    and nothing in the response distinguishes it from one that is.
 *
 *    So a 404 is now an upstream failure. The cost is a domain genuinely absent from the logs
 *    reading as "the source did not answer" rather than as "nothing found" — a wrong status,
 *    which the reader can retry and check. The alternative was a wrong finding, which they
 *    cannot. The empty-result path remains for a 200 carrying an empty array, which is the
 *    unambiguous form.
 *
 * 5. **502 is routine.** Ten consecutive requests during verification all returned 502 Bad
 *    Gateway, the first after a 60-second hang. crt.sh is a single free service under heavy
 *    load. The timeout is generous, the failure copy names overload specifically, and nothing
 *    retries — retrying into an overloaded service is how you become part of the problem.
 *
 * 6. **Terms: none are published, and that is recorded rather than smoothed over.** crt.sh
 *    carries no terms of service, no acceptable-use policy and no published rate limit;
 *    `https://crt.sh/robots.txt` returned 502 on every attempt on 2026-09-01, so no crawl
 *    directive could be read either way. The page footer reads "© Sectigo Limited 2015-2026.
 *    All rights reserved."
 *
 *    The underlying data is not Sectigo's: Certificate Transparency logs are public,
 *    append-only and designed to be read by anyone (RFC 6962), and the certificates in them
 *    are published by the CAs that issued them. What we consume from Sectigo is the *service*
 *    of having indexed them.
 *
 *    **This is the weakest legal basis of the four**, and the connector row therefore seeds
 *    disabled and draft like the rest, with the gap stated in `legal_basis` so an operator
 *    decides deliberately. `docs/sources/crt-sh.md` records the check and names
 *    SSLMate's Cert Spotter API — which publishes explicit terms and a free tier of 10
 *    full-domain queries an hour, at the cost of requiring a key — as the alternative if the
 *    absence of terms is judged unacceptable.
 *
 * NONE OF THIS IS A LEGAL OPINION. See `docs/content/legal-review.md`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const CRTSH_CONNECTOR_SLUG = "crt-sh";

/**
 * The most certificate rows we will read into memory for one lookup.
 *
 * `ripe.net` returns 4,375 rows even with expired certificates excluded, and a large hosting
 * provider's domain returns far more. The cap bounds the cache entry and the fold; the result
 * is marked `truncated` so the UI can say the list is incomplete instead of implying it is
 * the whole answer.
 */
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

  /**
   * The cache key, and the clamp. `normaliseHostname` is applied here as well as in the
   * Server Action, because this is the last point before a value reaches a query string and
   * "the action already checked" is exactly the assumption that stops being true after a
   * refactor.
   */
  normalise(raw: unknown): CrtShParams {
    const parsed = crtShParamsSchema.parse(raw);
    const domain = normaliseHostname(parsed.domain);
    if (!domain.ok) throw new Error("invalid domain");
    return { domain: domain.value, excludeExpired: parsed.excludeExpired };
  },

  cacheKey: (params) => `${params.domain}|${params.excludeExpired ? "unexpired" : "all"}`,

  async fetch(connector: Connector, params, signal) {
    const base = connector.baseUrl.replace(/\/+$/, "");
    const query = new URLSearchParams({ q: params.domain, output: "json" });
    if (params.excludeExpired) query.set("exclude", "expired");

    /**
     * NOTHING catches a 404 here, deliberately. See point 4 in the header: crt.sh returns
     * 404 both for a search that matched nothing and for a search that failed behind its
     * front end, and the two are indistinguishable from the response. Letting it degrade to
     * the honest "this source did not answer" state is the only safe reading — a reader who
     * sees that will retry, and a reader shown "no certificates" for a domain with four
     * thousand of them will publish it.
     */
    const response = await upstreamGet({
      url: `${base}/?${query.toString()}`,
      pinnedHost: connectorHost(connector.baseUrl),
      signal,
    });

    const parsed = crtShResponseSchema.safeParse(decodeJson(response.text));
    if (!parsed.success) {
      // A shape change disables this tool and nothing else. The parse error is not logged:
      // it would quote the upstream body, which contains the reader's query.
      throw new UpstreamStatusError(502);
    }

    const truncated = parsed.data.length > MAX_ROWS;
    return {
      data: summariseCertificates(parsed.data.slice(0, MAX_ROWS), params.domain, { truncated }),
      upstreamStatus: response.status,
    };
  },
};

/**
 * The registry row this driver expects.
 *
 * `enabled: false, status: "draft"` — ADR 0012 §1, fail closed. An operator reads the recorded
 * basis and turns it on. For this source in particular that review is not a formality: see
 * point 6 above.
 */
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
    "(10 full-domain queries/hour) but requires an API key. See docs/sources/crt-sh.md. " +
    "NOT A LEGAL OPINION - see docs/content/legal-review.md.",
  baseUrl: "https://crt.sh",
  requiresApiKey: false,
  apiKeyEnvVar: null,
  /**
   * Deliberately tight. One lookup is one upstream request, but that request can occupy
   * crt.sh for a minute, so the cost to them is measured in seconds of database time rather
   * than in request count. Five a minute across the whole site is a ceiling well inside
   * anything a single interactive user of crt.sh's own web form would generate.
   */
  perUserQuota: 3,
  globalCeiling: 5,
  windowSeconds: 60,
  /**
   * 25s. Longer than any other connector here, because crt.sh legitimately takes tens of
   * seconds on a large domain — and shorter than the 60s hang that precedes its 502, so a
   * reader gets "this source did not respond in time" rather than a minute of nothing.
   */
  timeoutMs: 25_000,
  /** CT logs are append-only and a new certificate is not urgent; 15 minutes is generous. */
  cacheTtlSeconds: 900,
  staleWhileRevalidateSeconds: 3600,
  enabled: false,
  status: "draft" as const,
  notes:
    "Endpoint and behaviour verified 2026-09-01 against live requests. NO TERMS ARE " +
    "PUBLISHED for crt.sh; read legal_basis in full before setting enabled = true. See " +
    "docs/sources/crt-sh.md.",
};
