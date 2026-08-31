import { z } from "zod";

/**
 * Validation for authored seed content in `content/`.
 *
 * The catalogue is the product's credibility. Seed loading fails loudly on a malformed or
 * under-specified record rather than skipping it, because a silently dropped entry is a
 * catalogue that quietly disagrees with its own verification log.
 *
 * The authoring contract is documented in docs/content/editorial-standard.md.
 */

export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const slugSchema = z
  .string()
  // One character is legitimate: "x" is the platform's actual name.
  .min(1)
  .max(96)
  .regex(SLUG, "Slugs are lowercase words joined by single hyphens");

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Dates are YYYY-MM-DD")
  .refine((v) => !Number.isNaN(Date.parse(v)), "Not a real calendar date")
  .refine((v) => Date.parse(v) <= Date.now() + 86_400_000, "A verification date cannot be in the future");

export const inputTypes = [
  "domain", "ip", "email", "username", "phone", "image", "video", "url", "hash",
  "company-name", "person-name", "coordinates", "vessel-id", "aircraft-id", "file",
  "address", "bssid", "free-text", "none",
] as const;

/**
 * `none` is a real value, not a gap. Tradecraft and OPSEC entries — Tor Browser, Tails,
 * VeraCrypt, a password manager — produce no investigative output at all. They protect the
 * investigator rather than yielding evidence, and forcing a false output type on them
 * would misdescribe what they are for.
 */
export const outputTypes = [
  "records", "imagery", "timeline", "graph", "raw-dataset", "document", "map",
  "metadata", "archive", "report", "alerts", "none",
] as const;

/**
 * Mirrors `COST_MODELS` in `db/schema.ts`. `freeWithRegistration` is a distinct and
 * operationally important tier: it means the operator learns who you are before you get a
 * result, which for this audience is a threat-model fact, not a pricing detail.
 *
 * Casing rule (ADR 0004): CHECK-constrained vocabularies that code branches on are
 * camelCase, matching `needsReview`. Open `text[]` vocabularies that content grows —
 * `inputTypes`, `outputTypes` — stay kebab-case. `costModel` is the former.
 */
export const costModels = [
  "free", "freeWithRegistration", "freemium", "paid", "subscription", "enterprise",
] as const;

export const confidenceLevels = ["verified", "high", "medium", "needsReview"] as const;

export type InputType = (typeof inputTypes)[number];
export type OutputType = (typeof outputTypes)[number];
export type CostModel = (typeof costModels)[number];
export type ConfidenceLevel = (typeof confidenceLevels)[number];

/** True when a catalogue link is plain HTTP, so the UI can warn about the transport. */
export function isInsecureUrl(url: string): boolean {
  return url.startsWith("http://");
}

export const toolSchema = z
  .object({
    slug: slugSchema,
    name: z.string().min(1).max(120),
    // HTTPS is not required. Some long-standing, genuinely useful tools are still served
    // over plain HTTP, and silently dropping them would make the catalogue less honest,
    // not safer. The UI surfaces the insecure transport instead — which is real
    // operational information: never send investigation material over plaintext.
    url: z
      .string()
      .url()
      .refine(
        (v) => v.startsWith("https://") || v.startsWith("http://"),
        "Catalogue links must be http(s)",
      ),
    summary: z.string().min(10).max(200),
    description: z.string().min(40),
    inputTypes: z.array(z.enum(inputTypes)).min(1),
    outputTypes: z.array(z.enum(outputTypes)).min(1),
    costModel: z.enum(costModels),
    costNotes: z.string().min(3),
    jurisdiction: z.string().min(2),
    legalNotes: z.string().min(10),
    reliability: z.number().int().min(1).max(5),
    reliabilityNotes: z.string().min(10),
    confidence: z.enum(confidenceLevels),
    confidenceNotes: z.string().optional(),
    lastVerifiedAt: isoDateSchema,
    tags: z.array(slugSchema).max(12).default([]),
    requiresAccount: z.boolean(),
    hasApi: z.boolean(),
    openSource: z.boolean(),
  })
  .superRefine((tool, ctx) => {
    // An uncertain entry that does not say what is uncertain is worse than no entry:
    // it looks like a hedge rather than information.
    if (
      (tool.confidence === "medium" || tool.confidence === "needsReview") &&
      !tool.confidenceNotes?.trim()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confidenceNotes"],
        message: `"${tool.slug}" is ${tool.confidence} confidence but does not say what is uncertain.`,
      });
    }
  });

