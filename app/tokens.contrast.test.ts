import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The contrast matrix in `app/tokens.css` §4 has to be true, not merely written down.
 *
 * WHY THIS EXISTS — audit finding QV-06. The token file carried a measured ratio beside
 * every pairing somebody had thought of, and nothing at all for the pairings they had not.
 * Light `--muted-foreground` was annotated *"5.11:1 on bg · 5.39:1 on card · 4.79:1 on
 * muted — AA"*, all three of which were true, and all three of which described a third of
 * the surfaces the product actually put it on. Three shipped pages independently reached a
 * fourth surface and rendered 4.45:1, and the only thing that noticed was a browser.
 *
 * So §4 was rewritten as a matrix of *permitted* pairs — and a matrix nobody executes is
 * one refactor away from being exactly the same defect with more words. This file parses
 * that comment block and recomputes every number in it from the token values in the same
 * file. Change a token without re-measuring and this goes red in milliseconds instead of
 * waiting for `tests/e2e/axe.spec.ts`, a browser, and a database.
 *
 * It deliberately duplicates nothing: the expected values live in `tokens.css`, the colours
 * live in `tokens.css`, and the test only checks that one implies the other. It cannot be
 * satisfied by editing this file, only by editing the palette or the matrix.
 *
 * The same argument as `lib/env-documented.test.ts`: a doc that drifts from the code is
 * worse than no doc, because people trust it.
 */

const source = readFileSync(join(process.cwd(), "app", "tokens.css"), "utf8");

/* --- WCAG 2.1 relative luminance and contrast, from first principles ------------------ */

function channels(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  const parse = (at: number): number => Number.parseInt(value.slice(at, at + 2), 16);
  return [parse(0), parse(2), parse(4)];
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((raw) => {
    const s = raw / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

/** `source-over` composite of `fg` at `alpha` onto opaque `bg`, rounded as a browser does. */
function composite(fg: string, bg: string, alpha: number): string {
  const front = channels(fg);
  const back = channels(bg);
  return `#${front
    .map((value, index) => {
      const behind = back[index] ?? 0;
      return Math.floor(value * alpha + behind * (1 - alpha) + 0.5)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`.toUpperCase();
}

/** Two decimals, the precision the matrix is written to. */
const round2 = (value: number): number => Math.round(value * 100) / 100;

/* --- Reading the palette back out of the stylesheet ----------------------------------- */

/** `--slate-900: #0b0f15;` — the primitives, which are the only literal colours. */
function primitives(): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of source.matchAll(/^\s*(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6});/gm)) {
    const [, name, hex] = match;
    if (name && hex) found.set(name, hex.toLowerCase());
  }
  return found;
}

/**
 * `--card: var(--slate-850);` within one theme block. The dark palette is everything
 * between the §2 and §3 banners; the light palette is between §3 and §4.
 */
function semantic(theme: "dark" | "light"): Map<string, string> {
  const banners: Record<"dark" | "light", readonly [string, string]> = {
    dark: ["2. SEMANTIC PALETTE — DARK", "3. SEMANTIC PALETTE — LIGHT"],
    light: ["3. SEMANTIC PALETTE — LIGHT", "4. PERMITTED PAIRINGS"],
  };
  const [opens, closes] = banners[theme];
  const from = source.indexOf(opens);
  const to = source.indexOf(closes);
  expect(from, `${opens} banner is missing from tokens.css`).toBeGreaterThan(-1);
  expect(to, `${closes} banner is missing from tokens.css`).toBeGreaterThan(from);

  const block = source.slice(from, to);
  const raw = primitives();
  const found = new Map<string, string>();
  for (const match of block.matchAll(/^\s*(--[a-z0-9-]+):\s*var\((--[a-z0-9-]+)\);/gm)) {
    const [, name, reference] = match;
    if (!name || !reference) continue;
    const hex = raw.get(reference);
    if (hex) found.set(name, hex);
  }
  return found;
}

const PALETTE = { dark: semantic("dark"), light: semantic("light") } as const;
const THEMES = ["dark", "light"] as const;
type Theme = (typeof THEMES)[number];

function token(theme: Theme, name: string): string {
  const hex = PALETTE[theme].get(name);
  expect(hex, `${name} is not defined in the ${theme} palette`).toBeDefined();
  return hex ?? "";
}

/* --- The matrix rows themselves ------------------------------------------------------- */

const INKS = ["--foreground", "--foreground-secondary", "--muted-foreground"] as const;

