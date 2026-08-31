import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Written by qa-adversary.
 *
 * WHY THIS IS A SOURCE-SHAPE TEST AND NOT A BEHAVIOURAL ONE.
 *
 * `lib/actions/**` carries every write in the product and, measured with
 * `vitest run --coverage`, has 0.14% statement coverage. A behavioural test needs a real
 * Postgres and a Next request scope; the Vitest environment has neither (`vitest.config.ts`
 * pins a fake `DATABASE_URL`). The behavioural gap is filed in `docs/qa/coverage.md` and is
 * an engineer's to close in Playwright.
 *
 * What CAN be asserted here, deterministically and with no database, is the property the
 * whole authorisation model rests on: **a Server Action is a public HTTP endpoint, and its
 * first act must be to establish who is calling.** Every regression in this class looks the
 * same — a new action written by copying a neighbour and dropping the guard line, which
 * typechecks, lints, renders and ships.
 *
 * These tests read the source. That is the point: they fail on the shape of the code before
 * anyone has to reproduce the exploit.
 */

const ROOT = resolve(__dirname, "..", "..");
const ACTIONS_DIR = resolve(__dirname);

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * Source with comments and string literals of prose stripped. Every assertion below is about
 * what the code DOES; a sentence in a comment explaining why something is not done must not
 * be able to fail the test that proves it is not done.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*/g, "$1 ");
}

function walk(dir: string, filter: (p: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    if (statSync(full).isDirectory()) out.push(...walk(full, filter));
    else if (filter(full)) out.push(full);
  }
  return out;
}

