import { describe, expect, it } from "vitest";

import fixtures from "./__fixtures__/doh-cloudflare.json";
import {
  classifyTxt,
  decodeCaaData,
  decodeMxData,
  decodeRecordSet,
  decodeTxtData,
  dohResponseSchema,
  emptyRecordTypes,
  nameExistence,
  rcodeMeaning,
  rcodeName,
  stripRootDot,
  type DnsLookup,
} from "./dns";

/**
 * `__fixtures__/doh-cloudflare.json` holds real responses from
 * `https://cloudflare-dns.com/dns-query`, captured 2026-09-01 for `ripe.net`,
 * `www.bbc.co.uk` and a name that does not exist. The decoders are asserted against those
 * captured shapes and against the presentation forms defined in the RFCs, never against
 * this module's own output.
 */

const captured = dohResponseSchema.parse(fixtures["ripe.net-A"]);

describe("the upstream schema", () => {
  it("parses every captured response", () => {
    for (const [key, body] of Object.entries(fixtures)) {
      expect(dohResponseSchema.safeParse(body).success, key).toBe(true);
    }
  });

  it("requires Status, because defaulting it would turn a SERVFAIL into “no records”", () => {
    expect(dohResponseSchema.safeParse({ Answer: [] }).success).toBe(false);
    expect(dohResponseSchema.safeParse({ Status: 0 }).success).toBe(true);
  });

  it("tolerates a field it has never seen", () => {
    expect(dohResponseSchema.safeParse({ Status: 0, SomethingNew: true }).success).toBe(true);
  });
});

describe("response codes", () => {
  it("names the codes an investigator meets", () => {
    // RFC 1035 §4.1.1 and RFC 6895's registry.
    expect(rcodeName(0)).toBe("NOERROR");
    expect(rcodeName(1)).toBe("FORMERR");
    expect(rcodeName(2)).toBe("SERVFAIL");
    expect(rcodeName(3)).toBe("NXDOMAIN");
    expect(rcodeName(4)).toBe("NOTIMP");
    expect(rcodeName(5)).toBe("REFUSED");
    expect(rcodeName(9)).toBe("OTHER");
  });

  it("says plainly that SERVFAIL is not evidence of absence", () => {
    expect(rcodeMeaning(2)).toMatch(/never as “no records”|not about the domain/);
    expect(rcodeMeaning(3)).toMatch(/does not exist/);
  });
});

describe("TXT decoding", () => {
  it("concatenates character-strings with no separator", () => {
    // A key split across two 255-byte strings is ONE value. Joining with a space would
    // silently corrupt every long DKIM key this tool ever shows.
    expect(decodeTxtData('"v=DKIM1; k=rsa; p=MIIBIjAN" "AQ8AMIIBCgKCAQEA"')).toBe(
      "v=DKIM1; k=rsa; p=MIIBIjANAQ8AMIIBCgKCAQEA",
    );
  });

  it("unquotes a single string and unescapes", () => {
    expect(decodeTxtData('"v=spf1 include:_spf.example.com ~all"')).toBe(
      "v=spf1 include:_spf.example.com ~all",
    );
    expect(decodeTxtData('"a \\"quoted\\" word"')).toBe('a "quoted" word');
  });

  it("passes an unquoted value through rather than losing it", () => {
    expect(decodeTxtData("bare-value")).toBe("bare-value");
  });

  it("decodes the captured ripe.net TXT set", () => {
    const set = decodeRecordSet("TXT", dohResponseSchema.parse(fixtures["ripe.net-TXT"]));
    expect(set.answers.length).toBeGreaterThan(0);
    for (const answer of set.answers) expect(answer.value.startsWith('"')).toBe(false);
    expect(set.answers.some((answer) => answer.value.startsWith("v=spf1"))).toBe(true);
  });

  it("reports what a record says about itself and claims nothing more", () => {
    expect(classifyTxt("v=spf1 -all")).toMatch(/SPF/);
    expect(classifyTxt("v=DMARC1; p=reject")).toMatch(/DMARC/);
    expect(classifyTxt("google-site-verification=abc123")).toMatch(/verification token/);
    expect(classifyTxt("some private note")).toBeNull();
  });
});

describe("MX decoding", () => {
  it("splits preference from exchange and strips the root dot", () => {
    expect(decodeMxData("10 cluster1.eu.messagelabs.com.")).toEqual({
      preference: 10,
      exchange: "cluster1.eu.messagelabs.com",
    });
  });

  it("recognises RFC 7505's null MX", () => {
    expect(decodeMxData("0 .")).toEqual({ preference: 0, exchange: "." });
  });

  it("returns null for a form it cannot read, rather than guessing", () => {
    expect(decodeMxData("mail.example.com")).toBeNull();
    expect(decodeMxData("")).toBeNull();
  });

  it("orders the captured MX set by preference, because that order is meaningful", () => {
    const set = decodeRecordSet("MX", dohResponseSchema.parse(fixtures["ripe.net-MX"]));
    const preferences = set.answers.map((answer) => answer.mx?.preference ?? -1);
    expect(preferences.length).toBeGreaterThan(0);
    expect([...preferences].sort((a, b) => a - b)).toEqual(preferences);
  });
});

