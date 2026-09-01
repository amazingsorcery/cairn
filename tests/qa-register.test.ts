import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE FINDINGS REGISTER MUST BE COUNTABLE, AND IT MUST AGREE WITH ITSELF.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QA finding QV-33 — and it is mine
 * ─────────────────────────────────────────────────────────────────────────────
 * On 2026-09-01 the maintainer parsed `docs/qa/audit-v2.md` for open findings, matched
 * nothing, and told the owner there were no open critical or high findings. The parse matched
 * nothing because the format did not support one:
 *
 *   - seven findings carried TWO `- Status:` lines each — the qa-adversary reopen, then the
 *     engineer's fix underneath it — so "the status" was ambiguous and depended on whether a
 *     reader took the first match or the last;
 *   - two carried `- Status: **open**` followed by a prose paragraph beginning "Re-verified
 *     independently by qa-adversary — closed", so the line and the paragraph said opposite
 *     things;
 *   - and an empty result set read as "clean" rather than as "the parse is broken", which is
 *     the failure mode a control must never have.
 *
 * `docs/qa/findings.json` is now the countable artefact and this file is what stops it
 * becoming a second document that drifts from the first. The prose entry is still where the
 * argument, the measurement and the reproduction live — a JSON field cannot carry those and
 * should not try.
 *
 * The rule the register now follows: **exactly one `- Status:` line per finding**, and its
 * first word is one of the closed vocabulary. History goes in the prose UNDER that line, not
 * in a second line beside it.
 */

const ROOT = process.cwd();
const REGISTER = join(ROOT, "docs/qa/audit-v2.md");
const LEDGER = join(ROOT, "docs/qa/findings.json");

/** Every status a finding may be in. Anything else is a typo or an invention. */
const STATUSES = ["open", "fixed", "claimed", "partly", "unreachable", "wontfix"] as const;
type Status = (typeof STATUSES)[number];

/** Statuses that do NOT bar a release. Everything else counts as outstanding. */
const SETTLED: ReadonlySet<string> = new Set<Status>(["fixed", "unreachable", "wontfix"]);

const SEVERITIES = ["critical", "high", "medium", "low"] as const;
const CATEGORIES = [
  "security",
  "a11y",
  "perf",
  "correctness",
  "data-integrity",
  "ops",
  "coverage",
] as const;

interface Finding {
  readonly id: string;
  readonly severity: (typeof SEVERITIES)[number];
  readonly category: (typeof CATEGORIES)[number];
  readonly status: Status;
  readonly blocksRelease: boolean;
  readonly title: string;
  readonly verifiedBy?: string;
  readonly note?: string;
}

