import { describe, expect, it } from "vitest";

import fixtures from "./__fixtures__/ripestat.json";
import {
  abuseContactSchema,
  combineIpIntelligence,
  isMultiOrigin,
  originChanged,
  prefixOverviewSchema,
  rirGeoSchema,
  routingStatusSchema,
  visibilityAssessment,
  type IpIntelParts,
} from "./ip-intel";

/**
 * `__fixtures__/ripestat.json` holds real responses from the four RIPEstat Data API
 * endpoints this tool reads, captured 2026-09-01 for 8.8.8.8 (Google, IPv4),
 * 2001:4860:4860::8888 (Google, IPv6) and 193.0.6.139 (the RIPE NCC's own address).
 *
 * The third case is the interesting one for testing: it is a *less specific* match — the
 * address itself is not announced, the /21 containing it is — which is the distinction the
 * UI has to render correctly or a reader concludes the wrong thing about what is routed.
 */

type FixtureKey = keyof typeof fixtures;

function partsFor(key: FixtureKey, resource: string): IpIntelParts {
  const raw = fixtures[key];
  return {
    resource,
    prefixOverview: prefixOverviewSchema.parse(raw.prefixOverview),
    routingStatus: routingStatusSchema.parse(raw.routingStatus),
    rirGeo: rirGeoSchema.parse(raw.rirGeo),
    abuseContact: abuseContactSchema.parse(raw.abuseContact),
  };
}

describe("the upstream schemas", () => {
  it("parse every captured response", () => {
    for (const key of Object.keys(fixtures) as FixtureKey[]) {
      const raw = fixtures[key];
      expect(prefixOverviewSchema.safeParse(raw.prefixOverview).success, key).toBe(true);
      expect(routingStatusSchema.safeParse(raw.routingStatus).success, key).toBe(true);
      expect(rirGeoSchema.safeParse(raw.rirGeo).success, key).toBe(true);
      expect(abuseContactSchema.safeParse(raw.abuseContact).success, key).toBe(true);
    }
  });

  it("require the envelope's status, which is how an error response announces itself", () => {
    expect(prefixOverviewSchema.safeParse({ data: {} }).success).toBe(false);
    expect(prefixOverviewSchema.safeParse({ status: "ok", data: {} }).success).toBe(true);
  });

  it("accept an ASN as either a number or a string, because RIPEstat sends both", () => {
    // `prefix-overview` sends `asn: 15169`; `routing-status` sends `origin: "15169"`.
    const parsed = routingStatusSchema.parse({
      status: "ok",
      data: { origins: [{ origin: "64500" }], first_seen: { origin: 64500 } },
    });
    expect(parsed.data.origins?.[0]?.origin).toBe("64500");
  });
});

describe("combining the four endpoints", () => {
  it("reads Google's public resolver correctly", () => {
    const intel = combineIpIntelligence(partsFor("8.8.8.8", "8.8.8.8"));
    expect(intel.prefix).toBe("8.8.8.0/24");
    expect(intel.announced).toBe(true);
    expect(intel.origins).toHaveLength(1);
    expect(intel.origins[0]?.asn).toBe(15169);
    expect(intel.origins[0]?.holder).toMatch(/Google/);
    expect(intel.ianaBlock?.resource).toBe("8.0.0.0/8");
    expect(intel.registryCountry).toBe("US");
    expect(intel.abuseContacts).toContain("network-abuse@google.com");
    expect(intel.authoritativeRir).toBe("ARIN");
    expect(intel.missing).toEqual([]);
  });

  it("carries the origin AS's route objects from routing-status onto the origin", () => {
    const intel = combineIpIntelligence(partsFor("8.8.8.8", "8.8.8.8"));
    expect(intel.origins[0]?.routeObjects).toContain("RADB");
  });

  it("takes IPv6 visibility from the v6 counters, not the zeroed v4 ones", () => {
    // The bug this catches: reading `visibility.v4` unconditionally reports every IPv6
    // prefix as "seen by 0 of 0 collectors", which reads as "not routed".
    const intel = combineIpIntelligence(partsFor("2001-4860", "2001:4860:4860::8888"));
    expect(intel.routing?.peersSeeing).toBeGreaterThan(0);
    expect(intel.routing?.totalPeers).toBeGreaterThan(0);
    expect(intel.routing?.peersSeeing).toBe(intel.routing?.totalPeers);
  });

  it("reports a less-specific match as such", () => {
    // 193.0.6.139 is inside 193.0.0.0/21; the address itself is not separately announced.
    const intel = combineIpIntelligence(partsFor("193-0-6-139", "193.0.6.139"));
    expect(intel.isLessSpecific).toBe(true);
    expect(intel.prefix).toBe("193.0.0.0/21");
    expect(intel.origins[0]?.asn).toBe(3333);
    expect(intel.ianaBlock?.description).toMatch(/RIPE NCC/);
  });

  it("keeps more-specific routes, which are where a hijack or a sub-allocation shows up", () => {
    const intel = combineIpIntelligence(partsFor("2001-4860", "2001:4860:4860::8888"));
    expect((intel.routing?.moreSpecifics.length ?? 0)).toBeGreaterThan(0);
    for (const entry of intel.routing?.moreSpecifics ?? []) {
      expect(entry.prefix).toMatch(/^2001:4860:/);
      expect(typeof entry.origin === "number" || entry.origin === null).toBe(true);
    }
  });
});