describe("CAA decoding", () => {
  it("splits flags, tag and value", () => {
    // RFC 8659 §4.1's own example form.
    expect(decodeCaaData('0 issue "letsencrypt.org"')).toEqual({
      flags: 0,
      tag: "issue",
      value: "letsencrypt.org",
    });
    expect(decodeCaaData('128 iodef "mailto:security@example.com"')).toEqual({
      flags: 128,
      tag: "iodef",
      value: "mailto:security@example.com",
    });
  });

  it("keeps CA parameters, which change what the record permits", () => {
    // The captured ripe.net set contains this exact value.
    expect(decodeCaaData('0 issue "digicert.com; cansignhttpexchanges=yes"')?.value).toBe(
      "digicert.com; cansignhttpexchanges=yes",
    );
  });

  it("decodes the captured CAA set and names each authority", () => {
    const set = decodeRecordSet("CAA", dohResponseSchema.parse(fixtures["ripe.net-CAA"]));
    expect(set.answers.length).toBeGreaterThan(2);
    expect(set.answers.every((answer) => answer.caa !== undefined)).toBe(true);
    expect(set.answers.map((answer) => answer.caa?.value)).toContain("letsencrypt.org");
  });
});

describe("record sets", () => {
  it("reports the CNAME chain separately from the addresses it ends in", () => {
    // www.bbc.co.uk is a CNAME to a CNAME to Fastly. The A records belong to Fastly's map,
    // not to the BBC, and a tool that hid the chain would invite exactly that error.
    const set = decodeRecordSet("A", dohResponseSchema.parse(fixtures["www.bbc.co.uk-A"]));
    expect(set.cnameChain).toEqual(["www.bbc.co.uk.pri.bbc.co.uk", "bbc.map.fastly.net"]);
    expect(set.answers).toHaveLength(4);
    expect(set.answers.every((answer) => answer.name === "bbc.map.fastly.net")).toBe(true);
    // The CNAME records themselves are not presented as A records.
    expect(set.answers.some((answer) => answer.value.endsWith("fastly.net."))).toBe(false);
  });

  it("sorts addresses, because resolvers rotate them and the order carries no information", () => {
    const set = decodeRecordSet("A", dohResponseSchema.parse(fixtures["www.bbc.co.uk-A"]));
    const values = set.answers.map((answer) => answer.value);
    expect([...values].sort()).toEqual(values);
  });

  it("carries the DNSSEC and truncation flags through", () => {
    const validated = decodeRecordSet("CAA", dohResponseSchema.parse(fixtures["ripe.net-CAA"]));
    expect(validated.dnssecValidated).toBe(true);
    expect(validated.truncated).toBe(false);
    expect(decodeRecordSet("A", captured).rcode).toBe("NOERROR");
  });

  it("distinguishes “no record of this type” from “no such name”", () => {
    const nx = decodeRecordSet("A", dohResponseSchema.parse(fixtures["nxdomain-A"]));
    expect(nx.rcode).toBe("NXDOMAIN");
    expect(nx.answers).toEqual([]);

    const empty = decodeRecordSet("MX", { Status: 0, Answer: [] });
    expect(empty.rcode).toBe("NOERROR");
    expect(empty.answers).toEqual([]);
  });

  it("keeps a resolver comment, which is usually the DNSSEC explanation", () => {
    const set = decodeRecordSet("A", { Status: 2, Comment: "DNSSEC validation failure." });
    expect(set.comment).toBe("DNSSEC validation failure.");
    expect(decodeRecordSet("A", { Status: 0, Comment: "  " }).comment).toBeNull();
  });
});

describe("the lookup as a whole", () => {
  const lookup = (statuses: readonly number[]): DnsLookup => ({
    name: "example.com",
    resolver: "Cloudflare",
    records: statuses.map((status, index) =>
      decodeRecordSet((["A", "AAAA", "MX", "NS", "TXT", "CAA"] as const)[index] ?? "A", {
        Status: status,
      }),
    ),
  });

  it("treats one NXDOMAIN as settling the question of existence", () => {
    expect(nameExistence(lookup([3, 0, 0]))).toBe("nxdomain");
  });

  it("reports “unknown” when every query failed, rather than “no records”", () => {
    expect(nameExistence(lookup([2, 2, 2]))).toBe("unknown");
    expect(nameExistence(lookup([5, 5]))).toBe("unknown");
  });

  it("lists the types that came back empty so the UI can show the absence", () => {
    expect(emptyRecordTypes(lookup([0, 0, 0]))).toEqual(["A", "AAAA", "MX"]);
    expect(emptyRecordTypes(lookup([2, 3]))).toEqual([]);
  });
});

describe("name normalisation", () => {
  it("strips the root dot and lowercases", () => {
    expect(stripRootDot("Example.COM.")).toBe("example.com");
    expect(stripRootDot("example.com")).toBe("example.com");
  });
});
