import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { currentUser, isEditor, type SessionUser } from "@/lib/auth";
import { pageMetadata } from "@/lib/metadata";

/**
 * Role gate for `/admin` pages. Non-editors get 404, not 403, so the route's existence
 * isn't confirmed. Called on every page, not just the layout, since layouts can be
 * bypassed (parallel routes, streaming). Server Actions re-check roles separately.
 */

export async function requireEditorPage(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user || !isEditor(user.role)) notFound();
  return user;
}

/** Connectors and taxonomy are admin-only: kill-switch, quotas and legal basis are operator concerns. */
export async function requireAdminPage(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user || user.role !== "admin") notFound();
  return user;
}

/**
 * Role-checked metadata. Static `metadata` resolves even when the page calls `notFound()`,
 * which would leak the real title on the 404.
 */
export async function adminMetadata(
  input: { title: string; description: string; path: string },
  level: "editor" | "admin" = "editor",
): Promise<Metadata> {
  const user = await currentUser();
  const entitled = user !== null && (level === "admin" ? user.role === "admin" : isEditor(user.role));
  if (!entitled) return { title: "Not found", robots: { index: false, follow: false } };
  return pageMetadata({ ...input, index: false });
}
