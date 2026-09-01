import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { authProviders } from "./env";

/**
 * The one gate on the signed-in surface in a deployment that has no sign-in.
 *
 * `/signin/**`, `/workspaces/**` and the two save pickers exist as route files whatever the
 * configuration is. When no provider is configured they cannot do their job — no account can
 * be created, so no case can be saved and no session can be established — and the product's
 * own rule is that a thing which is not built is not linked (product-brief §8). The controls
 * that lead here are therefore not rendered, and these routes answer as if they were never
 * built.
 *
 * ## Why 404 and not a redirect to `/signin`
 *
 * `/signin` is itself not served in this mode, so a redirect would take the reader to a 404
 * by a longer path, having first told them an account is possible here. It is also not a 403:
 * this codebase answers "you may not" and "there is nothing here" identically on purpose
 * (`components/admin/guard.ts`), and a deployment with no accounts genuinely has nothing
 * there.
 *
 * ## Why these are functions and not constants
 *
 * A `const` captured at module evaluation is correct by luck — it depends on which bundle
 * loaded first — and it cannot be exercised in both modes by a test. `authProviders` is
 * already fixed for the life of the process, so reading it per call costs a property access.
 *
 * The name is load-bearing: `tests/nav-links.test.ts` requires any public file linking to
 * `/signin` or `/workspaces` to mention `signInEnabled`, so a new link into the signed-in
 * surface cannot be added without meeting this file.
 */

/** Can anybody sign in to this deployment? */
export function isSignInEnabled(): boolean {
  return authProviders.enabled;
}

/**
 * Serve this route only where a session can exist. Called FIRST in a page, layout or route
 * handler — before any input is validated and before any query runs, so nothing about the
 * request is processed on a surface this deployment does not offer.
 */
export function requireSignInEnabled(): void {
  if (!authProviders.enabled) notFound();
}

/**
 * The same decision for a page's `<title>`.
 *
 * A static `export const metadata` is resolved even when the page body calls `notFound()`, so
 * without this a reader in public-only mode gets a 404 under `<title>Your cases</title>` —
 * a page that looks broken rather than absent. `components/admin/guard.ts` makes the same
 * argument for the editorial surface, where the leak is a security one rather than a
 * cosmetic one.
 */
export function metadataUnlessPublicOnly(metadata: Metadata): Metadata {
  if (authProviders.enabled) return metadata;
  return { title: "Not found", robots: { index: false, follow: false } };
}
