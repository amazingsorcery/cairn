"use client";

import { SessionProvider } from "next-auth/react";

/**
 * Client-side session context for the header.
 *
 * The header can't call `auth()` on the server: reading cookies in the root layout would opt
 * every public route out of static generation and ISR. Instead it renders signed-out on the
 * server and client leaves upgrade after hydration (one `/api/auth/session` request).
 *
 * Refetching is off; revoked sessions are still enforced server-side on the next request.
 * When `enabled` is false (public-only mode) the provider isn't mounted at all.
 */
export function HeaderSessionProvider({
  children,
  enabled,
}: {
  children: React.ReactNode;
  enabled: boolean;
}) {
  if (!enabled) return <>{children}</>;

  return (
    <SessionProvider refetchOnWindowFocus={false} refetchInterval={0}>
      {children}
    </SessionProvider>
  );
}
