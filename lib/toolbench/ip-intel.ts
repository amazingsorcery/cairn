import { z } from "zod";

/**
 * RIPEstat answers, combined into one view of an address.
 *
 * Four RIPEstat endpoints are read for each lookup, because no single one answers the
 * question an investigator is actually asking:
 *
 *   `prefix-overview`      which prefix contains this address, which AS announces it, and
 *                          which registry administers the containing IANA block.
 *   `routing-status`       when the prefix was first and last seen in BGP, how many of RIPE
 *                          RIS's collectors currently see it, and what more- and
 *                          less-specific routes exist.
 *   `rir-geo`              the country the Regional Internet Registry recorded for the
 *                          allocation. **A registry fact, not a measurement** — see the
 *                          limits section on the tool page.
 *   `abuse-contact-finder` the address a network's own registry data nominates for abuse
 *                          reports, which is the correct place to send one.
 *
 * Every part is independently optional. One endpoint failing degrades one section of the
 * result and says so; it does not fail the lookup, because three of four answers with an
 * honest gap is a better outcome than nothing.
 *
 * Everything here is pure. The HTTP calls live in `lib/connectors/ripestat.ts`.
 */

/* ------------------------------------------------------------------ *
 * The RIPEstat envelope
 * ------------------------------------------------------------------ */

/**
 * Every Data API response carries the same wrapper. `status` and `data_call_status` are the
 * two fields worth checking: `status` is `ok` / `error` / `maintenance`, and
 * `data_call_status` is `supported` / `deprecated` / `development`.
 *
 * The deprecation flag is read and surfaced rather than ignored. RIPEstat's own
 * documentation says in capitals to check it regularly, because a deprecated endpoint is
 * removed on a date they publish and our silence would become a dead panel.
 */
export function ripeEnvelope<T extends z.ZodTypeAny>(data: T) {
  return z
    .object({
      status: z.string(),
      status_code: z.number().nullish(),
      data_call_status: z.string().nullish(),
      data_call_name: z.string().nullish(),
      version: z.string().nullish(),
      cached: z.boolean().nullish(),
      messages: z.array(z.unknown()).nullish(),
      data,
    })
    .passthrough();
}

/* ------------------------------------------------------------------ *
 * prefix-overview
 * ------------------------------------------------------------------ */

export const prefixOverviewSchema = ripeEnvelope(
  z
    .object({
      resource: z.string().nullish(),
      announced: z.boolean().nullish(),
      is_less_specific: z.boolean().nullish(),
      asns: z
        .array(z.object({ asn: z.number(), holder: z.string().nullish() }).passthrough())
        .nullish(),
      related_prefixes: z.array(z.string()).nullish(),
      block: z
        .object({
          resource: z.string().nullish(),
          desc: z.string().nullish(),
          name: z.string().nullish(),
        })
        .passthrough()
        .nullish(),
      query_time: z.string().nullish(),
    })
    .passthrough(),
);

/* ------------------------------------------------------------------ *
 * routing-status
 * ------------------------------------------------------------------ */

const seenSchema = z
  .object({
    prefix: z.string().nullish(),
    origin: z.union([z.string(), z.number()]).nullish(),
    time: z.string().nullish(),
  })
  .passthrough();

export const routingStatusSchema = ripeEnvelope(
  z
    .object({
      first_seen: seenSchema.nullish(),
      last_seen: seenSchema.nullish(),
      visibility: z
        .object({
          v4: z
            .object({ ris_peers_seeing: z.number().nullish(), total_ris_peers: z.number().nullish() })
            .passthrough()
            .nullish(),
          v6: z
            .object({ ris_peers_seeing: z.number().nullish(), total_ris_peers: z.number().nullish() })
            .passthrough()
            .nullish(),
        })
        .passthrough()
        .nullish(),
      origins: z
        .array(
          z
            .object({ origin: z.union([z.string(), z.number()]), route_objects: z.array(z.string()).nullish() })
            .passthrough(),
        )
        .nullish(),
      less_specifics: z
        .array(z.object({ prefix: z.string(), origin: z.union([z.string(), z.number()]).nullish() }).passthrough())
        .nullish(),
      more_specifics: z
        .array(z.object({ prefix: z.string(), origin: z.union([z.string(), z.number()]).nullish() }).passthrough())
        .nullish(),
      resource: z.string().nullish(),
      query_time: z.string().nullish(),
    })
    .passthrough(),
);

