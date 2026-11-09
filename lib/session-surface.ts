import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { authProviders } from "./env";

/**
 * Gate for the signed-in surface (`/signin`, `/workspaces`, save pickers) when no sign-in
 * provider is configured. Those routes 404 (not a redirect, since `/signin` 404s too; not 403).
 *
 * Functions rather than constants so tests can exercise both modes.
 * `tests/nav-links.test.ts` requires public files linking to `/signin` or `/workspaces` to
 * mention `signInEnabled`.
 */

/** Can anybody sign in to this deployment? */
export function isSignInEnabled(): boolean {
  return authProviders.enabled;
}

/** Call first in a page, layout or route handler, before validating input or querying. */
export function requireSignInEnabled(): void {
  if (!authProviders.enabled) notFound();
}

/**
 * Same decision for `<title>`: static metadata resolves even when the page calls `notFound()`.
 */
export function metadataUnlessPublicOnly(metadata: Metadata): Metadata {
  if (authProviders.enabled) return metadata;
  return { title: "Not found", robots: { index: false, follow: false } };
}
