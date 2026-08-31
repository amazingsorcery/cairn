/**
 * Validates authored content in `content/` against the Zod contract and checks cross-file
 * integrity. Run with `pnpm content:check`. CI runs it too — a catalogue that disagrees
 * with itself reaches users as broken links, which is a product failure, not a lint nit.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  categoryFileSchema,
  checkCatalogueIntegrity,
  playbookFrontMatterSchema,
  type CategoryFile,
  type PlaybookFrontMatter,
} from "../lib/content/schema";

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

let failures = 0;
const categories: CategoryFile[] = [];
const playbooks: PlaybookFrontMatter[] = [];

const toolsDir = join(process.cwd(), "content", "tools");
for (const file of readdirSync(toolsDir).filter((f) => f.endsWith(".json"))) {
  const raw: unknown = JSON.parse(readFileSync(join(toolsDir, file), "utf8"));
  const result = categoryFileSchema.safeParse(raw);
  if (!result.success) {
    failures += 1;
    console.error(`FAIL content/tools/${file}`);
    for (const issue of result.error.issues) {
      console.error(`   ${issue.path.join(".")}: ${issue.message}`);
    }
  } else {
    categories.push(result.data);
  }
}

const playbookDir = join(process.cwd(), "content", "playbooks");
if (existsSync(playbookDir)) {
  for (const file of readdirSync(playbookDir).filter((f) => f.endsWith(".md"))) {
    const source = readFileSync(join(playbookDir, file), "utf8");
    const match = FRONT_MATTER.exec(source);
    if (!match?.[1]) {
      failures += 1;
      console.error(`FAIL content/playbooks/${file}: no YAML front matter`);
      continue;
    }

    let frontMatter: unknown;
    try {
      frontMatter = parseYaml(match[1]);
    } catch (error) {
      failures += 1;
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`FAIL content/playbooks/${file}: front matter is not valid YAML — ${detail}`);
      continue;
    }

    const parsed = playbookFrontMatterSchema.safeParse(frontMatter);
    if (!parsed.success) {
      failures += 1;
      console.error(`FAIL content/playbooks/${file}`);
      for (const issue of parsed.error.issues) {
        console.error(`   ${issue.path.join(".")}: ${issue.message}`);
      }
      continue;
    }

    // The prose after the front matter is what a reader actually reads. Valid metadata
    // with no body is a stub, and stubs are the placeholder slop the brief forbids.
    const body = source.slice(match[0].length).trim();
    if (body.length < 400) {
      failures += 1;
      console.error(
        `FAIL content/playbooks/${file}: body is ${body.length} chars — a stub, not a playbook`,
      );
      continue;
    }

    if (parsed.data.slug !== file.replace(/\.md$/, "")) {
      failures += 1;
      console.error(
        `FAIL content/playbooks/${file}: slug "${parsed.data.slug}" does not match the filename`,
      );
      continue;
    }

    playbooks.push(parsed.data);
  }
}

const problems = checkCatalogueIntegrity(categories, playbooks);
const toolCount = categories.reduce((n, c) => n + c.tools.length, 0);
const stepCount = playbooks.reduce((n, p) => n + p.steps.length, 0);
const toolLinks = playbooks.reduce(
  (n, p) => n + p.steps.reduce((m, s) => m + s.tools.length, 0),
  0,
);

const byConfidence = new Map<string, number>();
for (const c of categories) {
  for (const t of c.tools) byConfidence.set(t.confidence, (byConfidence.get(t.confidence) ?? 0) + 1);
}

console.log("");
console.log(`categories      : ${categories.length}`);
console.log(`tools           : ${toolCount}`);
console.log(`playbooks       : ${playbooks.length}`);
console.log(`playbook steps  : ${stepCount}`);
console.log(`step tool links : ${toolLinks} (every one resolved against the catalogue)`);
console.log(
  `confidence      : ${[...byConfidence.entries()].map(([k, v]) => `${k}=${v}`).join(" ")}`,
);

if (problems.length > 0) {
  console.error("\nIntegrity problems:");
  for (const p of problems) console.error(`   ${p}`);
  failures += problems.length;
}

if (failures > 0) {
  console.error(`\n${failures} problem(s). Content is not shippable.`);
  process.exit(1);
}
console.log("\nContent valid.");
