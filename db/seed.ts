/**
 * Seed loader. `pnpm db:seed`.
 *
 * Reads `content/` — authored by the content-strategist — validates every record through
 * `lib/content/schema.ts`, and upserts it. It invents nothing: every field written here
 * comes from an authored file or is derived from one by a rule stated in this file.
 *
 * FOUR PROPERTIES, each of which is a requirement rather than a nicety:
 *
 * 1. **Validate everything before writing anything.** A half-loaded catalogue is worse than
 *    an unloaded one: it looks complete and is not. Every file is parsed and every
 *    cross-file integrity rule is checked before the first INSERT.
 *
 * 2. **Fail loudly, never skip.** product-brief §6: "a single fabricated entry destroys the
 *    product's credibility on day one", and a silently dropped entry is a catalogue that
 *    quietly disagrees with its own verification log. A bad record aborts the run with the
 *    file, the slug and the reason.
 *
 * 3. **Idempotent.** Safe to run twice. Everything upserts by slug, so a second run changes
 *    nothing but `updated_at`. docs/deploy/HANDOFF.md A#10: `deploy.sh` never runs this —
 *    seeding is a manual first-deploy step precisely so a redeploy cannot overwrite
 *    editorial changes.
 *
 * 4. **`search_keywords` is computed here too.** The seed bypasses the Server Actions, so it
 *    calls the same fan-out helpers they do (`lib/actions/search-keywords.ts`), in the same
 *    transaction as the write. A seeded catalogue with empty `search_keywords` is a
 *    catalogue where no facet search works, and nothing errors.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it never sets `last_verified_at` to anything other than
 * the authored date, and it never marks an entry more confident than the content says.
 * ADR 0007's consequences: "a reviewer should treat a seed file full of `verified` as a red
 * flag" — so this script copies the authored value and nothing else.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { eq, sql } from "drizzle-orm";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import {
  cameras,
  categories,
  connectors,
  playbookStepTools,
  playbookSteps,
  playbooks,
  tags,
  toolTags,
  tools,
} from "@/db/schema";
import {
  cameraProviderFileSchema,
  categoryFileSchema,
  checkCameraIntegrity,
  checkCatalogueIntegrity,
  playbookFrontMatterSchema,
  slugSchema,
  type CameraProviderFile,
  type CategoryFile,
  type PlaybookFrontMatter,
} from "@/lib/content/schema";
import {
  recomputePlaybookSearchKeywords,
  recomputeToolSearchKeywords,
} from "@/lib/actions/search-keywords";
import { closeDb, db, type Db } from "@/lib/db";
import { FLIGHTS_CONNECTOR_SEED } from "@/lib/connectors/flights";
import { SOURCE_CONNECTOR_SEEDS } from "@/lib/sources/connector-seeds";
import {
  CAMERA_SUBJECT_TO_VIEW_KIND,
  assertCameraSubjectsMapped,
} from "@/lib/validation/connectors";
import { assertCostModelsAligned } from "@/lib/validation/vocabulary";

const here = dirname(fileURLToPath(import.meta.url));
const contentDir = join(here, "..", "content");

/* ================================================================== *
 * Load and validate — nothing is written until all of this succeeds
 * ================================================================== */

class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedError";
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new SeedError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}

function explain(path: string, error: z.ZodError): string {
  const lines = error.issues.map((i) => `    ${i.path.join(".") || "(root)"}: ${i.message}`);
  return `${path}\n${lines.join("\n")}`;
}

function loadToolFiles(): CategoryFile[] {
  const dir = join(contentDir, "tools");
  if (!existsSync(dir)) throw new SeedError(`${dir} does not exist. There is nothing to seed.`);

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (files.length === 0) throw new SeedError(`${dir} contains no .json files.`);

  const problems: string[] = [];
  const parsed: CategoryFile[] = [];

  for (const file of files) {
    const result = categoryFileSchema.safeParse(readJson(join(dir, file)));
    if (!result.success) problems.push(explain(`content/tools/${file}`, result.error));
    else parsed.push(result.data);
  }

  if (problems.length > 0) throw new SeedError(`Invalid tool content:\n${problems.join("\n")}`);
  return parsed;
}

/**
 * Playbook front matter is YAML between the first pair of `---` fences; everything after the
 * closing fence is the Markdown OVERVIEW — the lead-in shown above the step list.
 *
 * The step BODIES are in the front matter (as YAML block scalars), not in the Markdown, so
 * this split loses nothing.
 */
