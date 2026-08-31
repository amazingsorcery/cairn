import { z } from "zod";

/**
 * Primitives shared by every schema in this directory.
 *
 * `SLUG` and the slug shape are re-exported from `lib/content/schema.ts` rather than
 * restated: the catalogue's authored slugs and the application's generated slugs must obey
 * one rule, or a tool seeded from content and a tool created in `/admin` will disagree
 * about what a valid URL segment is.
 */
export { SLUG, slugSchema } from "@/lib/content/schema";

/**
 * Postgres `uuid`, in the canonical hyphenated form. Route params reach us as strings and a
 * malformed one must be a validation failure, not a `22P02` from the driver: an invalid
 * uuid in a `where` clause is a 500 where it should be a 404.
 */
export const uuidSchema = z.string().uuid("Not a valid identifier");

/**
 * The summary length ceiling. `tools.summary` and `playbooks.summary` are card copy and the
 * page's meta description; past roughly 200 characters a search engine truncates it and a
 * card either clips or reflows. The database does not constrain this (HANDOFF §3), so it is
 * enforced here.
 */
export const SUMMARY_MAX = 200;

export const summarySchema = z
  .string()
  .trim()
  .min(10, "A summary must say something")
  .max(SUMMARY_MAX, `A summary must be ${SUMMARY_MAX} characters or fewer — it is card copy`);

/** Long-form Markdown. No upper bound; a lower one, because an empty body is a broken page. */
export const markdownSchema = z.string().trim().min(1);

/**
 * A catalogue link. `http://` is permitted deliberately — see `lib/content/schema.ts`: some
 * long-standing, genuinely useful tools are still served over plain HTTP, and dropping them
 * would make the catalogue less honest rather than safer. The UI surfaces the insecure
 * transport instead.
 */
export const catalogueUrlSchema = z
  .string()
  .trim()
  .url("Must be an absolute URL")
  .refine((v) => v.startsWith("https://") || v.startsWith("http://"), "Links must be http(s)");

/** Editorial reliability, 1–5. Mirrors `tools_reliability_range_check`. */
export const reliabilitySchema = z.number().int().min(1).max(5);

/**
 * A date the user or an editor asserts. Never in the future: `lastVerifiedAt` is a claim
 * about when a human looked, and a forward-dated one is a lie about freshness
 * (product-brief §6.3).
 */
export const pastDateSchema = z
  .date()
  .refine((d) => d.getTime() <= Date.now() + 86_400_000, "A verification date cannot be in the future");

/** Free-text search input. Bounded so a megabyte of text cannot reach `websearch_to_tsquery`. */
export const searchQuerySchema = z.string().trim().max(200);

/** 1-based page number, clamped rather than rejected. caching.md §6. */
export const pageSchema = z.coerce
  .number()
  .int()
  .catch(1)
  .transform((n) => Math.min(Math.max(n, 1), 100));

/**
 * Read one or many values for the same key out of `searchParams`.
 *
 * Next.js hands `?tag=a&tag=b` to a page as `string[]` and `?tag=a` as `string`. Every
 * filter in `/directory` is multi-valued, so normalising the two shapes in one place stops
 * each filter from having to remember.
 */
export function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
