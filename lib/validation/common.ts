import { z } from "zod";

/**
 * Shared primitives. The slug rule is re-exported from `lib/content/schema.ts` so seeded and
 * admin-created slugs follow the same rule.
 */
export { SLUG, slugSchema } from "@/lib/content/schema";

/** Validated up front so a malformed id is a 404, not a `22P02` 500 from the driver. */
export const uuidSchema = z.string().uuid("Not a valid identifier");

/**
 * Summaries are card copy and the meta description, which search engines truncate around 200
 * chars. Not constrained in the database.
 */
export const SUMMARY_MAX = 200;

export const summarySchema = z
  .string()
  .trim()
  .min(10, "A summary must say something")
  .max(SUMMARY_MAX, `A summary must be ${SUMMARY_MAX} characters or fewer — it is card copy`);

/** Long-form Markdown. Non-empty, no upper bound. */
export const markdownSchema = z.string().trim().min(1);

/** Catalogue link. `http://` is allowed since some useful tools are HTTP-only; the UI flags it. */
export const catalogueUrlSchema = z
  .string()
  .trim()
  .url("Must be an absolute URL")
  .refine((v) => v.startsWith("https://") || v.startsWith("http://"), "Links must be http(s)");

/** Editorial reliability, 1–5. Mirrors `tools_reliability_range_check`. */
export const reliabilitySchema = z.number().int().min(1).max(5);

/** An asserted date such as `lastVerifiedAt`. Not in the future (one day of clock slack). */
export const pastDateSchema = z
  .date()
  .refine((d) => d.getTime() <= Date.now() + 86_400_000, "A verification date cannot be in the future");

/** Free-text search input. Bounded so a megabyte of text cannot reach `websearch_to_tsquery`. */
export const searchQuerySchema = z.string().trim().max(200);

/** 1-based page number, clamped to 1-100 rather than rejected. */
export const pageSchema = z.coerce
  .number()
  .int()
  .catch(1)
  .transform((n) => Math.min(Math.max(n, 1), 100));

/** Normalise a `searchParams` value (`string` for `?tag=a`, `string[]` for repeats) to an array. */
export function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
