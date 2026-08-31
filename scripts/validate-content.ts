/**
 * Validates authored content in `content/` against the Zod contract and checks
 * cross-file integrity. Run with `pnpm content:check`. CI runs it too — a catalogue that
 * disagrees with itself is a broken product, not a lint nit.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  categoryFileSchema,
  playbookFrontMatterSchema,
  checkCatalogueIntegrity,
  type CategoryFile,
  type PlaybookFrontMatter,
} from "../lib/content/schema";

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
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
    if (!match?.[1]) {
      failures += 1;
      console.error(`FAIL content/playbooks/${file}: no YAML front matter`);
      continue;
    }
    console.log(`   found front matter in ${file} (${match[1].length} chars)`);
  }
}

const problems = checkCatalogueIntegrity(categories, playbooks);
const toolCount = categories.reduce((n, c) => n + c.tools.length, 0);

console.log("");
console.log(`categories : ${categories.length}`);
console.log(`tools      : ${toolCount}`);
console.log(`playbooks  : ${playbooks.length}`);

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