describe("degrading when one endpoint fails", () => {
  const base = partsFor("8.8.8.8", "8.8.8.8");

  it("names the section it could not fill instead of showing an empty box", () => {
    const intel = combineIpIntelligence({ ...base, abuseContact: null });
    expect(intel.missing).toEqual(["abuse"]);
    expect(intel.abuseContacts).toEqual([]);
    // Everything else still arrived.
    expect(intel.prefix).toBe("8.8.8.0/24");
    expect(intel.registryCountry).toBe("US");
  });

  it("treats a non-ok envelope as missing rather than reading its empty data", () => {
    const errored = rirGeoSchema.parse({ status: "error", data: { located_resources: [] } });
    const intel = combineIpIntelligence({ ...base, rirGeo: errored });
    expect(intel.missing).toEqual(["geo"]);
    expect(intel.registryCountry).toBeNull();
  });

  it("flags an endpoint RIPEstat has marked deprecated", () => {
    const deprecated = rirGeoSchema.parse({
      status: "ok",
      data_call_status: "deprecated (removal 2027-01-01)",
      data_call_name: "rir-geo",
      data: { located_resources: [{ resource: "8.8.8.0/24", location: "US" }] },
    });
    const intel = combineIpIntelligence({ ...base, rirGeo: deprecated });
    expect(intel.deprecatedEndpoints).toEqual(["rir-geo"]);
    // Still usable — deprecated is a warning about the future, not a failure now.
    expect(intel.registryCountry).toBe("US");
  });

  it("survives every endpoint failing at once", () => {
    const intel = combineIpIntelligence({
      resource: "8.8.8.8",
      prefixOverview: null,
      routingStatus: null,
      rirGeo: null,
      abuseContact: null,
    });
    expect(intel.missing).toEqual(["prefix", "routing", "geo", "abuse"]);
    expect(intel.origins).toEqual([]);
    expect(intel.routing).toBeNull();
  });
});

describe("reading the routing result", () => {
  it("describes full propagation, partial propagation and near-invisibility differently", () => {
    const routing = (peersSeeing: number, totalPeers: number) => ({
      firstSeenAt: null,
      firstSeenOrigin: null,
      lastSeenAt: null,
      lastSeenOrigin: null,
      peersSeeing,
      totalPeers,
      lessSpecifics: [],
      moreSpecifics: [],
    });
    expect(visibilityAssessment(routing(111, 111))).toMatch(/globally routed/);
    expect(visibilityAssessment(routing(70, 111))).toMatch(/most but not all/);
    expect(visibilityAssessment(routing(4, 111))).toMatch(/minority/);
    expect(visibilityAssessment(routing(0, 0))).toBeNull();
    expect(visibilityAssessment(null)).toBeNull();
  });

  it("flags a multi-origin prefix without pronouncing on why", () => {
    const single = combineIpIntelligence(partsFor("8.8.8.8", "8.8.8.8"));
    expect(isMultiOrigin(single)).toBe(false);

    const multi = combineIpIntelligence({
      resource: "198.51.100.1",
      prefixOverview: prefixOverviewSchema.parse({
        status: "ok",
        data: {
          resource: "198.51.100.0/24",
          announced: true,
          asns: [
            { asn: 64500, holder: "EXAMPLE-ONE" },
            { asn: 64501, holder: "EXAMPLE-TWO" },
          ],
        },
      }),
      routingStatus: null,
      rirGeo: null,
      abuseContact: null,
    });
    expect(isMultiOrigin(multi)).toBe(true);
    expect(multi.origins.map((entry) => entry.asn)).toEqual([64500, 64501]);
  });

  it("detects that the origin AS changed between first and last sighting", () => {
    const changed = {
      firstSeenAt: "2002-11-06T16:00:00",
      firstSeenOrigin: 21284,
      lastSeenAt: "2026-09-01T00:00:00",
      lastSeenOrigin: 15169,
      peersSeeing: 111,
      totalPeers: 111,
      lessSpecifics: [],
      moreSpecifics: [],
    };
    expect(originChanged(changed)).toBe(true);
    expect(originChanged({ ...changed, firstSeenOrigin: 15169 })).toBe(false);
    expect(originChanged(null)).toBe(false);
  });

  it("finds the real origin change in the captured 8.8.8.0/24 history", () => {
    // RIPEstat's own data: first seen in 2002 originated by AS21284, last seen by AS15169.
    const intel = combineIpIntelligence(partsFor("8.8.8.8", "8.8.8.8"));
    expect(originChanged(intel.routing)).toBe(true);
    expect(intel.routing?.firstSeenAt).toMatch(/^2002-11-06/);
  });
});