/* ------------------------------------------------------------------ *
 * rir-geo
 * ------------------------------------------------------------------ */

export const rirGeoSchema = ripeEnvelope(
  z
    .object({
      located_resources: z
        .array(z.object({ resource: z.string().nullish(), location: z.string().nullish() }).passthrough())
        .nullish(),
      result_time: z.string().nullish(),
      latest_time: z.string().nullish(),
    })
    .passthrough(),
);

/* ------------------------------------------------------------------ *
 * abuse-contact-finder
 * ------------------------------------------------------------------ */

export const abuseContactSchema = ripeEnvelope(
  z
    .object({
      abuse_contacts: z.array(z.string()).nullish(),
      authoritative_rir: z.string().nullish(),
      latest_time: z.string().nullish(),
    })
    .passthrough(),
);

/* ------------------------------------------------------------------ *
 * The combined view
 * ------------------------------------------------------------------ */

export interface OriginAsn {
  readonly asn: number;
  readonly holder: string | null;
  /** Which internet routing registries hold a route object for this origin, if any. */
  readonly routeObjects: readonly string[];
}

export interface RoutingHistory {
  readonly firstSeenAt: string | null;
  readonly firstSeenOrigin: number | null;
  readonly lastSeenAt: string | null;
  readonly lastSeenOrigin: number | null;
  /** How many of RIPE RIS's collectors currently see this prefix, out of how many. */
  readonly peersSeeing: number | null;
  readonly totalPeers: number | null;
  readonly lessSpecifics: readonly { readonly prefix: string; readonly origin: number | null }[];
  readonly moreSpecifics: readonly { readonly prefix: string; readonly origin: number | null }[];
}

export interface IpIntelligence {
  /** The address as queried, after normalisation. */
  readonly resource: string;
  /** The covering prefix RIPEstat matched, or null when nothing covers the address. */
  readonly prefix: string | null;
  /** Whether the prefix is currently announced in BGP at all. */
  readonly announced: boolean | null;
  /**
   * True when RIPEstat had to widen the query to a less specific prefix to find a match —
   * meaning the exact address is inside an announced block rather than being announced.
   */
  readonly isLessSpecific: boolean | null;
  readonly origins: readonly OriginAsn[];
  /** The IANA block the address falls in, and which registry administers it. */
  readonly ianaBlock: { readonly resource: string; readonly name: string | null; readonly description: string | null } | null;
  readonly relatedPrefixes: readonly string[];
  /** ISO 3166-1 alpha-2, from the RIR's own allocation record. Not a measurement. */
  readonly registryCountry: string | null;
  readonly registryObservedAt: string | null;
  readonly routing: RoutingHistory | null;
  readonly abuseContacts: readonly string[];
  readonly authoritativeRir: string | null;
  /** The instant RIPEstat's own data was current for, when it told us. */
  readonly queryTime: string | null;
  /** Sections we could not fill, so the UI states the gap rather than showing an empty box. */
  readonly missing: readonly IpIntelSection[];
  /** Endpoints RIPEstat reported as deprecated. Rendered as an operator warning. */
  readonly deprecatedEndpoints: readonly string[];
}

export type IpIntelSection = "prefix" | "routing" | "geo" | "abuse";

