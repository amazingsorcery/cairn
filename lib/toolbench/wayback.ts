import { z } from "zod";

import { fail, ok, type ToolResult } from "./result";
import { normaliseLookupUrl } from "./net-target";

/**
 * The Wayback Machine's CDX index, turned into a timeline — and two captures, turned into a
 * difference.
 *
 * The CDX server returns one row per *capture*, and there are commonly thousands. Clicking
 * through them is the way most people use the archive and it is the slow way: the useful
 * question is not "what did this page look like in March" but "when did it change", and the
 * index answers that directly because every row carries a **content digest**. Two
 * consecutive captures with the same digest are byte-identical; a digest change is the
 * archive telling you the page changed, without downloading either capture.
 *
 * Everything in this module is pure. The HTTP calls live in `lib/connectors/wayback.ts`.
 */

/* ------------------------------------------------------------------ *
 * The CDX response
 * ------------------------------------------------------------------ */

/**
 * CDX JSON is an array of arrays whose **first row is the header**, naming the columns in
 * the order they appear. It is parsed by name rather than by position on purpose: the column
 * set is controlled by the `fl=` parameter, and a positional parser silently mis-assigns
 * every field the day somebody adds one.
 */
export const cdxResponseSchema = z.array(
  z.array(
    // Cells are strings in every column we request — but the CDX server emits a bare JSON
    // `null` for a counter column it cannot fill, and one null in one row must not throw away
    // a thirty-year timeline. Numbers are coerced for the same reason.
    z
      .union([z.string(), z.number(), z.null()])
      .transform((cell) => (cell === null ? "" : String(cell))),
  ),
);

export interface Snapshot {
  /** The archive's 14-digit capture timestamp, `YYYYMMDDhhmmss`, always UTC. */
  readonly timestamp: string;
  readonly capturedAt: string;
  /** The URL as it was crawled, which may differ from the URL you asked about. */
  readonly original: string;
  readonly mimeType: string | null;
  /** HTTP status at capture time. `-` in the index for a revisit record. */
  readonly statusCode: number | null;
  /** Base32 SHA-1 of the response body. Equal digests mean byte-identical captures. */
  readonly digest: string | null;
  readonly lengthBytes: number | null;
}

/**
 * A 14-digit archive timestamp is `YYYYMMDDhhmmss` in UTC. Parsing it with `new Date(string)`
 * would be wrong twice over — the format is not one `Date` accepts, and any form it did
 * accept without an offset would be read as local time.
 */
export function parseWaybackTimestamp(timestamp: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(timestamp);
  if (!match) return null;
  const [, year = "", month = "", day = "", hour = "", minute = "", second = ""] = match;
  const value = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  // Round-trip check, so 20261301000000 (month 13) is rejected rather than rolling over into
  // the next year and producing a confidently wrong date on a timeline.
  const formatted =
    `${date.getUTCFullYear().toString().padStart(4, "0")}` +
    `${(date.getUTCMonth() + 1).toString().padStart(2, "0")}` +
    `${date.getUTCDate().toString().padStart(2, "0")}` +
    `${date.getUTCHours().toString().padStart(2, "0")}` +
    `${date.getUTCMinutes().toString().padStart(2, "0")}` +
    `${date.getUTCSeconds().toString().padStart(2, "0")}`;
  return formatted === timestamp ? date : null;
}

