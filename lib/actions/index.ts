/**
 * Server Actions.
 *
 * Every action in this directory does the same four things, in this order:
 *
 *   1. re-check the session,
 *   2. Zod-validate the payload,
 *   3. re-check authorisation IN SQL — ownership for a workspace, role for the admin path,
 *   4. mutate, then revalidate exactly the tags in caching.md §5, after commit.
 *
 * A Server Action is a public HTTP endpoint with a generated name. Its arguments are
 * attacker-controlled and its authorisation is NOT inherited from the page that rendered the
 * form, which is why step 1 and step 3 are not optional even when the form is only reachable
 * from an authenticated page.
 *
 * `search-keywords.ts` is not an action module — it is the fan-out HANDOFF §4 requires, and
 * every caller runs it inside the same transaction as the write that triggered it.
 */
export * from "./result";
export * from "./workspaces";
export * from "./tools";
export * from "./playbooks";
export * from "./taxonomy";
export * from "./connectors";
