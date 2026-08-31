/**
 * The validation layer. Zod at every boundary (product-brief §5).
 *
 * Three kinds of rule live here, and it is worth knowing which is which:
 *
 *   1. RESTATEMENTS of a Postgres CHECK constraint (`reliability` 1–5, the publish gate).
 *      The database is the enforcement; these exist so an editor gets a field and a
 *      sentence instead of a constraint name.
 *   2. INVARIANTS THE DATABASE DELIBERATELY DOES NOT ENFORCE (HANDOFF §3): the
 *      `kind`/`tool_id`/`step_id` pairing on `workspace_items`, contiguous 0-based step
 *      ordering, `input_types` / `output_types` membership, summary length. For these, Zod
 *      IS the enforcement — there is nothing behind it.
 *   3. NORMALISATION of untrusted query strings into a canonical, cacheable filter tuple
 *      (`filters.ts`), which is a cache-integrity control as much as a validation one.
 */
export * from "./common";
export * from "./vocabulary";
export * from "./tools";
export * from "./playbooks";
export * from "./workspaces";
export * from "./taxonomy";
export * from "./filters";