export const SECTION_LABEL: Readonly<Record<IpIntelSection, string>> = {
  prefix: "network and origin AS",
  routing: "BGP routing history",
  geo: "registry country",
  abuse: "abuse contact",
};

export interface IpIntelParts {
  readonly resource: string;
  readonly prefixOverview: z.infer<typeof prefixOverviewSchema> | null;
  readonly routingStatus: z.infer<typeof routingStatusSchema> | null;
  readonly rirGeo: z.infer<typeof rirGeoSchema> | null;
  readonly abuseContact: z.infer<typeof abuseContactSchema> | null;
}

/** RIPEstat renders an ASN as a number in some fields and a string in others. */
function toAsn(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `ok` is the only status that means the payload is usable. */
function usable(envelope: { status: string } | null): boolean {
  return envelope !== null && envelope.status === "ok";
}

export function combineIpIntelligence(parts: IpIntelParts): IpIntelligence {
  const missing: IpIntelSection[] = [];
  const deprecated: string[] = [];

  const note = (
    envelope: { data_call_status?: string | null; data_call_name?: string | null } | null,
  ): void => {
    if (envelope?.data_call_status?.startsWith("deprecated") === true) {
      deprecated.push(envelope.data_call_name ?? "an endpoint");
    }
  };
  note(parts.prefixOverview);
  note(parts.routingStatus);
  note(parts.rirGeo);
  note(parts.abuseContact);

  /* prefix-overview -------------------------------------------------- */
  let prefix: string | null = null;
  let announced: boolean | null = null;
  let isLessSpecific: boolean | null = null;
  let relatedPrefixes: readonly string[] = [];
  let ianaBlock: IpIntelligence["ianaBlock"] = null;
  let queryTime: string | null = null;
  const holders = new Map<number, string | null>();

  if (usable(parts.prefixOverview) && parts.prefixOverview) {
    const data = parts.prefixOverview.data;
    prefix = data.resource ?? null;
    announced = data.announced ?? null;
    isLessSpecific = data.is_less_specific ?? null;
    relatedPrefixes = data.related_prefixes ?? [];
    queryTime = data.query_time ?? null;
    for (const entry of data.asns ?? []) holders.set(entry.asn, entry.holder?.trim() || null);
    if (data.block?.resource) {
      ianaBlock = {
        resource: data.block.resource,
        name: data.block.name ?? null,
        description: data.block.desc ?? null,
      };
    }
  } else {
    missing.push("prefix");
  }

  /* routing-status --------------------------------------------------- */
  let routing: RoutingHistory | null = null;
  const routeObjects = new Map<number, readonly string[]>();

  if (usable(parts.routingStatus) && parts.routingStatus) {
    const data = parts.routingStatus.data;
    for (const entry of data.origins ?? []) {
      const asn = toAsn(entry.origin);
      if (asn !== null) {
        routeObjects.set(asn, entry.route_objects ?? []);
        if (!holders.has(asn)) holders.set(asn, null);
      }
    }
    // The IPv4 and IPv6 visibility counters are mutually exclusive in practice: a v4 prefix
    // reports zeros under v6 and vice versa, so take whichever collector set saw anything.
    const v4 = data.visibility?.v4;
    const v6 = data.visibility?.v6;
    const seen = (v4?.ris_peers_seeing ?? 0) > 0 ? v4 : (v6?.ris_peers_seeing ?? 0) > 0 ? v6 : (v4 ?? v6);

    routing = {
      firstSeenAt: data.first_seen?.time ?? null,
      firstSeenOrigin: toAsn(data.first_seen?.origin),
      lastSeenAt: data.last_seen?.time ?? null,
      lastSeenOrigin: toAsn(data.last_seen?.origin),
      peersSeeing: seen?.ris_peers_seeing ?? null,
      totalPeers: seen?.total_ris_peers ?? null,
      lessSpecifics: (data.less_specifics ?? []).map((entry) => ({
        prefix: entry.prefix,
        origin: toAsn(entry.origin),
      })),
      moreSpecifics: (data.more_specifics ?? []).map((entry) => ({
        prefix: entry.prefix,
        origin: toAsn(entry.origin),
      })),
    };
    queryTime ??= data.query_time ?? null;
    prefix ??= data.resource ?? null;
  } else {
    missing.push("routing");
  }

  /* rir-geo ---------------------------------------------------------- */
  let registryCountry: string | null = null;
  let registryObservedAt: string | null = null;
  if (usable(parts.rirGeo) && parts.rirGeo) {
    const data = parts.rirGeo.data;
    const located = data.located_resources ?? [];
    registryCountry = located[0]?.location?.trim().toUpperCase() || null;
    registryObservedAt = data.result_time ?? data.latest_time ?? null;
  } else {
    missing.push("geo");
  }

  /* abuse-contact-finder --------------------------------------------- */
  let abuseContacts: readonly string[] = [];
  let authoritativeRir: string | null = null;
  if (usable(parts.abuseContact) && parts.abuseContact) {
    const data = parts.abuseContact.data;
    abuseContacts = (data.abuse_contacts ?? []).map((entry) => entry.trim()).filter((entry) => entry !== "");
    authoritativeRir = data.authoritative_rir?.trim().toUpperCase() || null;
  } else {
    missing.push("abuse");
  }

  const origins: OriginAsn[] = [...holders.entries()]
    .map(([asn, holder]) => ({ asn, holder, routeObjects: routeObjects.get(asn) ?? [] }))
    .sort((a, b) => a.asn - b.asn);

  return {
    resource: parts.resource,
    prefix,
    announced,
    isLessSpecific,
    origins,
    ianaBlock,
    relatedPrefixes,
    registryCountry,
    registryObservedAt,
    routing,
    abuseContacts,
    authoritativeRir,
    queryTime,
    missing,
    deprecatedEndpoints: [...new Set(deprecated)],
  };
}

/* ------------------------------------------------------------------ *
 * Reading the result
 * ------------------------------------------------------------------ */

/**
 * How thoroughly the prefix is propagated, in words.
 *
 * This is the number people misread most. RIPE RIS has a fixed set of collector peers; a
 * prefix seen by nearly all of them is globally routed, and one seen by a handful is either
 * newly announced, being withdrawn, or deliberately scoped — and telling those apart needs
 * the first-seen date next to it, which is why they are rendered together.
 */
export function visibilityAssessment(routing: RoutingHistory | null): string | null {
  if (!routing || routing.peersSeeing === null || routing.totalPeers === null || routing.totalPeers === 0) {
    return null;
  }
  const share = routing.peersSeeing / routing.totalPeers;
  if (share >= 0.9) {
    return "Seen by almost every RIPE RIS collector, which is what a normally propagated, globally routed prefix looks like.";
  }
  if (share >= 0.5) {
    return "Seen by most but not all collectors. Partial propagation is common during a change and is also what a regionally scoped announcement looks like.";
  }
  return "Seen by a minority of collectors. That is what a very new announcement, a withdrawal in progress, or a deliberately limited announcement looks like — check the first-seen date before reading anything into it.";
}

/**
 * A prefix announced by more than one AS.
 *
 * Worth flagging and worth not over-reading. Multi-origin announcements are routinely
 * legitimate — anycast, a customer announcing its own space alongside its provider, a
 * migration between providers — and are also what a route hijack looks like. The tool says
 * both.
 */
export function isMultiOrigin(intel: IpIntelligence): boolean {
  return intel.origins.length > 1;
}

/** Has the origin AS changed since the prefix was first seen? A dated fact for a timeline. */
export function originChanged(routing: RoutingHistory | null): boolean {
  if (!routing || routing.firstSeenOrigin === null || routing.lastSeenOrigin === null) return false;
  return routing.firstSeenOrigin !== routing.lastSeenOrigin;
}