function splitFrontMatter(source: string, path: string): { frontMatter: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!match || match[1] === undefined) {
    throw new SeedError(`${path}: no YAML front matter. Every playbook must open with '---'.`);
  }
  return { frontMatter: match[1], body: (match[2] ?? "").trim() };
}

type LoadedPlaybook = { frontMatter: PlaybookFrontMatter; overview: string | null };

function loadPlaybooks(): LoadedPlaybook[] {
  const dir = join(contentDir, "playbooks");
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  const problems: string[] = [];
  const parsed: LoadedPlaybook[] = [];

  for (const file of files) {
    const path = `content/playbooks/${file}`;
    const { frontMatter, body } = splitFrontMatter(readFileSync(join(dir, file), "utf8"), path);

    let raw: unknown;
    try {
      raw = parseYaml(frontMatter);
    } catch (error) {
      problems.push(`${path}\n    front matter is not valid YAML: ${(error as Error).message}`);
      continue;
    }

    const result = playbookFrontMatterSchema.safeParse(raw);
    if (!result.success) problems.push(explain(path, result.error));
    else parsed.push({ frontMatter: result.data, overview: body || null });
  }

  if (problems.length > 0) throw new SeedError(`Invalid playbook content:\n${problems.join("\n")}`);
  return parsed;
}

/**
 * The camera provider block carries more than `cameraProviderFileSchema` validates — it also
 * describes the CONNECTOR that gives us the legal basis for embedding its feeds. Zod strips
 * unknown keys, so those fields are parsed separately here rather than by widening the
 * content contract, which belongs to the content-strategist.
 *
 * `connectorKind: null` means link-out only: the reader's browser goes to the operator
 * directly, we make no call, and no connector is needed
 * (`cameras_embed_requires_connector_check` only bites when `embed_permitted` is true).
 */
