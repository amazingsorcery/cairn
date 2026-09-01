import { describe, expect, it } from "vitest";

import fixture from "./__fixtures__/crtsh-ripe-net.json";
import {
  crtShResponseSchema,
  isWithinDomain,
  issuerOrganisation,
  resolvableHostnames,
  splitNameValue,
  summariseCertificates,
  toInstant,
  type CrtShRow,
} from "./ct";

/**
 * `__fixtures__/crtsh-ripe-net.json` is the first 25 rows of a real response from
 * `https://crt.sh/?q=ripe.net&output=json&exclude=expired`, captured 2026-09-01. Asserting
 * against a captured shape rather than a hand-written one is the point: it is what catches a
 * field being renamed or retyped upstream, which is the failure this schema exists for.
 */

describe("the upstream schema", () => {
  it("parses a real captured crt.sh response", () => {
    const parsed = crtShResponseSchema.safeParse(fixture);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toHaveLength(25);
  });

  it("accepts a row with fields we do not read, and rejects one with no name at all", () => {
    expect(crtShResponseSchema.safeParse([{ name_value: "a.example.com", brand_new: 7 }]).success).toBe(
      true,
    );
    // A row naming no hostname is the one thing the tool cannot work around.
    expect(crtShResponseSchema.safeParse([{ common_name: "a.example.com" }]).success).toBe(false);
    // Not an array at all — a shape change must degrade the tool, not be coerced.
    expect(crtShResponseSchema.safeParse({ rows: [] }).success).toBe(false);
  });
});