export const categoryFileSchema = z.object({
  category: z.object({
    slug: slugSchema,
    name: z.string().min(2).max(80),
    description: z.string().min(20).max(400),
  }),
  tools: z.array(toolSchema).min(1),
});

export const playbookStepSchema = z.object({
  order: z.number().int().positive(),
  title: z.string().min(3).max(140),
  objective: z.string().min(10),
  doneWhen: z.string().min(10),
  body: z.string().min(40),
  tools: z
    .array(z.object({ slug: slugSchema, note: z.string().min(3).optional() }))
    .default([]),
});

export const playbookFrontMatterSchema = z.object({
  slug: slugSchema,
  title: z.string().min(3).max(160),
  summary: z.string().min(20).max(300),
  difficulty: z.enum(["beginner", "intermediate", "advanced"]),
  estimatedMinutes: z.number().int().positive().max(2880),
  category: slugSchema,
  tags: z.array(slugSchema).max(12).default([]),
  lastReviewedAt: isoDateSchema,
  steps: z.array(playbookStepSchema).min(2),
});

export type ToolRecord = z.infer<typeof toolSchema>;
export type CategoryFile = z.infer<typeof categoryFileSchema>;
export type PlaybookFrontMatter = z.infer<typeof playbookFrontMatterSchema>;
export type PlaybookStep = z.infer<typeof playbookStepSchema>;

/**
 * Cross-file integrity. Individually valid records can still describe an incoherent
 * catalogue — a duplicated slug, or a playbook pointing at a tool that was omitted during
 * verification. Those are the failures that reach users as broken links.
 */
export function checkCatalogueIntegrity(
  files: readonly CategoryFile[],
  playbooks: readonly PlaybookFrontMatter[],
): string[] {
  const problems: string[] = [];

  const seenToolSlugs = new Map<string, string>();
  const seenCategorySlugs = new Set<string>();

  for (const file of files) {
    if (seenCategorySlugs.has(file.category.slug)) {
      problems.push(`Duplicate category slug: ${file.category.slug}`);
    }
    seenCategorySlugs.add(file.category.slug);

    for (const tool of file.tools) {
      const previous = seenToolSlugs.get(tool.slug);
      if (previous) {
        problems.push(
          `Duplicate tool slug "${tool.slug}" in categories "${previous}" and "${file.category.slug}"`,
        );
      }
      seenToolSlugs.set(tool.slug, file.category.slug);
    }
  }

  const seenPlaybookSlugs = new Set<string>();
  for (const playbook of playbooks) {
    if (seenPlaybookSlugs.has(playbook.slug)) {
      problems.push(`Duplicate playbook slug: ${playbook.slug}`);
    }
    seenPlaybookSlugs.add(playbook.slug);

    if (!seenCategorySlugs.has(playbook.category)) {
      problems.push(
        `Playbook "${playbook.slug}" references unknown category "${playbook.category}"`,
      );
    }

    const orders = playbook.steps.map((s) => s.order);
    const expected = Array.from({ length: orders.length }, (_, i) => i + 1);
    if (orders.join(",") !== expected.join(",")) {
      problems.push(
        `Playbook "${playbook.slug}" steps must be numbered 1..${orders.length} in order, got ${orders.join(",")}`,
      );
    }

    for (const step of playbook.steps) {
      for (const link of step.tools) {
        if (!seenToolSlugs.has(link.slug)) {
          problems.push(
            `Playbook "${playbook.slug}" step ${step.order} links to unknown tool "${link.slug}"`,
          );
        }
      }
    }
  }

  return problems;
}