const toNumber = (value: string | undefined): number | null => {
  if (value === undefined || value === "" || value === "-") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Decode the header-plus-rows array into snapshots, dropping any row we cannot date. */
export function decodeCdx(rows: readonly (readonly string[])[]): readonly Snapshot[] {
  const [header, ...body] = rows;
  if (!header) return [];
  const index = (name: string): number => header.indexOf(name);
  const at = index("timestamp");
  if (at < 0) return [];

  const originalAt = index("original");
  const mimeAt = index("mimetype");
  const statusAt = index("statuscode");
  const digestAt = index("digest");
  const lengthAt = index("length");

  const snapshots: Snapshot[] = [];
  for (const row of body) {
    const timestamp = row[at] ?? "";
    const capturedAt = parseWaybackTimestamp(timestamp);
    if (capturedAt === null) continue;
    const digest = digestAt >= 0 ? (row[digestAt] ?? "") : "";
    snapshots.push({
      timestamp,
      capturedAt: capturedAt.toISOString(),
      original: originalAt >= 0 ? (row[originalAt] ?? "") : "",
      mimeType: mimeAt >= 0 ? (row[mimeAt] || null) : null,
      statusCode: statusAt >= 0 ? toNumber(row[statusAt]) : null,
      digest: digest === "" || digest === "-" ? null : digest,
      lengthBytes: lengthAt >= 0 ? toNumber(row[lengthAt]) : null,
    });
  }
  return snapshots.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/* ------------------------------------------------------------------ *
 * The timeline
 * ------------------------------------------------------------------ */

export interface YearBucket {
  readonly year: number;
  readonly captures: number;
  readonly changes: number;
}

export interface ChangePoint {
  /** The first capture carrying a new digest. */
  readonly snapshot: Snapshot;
  /** The capture immediately before it, which is what to diff against. */
  readonly previous: Snapshot;
}

export interface Timeline {
  readonly url: string;
  /**
   * One row per **distinct consecutive version**, not one per crawl.
   *
   * The index query sends `collapse=digest`, which asks the archive to drop a capture whose
   * content digest matches the capture before it. That is not a size optimisation dressed up
   * as a feature: it is exactly the question this tool asks. A page crawled four hundred
   * times that changed nine times comes back as nine rows, and the redundant 391 are never
   * transferred. The consequence, which the UI states rather than hides, is that **this is
   * not a count of how many times the page was archived.**
   */
  readonly snapshots: readonly Snapshot[];
  readonly first: Snapshot | null;
  readonly last: Snapshot | null;
  readonly years: readonly YearBucket[];
  /** Captures where the content digest differed from the capture before it. */
  readonly changePoints: readonly ChangePoint[];
  /** Distinct content digests seen. One digest across 400 captures means a static page. */
  readonly distinctDigests: number;
  /** Gaps of a year or more between consecutive captures. Read them carefully — see the UI. */
  readonly gaps: readonly { readonly from: Snapshot; readonly to: Snapshot; readonly days: number }[];
  readonly truncated: boolean;
}

const DAY_MS = 86_400_000;
/** Below a year, a gap in crawl coverage is unremarkable and listing it would be noise. */
const GAP_THRESHOLD_DAYS = 365;

export function buildTimeline(
  url: string,
  snapshots: readonly Snapshot[],
  options: { readonly truncated?: boolean } = {},
): Timeline {
  const years = new Map<number, { captures: number; changes: number }>();
  const changePoints: ChangePoint[] = [];
  const gaps: { from: Snapshot; to: Snapshot; days: number }[] = [];
  const digests = new Set<string>();

  let previous: Snapshot | null = null;
  for (const snapshot of snapshots) {
    const year = Number(snapshot.timestamp.slice(0, 4));
    const bucket = years.get(year) ?? { captures: 0, changes: 0 };
    bucket.captures += 1;

    if (snapshot.digest !== null) digests.add(snapshot.digest);

    if (previous !== null) {
      // A change is only assertable when BOTH captures carry a digest. A missing digest is
      // "unknown", and counting it as a change would invent edits that never happened.
      if (previous.digest !== null && snapshot.digest !== null && previous.digest !== snapshot.digest) {
        bucket.changes += 1;
        changePoints.push({ snapshot, previous });
      }
      const days = Math.round(
        (Date.parse(snapshot.capturedAt) - Date.parse(previous.capturedAt)) / DAY_MS,
      );
      if (days >= GAP_THRESHOLD_DAYS) gaps.push({ from: previous, to: snapshot, days });
    }

    years.set(year, bucket);
    previous = snapshot;
  }

  return {
    url,
    snapshots,
    first: snapshots[0] ?? null,
    last: snapshots[snapshots.length - 1] ?? null,
    years: [...years.entries()]
      .map(([year, bucket]) => ({ year, captures: bucket.captures, changes: bucket.changes }))
      .sort((a, b) => a.year - b.year),
    changePoints,
    distinctDigests: digests.size,
    gaps,
    truncated: options.truncated ?? false,
  };
}

/* ------------------------------------------------------------------ *
 * Snapshot URLs — the one place a user value touches a path
 * ------------------------------------------------------------------ */

/** The only host any of this may talk to. Never widen this without reading the SSRF notes. */
export const WAYBACK_HOST = "web.archive.org";

/**
 * Build the URL of one archived capture, in its **unmodified** form.
 *
 * The `id_` suffix on the timestamp is what asks for the original bytes rather than the
 * archive's rewritten copy. It matters for a diff: without it the archive injects its own
 * toolbar and rewrites every link to point at itself, so two captures a year apart differ in
 * hundreds of lines of archive scaffolding and the actual editorial change is buried.
 *
 * SSRF: the host is a constant, the timestamp is `\d{14}` or nothing is built, and the
 * original URL is re-validated through `normaliseLookupUrl` — which rejects a non-web
 * scheme, credentials, a port and every private or loopback host. The caller pins the host
 * again on the request and on each redirect hop.
 */
export function snapshotUrl(timestamp: string, original: string): ToolResult<string> {
  if (parseWaybackTimestamp(timestamp) === null) {
    return fail("That is not a Wayback capture timestamp. It is fourteen digits: YYYYMMDDhhmmss.");
  }
  const target = normaliseLookupUrl(original);
  if (!target.ok) return fail(target.error);

  const url = new URL(`https://${WAYBACK_HOST}/web/${timestamp}id_/${target.value.href}`);
  // Belt and braces: if anything above ever let a path escape, this catches it before a
  // request is made rather than after.
  if (url.hostname !== WAYBACK_HOST || !url.pathname.startsWith(`/web/${timestamp}id_/`)) {
    return fail("That capture could not be addressed safely.");
  }
  return ok(url.toString());
}

/** The reader-facing URL of a capture — the rewritten one, with the archive's own banner. */
export function snapshotViewUrl(timestamp: string, original: string): ToolResult<string> {
  if (parseWaybackTimestamp(timestamp) === null) return fail("That is not a capture timestamp.");
  const target = normaliseLookupUrl(original);
  if (!target.ok) return fail(target.error);
  return ok(`https://${WAYBACK_HOST}/web/${timestamp}/${target.value.href}`);
}

/* ------------------------------------------------------------------ *
 * HTML to text
 * ------------------------------------------------------------------ */

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith("#")) {
      const value = body.startsWith("#x") || body.startsWith("#X")
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      // Reject anything outside the Unicode range, and the surrogate block, rather than
      // throwing from String.fromCodePoint on a hostile page.
      if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return match;
      if (value >= 0xd800 && value <= 0xdfff) return match;
      return String.fromCodePoint(value);
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Elements whose *contents* are not page text at all. */
const DROPPED_ELEMENTS = ["script", "style", "noscript", "template", "svg", "head"] as const;

/** Elements that end a line of visible text. */
const BLOCK_ELEMENTS =
  /<\/?(?:p|div|br|hr|h[1-6]|li|ul|ol|tr|td|th|table|section|article|header|footer|nav|aside|blockquote|pre|form|figure|figcaption|main|dl|dt|dd)\b[^>]*>/gi;

/**
 * Reduce an archived HTML capture to the text a reader would have seen.
 *
 * **Nothing here renders HTML.** The output is a plain string put into a React text node;
 * `dangerouslySetInnerHTML` is lint-banned in this repository and would be the wrong tool
 * even if it were not, because the input is a 15-year-old page from an arbitrary website.
 *
 * It is deliberately crude, and the tool page says so: a diff of extracted text tells you
 * *that* wording changed, not how the page was laid out. Comparing rendered HTML instead
 * would drown the editorial change in markup churn, which defeats the purpose.
 */
export function htmlToText(html: string): string {
  let text = html;
  for (const element of DROPPED_ELEMENTS) {
    text = text.replace(new RegExp(`<${element}\\b[\\s\\S]*?</${element}\\s*>`, "gi"), " ");
    // An unclosed <script> at the end of a truncated capture would otherwise leak its body.
    text = text.replace(new RegExp(`<${element}\\b[\\s\\S]*$`, "i"), " ");
  }
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(BLOCK_ELEMENTS, "\n");
  text = text.replace(/<[^>]*>/g, " ");
  text = decodeEntities(text);

  return text
    .split("\n")
    .map((line) => line.replace(/[ \t \r]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/* ------------------------------------------------------------------ *
 * Diff
 * ------------------------------------------------------------------ */

export type DiffOp = "same" | "added" | "removed";

export interface DiffLine {
  readonly op: DiffOp;
  readonly text: string;
}

export interface TextDiff {
  readonly lines: readonly DiffLine[];
  readonly added: number;
  readonly removed: number;
  readonly unchanged: number;
  /** True when the inputs were too large to diff exactly and were compared coarsely. */
  readonly approximate: boolean;
}

/**
 * The largest LCS table we will build: 2000 × 2000 cells.
 *
 * A full-page diff is quadratic, and an archived homepage can be tens of thousands of lines.
 * Common prefixes and suffixes are trimmed first, which collapses almost every real pair to
 * a fraction of their length; beyond the cap the diff falls back to a set comparison and
 * says it did, because a page that silently truncates its own answer is worse than one that
 * admits the limit.
 */
const MAX_LCS_CELLS = 2000 * 2000;

export function diffLines(before: string, after: string): TextDiff {
  const a = before.length === 0 ? [] : before.split("\n");
  const b = after.length === 0 ? [] : after.split("\n");

  // Trim the identical head and tail. On two captures of the same page this is usually most
  // of the document, and it is exact — no information is lost.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const lines: DiffLine[] = [];
  for (let index = 0; index < head; index += 1) lines.push({ op: "same", text: a[index] ?? "" });

  let approximate = false;
  if (midA.length * midB.length > MAX_LCS_CELLS) {
    approximate = true;
    const inB = new Set(midB);
    const inA = new Set(midA);
    for (const line of midA) lines.push({ op: inB.has(line) ? "same" : "removed", text: line });
    for (const line of midB) if (!inA.has(line)) lines.push({ op: "added", text: line });
  } else {
    lines.push(...lcsDiff(midA, midB));
  }

  for (let index = a.length - tail; index < a.length; index += 1) {
    lines.push({ op: "same", text: a[index] ?? "" });
  }

  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const line of lines) {
    if (line.op === "added") added += 1;
    else if (line.op === "removed") removed += 1;
    else unchanged += 1;
  }

  return { lines, added, removed, unchanged, approximate };
}

/** Textbook longest-common-subsequence diff, with removals emitted before additions. */
function lcsDiff(a: readonly string[], b: readonly string[]): DiffLine[] {
  const rows = a.length;
  const columns = b.length;
  // One flat array rather than an array of arrays: on a 2000×2000 diff that is 4M numbers,
  // and the nested form allocates 2000 extra objects for no benefit.
  const table = new Int32Array((rows + 1) * (columns + 1));
  const cell = (row: number, column: number): number => table[row * (columns + 1) + column] ?? 0;

  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      table[row * (columns + 1) + column] =
        a[row] === b[column]
          ? cell(row + 1, column + 1) + 1
          : Math.max(cell(row + 1, column), cell(row, column + 1));
    }
  }

  const out: DiffLine[] = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (a[row] === b[column]) {
      out.push({ op: "same", text: a[row] ?? "" });
      row += 1;
      column += 1;
    } else if (cell(row + 1, column) >= cell(row, column + 1)) {
      out.push({ op: "removed", text: a[row] ?? "" });
      row += 1;
    } else {
      out.push({ op: "added", text: b[column] ?? "" });
      column += 1;
    }
  }
  while (row < rows) {
    out.push({ op: "removed", text: a[row] ?? "" });
    row += 1;
  }
  while (column < columns) {
    out.push({ op: "added", text: b[column] ?? "" });
    column += 1;
  }
  return out;
}

/**
 * Collapse long runs of unchanged lines, the way a code review does.
 *
 * A diff of two captures of a news homepage is 95% identical, and showing all of it buries
 * the change. `context` lines are kept either side of every edit; everything else becomes a
 * gap marker the UI renders as "N unchanged lines".
 */
export function collapseUnchanged(
  diff: TextDiff,
  context = 3,
): readonly (DiffLine | { readonly op: "gap"; readonly count: number })[] {
  const out: (DiffLine | { op: "gap"; count: number })[] = [];
  const keep = new Set<number>();
  diff.lines.forEach((line, index) => {
    if (line.op === "same") return;
    for (let offset = -context; offset <= context; offset += 1) keep.add(index + offset);
  });

  let run = 0;
  diff.lines.forEach((line, index) => {
    if (line.op !== "same" || keep.has(index)) {
      if (run > 0) {
        out.push({ op: "gap", count: run });
        run = 0;
      }
      out.push(line);
      return;
    }
    run += 1;
  });
  if (run > 0) out.push({ op: "gap", count: run });
  return out;
}
