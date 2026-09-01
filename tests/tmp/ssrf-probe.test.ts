import { describe, it } from "vitest";

import {
  normaliseHostname,
  normalisePublicIp,
  normaliseLookupUrl,
  normaliseNetworkTarget,
  isPinnedHost,
} from "@/lib/toolbench/net-target";
import { snapshotUrl } from "@/lib/toolbench/wayback";

const HOSTS = [
  "localhost",
  "localhost.",
  "localhost..",
  "LOCALHOST",
  "127.0.0.1",
  "2130706433",
  "0x7f000001",
  "0177.0.0.1",
  "127.1",
  "[::1]",
  "::1",
  "metadata.google.internal",
  "169.254.169.254",
  "example.com.",
  "example.com..",
  "еxample.com",
  "xn--e1awd7f.com",
  "a.example.com。com",
  "example．com",
  "example｡com",
  "exam%2eple.com",
  "example.com%00.evil.test",
  "sub.example.com",
  "a".repeat(300) + ".com",
  "example.com:80",
  "user@example.com",
  "example.com/path",
  "-bad.example.com",
  "example.-com",
  "under_score.example.com",
  "example.co.uk",
  "1.example.com",
  "internal",
  "svc.cluster.local",
  "burp.oastify.com",
];

const IPS = [
  "127.0.0.1",
  "169.254.169.254",
  "10.0.0.1",
  "192.168.1.1",
  "172.16.0.1",
  "100.64.0.1",
  "::1",
  "::",
  "::ffff:127.0.0.1",
  "::ffff:7f00:1",
  "::127.0.0.1",
  "::ffff:0:127.0.0.1",
  "0:0:0:0:0:ffff:169.254.169.254",
  "64:ff9b::7f00:1",
  "2002:7f00:1::1",
  "2001::7f00:1",
  "fd00::1",
  "fe80::1",
  "ff02::1",
  "0.0.0.0",
  "0177.0.0.1",
  "2130706433",
  "0x7f000001",
  "127.1",
  "127.0.0.1 ",
  "1.1.1.1",
  "2606:4700:4700::1111",
  "::0.0.0.1",
  "::0.0.0.0",
  "0:0:0:0:0:0:a9fe:a9fe",
  "::a9fe:a9fe",
];

const URLS = [
  "http://169.254.169.254/latest/meta-data/",
  "https://web.archive.org@169.254.169.254/",
  "https://example.com@169.254.169.254/",
  "file:///etc/passwd",
  "gopher://127.0.0.1:11211/",
  "http://[::1]/",
  "http://[::ffff:127.0.0.1]/",
  "http://[::127.0.0.1]/",
  "http://localhost/",
  "http://127.0.0.1:8080/",
  "https://example.com/%2e%2e/%2e%2e/admin",
  "https://example.com/..%2f..%2fadmin",
  "https://example.com/a/../../../b",
  "https://example.com/#frag",
  "https://example.com/?q=1#frag",
  "https://example.com\\@evil.test/",
  "https://example.com/ /x",
  "https://[2606:4700:4700::1111]/x",
  "https://2606:4700:4700::1111/x",
  "https://example.com/%00",
  "https://example.com/x?a=b&c=d",
  "https://xn--e1awd7f.com/",
  "https://example.com.",
  "https://example.com./x",
  "  https://example.com/x  ",
  "HTTPS://EXAMPLE.COM/X",
  "https://example.com/\r\nHost: evil.test",
  "https://example.com/%0d%0aHost:%20evil.test",
];

describe("SSRF probe (QA, reporting only)", () => {
  it("hostnames", () => {
    for (const h of HOSTS) {
      const r = normaliseHostname(h);
      console.log(`HOST ${JSON.stringify(h)} -> ${r.ok ? "ACCEPT " + r.value : "refuse"}`);
    }
  });

  it("ips", () => {
    for (const ip of IPS) {
      const r = normalisePublicIp(ip);
      console.log(`IP   ${JSON.stringify(ip)} -> ${r.ok ? "ACCEPT " + r.value.address : "refuse"}`);
    }
  });

  it("targets", () => {
    for (const t of [...IPS, ...HOSTS]) {
      const r = normaliseNetworkTarget(t);
      if (r.ok) console.log(`TGT  ${JSON.stringify(t)} -> ACCEPT ${r.value.kind} ${JSON.stringify(r.value.kind === "ip" ? r.value.value.address : r.value.value)}`);
    }
  });

  it("urls", () => {
    for (const u of URLS) {
      const r = normaliseLookupUrl(u);
      if (r.ok) {
        const snap = snapshotUrl("20200101000000", r.value.href);
        console.log(
          `URL  ${JSON.stringify(u)} -> ACCEPT href=${JSON.stringify(r.value.href)} host=${r.value.hostname} snapshot=${snap.ok ? JSON.stringify(snap.value) : "refused"}`,
        );
      } else {
        console.log(`URL  ${JSON.stringify(u)} -> refuse`);
      }
    }
  });

  it("pin", () => {
    for (const u of [
      "https://web.archive.org/x",
      "https://WEB.ARCHIVE.ORG/x",
      "https://web.archive.org./x",
      "https://web.archive.org:443/x",
      "https://web.archive.org:8443/x",
      "https://user@web.archive.org/x",
      "http://web.archive.org/x",
      "https://web.archive.org.evil.test/x",
      "https://evil.test/web.archive.org",
      "https://xn--web.archive.org/x",
    ]) {
      console.log(`PIN  ${JSON.stringify(u)} -> ${isPinnedHost(u, "web.archive.org")}`);
    }
  });
});
