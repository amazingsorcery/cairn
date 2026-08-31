import type { SourceFeature } from "@/lib/sources/types";

/**
 * Typed reads out of `SourceFeature.properties`.
 *
 * The contract types that bag as `Record<string, string | number | boolean | null>`, which
 * is the right call — it is what survives JSON, it forbids `any`, and it lets the adapter
 * and the map be written in parallel without a shared per-source interface. The cost is that
 * a registry entry reading `properties.magnitude` gets a four-way union back.
 *
 * These are the narrowings, in one place, so no registry entry casts. A missing key and a
 * key of the wrong type both return `null`, which every column and detail row already has to
 * render as "not reported" — so an upstream that stops sending a field degrades one cell
 * rather than throwing inside a table row.
 *
 * The alternative — generic `SourceAdapter<T>` subtypes carried through the registry — is
 * better typing and worse coupling: it would make `components/map/` depend on each adapter's
 * feature interface, and adding a source would then edit map code. That is exactly the
 * trade `lib/sources/types.ts` was written to avoid, so the loss is taken here.
 */

export function numberProp(feature: SourceFeature, key: string): number | null {
  const value = feature.properties[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function stringProp(feature: SourceFeature, key: string): string | null {
  const value = feature.properties[key];
  if (typeof value === "string") return value.length > 0 ? value : null;
  return null;
}

export function boolProp(feature: SourceFeature, key: string): boolean | null {
  const value = feature.properties[key];
  return typeof value === "boolean" ? value : null;
}

/**
 * An ISO instant out of the property bag.
 *
 * Adapters carry times as ISO strings or as epoch milliseconds depending on what the
 * upstream sends, and both are legal in the property bag. Accepting either here means an
 * adapter is not forced to reformat a field it received as a number, and a registry entry
 * never has to know which it got.
 */
export function instantProp(feature: SourceFeature, key: string): Date | null {
  const value = feature.properties[key];
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/** Epoch milliseconds for sorting a time column, or null when the field is absent. */
export function instantValue(feature: SourceFeature, key: string): number | null {
  return instantProp(feature, key)?.getTime() ?? null;
}
