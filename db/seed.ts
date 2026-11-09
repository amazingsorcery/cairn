/**
 * Seed loader (`pnpm db:seed`). Validates everything in `content/` through
 * `lib/content/schema.ts` and upserts it. Every field comes from content or a rule here.
 *
 * 1. Validates all files and cross-file rules before the first write.
 * 2. Fails on any bad record (file, slug, reason); never skips.
 * 3. Idempotent: upserts by slug. deploy.sh never runs it, so redeploys can't overwrite
 *    editorial changes.
 * 4. Recomputes `search_keywords` with the same helpers the Server Actions use, in the same
 *    transaction.
 *
 * `last_verified_at` and confidence are copied from content as authored, never raised.
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
import { TOOLBENCH_CONNECTOR_SEEDS } from "@/lib/connectors/toolbench-seeds";
import {
  CAMERA_SUBJECT_TO_VIEW_KIND,
  assertCameraSubjectsMapped,
} from "@/lib/validation/connectors";
import { assertCostModelsAligned } from "@/lib/validation/vocabulary";

const here = dirname(fileURLToPath(import.meta.url));
const contentDir = join(here, "..", "content");

/* ================================================================== *
 * Load and validate (nothing is written until this succeeds)
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
 * YAML front matter between the first `---` fences; the rest is the Markdown overview.
 * Step bodies live in the front matter.
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
 * Connector fields in the camera provider block, which `cameraProviderFileSchema` strips.
 * `connectorKind: null` means link-out only, so no connector is needed.
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
 * Derivations
 * ================================================================== */

/**
 * Content step order is 1-based; `order_index` is 0-based and contiguous. An off-by-one
 * here wouldn't error, so it's exported and unit-tested.
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

/** `toOrderIndex` over a list, asserting the output is contiguous from 0. */
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
 * Tag label from its slug (content only has slugs). No acronym handling; editors can rename
 * tags in `/admin/taxonomy`.
 */
export function tagNameFromSlug(slug: string): string {
  const words = slug.split("-").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `YYYY-MM-DD` to midnight UTC, so the container TZ can't shift the date. */
export function toUtcDate(iso: string): Date {
  const date = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new SeedError(`"${iso}" is not a calendar date`);
  return date;
}

/* ================================================================== *
 * Write
 * ================================================================== */

type Counts = Record<string, number>;

/** Upsert categories by slug, keeping ids stable across runs. Returns slug -> id. */
async function upsertCategories(tx: Db, files: CategoryFile[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const [index, file] of files.entries()) {
    const [row] = await tx
      .insert(categories)
      .values({
        slug: file.category.slug,
        name: file.category.name,
        description: file.category.description,
        // Files are sorted, so this is stable. A re-seed resets admin reordering.
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
        // Keep the name: an editor may have fixed the derived label ("Tls" -> "TLS").
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
       * Published: content requires both `lastVerifiedAt` and `reliability`, so the publish
       * CHECK passes with authored values. `confidence` is copied verbatim.
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
            // Don't reset status/published_at, so unpublished entries stay unpublished.
          },
        })
        .returning({ id: tools.id });

      if (!row) throw new SeedError(`Upsert returned no row for tool ${tool.slug}`);
      toolIds.push(row.id);

      // Replace the tag set so removed tags don't linger.
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
     * `confidence` stays at the default `needsReview`: playbook front matter has no
     * confidence field and we don't invent one. Add it to the front matter if needed.
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
     * Steps are replaced, not upserted: they have no natural key. Safe because
     * `workspace_items.step_id` is ON DELETE SET NULL (checklists keep their snapshot), and
     * the order uniqueness constraint is deferred.
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
 * Camera providers become connector rows, which hold the legal basis embedding requires.
 * `enabled` is false because nothing calls them (embeds load in the reader's browser);
 * `status` is published because they back published cameras.
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
        `reader's own browser to the operator; we make no outbound call and ` +
        `retain no imagery. NOT A LEGAL OPINION.`,
      baseUrl: connector.apiUrl ?? connector.termsUrl ?? "https://example.invalid",
      requiresApiKey: false,
      apiKeyEnvVar: null,
      /** Required positive; kept small so any future caller is throttled. */
      perUserQuota: 10,
      globalCeiling: 30,
      windowSeconds: 60,
      timeoutMs: 5000,
      /** Registry metadata is slow-moving. */
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
          // `enabled` and `status` are operator-owned; not reset.
        },
      })
      .returning({ id: connectors.id });

    if (!row) throw new SeedError(`Upsert returned no row for connector ${connector.slug}`);
    ids.set(connector.slug, row.id);
  }

  return ids;
}

