import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every variable the application reads must be documented in `.env.example`.
 *
 * This exists because it already went wrong once: `RATE_LIMIT_SECRET` was added to the Zod
 * schema as a required value with no default, and never added to `.env.example`. Anyone
 * following the runbook would have built a `.env` without it, and the first deploy would
 * have refused to boot — a guaranteed failure, discovered at the worst possible moment, on
 * a fresh server, with a message about a variable they had never heard of.
 *
 * A doc that drifts from the code is worse than no doc, because people trust it.
 */

const schemaSource = readFileSync(join(process.cwd(), "lib", "env.schema.ts"), "utf8");
const exampleSource = readFileSync(join(process.cwd(), ".env.example"), "utf8");

/** Keys declared on the Zod object, e.g. `    APP_URL: z.string()`. */
function schemaKeys(): string[] {
  const keys = new Set<string>();
  for (const match of schemaSource.matchAll(/^\s{4}([A-Z][A-Z0-9_]*):/gm)) {
    if (match[1]) keys.add(match[1]);
  }
  return [...keys].sort();
}

/** Anything documented in .env.example, whether set or commented out. */
function documentedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const match of exampleSource.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)) {
    if (match[1]) keys.add(match[1]);
  }
  return keys;
}

describe(".env.example", () => {
  it("finds the schema keys at all (guards this test against a refactor)", () => {
    const keys = schemaKeys();
    expect(keys.length).toBeGreaterThan(8);
    expect(keys).toContain("DATABASE_URL");
    expect(keys).toContain("AUTH_SECRET");
  });

  it("documents every variable the application reads", () => {
    const documented = documentedKeys();
    const missing = schemaKeys().filter((key) => !documented.has(key));
    expect(missing, `Undocumented in .env.example: ${missing.join(", ")}`).toEqual([]);
  });

  it("never contains a value that looks like a real secret", () => {
    // A committed placeholder that looks usable is how a shared secret reaches production.
    const suspicious: string[] = [];
    for (const line of exampleSource.split("\n")) {
      const match = /^([A-Z][A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN|KEY))=(.+)$/.exec(line.trim());
      const value = match?.[2]?.trim();
      if (!match?.[1] || !value) continue;
      const looksFake = /CHANGEME|changeme|example|placeholder|xxx|your[-_]/i.test(value);
      if (!looksFake) suspicious.push(`${match[1]}=${value}`);
    }
    expect(suspicious, `Possible real secrets in .env.example: ${suspicious.join(", ")}`).toEqual(
      [],
    );
  });
});