const providerConnectorSchema = z.object({
  slug: slugSchema,
  name: z.string().min(2),
  operator: z.string().min(2),
  jurisdiction: z.string().min(2),
  connectorKind: z.enum(["cameras", "flights"]).nullable(),
  apiUrl: z.string().url().optional(),
  termsUrl: z.string().url().nullable(),
  licence: z.string().min(2),
  attributionRequired: z.boolean(),
  attribution: z.string().min(2).nullable(),
  rateLimitNotes: z.string().min(2),
  lastVerifiedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
type ProviderConnector = z.infer<typeof providerConnectorSchema>;

type LoadedCameraFile = { file: CameraProviderFile; connector: ProviderConnector | null };

function loadCameras(): LoadedCameraFile[] {
  const dir = join(contentDir, "cameras");
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  const problems: string[] = [];
  const parsed: LoadedCameraFile[] = [];

  for (const name of files) {
    const path = `content/cameras/${name}`;
    const raw = readJson(join(dir, name));

    const result = cameraProviderFileSchema.safeParse(raw);
    if (!result.success) {
      problems.push(explain(path, result.error));
      continue;
    }

    const providerRaw = (raw as { provider?: unknown }).provider;
    const connector = providerConnectorSchema.safeParse(providerRaw);
    if (!connector.success) {
      problems.push(explain(`${path} (provider connector fields)`, connector.error));
      continue;
    }

    parsed.push({
      file: result.data,
      connector: connector.data.connectorKind === null ? null : connector.data,
    });
  }

  if (problems.length > 0) throw new SeedError(`Invalid camera content:\n${problems.join("\n")}`);
  return parsed;
}

/* ================================================================== *
 * Derivations — every one of these is a stated rule, not a guess
 * ================================================================== */

/**
 * THE ONE TRANSLATION THAT MATTERS.
 *
 * Content numbers playbook steps from **1** (`order: 1`, checked by
 * `checkCatalogueIntegrity`, which requires exactly `1..n` in order). The schema stores
 * `order_index` **0-based and contiguous** (db/schema.ts, HANDOFF §3), and the DEFERRABLE
 * unique constraint plus `playbook_steps_order_index_check` both key off that.
 *
 * Off-by-one here does not error. It produces a playbook whose steps are numbered 2..n+1 in
 * the UI, or one whose first step sorts last. Exported and unit-tested for exactly that
 * reason.
 */
export function toOrderIndex(contentOrder: number): number {
  if (!Number.isInteger(contentOrder) || contentOrder < 1) {
    throw new SeedError(
      `Playbook step order must be a whole number from 1, got ${contentOrder}. ` +
        "Content is 1-based; the database column is 0-based.",
    );
  }
  return contentOrder - 1;
}

/**
 * The same translation applied to a whole step list, with the contiguity invariant asserted
 * on the OUTPUT rather than assumed from the input. `checkCatalogueIntegrity` already checks
 * the 1-based side; this checks what we are about to write.
 */
export function toOrderIndexes(contentOrders: readonly number[]): number[] {
  const indexes = contentOrders.map(toOrderIndex);
  const sorted = [...indexes].sort((a, b) => a - b);
  const expected = Array.from({ length: sorted.length }, (_, i) => i);
  if (sorted.join(",") !== expected.join(",")) {
    throw new SeedError(
      `Playbook steps must translate to a contiguous 0-based range, got [${sorted.join(", ")}] ` +
        `from content orders [${contentOrders.join(", ")}].`,
    );
  }
  return indexes;
}

/**
 * A display name for a tag, from its authored slug.
 *
 * Content authors tags as slugs only (`["certificates", "attack-surface"]`) and `tags.name`
 * is NOT NULL, so a label has to come from somewhere. Deriving it — hyphens to spaces, first
 * letter capitalised — is a presentational rule, not a claim about the world, so it does not
 * cross product-brief §6's prohibition on inventing facts.
 *
 * Known-acronym casing is deliberately NOT special-cased: a list of exceptions here would
 * drift from the content and be invisible when it did. An editor can rename any tag in
 * `/admin/taxonomy`, and the rename fans out to `search_keywords` correctly.
 */
export function tagNameFromSlug(slug: string): string {
  const words = slug.split("-").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * An authored `YYYY-MM-DD` becomes midnight UTC.
 *
 * UTC rather than local: the container's `TZ` must not be able to move a verification date
 * across a day boundary. product-brief §6.3 — it is never back-dated or forward-dated.
 */
export function toUtcDate(iso: string): Date {
  const date = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new SeedError(`"${iso}" is not a calendar date`);
  return date;
}

/* ================================================================== *
 * Write
 * ================================================================== */

type Counts = Record<string, number>;

/**
 * Upsert one category and return its id. `onConflictDoUpdate` on the slug is what makes the
 * whole script re-runnable: a second run finds the row and updates it in place, so ids are
 * stable and every FK that points at them survives.
 */
async function upsertCategories(tx: Db, files: CategoryFile[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const [index, file] of files.entries()) {
    const [row] = await tx
      .insert(categories)
      .values({
        slug: file.category.slug,
        name: file.category.name,
        description: file.category.description,
        // Files are read in sorted order, so the ordering is stable across runs. An editor
        // can reorder them afterwards in /admin/taxonomy; a re-seed will reset it, which is
        // why the seed is a manual first-deploy step and not part of deploy.sh.
        sortOrder: index,
      })
      .onConflictDoUpdate({
        target: categories.slug,
        set: {
          name: file.category.name,
          description: file.category.description,
          updatedAt: new Date(),
        },
      })
      .returning({ id: categories.id });

    if (!row) throw new SeedError(`Upsert returned no row for category ${file.category.slug}`);
    ids.set(file.category.slug, row.id);
  }

  return ids;
}

async function upsertTags(tx: Db, slugs: readonly string[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const slug of [...slugs].sort()) {
    const [row] = await tx
      .insert(tags)
      .values({ slug, name: tagNameFromSlug(slug) })
      .onConflictDoUpdate({
        target: tags.slug,
        // The NAME is not overwritten on conflict: an editor may have corrected the derived
        // label (e.g. "Tls" to "TLS"), and a re-seed must not undo editorial work.
        set: { updatedAt: new Date() },
      })
      .returning({ id: tags.id });

    if (!row) throw new SeedError(`Upsert returned no row for tag ${slug}`);
    ids.set(slug, row.id);
  }

  return ids;
}

async function upsertTools(
  tx: Db,
  files: CategoryFile[],
  categoryIds: Map<string, string>,
  tagIds: Map<string, string>,
  now: Date,
): Promise<string[]> {
  const toolIds: string[] = [];

  for (const file of files) {
    const categoryId = categoryIds.get(file.category.slug);
    if (!categoryId) throw new SeedError(`No category id for ${file.category.slug}`);

    for (const tool of file.tools) {
      /**
       * PUBLISHED, deliberately. `tools_published_requires_verification_check` requires
       * `last_verified_at` AND `reliability`, and the content contract makes both mandatory
       * on every authored tool — so every seeded tool clears the ADR 0007 gate honestly,
       * with the editor's own date and rating rather than a value invented here.
       *
       * `confidence` is copied verbatim. It is never upgraded to get past anything, because
       * nothing here needs upgrading to pass.
       */
      const lastVerifiedAt = toUtcDate(tool.lastVerifiedAt);

      const [row] = await tx
        .insert(tools)
        .values({
          slug: tool.slug,
          name: tool.name,
          url: tool.url,
          summary: tool.summary,
          description: tool.description,
          categoryId,
          inputTypes: tool.inputTypes,
          outputTypes: tool.outputTypes,
          costModel: tool.costModel,
          costNotes: tool.costNotes,
          jurisdiction: tool.jurisdiction,
          legalNotes: tool.legalNotes,
          lastVerifiedAt,
          reliability: tool.reliability,
          reliabilityNotes: tool.reliabilityNotes,
          confidence: tool.confidence,
          status: "published",
          publishedAt: now,
        })
        .onConflictDoUpdate({
          target: tools.slug,
          set: {
            name: tool.name,
            url: tool.url,
            summary: tool.summary,
            description: tool.description,
            categoryId,
            inputTypes: tool.inputTypes,
            outputTypes: tool.outputTypes,
            costModel: tool.costModel,
            costNotes: tool.costNotes,
            jurisdiction: tool.jurisdiction,
            legalNotes: tool.legalNotes,
            lastVerifiedAt,
            reliability: tool.reliability,
            reliabilityNotes: tool.reliabilityNotes,
            confidence: tool.confidence,
            updatedAt: new Date(),
            // `status` and `published_at` are NOT reset on conflict. An editor who
            // unpublished an entry did so for a reason, and a re-seed must not quietly
            // republish it.
          },
        })
        .returning({ id: tools.id });

      if (!row) throw new SeedError(`Upsert returned no row for tool ${tool.slug}`);
      toolIds.push(row.id);

      // Replace the tag set wholesale, so a tag removed from the content file is removed
      // from the row rather than accumulating forever.
      await tx.delete(toolTags).where(eq(toolTags.toolId, row.id));
      if (tool.tags.length > 0) {
        const links = tool.tags.map((slug) => {
          const tagId = tagIds.get(slug);
          if (!tagId) throw new SeedError(`Tool ${tool.slug} references unknown tag ${slug}`);
          return { toolId: row.id, tagId };
        });
        await tx.insert(toolTags).values(links).onConflictDoNothing();
      }
    }
  }

  return toolIds;
}

async function upsertPlaybooks(
  tx: Db,
  loaded: LoadedPlaybook[],
  categoryIds: Map<string, string>,
  toolIdBySlug: Map<string, string>,
  now: Date,
): Promise<string[]> {
  const playbookIds: string[] = [];

  for (const { frontMatter, overview } of loaded) {
    const categoryId = categoryIds.get(frontMatter.category);
    if (!categoryId) {
      throw new SeedError(
        `Playbook ${frontMatter.slug} references unknown category ${frontMatter.category}`,
      );
    }

    /**
     * `confidence` is left at the column default `needsReview`.
     *
     * The playbook front-matter contract has no `confidence` field, and product-brief §6
     * forbids inventing one. `needsReview` is the honest value for "no editorial judgement
     * has been recorded", and it errs toward the reader's scepticism rather than away from
     * it. This is flagged in the run summary and in docs/backend/HANDOFF.md: if playbooks
     * should carry a confidence, it belongs in the front matter, not here.
     */
    const lastVerifiedAt = toUtcDate(frontMatter.lastReviewedAt);

    const [row] = await tx
      .insert(playbooks)
      .values({
        slug: frontMatter.slug,
        title: frontMatter.title,
        summary: frontMatter.summary,
        overview,
        categoryId,
        difficulty: frontMatter.difficulty,
        estimatedMinutes: frontMatter.estimatedMinutes,
        lastVerifiedAt,
        status: "published",
        publishedAt: now,
      })
      .onConflictDoUpdate({
        target: playbooks.slug,
        set: {
          title: frontMatter.title,
          summary: frontMatter.summary,
          overview,
          categoryId,
          difficulty: frontMatter.difficulty,
          estimatedMinutes: frontMatter.estimatedMinutes,
          lastVerifiedAt,
          updatedAt: new Date(),
        },
      })
      .returning({ id: playbooks.id });

    if (!row) throw new SeedError(`Upsert returned no row for playbook ${frontMatter.slug}`);
    playbookIds.push(row.id);

    /**
     * Steps are replaced wholesale rather than upserted.
     *
     * There is no natural key for a step — content identifies it by position, and position
     * is exactly what an edit changes — so a diff would be guesswork. Deleting and
     * reinserting is correct and safe: `workspace_items.step_id` is ON DELETE SET NULL, so
     * every user's checklist keeps its snapshot title and checked state (ADR 0008).
     *
     * `playbook_steps_playbook_order_uniq` is DEFERRABLE INITIALLY DEFERRED, so the delete
     * and the insert can both happen inside this transaction without a transient duplicate
     * aborting it.
     */
    await tx.delete(playbookSteps).where(eq(playbookSteps.playbookId, row.id));

    const orderIndexes = toOrderIndexes(frontMatter.steps.map((s) => s.order));

    const inserted = await tx
      .insert(playbookSteps)
      .values(
        frontMatter.steps.map((step, i) => {
          const orderIndex = orderIndexes[i];
          if (orderIndex === undefined) {
            throw new SeedError(`Missing translated order index for step ${step.order}`);
          }
          return {
            playbookId: row.id,
            orderIndex,
            title: step.title,
            objective: step.objective,
            body: step.body,
            doneWhen: step.doneWhen,
          };
        }),
      )
      .returning({ id: playbookSteps.id, orderIndex: playbookSteps.orderIndex });

    const stepIdByOrderIndex = new Map(inserted.map((s) => [s.orderIndex, s.id]));

    const links = frontMatter.steps.flatMap((step, i) => {
      const orderIndex = orderIndexes[i];
      if (orderIndex === undefined) return [];
      const stepId = stepIdByOrderIndex.get(orderIndex);
      if (!stepId) throw new SeedError(`No inserted step for order index ${orderIndex}`);

      return step.tools.map((link, linkIndex) => {
        const toolId = toolIdBySlug.get(link.slug);
        if (!toolId) {
          throw new SeedError(
            `Playbook ${frontMatter.slug} step ${step.order} links to unknown tool "${link.slug}"`,
          );
        }
        return { stepId, toolId, note: link.note ?? null, orderIndex: linkIndex };
      });
    });

    if (links.length > 0) {
      await tx.insert(playbookStepTools).values(links).onConflictDoNothing();
    }
  }

  return playbookIds;
}

/**
 * Camera providers become connector rows.
 *
 * ADR 0012 §4: publishing a camera that EMBEDS requires a connector, because rendering a
 * third party's feed inside our page relies on a permission and a recorded permission lives
 * on a connector. The provider block in `content/cameras/*.json` carries exactly what that
 * row needs — operator, terms URL, licence, attribution, rate-limit notes and a check date.
 *
 * `enabled` is FALSE for every camera connector, and that is correct rather than cautious:
 * nothing ever calls them. `/live/cameras` makes zero outbound requests on load (sitemap.md
 * §3) and embeds are click-to-load from the reader's own browser straight to the operator
 * (ADR 0015). The row exists to hold the legal basis, not to be called.
 *
 * `status` is `published` because `status` is the EDITORIAL axis — is this connector part of
 * the shipped product — and it is: it is the recorded basis behind published camera entries.
 * ADR 0012 §1 keeps the two axes separate for exactly this kind of case.
 */
async function upsertCameraConnectors(
  tx: Db,
  files: LoadedCameraFile[],
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const { connector } of files) {
    if (!connector) continue;

    const values = {
      slug: connector.slug,
      name: connector.name,
      kind: "cameras" as const,
      operatorName: connector.operator,
      homepageUrl: connector.termsUrl ?? connector.apiUrl ?? "https://example.invalid",
      termsUrl: connector.termsUrl,
      attribution: connector.attribution,
      attributionRequired: connector.attributionRequired,
      legalBasis:
        `Licence: ${connector.licence}. ${connector.rateLimitNotes} ` +
        `Terms read ${connector.lastVerifiedAt}. Camera feeds are click-to-load from the ` +
        `reader's own browser to the operator (ADR 0015); we make no outbound call and ` +
        `retain no imagery. NOT A LEGAL OPINION — see docs/content/legal-review.md.`,
      baseUrl: connector.apiUrl ?? connector.termsUrl ?? "https://example.invalid",
      requiresApiKey: false,
      apiKeyEnvVar: null,
      /**
       * Quota columns are NOT NULL and CHECK-constrained positive even for a connector
       * nothing calls, so they carry deliberately small values rather than a pretend-large
       * number: if a future code path ever does call one, it should be throttled, not
       * unlimited.
       */
      perUserQuota: 10,
      globalCeiling: 30,
      windowSeconds: 60,
      timeoutMs: 5000,
      /** ADR 0014 §2 starting values for a camera REGISTRY: slow-moving, not per-frame. */
      cacheTtlSeconds: 900,
      staleWhileRevalidateSeconds: 3600,
      enabled: false,
      status: "published" as const,
      lastCheckedAt: toUtcDate(connector.lastVerifiedAt),
      notes: `Seeded from content/cameras/. ${connector.rateLimitNotes}`,
    };

    const [row] = await tx
      .insert(connectors)
      .values(values)
      .onConflictDoUpdate({
        target: connectors.slug,
        set: {
          name: values.name,
          operatorName: values.operatorName,
          termsUrl: values.termsUrl,
          attribution: values.attribution,
          attributionRequired: values.attributionRequired,
          legalBasis: values.legalBasis,
          baseUrl: values.baseUrl,
          lastCheckedAt: values.lastCheckedAt,
          notes: values.notes,
          updatedAt: new Date(),
          // `enabled` and `status` are NOT reset. An operator who hit the kill-switch did so
          // for a reason and a re-seed must not undo it (ADR 0011 rule 6).
        },
      })
      .returning({ id: connectors.id });

    if (!row) throw new SeedError(`Upsert returned no row for connector ${connector.slug}`);
    ids.set(connector.slug, row.id);
  }

  return ids;
}

/**
 * The flights connector. Its registry values live beside its driver in
 * `lib/connectors/flights.ts`, where the endpoint, licence and quota envelope are reviewed
 * together, and are written here as data because ADR 0012 is explicit that a kill-switch
 * requiring a deploy is not a kill-switch.
 *
 * Seeded `draft` and `enabled: false` — fail closed (ADR 0012 §1). Unlike the camera
 * connectors, this one really does make outbound calls, so an operator must read the
 * recorded legal basis and turn it on deliberately. `/live/flights` renders its `disabled`
 * state until they do, which is honest rather than broken.
 */
async function upsertFlightsConnector(tx: Db): Promise<void> {
  const seed = FLIGHTS_CONNECTOR_SEED;
  await tx
    .insert(connectors)
    .values({ ...seed, lastCheckedAt: toUtcDate("2026-08-31") })
    .onConflictDoUpdate({
      target: connectors.slug,
      set: {
        name: seed.name,
        operatorName: seed.operatorName,
        homepageUrl: seed.homepageUrl,
        termsUrl: seed.termsUrl,
        attribution: seed.attribution,
        attributionRequired: seed.attributionRequired,
        legalBasis: seed.legalBasis,
        baseUrl: seed.baseUrl,
        notes: seed.notes,
        updatedAt: new Date(),
        // `enabled`, `status` and `lastCheckedAt` are not reset: they are the operator's.
      },
    });
}

/**
 * Registry rows for every wired live source.
 *
 * Without these `pollSource` refuses each adapter before any request — correctly, since
 * §3.3 requires a recorded basis — and `/map` ships with every layer permanently
 * unavailable on a fresh database. The map engineer found that exactly this had happened to
 * earthquakes and weather.
 *
 * Seeded `draft` and `enabled: false` like the flights connector, for the same reason: these
 * make real outbound calls, so an operator reads the recorded legal basis and turns each one
 * on deliberately. A re-seed never resets `enabled`, `status` or `lastCheckedAt` — those are
 * the operator's, not ours.
 */
async function upsertSourceConnectors(tx: Db): Promise<number> {
  for (const seed of SOURCE_CONNECTOR_SEEDS) {
    await tx
      .insert(connectors)
      .values({ ...seed, lastCheckedAt: toUtcDate("2026-08-31") })
      .onConflictDoUpdate({
        target: connectors.slug,
        set: {
          name: seed.name,
          operatorName: seed.operatorName,
          homepageUrl: seed.homepageUrl,
          termsUrl: seed.termsUrl,
          attribution: seed.attribution,
          attributionRequired: seed.attributionRequired,
          legalBasis: seed.legalBasis,
          baseUrl: seed.baseUrl,
          requiresApiKey: seed.requiresApiKey,
          apiKeyEnvVar: seed.apiKeyEnvVar,
          perUserQuota: seed.perUserQuota,
          globalCeiling: seed.globalCeiling,
          windowSeconds: seed.windowSeconds,
          timeoutMs: seed.timeoutMs,
          cacheTtlSeconds: seed.cacheTtlSeconds,
          staleWhileRevalidateSeconds: seed.staleWhileRevalidateSeconds,
          notes: seed.notes,
          updatedAt: new Date(),
        },
      });
  }
  return SOURCE_CONNECTOR_SEEDS.length;
}

async function upsertCameras(
  tx: Db,
  files: LoadedCameraFile[],
  connectorIds: Map<string, string>,
  now: Date,
): Promise<number> {
  let count = 0;

  for (const { file, connector } of files) {
    const connectorId = connector ? (connectorIds.get(connector.slug) ?? null) : null;

    for (const camera of file.cameras) {
      /**
       * `cameras_embed_requires_connector_check` refuses a published, embedding camera with
       * no connector. Catching it here names the provider file instead of quoting a
       * constraint at whoever ran the seed.
       */
      if (camera.embedPermitted && !connectorId) {
        throw new SeedError(
          `Camera "${camera.slug}" permits embedding but its provider ` +
            `"${file.provider.slug}" declares no connector. Embedding needs a recorded legal ` +
            `basis, and a recorded basis lives on a connector (ADR 0012 §4).`,
        );
      }

      const values = {
        slug: camera.slug,
        name: camera.name,
        operatorName: camera.operator,
        connectorId,
        jurisdiction: camera.jurisdiction,
        latitude: camera.latitude,
        longitude: camera.longitude,
        locationLabel: camera.locationLabel,
        viewKind: CAMERA_SUBJECT_TO_VIEW_KIND[camera.subject],
        sourceUrl: camera.sourceUrl,
        embedUrl: camera.embedUrl,
        embedPermitted: camera.embedPermitted,
        embedNotes: camera.embedNotes,
        attribution: camera.attribution,
        lastVerifiedAt: toUtcDate(camera.lastVerifiedAt),
        confidence: camera.confidence,
        status: "published" as const,
        publishedAt: now,
      };

      await tx
        .insert(cameras)
        .values(values)
        .onConflictDoUpdate({
          target: cameras.slug,
          set: {
            name: values.name,
            operatorName: values.operatorName,
            connectorId: values.connectorId,
            jurisdiction: values.jurisdiction,
            latitude: values.latitude,
            longitude: values.longitude,
            locationLabel: values.locationLabel,
            viewKind: values.viewKind,
            sourceUrl: values.sourceUrl,
            embedUrl: values.embedUrl,
            embedPermitted: values.embedPermitted,
            embedNotes: values.embedNotes,
            attribution: values.attribution,
            lastVerifiedAt: values.lastVerifiedAt,
            confidence: values.confidence,
            updatedAt: new Date(),
            // `status` and `published_at` are not reset, as on tools.
          },
        });

      count += 1;
    }
  }

  return count;
}

/* ================================================================== *
 * Entry point
 * ================================================================== */

async function main(): Promise<void> {
  const started = Date.now();

  // Cheap invariants first: a vocabulary that has drifted would otherwise surface as a
  // CHECK violation half-way through a load, with a constraint name instead of a cause.
  assertCostModelsAligned();
  assertCameraSubjectsMapped();

  console.log("Reading content/ ...");
  const toolFiles = loadToolFiles();
  const playbookFiles = loadPlaybooks();
  const cameraFiles = loadCameras();

  // Cross-file integrity, before anything is written. A duplicated slug or a playbook
  // pointing at a tool that was omitted during verification are exactly the failures that
  // reach users as broken links.
  const problems = [
    ...checkCatalogueIntegrity(
      toolFiles,
      playbookFiles.map((p) => p.frontMatter),
    ),
    ...checkCameraIntegrity(cameraFiles.map((c) => c.file)),
  ];
  if (problems.length > 0) {
    throw new SeedError(`Catalogue integrity problems:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  }

  const toolCount = toolFiles.reduce((n, f) => n + f.tools.length, 0);
  const stepCount = playbookFiles.reduce((n, p) => n + p.frontMatter.steps.length, 0);
  const cameraCount = cameraFiles.reduce((n, c) => n + c.file.cameras.length, 0);
  const tagSlugs = new Set(toolFiles.flatMap((f) => f.tools.flatMap((t) => t.tags)));

  console.log(
    `  ${toolFiles.length} categories, ${toolCount} tools, ${tagSlugs.size} tags, ` +
      `${playbookFiles.length} playbooks (${stepCount} steps), ${cameraCount} cameras`,
  );
  console.log("Content is valid. Writing ...");

  const now = new Date();

  /**
   * ONE transaction for the whole seed. Either the catalogue loads or the database is
   * untouched — there is no half-seeded state to reason about, and a failure at camera 14 of
   * 16 does not leave a catalogue that looks complete.
   */
  let liveSourceConnectors = 0;
  const counts: Counts = await db.transaction(async (tx) => {
    const categoryIds = await upsertCategories(tx, toolFiles);
    const tagIds = await upsertTags(tx, [...tagSlugs]);
    const toolIds = await upsertTools(tx, toolFiles, categoryIds, tagIds, now);

    // Resolve slugs to ids once, for the playbook step links. The alternative is a lookup
    // per link — 109 extra round trips inside an open transaction.
    const toolRows = await tx.select({ id: tools.id, slug: tools.slug }).from(tools);
    const toolIdBySlug = new Map(toolRows.map((t) => [t.slug, t.id]));

    const playbookIds = await upsertPlaybooks(tx, playbookFiles, categoryIds, toolIdBySlug, now);

    const connectorIds = await upsertCameraConnectors(tx, cameraFiles);
    await upsertFlightsConnector(tx);
    liveSourceConnectors = await upsertSourceConnectors(tx);
    const camerasWritten = await upsertCameras(tx, cameraFiles, connectorIds, now);

    /**
     * The fan-out, in the SAME transaction as the writes that made it stale (HANDOFF §4).
     * The seed bypasses the Server Actions, so it calls the identical helpers they do rather
     * than a second implementation that could drift.
     */
    await recomputeToolSearchKeywords(tx, toolIds);
    await recomputePlaybookSearchKeywords(tx, playbookIds);

    return {
      categories: categoryIds.size,
      tags: tagIds.size,
      tools: toolIds.length,
      playbooks: playbookIds.length,
      connectors: connectorIds.size + 1 + liveSourceConnectors,
      cameras: camerasWritten,
    };
  });

  /**
   * Post-write assertion. `search_keywords` is the one thing here whose failure is
   * completely silent — an empty column means no facet search works and nothing errors — so
   * it is read back rather than assumed.
   */
  const [emptyKeywords] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tools)
    .where(sql`${tools.searchKeywords} = ''`);

  if ((emptyKeywords?.n ?? 0) > 0) {
    throw new SeedError(
      `${emptyKeywords?.n} tools have empty search_keywords after seeding. Search would be ` +
        "silently degraded. This is a bug in the fan-out, not in the content.",
    );
  }

  console.log("");
  for (const [name, count] of Object.entries(counts)) {
    console.log(`  ${name.padEnd(12)} ${count}`);
  }
  console.log("");
  console.log(`Seeded in ${Date.now() - started}ms. Safe to run again.`);
  console.log("");
  console.log("Notes for whoever runs this:");
  console.log(
    "  - Playbooks are stored with confidence 'needsReview'. The playbook front-matter\n" +
      "    contract has no confidence field and this script will not invent one. If playbooks\n" +
      "    should carry a confidence, add it to content and to lib/content/schema.ts.",
  );
  console.log(
    "  - The flights connector is seeded status=draft, enabled=false (ADR 0012 §1, fail\n" +
      "    closed). /live/flights renders its disabled state until an operator reads the\n" +
      "    recorded legal_basis and turns it on.",
  );
  console.log(
    "  - Re-running never resets status, published_at, enabled, or a tag's edited name.\n" +
      "    Editorial decisions survive a re-seed.",
  );
}

/**
 * Only run when this file is the process entry point.
 *
 * Without the guard, `import { toOrderIndex } from "./seed"` in a unit test would execute the
 * whole load — which is both a surprise and, against a configured DATABASE_URL, a write.
 * The translation helpers above are exported precisely so they can be tested, so the guard
 * is what makes that safe.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  main()
    .then(async () => {
      // Close the pool and let the process exit naturally. NOT `process.exit(0)`: an explicit
      // exit can cut the socket before the connection's terminate packet is flushed, which
      // leaves a single-connection server (the local PGlite harness) holding a dead handler
      // and refusing the next client. `pool.end()` already waits for every connection to
      // close, so there is nothing left to hurry.
      await closeDb();
    })
    .catch(async (error: unknown) => {
      console.error("");
      console.error(error instanceof SeedError ? error.message : error);
      console.error("");
      console.error("Nothing was written. Fix the content and run again.");
      try {
        await closeDb();
      } catch {
        // A pool that never opened is not the failure worth reporting.
      }
      process.exit(1);
    });
}
