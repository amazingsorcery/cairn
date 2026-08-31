/**
 * The read layer.
 *
 * Three rules, restated here because they are the ones that break silently:
 *
 *  1. **Public reads filter `status = 'published'`** (HANDOFF §7). `admin.ts` is the only
 *     module that sees drafts, and everything in it is called behind a role check.
 *  2. **Ownership is a SQL predicate, never a TypeScript comparison** (`workspaces.ts`). A
 *     non-owner gets null, which the route turns into 404 — never 403, which would confirm
 *     the row exists.
 *  3. **Nothing that takes a `userId` is cached** (caching.md §6). `workspaces.ts` and
 *     `admin.ts` deliberately do not import `./cache`.
 */
export * from "./cache";
export * from "./taxonomy";
export * from "./tools";
export * from "./playbooks";
export * from "./search";
export * from "./workspaces";
export * from "./live";
export * from "./admin";
