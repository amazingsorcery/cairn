import { describe, expect, it } from "vitest";

import cdxFixture from "./__fixtures__/wayback-cdx-ripe-net.json";
import {
  buildTimeline,
  cdxResponseSchema,
  collapseUnchanged,
  decodeCdx,
  diffLines,
  htmlToText,
  parseWaybackTimestamp,
  snapshotUrl,
  snapshotViewUrl,
  WAYBACK_HOST,
  type Snapshot,
} from "./wayback";

/**
 * `__fixtures__/wayback-cdx-ripe-net.json` is a real CDX response for `ripe.net`, captured
 * 2026-09-01 with `collapse=digest` and `limit=60`. It reaches back to 1997, which is what
 * makes it a good fixture: it exercises two-digit-era timestamps, a multi-decade timeline
 * and the crawl gaps of the early web.
 */

const snapshot = (timestamp: string, digest: string | null, overrides: Partial<Snapshot> = {}): Snapshot => ({
  timestamp,
  capturedAt: parseWaybackTimestamp(timestamp)?.toISOString() ?? "",
  original: "http://example.com/",
  mimeType: "text/html",
  statusCode: 200,
  digest,
  lengthBytes: 100,
  ...overrides,
});

describe("capture timestamps", () => {
  it("reads a 14-digit timestamp as UTC", () => {
    expect(parseWaybackTimestamp("19970508135147")?.toISOString()).toBe("1997-05-08T13:51:47.000Z");
    expect(parseWaybackTimestamp("20260101000000")?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("rejects a value that would silently roll over into a wrong date", () => {
    // Date.UTC(2026, 12, ...) is January 2027. A timeline entry a year out is worse than none.
    expect(parseWaybackTimestamp("20261301000000")).toBeNull();
    expect(parseWaybackTimestamp("20260231000000")).toBeNull();
    expect(parseWaybackTimestamp("20260101250000")).toBeNull();
  });

  it("rejects anything that is not fourteen digits", () => {
    for (const value of ["2026", "2026010100000", "202601010000000", "abcdefghijklmn", ""]) {
      expect(parseWaybackTimestamp(value), value).toBeNull();
    }
  });
});

describe("decoding the CDX index", () => {
  it("parses the captured response and maps columns by name", () => {
    const rows = cdxResponseSchema.parse(cdxFixture);
    const snapshots = decodeCdx(rows);
    expect(snapshots).toHaveLength(rows.length - 1);
    expect(snapshots[0]?.timestamp).toBe("19970508135147");
    expect(snapshots[0]?.statusCode).toBe(200);
    expect(snapshots[0]?.digest).toBe("7GGMCIW525BOCWX7K4SYOPQDMCEZWBVY");
    expect(snapshots[0]?.original).toBe("http://www.ripe.net:80/");
  });

  it("reads columns by header name, not by position", () => {
    // The `fl=` parameter controls the column set, so a positional parser mis-assigns every
    // field the day somebody reorders it. Same data, reversed columns, same result.
    const forward = decodeCdx([
      ["timestamp", "original", "statuscode", "digest"],
      ["20200101000000", "http://example.com/", "404", "ABC"],
    ]);
    const reversed = decodeCdx([
      ["digest", "statuscode", "original", "timestamp"],
      ["ABC", "404", "http://example.com/", "20200101000000"],
    ]);
    expect(forward).toEqual(reversed);
    expect(forward[0]?.statusCode).toBe(404);
  });

  it("treats the index's dash placeholder as unknown rather than zero", () => {
    const [decoded] = decodeCdx([
      ["timestamp", "statuscode", "digest", "length"],
      ["20200101000000", "-", "-", "-"],
    ]);
    expect(decoded?.statusCode).toBeNull();
    expect(decoded?.digest).toBeNull();
    expect(decoded?.lengthBytes).toBeNull();
  });

  it("drops an undatable row rather than putting it on a timeline at the epoch", () => {
    const decoded = decodeCdx([
      ["timestamp", "original"],
      ["not-a-timestamp", "http://example.com/"],
      ["20200101000000", "http://example.com/"],
    ]);
    expect(decoded).toHaveLength(1);
  });

  it("returns nothing for an empty or headerless response", () => {
    expect(decodeCdx([])).toEqual([]);
    expect(decodeCdx([["urlkey", "original"]])).toEqual([]);
  });
});

describe("the timeline", () => {
  it("summarises the captured ripe.net history", () => {
    const snapshots = decodeCdx(cdxResponseSchema.parse(cdxFixture));
    const timeline = buildTimeline("http://ripe.net/", snapshots);
    expect(timeline.first?.timestamp.slice(0, 4)).toBe("1997");
    expect(timeline.years[0]?.year).toBe(1997);
    expect(timeline.years.every((bucket) => bucket.captures > 0)).toBe(true);
    // `collapse=digest` was used, so every capture in the fixture carries a distinct digest.
    expect(timeline.distinctDigests).toBe(snapshots.length);
  });

  it("counts a change only where both captures carry a digest", () => {
    // The failure this prevents: treating a missing digest as a difference, which invents
    // edits that never happened and puts fictional dates on an investigator's timeline.
    const timeline = buildTimeline("u", [
      snapshot("20200101000000", "A"),
      snapshot("20200201000000", null),
      snapshot("20200301000000", "A"),
      snapshot("20200401000000", "B"),
    ]);
    expect(timeline.changePoints).toHaveLength(1);
    expect(timeline.changePoints[0]?.snapshot.timestamp).toBe("20200401000000");
    expect(timeline.changePoints[0]?.previous.timestamp).toBe("20200301000000");
  });

  it("gives each change point the capture immediately before it, which is what to diff", () => {
    const timeline = buildTimeline("u", [
      snapshot("20200101000000", "A"),
      snapshot("20200102000000", "A"),
      snapshot("20200103000000", "B"),
    ]);
    expect(timeline.changePoints[0]?.previous.timestamp).toBe("20200102000000");
  });

  it("reports a static page as one digest across many captures", () => {
    const timeline = buildTimeline(
      "u",
      ["20200101000000", "20200201000000", "20200301000000"].map((t) => snapshot(t, "SAME")),
    );
    expect(timeline.distinctDigests).toBe(1);
    expect(timeline.changePoints).toEqual([]);
  });

  it("lists gaps of a year or more and ignores shorter ones", () => {
    const timeline = buildTimeline("u", [
      snapshot("20100101000000", "A"),
      snapshot("20100601000000", "B"),
      snapshot("20150101000000", "C"),
    ]);
    expect(timeline.gaps).toHaveLength(1);
    expect(timeline.gaps[0]?.from.timestamp).toBe("20100601000000");
    expect(timeline.gaps[0]?.days).toBeGreaterThan(1600);
  });

  it("handles a URL with no captures at all", () => {
    const timeline = buildTimeline("http://example.com/", []);
    expect(timeline.first).toBeNull();
    expect(timeline.last).toBeNull();
    expect(timeline.years).toEqual([]);
    expect(timeline.distinctDigests).toBe(0);
  });
});

describe("snapshot URLs are pinned to the archive", () => {
  it("builds the unmodified-capture form", () => {
    const built = snapshotUrl("19970508135147", "http://www.ripe.net:80/");
    expect(built.ok).toBe(true);
    // The default port is dropped by URL normalisation; the archive serves both forms.
    if (built.ok) {
      expect(built.value).toBe(`https://${WAYBACK_HOST}/web/19970508135147id_/http://www.ripe.net/`);
    }
  });

  it("builds the reader-facing form separately, with the archive's own banner", () => {
    const view = snapshotViewUrl("20200101000000", "https://example.com/a");
    expect(view.ok).toBe(true);
    if (view.ok) expect(view.value).toBe(`https://${WAYBACK_HOST}/web/20200101000000/https://example.com/a`);
  });

  it("refuses a timestamp that is not fourteen digits", () => {
    for (const value of ["2020", "../../etc", "20200101000000/../..", ""]) {
      expect(snapshotUrl(value, "https://example.com/").ok, value).toBe(false);
    }
  });

  it("refuses an original URL that would point the fetch anywhere but the public web", () => {
    for (const original of [
      "http://127.0.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "file:///etc/passwd",
      "http://localhost/",
      "http://../../x",
      "https://user:pass@example.com/",
    ]) {
      expect(snapshotUrl("20200101000000", original).ok, original).toBe(false);
    }
  });

  it("still lands on web.archive.org for a hostile-looking original", () => {
    // Even where a value is accepted, the resulting host must be the archive and the path
    // must still be under the requested capture.
    const built = snapshotUrl("20200101000000", "https://example.com/a/../../b");
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(new URL(built.value).hostname).toBe(WAYBACK_HOST);
      expect(new URL(built.value).pathname.startsWith("/web/20200101000000id_/")).toBe(true);
    }
  });
});

describe("HTML to text", () => {
  it("drops script and style content entirely", () => {
    const text = htmlToText(
      "<html><head><style>body{color:red}</style></head><body><script>alert('x')</script><p>Hello</p></body></html>",
    );
    expect(text).toBe("Hello");
    expect(text).not.toMatch(/alert|color:red/);
  });

  it("drops an unclosed script at the end of a truncated capture", () => {
    expect(htmlToText("<p>Visible</p><script>var leak = 1;")).toBe("Visible");
  });

  it("turns block elements into line breaks and inline markup into nothing", () => {
    expect(htmlToText("<h1>Title</h1><p>One <b>bold</b> word.</p><br><p>Two</p>")).toBe(
      "Title\nOne bold word.\nTwo",
    );
  });

  it("decodes the entities an archived page actually contains", () => {
    expect(htmlToText("<p>AT&amp;T &lt;tag&gt; &quot;q&quot; &#8212; &#x2019;</p>")).toBe(
      'AT&T <tag> "q" — ’',
    );
  });

  it("leaves a malformed numeric entity alone rather than throwing on it", () => {
    // A surrogate or an out-of-range code point from a hostile page must not crash the diff.
    expect(htmlToText("<p>&#xD800; &#99999999;</p>")).toBe("&#xD800; &#99999999;");
  });

  it("strips comments, including a conditional comment full of markup", () => {
    expect(htmlToText("<p>A</p><!-- <script>x</script> hidden --><p>B</p>")).toBe("A\nB");
  });

  it("extracts readable text from the real 1997 ripe.net capture shape", () => {
    const text = htmlToText(
      '<HTML>\n<HEAD>\n<TITLE>RIPE NCC: Homepage </TITLE>\n</HEAD>\n\n<BODY BGCOLOR="#FFFFFF">\n<A HREF="/">RIPE</A>\n<P>Network Coordination Centre</P>\n</BODY></HTML>',
    );
    // <head> is dropped, so the <title> does not appear in the body text.
    expect(text).toBe("RIPE\nNetwork Coordination Centre");
  });
});

describe("the diff", () => {
  it("marks added, removed and unchanged lines", () => {
    const diff = diffLines("a\nb\nc", "a\nB\nc");
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.unchanged).toBe(2);
    expect(diff.lines.map((line) => `${line.op}:${line.text}`)).toEqual([
      "same:a",
      "removed:b",
      "added:B",
      "same:c",
    ]);
  });

  it("reports two identical texts as entirely unchanged", () => {
    const diff = diffLines("one\ntwo", "one\ntwo");
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
    expect(diff.unchanged).toBe(2);
    expect(diff.approximate).toBe(false);
  });

  it("handles an empty side", () => {
    expect(diffLines("", "new").added).toBe(1);
    expect(diffLines("old", "").removed).toBe(1);
    expect(diffLines("", "").lines).toEqual([]);
  });

  it("finds a genuine insertion rather than rewriting the whole document", () => {
    const before = ["intro", "one", "two", "three", "outro"].join("\n");
    const after = ["intro", "one", "INSERTED", "two", "three", "outro"].join("\n");
    const diff = diffLines(before, after);
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(0);
    expect(diff.unchanged).toBe(5);
  });

  it("falls back to a coarse comparison on very large inputs, and says so", () => {
    // 3000 differing lines on both sides exceeds the 2000x2000 cell cap.
    const before = Array.from({ length: 3000 }, (_, index) => `old-${index}`).join("\n");
    const after = Array.from({ length: 3000 }, (_, index) => `new-${index}`).join("\n");
    const diff = diffLines(before, after);
    expect(diff.approximate).toBe(true);
    expect(diff.added).toBe(3000);
    expect(diff.removed).toBe(3000);
  });

  it("stays exact on large inputs that share a head and a tail", () => {
    // The trim is what makes a real page diff tractable: two captures of the same document
    // usually differ in a handful of lines out of thousands.
    const shared = Array.from({ length: 5000 }, (_, index) => `line-${index}`);
    const before = [...shared, "old"].join("\n");
    const after = [...shared, "new"].join("\n");
    const diff = diffLines(before, after);
    expect(diff.approximate).toBe(false);
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.unchanged).toBe(5000);
  });

  it("collapses long unchanged runs into a gap marker", () => {
    const before = ["x", ...Array.from({ length: 40 }, (_, index) => `same-${index}`), "y"].join("\n");
    const after = ["X", ...Array.from({ length: 40 }, (_, index) => `same-${index}`), "y"].join("\n");
    const collapsed = collapseUnchanged(diffLines(before, after), 2);
    const gaps = collapsed.filter((entry) => entry.op === "gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toEqual({ op: "gap", count: 39 });
    // Nothing is lost: the gap count plus the rendered lines equals the full diff.
    const rendered = collapsed.filter((entry) => entry.op !== "gap").length;
    expect(rendered + 39).toBe(diffLines(before, after).lines.length);
  });

  it("emits no gap when everything is close to a change", () => {
    const collapsed = collapseUnchanged(diffLines("a\nb", "a\nB"), 3);
    expect(collapsed.some((entry) => entry.op === "gap")).toBe(false);
  });
});
