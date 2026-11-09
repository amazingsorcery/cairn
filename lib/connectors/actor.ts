import { headers } from "next/headers";

import { auth } from "@/lib/auth";
import { clientSubject } from "@/lib/rate-limit";

import type { ActorIdentity } from "./types";

/**
 * Who is asking, for the quota counter and the audit row.
 *
 * Kept out of `toolbench.ts` so drivers (and the seed data that imports them) don't pull in
 * `next-auth` and the request context.
 *
 * Subject is the user id if signed in, else the client IP; both are HMAC-hashed before storage.
 * Without a forwarding header `clientSubject` returns a shared constant, so those callers share
 * one counter (fails closed).
 */
export async function toolbenchActor(): Promise<ActorIdentity> {
  const session = await auth();
  if (session?.user?.id) return { subject: session.user.id };

  const requestHeaders = await headers();
  return { subject: clientSubject(new Request("http://internal", { headers: requestHeaders })) };
}
