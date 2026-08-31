import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind classes, letting later conditional classes win over earlier ones. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Format a date for display. Fixed to en-GB with a UTC timezone so server and client
 * render identical strings — a locale-dependent format is a hydration mismatch waiting
 * to happen, and an investigator comparing timestamps needs them stable, not local.
 */
export function formatDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/** Full timestamp with UTC marker, for notes and audit trails where precision matters. */
export function formatTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return `${new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(date)} UTC`;
}

/**
 * How stale is a verification claim? The directory's credibility rests on being honest
 * about this, so the thresholds are deliberately unforgiving.
 */
export function verificationAge(lastVerifiedAt: Date | string): {
  days: number;
  status: "fresh" | "ageing" | "stale";
} {
  const date = lastVerifiedAt instanceof Date ? lastVerifiedAt : new Date(lastVerifiedAt);
  if (Number.isNaN(date.getTime())) return { days: Number.POSITIVE_INFINITY, status: "stale" };
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days <= 90) return { days, status: "fresh" };
  if (days <= 365) return { days, status: "ageing" };
  return { days, status: "stale" };
}

/** Normalise a string into a URL-safe slug. Used for anchors and generated identifiers. */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

/** Display host for an external link, so users see where they are being sent. */
export function displayHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}