interface TextRow {
  surface: string;
  /** Documented `dark / light` ratio per ink, in `INKS` order. */
  documented: [number, number][];
}

/** §4.1: `--card   14.98 / 19.21   8.88 / 12.25   5.86 / 7.78` */
function textRows(): TextRow[] {
  const pattern =
    /^\s*\*\s+(--[a-z-]+)\s+([\d.]+)\s*\/\s*([\d.]+)\s+([\d.]+)\s*\/\s*([\d.]+)\s+([\d.]+)\s*\/\s*([\d.]+)/gm;
  const rows: TextRow[] = [];
  for (const match of source.matchAll(pattern)) {
    const [, surface, ...numbers] = match;
    if (!surface || numbers.length < 6) continue;
    const values = numbers.map(Number);
    rows.push({
      surface,
      documented: [
        [values[0] ?? 0, values[1] ?? 0],
        [values[2] ?? 0, values[3] ?? 0],
        [values[4] ?? 0, values[5] ?? 0],
      ],
    });
  }
  return rows;
}

interface CompositeRow {
  intent: string;
  base: string;
  rendered: [string, string];
  documented: [number, number][];
}

/** §4.2: `bg-info/10 on --card   #1B2936 / #E8F1F6   12.44 / 16.78   7.37 / 10.70   4.87 / 6.79` */
function compositeRows(): CompositeRow[] {
  const pattern =
    /^\s*\*\s+bg-([a-z]+)\/10 on (--[a-z]+)\s+(#[0-9A-F]{6})\s*\/\s*(#[0-9A-F]{6})\s+([\d.]+)\s*\/\s*([\d.]+)\s+([\d.]+)\s*\/\s*([\d.]+)\s+([\d.]+)\s*\/\s*([\d.]+)/gm;
  const rows: CompositeRow[] = [];
  for (const match of source.matchAll(pattern)) {
    const [, intent, base, dark, light, ...numbers] = match;
    if (!intent || !base || !dark || !light || numbers.length < 6) continue;
    const values = numbers.map(Number);
    rows.push({
      intent,
      base,
      rendered: [dark, light],
      documented: [
        [values[0] ?? 0, values[1] ?? 0],
        [values[2] ?? 0, values[3] ?? 0],
        [values[4] ?? 0, values[5] ?? 0],
      ],
    });
  }
  return rows;
}

/**
 * The one cell in §4.1 below 4.5:1, and it is below deliberately. `--muted-foreground` on
 * `--accent` is 4.02:1 in dark, which §4.4 lists as FORBIDDEN rather than hiding: `--accent`
 * cannot be darkened without vanishing against `--popover`, and the palette has no primitive
 * between `--slate-400` and `--slate-300`, so on that one surface the muted step does not
 * exist. Listing it in §4.1 with its real number is the point — the alternative is a blank
 * cell, which is what caused QV-06.
 */
const DOCUMENTED_EXCEPTION = { surface: "--accent", ink: "--muted-foreground", theme: "dark" };

describe("app/tokens.css §4 — the permitted pairing matrix", () => {
  it("finds the palette at all, so a refactor cannot silently empty this suite", () => {
    expect(PALETTE.dark.size).toBeGreaterThan(20);
    expect(PALETTE.light.size).toBeGreaterThan(20);
    expect(textRows().length).toBe(13);
    expect(compositeRows().length).toBe(8);
  });

  it("defines every palette token in both themes", () => {
    const onlyDark = [...PALETTE.dark.keys()].filter((name) => !PALETTE.light.has(name));
    const onlyLight = [...PALETTE.light.keys()].filter((name) => !PALETTE.dark.has(name));
    expect(onlyDark, "tokens defined only in dark").toEqual([]);
    expect(onlyLight, "tokens defined only in light").toEqual([]);
  });

  describe("§4.1 the text ramp", () => {
    for (const row of textRows()) {
      for (const [index, ink] of INKS.entries()) {
        for (const [themeIndex, theme] of THEMES.entries()) {
          const claimed = row.documented[index]?.[themeIndex] ?? 0;

          it(`${ink} on ${row.surface} (${theme}) is documented as ${claimed.toFixed(2)}:1`, () => {
            const measured = round2(contrast(token(theme, ink), token(theme, row.surface)));
            expect(measured, `tokens.css §4.1 claims ${claimed}, the palette gives ${measured}`).toBe(
              claimed,
            );
          });

          const exempt =
            row.surface === DOCUMENTED_EXCEPTION.surface &&
            ink === DOCUMENTED_EXCEPTION.ink &&
            theme === DOCUMENTED_EXCEPTION.theme;

          if (!exempt) {
            it(`${ink} on ${row.surface} (${theme}) meets WCAG 1.4.3 AA`, () => {
              expect(contrast(token(theme, ink), token(theme, row.surface))).toBeGreaterThanOrEqual(
                4.5,
              );
            });
          }
        }
      }
    }
  });

  describe("§4.2 the alpha tints alert.tsx renders", () => {
    for (const row of compositeRows()) {
      for (const [themeIndex, theme] of THEMES.entries()) {
        const rendered = row.rendered[themeIndex] ?? "";

        it(`bg-${row.intent}/10 on ${row.base} (${theme}) composites to ${rendered}`, () => {
          const intent = token(theme, `--${row.intent}`);
          expect(composite(intent, token(theme, row.base), 0.1)).toBe(rendered);
        });

        for (const [index, ink] of INKS.entries()) {
          const claimed = row.documented[index]?.[themeIndex] ?? 0;

          it(`${ink} on bg-${row.intent}/10 over ${row.base} (${theme}) is ${claimed.toFixed(2)}:1 and AA`, () => {
            const measured = contrast(token(theme, ink), rendered);
            expect(round2(measured)).toBe(claimed);
            expect(measured).toBeGreaterThanOrEqual(4.5);
          });
        }
      }
    }
  });

  describe("§4.3 non-text tokens against the 3:1 bar", () => {
    for (const surface of ["--background", "--card", "--popover"]) {
      for (const theme of THEMES) {
        it(`--input on ${surface} (${theme}) meets WCAG 1.4.11`, () => {
          expect(contrast(token(theme, "--input"), token(theme, surface))).toBeGreaterThanOrEqual(3);
        });
      }
    }
  });
});

describe("§4.5 opacity is not a colour strategy", () => {
  /**
   * The other half of QV-06. `opacity-40` on the disabled pagination chips rendered
   * `--foreground` at 2.63:1 in light and 3.36:1 in dark, while every token involved
   * measured over 16:1 — the composite is invisible to any check that reads tokens rather
   * than pixels, including the matrix above. A `<span>` is not a user interface component
   * and cannot be `disabled`, so WCAG 1.4.3's exemption for inactive components does not
   * reach it and it owes the full 4.5:1.
   */
  it("the pagination chips dim with a token, not with alpha", () => {
    const pagination = readFileSync(
      join(process.cwd(), "components", "directory", "pagination.tsx"),
      "utf8",
    );
    // Strip block comments first: the file explains this rule at length, and the prose
    // naming `opacity-40` must not be what fails the check.
    const code = pagination.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/\bopacity-\d/);
    expect(code).toContain("text-muted-foreground");
  });

  it("records what opacity-40 actually rendered, so the number is not lost", () => {
    expect(composite(token("light", "--foreground"), token("light", "--background"), 0.4)).toBe(
      "#999B9F",
    );
    expect(composite(token("dark", "--foreground"), token("dark", "--background"), 0.4)).toBe(
      "#62676E",
    );
    // axe reported 2.63:1 and 3.36:1 against these same pixels; recomputing from the
    // 8-bit-rounded composite gives 2.64:1 and 3.37:1. Both are 0.01 apart, consistently,
    // because axe blends in full precision and the screen does not. That is a disagreement
    // about the last digit, not about whether it failed, and pretending otherwise by
    // asserting axe's number here would be the same sin this file exists to prevent.
    expect(round2(contrast("#999B9F", token("light", "--background")))).toBe(2.64);
    expect(round2(contrast("#62676E", token("dark", "--background")))).toBe(3.37);
    expect(contrast("#999B9F", token("light", "--background"))).toBeLessThan(4.5);
    expect(contrast("#62676E", token("dark", "--background"))).toBeLessThan(4.5);
  });
});

