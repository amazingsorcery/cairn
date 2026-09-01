import { headers } from "next/headers";

import { auth } from "@/lib/auth";
import { clientSubject } from "@/lib/rate-limit";

import type { ActorIdentity } from "./types";

/**
 * Who is asking, for the quota counter and the audit row.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS ITS OWN MODULE
 * ─────────────────────────────────────────────────────────────────────────────
 * It lived in `lib/connectors/toolbench.ts` next to `upstreamGet`, which the four Toolbench
 * drivers import. That put `auth()` — and therefore the whole of `next-auth` and Next's
 * request context — on the import path of every driver, and therefore on the import path of
 * `TOOLBENCH_CONNECTOR_SEEDS`, and therefore of `db/seed.ts`. `db/seed.test.ts` failed to
 * load at all: `Cannot find module .../next-auth/.../next/server`.
 *
 * The seed is DATA. It must be readable by a script, a test and a migration runner with no
 * request in scope and no session to read. Identity is request-scoped and belongs nowhere
 * near it, so it is separated here rather than papered over with a Vitest alias.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS AND IS NOT STORED
 * ─────────────────────────────────────────────────────────────────────────────
 * The signed-in user's id if there is one, otherwise the client IP. **Both are HMAC-hashed
 * before they reach `rate_limits` or `connector_requests`** (ADR 0009, ADR 0013), so nothing
 * identifying is stored on either side of the call. Identical construction to
 * `/live/flights`, deliberately: one way of identifying a caller in this codebase, not two.
 *
 * `clientSubject` falls back to a shared constant when no forwarding header is present — a
 * direct request inside the Compose network, or a local `next dev`. Every such caller then
 * shares one counter, which is the correct fail-closed behaviour: it cannot be used to
 * bypass a limit, only to reach one sooner.
 */
export async function toolbenchActor(): Promise<ActorIdentity> {
  const session = await auth();
  if (session?.user?.id) return { subject: session.user.id };

  const requestHeaders = await headers();
  return { subject: clientSubject(new Request("http://internal", { headers: requestHeaders })) };
}