/**
 * Flights connector, with values from `lib/connectors/flights.ts`. Seeded draft and
 * disabled; an operator enables it after reviewing the legal basis.
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
 * Registry rows for map sources and Toolbench connectors. Without a row the governed path
 * refuses every call. Seeded draft and disabled; a re-seed never resets `enabled`,
 * `status` or `lastCheckedAt`.
 */
async function upsertSourceConnectors(tx: Db): Promise<number> {
  const seeds = [...SOURCE_CONNECTOR_SEEDS, ...TOOLBENCH_CONNECTOR_SEEDS];
  for (const seed of seeds) {
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
  return seeds.length;
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
      /** Same rule as `cameras_embed_requires_connector_check`, with a clearer error. */
      if (camera.embedPermitted && !connectorId) {
        throw new SeedError(
          `Camera "${camera.slug}" permits embedding but its provider ` +
            `"${file.provider.slug}" declares no connector. Embedding needs a recorded legal ` +
            `basis, and a recorded basis lives on a connector.`,
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

  // Vocabulary drift would otherwise surface as a CHECK violation mid-load.
  assertCostModelsAligned();
  assertCameraSubjectsMapped();

  console.log("Reading content/ ...");
  const toolFiles = loadToolFiles();
  const playbookFiles = loadPlaybooks();
  const cameraFiles = loadCameras();

  // Cross-file integrity (duplicate slugs, links to missing tools) before any write.
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

  /** One transaction: the catalogue loads fully or not at all. */
  let liveSourceConnectors = 0;
  const counts: Counts = await db.transaction(async (tx) => {
    const categoryIds = await upsertCategories(tx, toolFiles);
    const tagIds = await upsertTags(tx, [...tagSlugs]);
    const toolIds = await upsertTools(tx, toolFiles, categoryIds, tagIds, now);

    // Resolve slugs once instead of per link.
    const toolRows = await tx.select({ id: tools.id, slug: tools.slug }).from(tools);
    const toolIdBySlug = new Map(toolRows.map((t) => [t.slug, t.id]));

    const playbookIds = await upsertPlaybooks(tx, playbookFiles, categoryIds, toolIdBySlug, now);

    const connectorIds = await upsertCameraConnectors(tx, cameraFiles);
    await upsertFlightsConnector(tx);
    liveSourceConnectors = await upsertSourceConnectors(tx);
    const camerasWritten = await upsertCameras(tx, cameraFiles, connectorIds, now);

    /** Same helpers as the Server Actions, in the same transaction as the writes. */
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

  /** Empty `search_keywords` would fail silently, so read it back. */
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
    "  - The flights connector is seeded status=draft, enabled=false (fail\n" +
      "    closed). /live/flights renders its disabled state until an operator reads the\n" +
      "    recorded legal_basis and turns it on.",
  );
  console.log(
    "  - Re-running never resets status, published_at, enabled, or a tag's edited name.\n" +
      "    Editorial decisions survive a re-seed.",
  );
}

/** Only run as the entry point, so tests can import the helpers without seeding. */
const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  main()
    .then(async () => {
      // No process.exit(0): it can cut the socket before the terminate packet is flushed,
      // which wedges single-connection servers like the local PGlite harness.
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
        // Pool may never have opened.
      }
      process.exit(1);
    });
}