/*
 * QV-26. The matrix was internally consistent and did not have to be COMPLETE.
 *
 * QA added `--qa-callout-surface: var(--slate-450)` to both theme blocks — a pairing at
 * 2.15:1 light and 1.19:1 dark, the worst in the palette — and all 229 assertions stayed
 * green. Every documented number was still true. Nothing checked that the matrix described
 * the palette it was written for.
 *
 * That is QV-06's own defect one level up, living inside the file written to prevent it: a
 * document is only a guard when it must grow as the thing it guards grows.
 *
 * So: every semantic token is either in the matrix, or explicitly classified below as
 * something text never sits on. A new token belongs to neither set until somebody decides,
 * and until then this fails. That is the point — the decision is cheap, and skipping it is
 * what produced both QV-06 and QV-26.
 */
const NOT_A_TEXT_SURFACE = new Set([
  // Inks. They sit ON surfaces; §4.1 measures them as foregrounds.
  "--foreground",
  "--foreground-secondary",
  "--foreground-faint",
  "--muted-foreground",
  "--card-foreground",
  "--popover-foreground",
  "--accent-foreground",
  "--secondary-foreground",
  "--primary-foreground",
  "--destructive-foreground",
  "--info-foreground",
  "--warning-foreground",
  "--success-foreground",
  "--confidence-verified-foreground",
  "--confidence-high-foreground",
  "--confidence-medium-foreground",
  "--confidence-review-foreground",
  // Lines, rings and fills. Non-text; §4.3 holds them to 3:1, not 4.5:1.
  "--border",
  "--input",
  "--ring",
  "--confidence-track",
  "--overlay-scrim",
  // Accent hues used as chip fills and icon strokes, each with its own -surface and
  // -foreground pair measured in §4.1. The bare hue never carries body text.
  "--primary",
  "--destructive",
  "--info",
  "--warning",
  "--success",
  "--confidence-verified",
  "--confidence-high",
  "--confidence-medium",
  "--confidence-review",
  /*
   * A component fill, not a text-ramp surface, and this is the evidence rather than a
   * convenience: `bg-secondary` has exactly six call sites — `badge.tsx`, `button.tsx`, and
   * four `file:bg-secondary` upload buttons — and every one pairs it with
   * `--secondary-foreground` or inherited `--foreground`. Both measure **6.53 dark / 15.23
   * light**, comfortably AA.
   *
   * It is excluded because the muted ramp is never rendered on it, NOT because it would
   * fail: `--foreground-secondary` gives 3.87 and `--muted-foreground` 2.56 in dark, both
   * below AA. Those numbers are in §4.4 as forbidden pairs so the exclusion is a recorded
   * decision rather than a silence. Put muted ink on this surface and §4.4 is the answer.
   *
   * Found by this file's own coverage test on its first run — the matrix had never described
   * this surface at all.
   */
  "--secondary",
  // Button-fill variants of --primary. Each carries --primary-foreground, never the ramp.
  "--primary-hover",
  "--primary-solid",
]);

