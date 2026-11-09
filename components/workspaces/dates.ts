/**
 * Timestamp coercion for workspace views.
 *
 * Some `lib/queries/workspaces.ts` fields are typed `Date` but arrive as strings, because
 * they come from raw `db.execute(sql...)` rows that skip Drizzle's date mapping. These
 * helpers accept either until the query layer maps them.
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

/** `2026-08-31T06:00:42Z`, whole seconds. */
export function isoTimestamp(value: Date | string): string {
  return asDate(value).toISOString().replace(/\.\d{3}Z$/, "Z");
}