function ledger(): readonly Finding[] {
  const parsed: unknown = JSON.parse(readFileSync(LEDGER, "utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error("findings.json is not an object");
  const findings = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) throw new Error("findings.json has no findings array");
  return findings as readonly Finding[];
}

const register = readFileSync(REGISTER, "utf8");

/** The `### [QV-nn] …` headings, in file order. */
function headings(): string[] {
  return [...register.matchAll(/^### \[(QV-\d+)\]/gm)].map((match) => match[1] as string);
}

/**
 * The body of each finding: from its heading to the next heading or the next `---` rule
 * followed by a `## `. Crude on purpose — the only question asked of it is how many
 * `- Status:` lines it contains.
 */
function bodies(): Map<string, string> {
  const out = new Map<string, string>();
  const sections = register.split(/^### \[/gm).slice(1);
  for (const section of sections) {
    const id = section.slice(0, section.indexOf("]"));
    if (!/^QV-\d+$/.test(id)) continue;
    out.set(id, section);
  }
  return out;
}

describe("QV-33: the register is countable", () => {
  it("the ledger parses and is not empty — an empty parse must fail, not read as clean", () => {
    expect(ledger().length).toBeGreaterThan(20);
  });

  it("every finding has a status from the closed vocabulary", () => {
    for (const finding of ledger()) {
      expect(STATUSES, `${finding.id} has status "${finding.status}"`).toContain(finding.status);
      expect(SEVERITIES, `${finding.id} has severity "${finding.severity}"`).toContain(
        finding.severity,
      );
      expect(CATEGORIES, `${finding.id} has category "${finding.category}"`).toContain(
        finding.category,
      );
    }
  });

  it("ids are unique and contiguous from QV-01, so a finding cannot be dropped silently", () => {
    const ids = ledger().map((finding) => finding.id);
    expect(new Set(ids).size).toBe(ids.length);
    const numbers = ids.map((id) => Number(id.slice(3))).sort((a, b) => a - b);
    expect(numbers[0]).toBe(1);
    for (let i = 1; i < numbers.length; i += 1) {
      expect(numbers[i], `QV-${String(numbers[i - 1]! + 1).padStart(2, "0")} is missing`).toBe(
        numbers[i - 1]! + 1,
      );
    }
  });

  it("`blocksRelease` agrees with the release rule in product-brief.md §8", () => {
    for (const finding of ledger()) {
      const outstanding = !SETTLED.has(finding.status);
      const high = finding.severity === "high" || finding.severity === "critical";
      expect(
        finding.blocksRelease,
        `${finding.id} is ${finding.severity}/${finding.status}; blocksRelease should be ` +
          `${String(outstanding && high)}. product-brief.md §8 makes "no open high/critical" a ` +
          `condition of Done.`,
      ).toBe(outstanding && high);
    }
  });

  it("anything not `open` names who re-measured it, and it is qa-adversary", () => {
    for (const finding of ledger()) {
      if (finding.status === "open") continue;
      expect(
        finding.verifiedBy ?? "",
        `${finding.id} is "${finding.status}" with nobody named. A status is a measurement, ` +
          `not a report received. Use "claimed" until qa-adversary has re-measured it.`,
      ).toMatch(/qa-adversary/);
    }
  });
});

describe("QV-33: the ledger and the prose describe the same register", () => {
  it("has one prose entry per ledger row and one ledger row per prose entry", () => {
    expect([...new Set(headings())].sort()).toEqual(ledger().map((f) => f.id).sort());
  });

  it("every finding carries exactly one `- Status:` line", () => {
    const offenders: string[] = [];
    for (const [id, body] of bodies()) {
      const count = (body.match(/^- Status:/gm) ?? []).length;
      if (count !== 1) offenders.push(`${id} has ${count}`);
    }
    expect(
      offenders,
      "Two Status lines in one entry is what made the register unparseable: a reader taking " +
        "the first match and a reader taking the last get different answers, and neither is " +
        "told they disagree. Put the history in prose under the one Status line.",
    ).toEqual([]);
  });

  it("each `- Status:` line's first word is the ledger's status for that finding", () => {
    const mismatches: string[] = [];
    const byId = new Map(ledger().map((finding) => [finding.id, finding]));
    for (const [id, body] of bodies()) {
      const line = body.match(/^- Status:\s*(.*)$/m)?.[1] ?? "";
      const word = line.replace(/\*/g, "").trim().split(/[\s—,.:]/)[0]?.toLowerCase() ?? "";
      const expected = byId.get(id)?.status;
      if (word !== expected) mismatches.push(`${id}: prose "${word}" vs ledger "${expected ?? "—"}"`);
    }
    expect(mismatches).toEqual([]);
  });

  it("no Status line is contradicted by a 'closed' claim in its own entry", () => {
    const contradictions: string[] = [];
    for (const [id, body] of bodies()) {
      const line = body.match(/^- Status:\s*(.*)$/m)?.[1] ?? "";
      if (!/\bopen\b/i.test(line.replace(/\*/g, ""))) continue;
      const after = body.slice(body.indexOf("- Status:"));
      if (/—\s*closed\b|\bis closed\b|— closed,/i.test(after)) contradictions.push(id);
    }
    expect(
      contradictions,
      "An entry whose Status says open and whose body says closed is the exact shape that " +
        "made the maintainer report 'no open findings' to the owner. QV-17 and QV-18 were " +
        "both in this state.",
    ).toEqual([]);
  });
});
