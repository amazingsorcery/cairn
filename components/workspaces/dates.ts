/**
 * Timestamp coercion for the workspace surface.
 *
 * WHY THIS EXISTS — READ BEFORE DELETING IT AS REDUNDANT.
 *
 * `lib/queries/workspaces.ts` types `WorkspaceSummary.createdAt`, `WorkspaceItemView
 * .createdAt` and `WorkspaceItemView.checkedAt` as `Date`. At run time they are STRINGS.
 * Those three reads go through `db.execute(sql\`…\`)`, which returns raw `pg` rows and
 * therefore skips the `timestamptz(... mode: 'date')` mapping that `db/schema.ts` applies to
 * every Drizzle-built query. The row is cast to a hand-written type, so TypeScript never
 * sees the discrepancy and `value.toISOString()` throws at render time — which is exactly
 * how this was found (`/workspaces/[id]`, `saved-tools.tsx`).
 *
 * The proper fix is in the data layer: map the rows in `listWorkspaces` and `getWorkspace`
 * before returning them, so the declared type is true. That is another engineer's file, so
 * it is written up in `docs/frontend/HANDOFF-workspaces.md` 7 and coerced here in the
 * meantime.
 *
 * These helpers accept `Date | string` and stay correct after the data layer is fixed, so
 * this file does not need removing in the same commit — it just stops doing anything.
 */

export function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export function asDateOrNull(value: Date | string | null): Date | null {
  if (value === null) return null;
  const date = asDate(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `2026-08-31` — the calendar date, for a `dateTime` attribute or an export. */
export function isoDate(value: Date | string): string {
  return asDate(value).toISOString().slice(0, 10);
}

/** `2026-08-31T06:00:42Z` — whole seconds. Milliseconds are noise in a case file. */
export function isoTimestamp(value: Date | string): string {
  return asDate(value).toISOString().replace(/\.\d{3}Z$/, "Z");
}
