import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cn, displayHost, formatDate, formatTimestamp, slugify, verificationAge } from "./utils";

describe("cn", () => {
  it("lets a later Tailwind utility beat an earlier conflicting one", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });

  it("drops falsy values instead of emitting 'false' into the class string", () => {
    expect(cn("base", false && "hidden", undefined, null, "extra")).toBe("base extra");
  });
});

describe("formatDate", () => {
  it("renders a stable UTC date regardless of the runtime timezone", () => {
    expect(formatDate("2026-05-01T23:30:00.000Z")).toBe("1 May 2026");
  });

  it("does not shift the day for a late-evening UTC timestamp", () => {
    expect(formatDate(new Date("2026-01-31T23:59:59.000Z"))).toBe("31 Jan 2026");
  });

  it("degrades to 'Unknown' rather than 'Invalid Date'", () => {
    expect(formatDate("not a date")).toBe("Unknown");
  });
});

describe("formatTimestamp", () => {
  it("marks the timezone explicitly so notes are unambiguous", () => {
    expect(formatTimestamp("2026-08-31T09:05:00.000Z")).toBe("31 Aug 2026, 09:05 UTC");
  });

  it("uses a 24-hour clock", () => {
    expect(formatTimestamp("2026-08-31T18:05:00.000Z")).toContain("18:05");
  });
});

describe("verificationAge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats a check within 90 days as fresh", () => {
    expect(verificationAge("2026-08-01T12:00:00.000Z")).toEqual({ days: 30, status: "fresh" });
  });

  it("treats the 90-day boundary as still fresh", () => {
    expect(verificationAge("2026-06-02T12:00:00.000Z").status).toBe("fresh");
  });

  it("treats a check between 90 days and a year as ageing", () => {
    expect(verificationAge("2026-01-01T12:00:00.000Z").status).toBe("ageing");
  });

  it("treats anything over a year as stale", () => {
    expect(verificationAge("2025-01-01T12:00:00.000Z").status).toBe("stale");
  });

  it("treats an unparseable date as stale rather than silently fresh", () => {
    expect(verificationAge("whenever").status).toBe("stale");
  });
});

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Corporate Ownership Tracing")).toBe("corporate-ownership-tracing");
  });

  it("collapses punctuation runs into a single hyphen", () => {
    expect(slugify("Who is  it -- really?")).toBe("who-is-it-really");
  });

  it("strips accents rather than dropping the letter", () => {
    expect(slugify("Réseau Français")).toBe("reseau-francais");
  });

  it("does not leave leading or trailing hyphens", () => {
    expect(slugify("  --hello--  ")).toBe("hello");
  });

  it("caps length so a pasted paragraph cannot become an anchor", () => {
    expect(slugify("a".repeat(200)).length).toBe(96);
  });
});

describe("displayHost", () => {
  it("shows the bare host so users can see where a link sends them", () => {
    expect(displayHost("https://www.shodan.io/search?query=x")).toBe("shodan.io");
  });

  it("keeps a meaningful subdomain", () => {
    expect(displayHost("https://opencorporates.com/companies")).toBe("opencorporates.com");
    expect(displayHost("https://web.archive.org/web/2026/https://x")).toBe("web.archive.org");
  });

  it("falls back to the raw string when the URL will not parse", () => {
    expect(displayHost("not a url")).toBe("not a url");
  });
});