/** Source files in `lib/actions` that declare `"use server"`. */
const actionModules = readdirSync(ACTIONS_DIR)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((f) => ({ name: f, path: join(ACTIONS_DIR, f), source: read(join(ACTIONS_DIR, f)) }))
  .filter((m) => /^["']use server["'];/m.test(m.source));

/**
 * Every `export async function name(...)` in a `"use server"` module, with the body text
 * from its signature to the start of the next export.
 */
function exportedActions(source: string): { name: string; body: string }[] {
  const matches = [...source.matchAll(/export async function (\w+)\s*\(/g)];
  return matches.map((m, i) => {
    const start = m.index ?? 0;
    const end = i + 1 < matches.length ? (matches[i + 1]!.index ?? source.length) : source.length;
    return { name: m[1]!, body: source.slice(start, end) };
  });
}

const GUARDS = /await\s+(requireUser|requireEditor|requireAdmin)\s*\(/;

describe("every Server Action establishes the caller before it does anything else", () => {
  it("finds the action modules it is supposed to be checking", () => {
    // A rename or a move must fail loudly rather than silently checking nothing.
    expect(actionModules.map((m) => m.name).sort()).toEqual([
      "connectors.ts",
      "playbooks.ts",
      "taxonomy.ts",
      "tools.ts",
      "workspaces.ts",
    ]);
    const total = actionModules.reduce((n, m) => n + exportedActions(m.source).length, 0);
    expect(total).toBeGreaterThanOrEqual(30);
  });

  for (const mod of actionModules) {
    for (const action of exportedActions(mod.source)) {
      it(`${mod.name} → ${action.name}() calls a require* guard`, () => {
        expect(action.body).toMatch(GUARDS);
      });

      it(`${mod.name} → ${action.name}() guards before it parses input`, () => {
        // An unauthenticated caller must not learn whether their payload was well-formed:
        // a validation error that only a valid payload produces is an oracle.
        const guardAt = action.body.search(GUARDS);
        const parseAt = action.body.search(/\.safeParse\(|\.parse\(/);
        if (parseAt === -1) return; // nothing to order against
        expect(guardAt).toBeGreaterThan(-1);
        expect(guardAt).toBeLessThan(parseAt);
      });

      it(`${mod.name} → ${action.name}() runs inside guard() so no driver error escapes`, () => {
        // `guard()` maps Postgres errors to sentences and strips `detail`, which on a unique
        // violation contains the conflicting value — for users_email_key, an email address.
        expect(action.body).toMatch(/return guard\(/);
      });
    }
  }
});

describe("workspace mutations carry the session user id into SQL", () => {
  const source = read(join(ACTIONS_DIR, "workspaces.ts"));

  for (const action of exportedActions(source)) {
    it(`${action.name}() constrains by user id rather than by a form field`, () => {
      // Either an explicit ownership assertion inside the transaction, or `user.id` in the
      // WHERE clause. What must never appear is a fetch-then-compare in TypeScript.
      const body = code(action.body);
      const scopesToUser =
        /assertOwns(Workspace|Item|Note)\(/.test(body) ||
        /eq\((workspaces|workspaceItems|notes)\.userId,\s*user\.id\)/.test(body) ||
        /user_id\s*=\s*\$\{user\.id\}/.test(body) ||
        // A create writes the session user id in rather than filtering by it.
        /userId:\s*user\.id/.test(body);
      expect(scopesToUser).toBe(true);
    });
  }

  it("never compares ownership in TypeScript after loading the row", () => {
    expect(source).not.toMatch(/\.userId\s*(!==|===)\s*user\.id/);
  });

  it("returns notFound, never forbidden, for a non-owner", () => {
    // A 403 confirms the workspace exists. HANDOFF §11 assertion 2.
    expect(source).not.toMatch(/fail\(\s*["']forbidden["']/);
    expect(source).toMatch(/fail\(\s*["']notFound["']/);
  });

  it("never revalidates a public cache tag from a workspace mutation", () => {
    // caching.md §5: a checkbox click must not purge the catalogue.
    expect(code(source)).not.toMatch(/revalidateTag|revalidatePath/);
  });
});

describe("role levels match the routes that expose them", () => {
  const connectors = read(join(ACTIONS_DIR, "connectors.ts"));
  const taxonomy = read(join(ACTIONS_DIR, "taxonomy.ts"));

  it("connector operations are admin, not editor (sitemap.md §8)", () => {
    for (const action of exportedActions(connectors)) {
      if (!/^(setConnectorEnabled|updateConnector|publishConnector|recheckConnector)$/.test(action.name)) continue;
      expect(action.body).toMatch(/await requireAdmin\(\)/);
    }
  });

  it("category operations are admin", () => {
    for (const action of exportedActions(taxonomy)) {
      if (!/Category|Categories/.test(action.name)) continue;
      expect(action.body).toMatch(/await requireAdmin\(\)/);
    }
  });
});

describe("every /admin page carries its own role guard", () => {
  const adminPages = walk(join(ROOT, "app", "admin"), (p) => p.endsWith("page.tsx"));

  it("finds the admin pages", () => {
    expect(adminPages.length).toBeGreaterThanOrEqual(7);
  });

  for (const page of adminPages) {
    const rel = relative(ROOT, page).replace(/\\/g, "/");
    const source = read(page);

    it(`${rel} calls requireEditorPage or requireAdminPage in the page body`, () => {
      // Not the layout. A layout guard is one parallel route or one streamed loading.tsx
      // away from not running.
      expect(source).toMatch(/await require(Editor|Admin)Page\(\)/);
    });

    it(`${rel} resolves its metadata behind the same role check`, () => {
      // A static `export const metadata` resolves even when the body calls notFound(), so a
      // non-editor gets the 404 body under a title naming the page they were refused.
      expect(source).not.toMatch(/^export const metadata/m);
      if (/generateMetadata/.test(source)) expect(source).toMatch(/adminMetadata\(/);
    });
  }
});

describe("banned constructs, asserted across the whole tree", () => {
  const sources = walk(ROOT, (p) => /\.(ts|tsx)$/.test(p) && !p.includes("node_modules"))
    .filter((p) => {
      const rel = relative(ROOT, p).replace(/\\/g, "/");
      return /^(app|components|lib|config|db|scripts|tests)\//.test(rel);
    })
    .map((p) => ({ rel: relative(ROOT, p).replace(/\\/g, "/"), source: read(p) }));

  it("scans a meaningful number of files", () => {
    expect(sources.length).toBeGreaterThan(100);
  });

  it("contains zero uses of dangerouslySetInnerHTML (ADR 0016 decision 5, as amended)", () => {
    const offenders = sources
      .filter((f) => !f.rel.endsWith(".test.ts") && !f.rel.endsWith(".test.tsx"))
      .filter((f) => /dangerouslySetInnerHTML\s*[=:]/.test(f.source))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("enables no rehype-raw or equivalent HTML passthrough in markdown", () => {
    const offenders = sources
      .filter((f) => !f.rel.endsWith(".test.ts") && !f.rel.endsWith(".test.tsx"))
      .filter((f) => /rehypePlugins=\{[^}]*rehypeRaw|from\s+["']rehype-raw["']|urlTransform=\{/.test(code(f.source)))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("has no source file outside db/schema.ts importing or querying `reviews` (HANDOFF §11 assertion 9)", () => {
    // The identifier, not the English word. `/about` and `/methodology` both say in prose
    // that the product publishes no user reviews — which is ADR 0010's decision being
    // honoured, not breached, and a test that flags it would train people to weaken it.
    const offenders = sources
      .filter((f) => f.rel !== "db/schema.ts" && !/\.(test|spec)\.tsx?$/.test(f.rel))
      .filter((f) =>
        /import\s*\{[^}]*\breviews\b[^}]*\}\s*from|\bfrom\(reviews\)|\breviews\.[a-zA-Z]|db\.query\.reviews\b/.test(
          code(f.source),
        ),
      )
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("stores no hyphenated `needs-review` confidence value (HANDOFF §11 assertion 10)", () => {
    const offenders = sources
      .filter((f) => !f.rel.endsWith(".test.ts") && !f.rel.endsWith(".test.tsx"))
      .filter((f) => /["']needs-review["']/.test(f.source))
      // methodology-anchor.tsx maps the stored value to a URL fragment; that is the one
      // legitimate appearance and it is a documented translation point.
      .filter((f) => f.rel !== "components/layout/methodology-anchor.tsx")
      // `scripts/verify-backend.ts` queries FOR the hyphenated value in order to assert that
      // no row carries it. Excluding the assertion is not excluding the property.
      .filter((f) => f.rel !== "scripts/verify-backend.ts")
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});