/** Semantic tokens declared in the theme blocks, ignoring the raw palette and the Tailwind bridge. */
function semanticTokenNames(): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/^\s+(--[a-z0-9-]+)\s*:/gm)) {
    const name = match[1];
    if (!name) continue;
    // `--color-*` is the Tailwind `@theme inline` bridge, not a colour decision.
    if (name.startsWith("--color-")) continue;
    // Raw palette primitives are inputs to semantic tokens, never used directly.
    if (/^--[a-z]+-\d+$/.test(name)) continue;
    // Non-colour tokens: spacing, radii, motion, z-index, fonts.
    if (/^--(space|radius|shadow|duration|ease|z|font|text|leading|tracking)-/.test(name)) continue;
    // Non-colour tokens without a namespace prefix, plus Tailwind v4's own defaults.
    if (/^--(radius|spacing|default-)/.test(name)) continue;
    names.add(name);
  }
  return [...names].sort();
}

describe("§4 coverage — the matrix must describe the whole palette", () => {
  it("classifies every semantic colour token as a text surface or explicitly not one", () => {
    const documented = new Set(textRows().map((row) => row.surface));
    const unclassified = semanticTokenNames().filter(
      (name) => !documented.has(name) && !NOT_A_TEXT_SURFACE.has(name),
    );

    expect(
      unclassified,
      `These tokens are in app/tokens.css and in neither §4.1 nor NOT_A_TEXT_SURFACE. ` +
        `Add each to the pairing matrix with its measured ratios, or classify it as something ` +
        `text never sits on. A token that is in neither set is one nobody has checked — which ` +
        `is exactly how --muted-foreground came to be documented against three of the thirteen ` +
        `surfaces it actually renders on.`,
    ).toEqual([]);
  });

  it("does not classify a token that no longer exists", () => {
    // The other direction: a stale entry in either list is a claim about a token that is gone,
    // and a matrix describing a palette that has moved is how the original defect started.
    const live = new Set(semanticTokenNames());
    const stale = [...NOT_A_TEXT_SURFACE].filter((name) => !live.has(name));
    expect(stale, "NOT_A_TEXT_SURFACE names tokens that are no longer in tokens.css").toEqual([]);
  });
});
