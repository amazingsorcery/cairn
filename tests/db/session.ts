import type { Session } from "next-auth";

import type { UserRole } from "@/db/schema";

/**
 * The session double, and the seam it is applied at.
 *
 * WHY `next-auth` AND NOT `@/lib/auth`. `currentUser`, `requireUser`, `UnauthenticatedError`
 * and `ForbiddenError` are the thing under test — `requireUser` is the first line of every
 * Server Action, and `lib/actions/result.ts` decides an action's failure code by
 * `instanceof` on those classes. Mocking `@/lib/auth` would replace all of that with a
 * hand-written imitation, and the tests would then prove that the imitation behaves, which is
 * the shape of a test that asserts nothing.
 *
 * So the double is pushed one layer down, to the only thing a unit test genuinely cannot
 * have: the session *store*. Everything above it — the null check, the role default, the
 * throw, the `instanceof` in `guard`, the error code the caller sees — is the real code.
 *
 * A test file applies it with, at the top of the file:
 *
 *     vi.mock("next-auth", async (importOriginal) => {
 *       const actual = await importOriginal<Record<string, unknown>>();
 *       const { sessionStore } = await import("@/tests/db/session");
 *       return { ...actual, default: () => sessionStore.authModule() };
 *     });
 *
 * `lib/auth.ts` destructures `NextAuth(authConfig)` into `{ handlers, auth, signIn, signOut }`
 * at module scope, so replacing the default export is enough and nothing else in the module
 * changes.
 */

type AuthModule = {
  handlers: { GET: () => Promise<Response>; POST: () => Promise<Response> };
  auth: () => Promise<Session | null>;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
};

class SessionStore {
  private current: Session | null = null;

  /** Sign in as this user for the duration of the next call. */
  signedInAs(user: { id: string; role?: UserRole; email?: string | null }): void {
    this.current = {
      user: {
        id: user.id,
        role: user.role ?? "user",
        email: user.email ?? null,
      },
      // Far enough ahead that nothing under test treats the session as expired.
      expires: new Date(Date.now() + 86_400_000).toISOString(),
    };
  }

  /** No session at all. What an unauthenticated POST to a Server Action's endpoint has. */
  signedOut(): void {
    this.current = null;
  }

  /**
   * A session whose user id is absent, which is what a half-built session row produces.
   * `currentUser` must read that as signed out rather than as a user called `undefined`.
   */
  signedInWithoutUserId(): void {
    this.current = { expires: new Date(Date.now() + 86_400_000).toISOString() } as Session;
  }

  authModule(): AuthModule {
    return {
      handlers: {
        GET: () => Promise.resolve(new Response(null, { status: 204 })),
        POST: () => Promise.resolve(new Response(null, { status: 204 })),
      },
      auth: () => Promise.resolve(this.current),
      signIn: () => Promise.resolve(),
      signOut: () => Promise.resolve(),
    };
  }
}

export const sessionStore = new SessionStore();