/* ------------------------------------------------------------------ *
 * Live pillar — camera registry (ADR 0011, ADR 0015)
 * ------------------------------------------------------------------ */

/**
 * A published camera feed.
 *
 * The line this schema enforces is *intentionally published* versus *merely reachable*.
 * Everything here is a feed an operator chose to publish, normally under a named licence.
 * Nothing Shodan-indexed, nothing on Insecam, nothing behind a default password: viewing
 * one of those is unauthorised access under the CFAA and the Computer Misuse Act, and it
 * is frequently a domestic interior.
 *
 * `embedPermitted` defaults to the safe side by construction — the refinements below make
 * it impossible to record an embed without also recording the URL and the reason it is
 * allowed. Link-out is always safe; a wrong embed misrepresents a third party's terms.
 */
export const cameraSubjects = [
  "traffic",
  "transport",
  "weather",
  "scenic",
  "tourism",
] as const;
export type CameraSubject = (typeof cameraSubjects)[number];

export const cameraSchema = z
  .object({
    slug: slugSchema,
    name: z.string().min(1).max(160),
    operator: z.string().min(2),
    jurisdiction: z.string().min(2).max(40),
    locationLabel: z.string().min(2).max(160),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    sourceUrl: z.string().url(),
    embedUrl: z.string().url().nullable(),
    embedPermitted: z.boolean(),
    embedNotes: z.string().min(10),
    attributionRequired: z.boolean(),
    attribution: z.string().min(2).nullable(),
    licence: z.string().min(2),
    subject: z.enum(cameraSubjects),
    confidence: z.enum(confidenceLevels),
    confidenceNotes: z.string().optional(),
    lastVerifiedAt: isoDateSchema,
  })
  .superRefine((camera, ctx) => {
    if (camera.embedPermitted && !camera.embedUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["embedUrl"],
        message: `"${camera.slug}" claims embedding is permitted but records no embed URL.`,
      });
    }
    if (!camera.embedPermitted && camera.embedUrl) {
      // Storing a URL we are not permitted to load is how it eventually gets loaded.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["embedUrl"],
        message: `"${camera.slug}" records an embed URL but embedding is not permitted. Remove the URL.`,
      });
    }
    if (camera.attributionRequired && !camera.attribution?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attribution"],
        message: `"${camera.slug}" requires attribution but records no attribution string to render.`,
      });
    }
    if (
      (camera.confidence === "medium" || camera.confidence === "needsReview") &&
      !camera.confidenceNotes?.trim()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confidenceNotes"],
        message: `"${camera.slug}" is ${camera.confidence} confidence but does not say what is uncertain.`,
      });
    }
  });

export const cameraProviderFileSchema = z.object({
  provider: z.object({
    slug: slugSchema,
    name: z.string().min(2).max(120),
    description: z.string().min(20).max(600),
  }),
  cameras: z.array(cameraSchema).min(1),
});

export type CameraRecord = z.infer<typeof cameraSchema>;
export type CameraProviderFile = z.infer<typeof cameraProviderFileSchema>;

/** Duplicate slugs across provider files would collide on `/live/cameras/[slug]`. */
export function checkCameraIntegrity(files: readonly CameraProviderFile[]): string[] {
  const problems: string[] = [];
  const seenCameras = new Map<string, string>();
  const seenProviders = new Set<string>();

  for (const file of files) {
    if (seenProviders.has(file.provider.slug)) {
      problems.push(`Duplicate camera provider slug: ${file.provider.slug}`);
    }
    seenProviders.add(file.provider.slug);

    for (const camera of file.cameras) {
      const previous = seenCameras.get(camera.slug);
      if (previous) {
        problems.push(
          `Duplicate camera slug "${camera.slug}" in providers "${previous}" and "${file.provider.slug}"`,
        );
      }
      seenCameras.set(camera.slug, file.provider.slug);
    }
  }

  return problems;
}