describe("crt.sh timestamps are UTC even though they carry no zone", () => {
  it("appends Z rather than letting the platform read them as local time", () => {
    // The bug this prevents: in a UTC+2 browser, `new Date("2017-07-26T11:06:02")` is
    // 09:06:02Z, shifting every first-seen date by the reader's offset.
    expect(toInstant("2017-07-26T11:06:02")?.toISOString()).toBe("2017-07-26T11:06:02.000Z");
    expect(toInstant("2026-07-04T16:20:43.634")?.toISOString()).toBe("2026-07-04T16:20:43.634Z");
  });

  it("leaves an explicit offset alone and refuses nonsense", () => {
    expect(toInstant("2020-01-01T00:00:00Z")?.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    expect(toInstant("not a date")).toBeNull();
    expect(toInstant(null)).toBeNull();
    expect(toInstant(undefined)).toBeNull();
  });
});

describe("scope: crt.sh matches by SQL ILIKE, so its results are wider than the domain", () => {
  it("counts the domain and its subdomains as in scope", () => {
    for (const name of ["example.com", "www.example.com", "a.b.example.com", "*.example.com", "EXAMPLE.COM"]) {
      expect(isWithinDomain(name, "example.com"), name).toBe(true);
    }
  });

  it("excludes the lookalikes an ILIKE search drags in", () => {
    // Each of these is returned by a crt.sh search for "example.com" and none of them is a
    // subdomain of it. Two are impersonation patterns worth showing separately.
    for (const name of [
      "example.com.attacker.example",
      "notexample.com",
      "example.community",
      "example.co",
      "myexample.com",
    ]) {
      expect(isWithinDomain(name, "example.com"), name).toBe(false);
    }
  });
});

describe("name and issuer parsing", () => {
  it("splits the newline-delimited SAN list and deduplicates it", () => {
    expect(splitNameValue("a.example.com\nb.example.com\na.example.com")).toEqual([
      "a.example.com",
      "b.example.com",
    ]);
    expect(splitNameValue("A.Example.com.\r\n *.example.com ")).toEqual([
      "a.example.com",
      "*.example.com",
    ]);
    expect(splitNameValue("   ")).toEqual([]);
  });

  it("reads the organisation out of an X.500 issuer string", () => {
    expect(issuerOrganisation("C=US, O=Let's Encrypt, CN=YR2")).toBe("Let's Encrypt");
    expect(issuerOrganisation("C=GB, O=Sectigo Limited, CN=Sectigo Public Server Authentication CA OV R36")).toBe(
      "Sectigo Limited",
    );
    expect(issuerOrganisation("CN=Some Internal CA")).toBeNull();
    expect(issuerOrganisation(null)).toBeNull();
  });
});

describe("summarising certificates into hostnames", () => {
  const now = new Date("2026-09-01T00:00:00Z");

  it("turns the captured response into one row per hostname", () => {
    const rows = crtShResponseSchema.parse(fixture);
    const summary = summariseCertificates(rows, "ripe.net", { now });

    expect(summary.certificateCount).toBe(25);
    // 21 distinct names appear across those 25 certificates, every one under ripe.net.
    expect(summary.hostnames).toHaveLength(21);
    expect(summary.outOfScope).toHaveLength(0);
    expect(summary.hostnames.map((entry) => entry.name)).toContain("sslvpn.ripe.net");

    // Both issuers in the capture are Let's Encrypt intermediates, and they are the only two.
    expect(summary.issuers.map((entry) => entry.organisation)).toEqual(["Let's Encrypt", "Let's Encrypt"]);
    expect(summary.issuers.reduce((total, entry) => total + entry.certificateCount, 0)).toBe(25);
  });

  it("collapses a multi-SAN certificate into one entry per name, each counting that certificate", () => {
    const rows: CrtShRow[] = [
      {
        name_value: "vpn.example.com\nvpn4.example.com\nvpn6.example.com",
        issuer_name: "C=US, O=Let's Encrypt, CN=R11",
        not_before: "2026-01-01T00:00:00",
        not_after: "2026-04-01T00:00:00",
      },
    ];
    const summary = summariseCertificates(rows, "example.com", { now });
    expect(summary.certificateCount).toBe(1);
    expect(summary.hostnames).toHaveLength(3);
    for (const entry of summary.hostnames) expect(entry.certificateCount).toBe(1);
  });

  it("takes first-seen from the earliest not_before and last-issued from the latest", () => {
    const rows: CrtShRow[] = [
      { name_value: "a.example.com", not_before: "2019-03-04T05:06:07", not_after: "2019-06-04T05:06:07" },
      { name_value: "a.example.com", not_before: "2026-08-01T00:00:00", not_after: "2026-11-01T00:00:00" },
      { name_value: "a.example.com", not_before: "2022-01-01T00:00:00", not_after: "2022-04-01T00:00:00" },
    ];
    const summary = summariseCertificates(rows, "example.com", { now });
    const [entry] = summary.hostnames;
    expect(entry?.firstSeen).toBe("2019-03-04T05:06:07.000Z");
    expect(entry?.lastIssued).toBe("2026-08-01T00:00:00.000Z");
    expect(entry?.lastExpiry).toBe("2026-11-01T00:00:00.000Z");
    expect(entry?.certificateCount).toBe(3);
    // One of the three covers 2026-09-01, so the name is currently certificated.
    expect(entry?.currentlyValid).toBe(true);
    expect(summary.firstSeen).toBe("2019-03-04T05:06:07.000Z");
  });

  it("reports a name whose certificates have all expired as not currently valid", () => {
    const rows: CrtShRow[] = [
      { name_value: "old.example.com", not_before: "2019-01-01T00:00:00", not_after: "2019-04-01T00:00:00" },
    ];
    const summary = summariseCertificates(rows, "example.com", { now });
    expect(summary.hostnames[0]?.currentlyValid).toBe(false);
  });

  it("separates lookalike names instead of hiding them or counting them as subdomains", () => {
    const rows: CrtShRow[] = [
      { name_value: "www.example.com", not_before: "2026-01-01T00:00:00", not_after: "2026-12-01T00:00:00" },
      {
        name_value: "example.com.secure-login.example",
        not_before: "2026-02-01T00:00:00",
        not_after: "2026-05-01T00:00:00",
      },
    ];
    const summary = summariseCertificates(rows, "example.com", { now });
    expect(summary.hostnames.map((entry) => entry.name)).toEqual(["www.example.com"]);
    expect(summary.outOfScope.map((entry) => entry.name)).toEqual(["example.com.secure-login.example"]);
  });

  it("flags wildcards and keeps them out of the resolvable list", () => {
    const rows: CrtShRow[] = [
      { name_value: "*.example.com", not_before: "2026-01-01T00:00:00", not_after: "2026-12-01T00:00:00" },
      { name_value: "www.example.com", not_before: "2026-01-02T00:00:00", not_after: "2026-12-01T00:00:00" },
    ];
    const summary = summariseCertificates(rows, "example.com", { now });
    expect(summary.hostnames.find((entry) => entry.name === "*.example.com")?.wildcard).toBe(true);
    // A wildcard is not a name a resolver can be asked about.
    expect(resolvableHostnames(summary)).toEqual(["www.example.com"]);
  });

  it("sorts most recently issued first, so new infrastructure is at the top", () => {
    const rows: CrtShRow[] = [
      { name_value: "old.example.com", not_before: "2020-01-01T00:00:00", not_after: "2020-04-01T00:00:00" },
      { name_value: "new.example.com", not_before: "2026-08-01T00:00:00", not_after: "2026-11-01T00:00:00" },
      { name_value: "middle.example.com", not_before: "2023-01-01T00:00:00", not_after: "2023-04-01T00:00:00" },
    ];
    const summary = summariseCertificates(rows, "example.com", { now });
    expect(summary.hostnames.map((entry) => entry.name)).toEqual([
      "new.example.com",
      "middle.example.com",
      "old.example.com",
    ]);
  });

  it("drops entries that are not hostnames at all", () => {
    const rows: CrtShRow[] = [
      { name_value: "admin@example.com\nwww.example.com", not_before: "2026-01-01T00:00:00", not_after: "2026-12-01T00:00:00" },
    ];
    const summary = summariseCertificates(rows, "example.com", { now });
    expect(summary.hostnames.map((entry) => entry.name)).toEqual(["www.example.com"]);
  });

  it("handles an empty result without inventing one", () => {
    const summary = summariseCertificates([], "example.com", { now });
    expect(summary.hostnames).toEqual([]);
    expect(summary.certificateCount).toBe(0);
    expect(summary.firstSeen).toBeNull();
    expect(summary.truncated).toBe(false);
  });
});
