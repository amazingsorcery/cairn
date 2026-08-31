import NextAuth, { type DefaultSession, type NextAuthConfig } from "next-auth";
import type { Provider } from "next-auth/providers";
import GitHub from "next-auth/providers/github";
import Nodemailer from "next-auth/providers/nodemailer";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { createTransport } from "nodemailer";


import { accounts, sessions, users, verificationTokens, type UserRole } from "@/db/schema";
import { db } from "./db";
import { adminEmails, authProviders, env } from "./env";
import { magicLinkEmail } from "./auth-mail";
import { safeRedirect } from "./auth-redirect";
import { logger, maskEmail } from "./logger";
import { consumeSafely } from "./rate-limit";

/**
 * Auth.js v5 configuration. product-brief §5: email magic link + GitHub OAuth, Postgres
 * sessions, no WebAuthn.
 *
 * DATABASE SESSIONS, not JWT. A session row can be revoked — deleting it signs the user out
 * everywhere, immediately. A JWT cannot be revoked before it expires, and for an audience
 * whose threat model includes device seizure that difference is the whole point. It also
 * means `role` is read from the database on every request rather than carried in a token
 * that was minted before the role changed.
 */

/* ------------------------------------------------------------------ *
 * Type augmentation — `session.user.id` and `session.user.role`
 * ------------------------------------------------------------------ */

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: UserRole;
    } & DefaultSession["user"];
  }

  interface User {
    role?: UserRole;
  }
}

/* ------------------------------------------------------------------ *
 * Providers
 * ------------------------------------------------------------------ */

/**
 * Providers are built from `authProviders`, which reports what the *environment* actually
 * configures. A half-configured provider must not render a button that fails on click —
 * the env schema already refuses to boot on a half-set provider, and this is the second
 * half of the same rule: what is not configured is not offered.
 *
 * `lib/env.ts` exports `authProviders`, so the sign-in page imports that rather than
 * inspecting this array.
 */
function buildProviders(): Provider[] {
  const providers: Provider[] = [];

  if (authProviders.github) {
    providers.push(
      GitHub({
        clientId: env.AUTH_GITHUB_ID,
        clientSecret: env.AUTH_GITHUB_SECRET,
        // Default scope only (`read:user user:email`). We need an identity and an address;
        // anything more is access we would have to justify to this audience.
        allowDangerousEmailAccountLinking: false,
      }),
    );
  }

  if (authProviders.email) {
    providers.push(
      Nodemailer({
        server: {
          host: env.SMTP_HOST,
          port: env.SMTP_PORT,
          // Implicit TLS on 465; STARTTLS is negotiated on 587 and 25.
          secure: env.SMTP_PORT === 465,
          auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
        },
        from: env.SMTP_FROM,
        /** 24 hours. Long enough to survive a delayed mail queue, short enough to expire. */
        maxAge: 24 * 60 * 60,
        async sendVerificationRequest({ identifier, url, provider }) {
          const { host } = new URL(url);
          const { subject, text, html } = magicLinkEmail({ url, host });

          const transport = createTransport(provider.server);
          const result = await transport.sendMail({
            to: identifier,
            from: provider.from,
            subject,
            text,
            html,
          });

          const rejected = result.rejected.concat(result.pending).filter(Boolean);
          if (rejected.length > 0) {
            // The address is masked even in the throw: this message reaches the Auth.js
            // error page and the logs.
            throw new Error(`Magic-link email was not accepted for ${maskEmail(identifier)}`);
          }

          // NEVER log `url` or `token`: either is a bearer credential for this account.
          // `maskEmail` keeps the line correlatable without identifying the recipient
          // (docs/product-brief.md §3.2 constraint 4).
          logger.info(
            { scope: "auth.magic-link", to: maskEmail(identifier), messageId: result.messageId },
            "Magic-link email sent",
          );
        },
      }),
    );
  }

  return providers;
}

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

export const authConfig: NextAuthConfig = {
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),

  /** Postgres sessions (product-brief §5). Revocable, and `role` is always current. */
  session: {
    strategy: "database",
    maxAge: 30 * 24 * 60 * 60,
    /** Refresh the row at most daily so an active session is not a write per request. */
    updateAge: 24 * 60 * 60,
  },

  providers: buildProviders(),

  pages: {
    signIn: "/signin",
    verifyRequest: "/signin/check-email",
    error: "/signin/error",
  },

  /**
   * `trustHost` comes from the environment because the app never sees TLS: Caddy terminates
   * it and forwards plain HTTP with `X-Forwarded-Proto: https`
   * (docs/deploy/HANDOFF.md A#3). Without it Auth.js builds callback and magic-link URLs
   * from `http://localhost:3000` and every sign-in fails.
   *
   * It is read from the environment rather than hardcoded to `true` because trusting
   * forwarded host headers is only safe behind a proxy that overwrites them, which is a
   * property of the deployment and not of the code.
   */
  trustHost: env.AUTH_TRUST_HOST,
  secret: env.AUTH_SECRET,

  callbacks: {
    /**
     * Runs before the magic-link email is sent (`email.verificationRequest` is true on that
     * pass), so a `false` here stops the send rather than merely refusing the session.
     * Rate limiting here rather than inside `sendVerificationRequest` means the transport is
     * never even opened for a request over the limit.
     */
    async signIn({ user, email }) {
      if (!email?.verificationRequest) return true;

      const address = user.email;
      if (!address) return false;

      const decision = await consumeSafely("signin-email", address);
      if (!decision.ok) {
        logger.warn(
          { scope: "auth.signin", to: maskEmail(address), count: decision.count },
          "Magic-link request rate limited",
        );
        // Auth.js turns `false` into a redirect to the error page. The user is not told
        // whether the address exists — an enumerable "too many requests for this account"
        // is an account-existence oracle.
        return false;
      }

      return true;
    },

    /** The open-redirect surface. See `safeRedirect`. */
    redirect({ url, baseUrl }) {
      return safeRedirect(url, baseUrl);
    },

    /**
     * With `strategy: "database"` the adapter hands us the user row, so `id` and `role` are
     * read from the database on every request rather than from a token minted earlier.
     * A role revoked at 10:00 takes effect at 10:00.
     */
    session({ session, user }) {
      session.user.id = user.id;
      session.user.role = (user as { role?: UserRole }).role ?? "user";
      return session;
    },
  },

  events: {
    /**
     * Role assignment happens HERE and nowhere else, because `createUser` fires exactly
     * once per account: on creation. Assigning on every sign-in would let a role removed by
     * an admin be silently restored by the next login, and would make `ADMIN_EMAILS` a
     * permanent override rather than a bootstrap.
     *
     * Consequence, documented in `.env.example`: `ADMIN_EMAILS` must be set *before* the
     * first sign-in of the account it names. Afterwards the role is changed in the database.
     */
    async createUser({ user }) {
      const address = user.email?.trim().toLowerCase();
      // `id` is optional on the base `User` type even though the adapter always supplies
      // it; without the guard we would silently update every row on a `where undefined`.
      if (!address || !user.id || !adminEmails.includes(address)) return;

      await db.update(users).set({ role: "admin" }).where(eq(users.id, user.id));
      logger.info(
        { scope: "auth.create-user", user: maskEmail(address) },
        "Granted admin role from ADMIN_EMAILS on account creation",
      );
    },

    signOut(message) {
      // `message` carries either the deleted session or the token; log neither.
      logger.info({ scope: "auth.signout", kind: "session" in message ? "db" : "jwt" }, "Signed out");
    },
  },

  logger: {
    error(error) {
      logger.error({ scope: "authjs", err: error }, "Auth.js error");
    },
    warn(code) {
      logger.warn({ scope: "authjs", code }, "Auth.js warning");
    },
    // `debug` is deliberately a no-op: Auth.js's debug channel includes tokens and
    // verification URLs, and this codebase must never write either to a log.
    debug() {},
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

export { magicLinkEmail } from "./auth-mail";
export { safeRedirect } from "./auth-redirect";

/* ------------------------------------------------------------------ *
 * Session helpers used by queries, actions and route handlers
 * ------------------------------------------------------------------ */

export type SessionUser = { id: string; role: UserRole; email: string | null };

/** The signed-in user, or null. Never throws. */
export async function currentUser(): Promise<SessionUser | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  return {
    id: session.user.id,
    role: session.user.role ?? "user",
    email: session.user.email ?? null,
  };
}

/**
 * The signed-in user, or throw. Server Actions call this first, before validating input:
 * an unauthenticated caller must not learn whether their payload was well-formed.
 *
 * Callers convert this into a redirect to `/signin`; it throws rather than redirecting so
 * that it is usable from a route handler and a server action alike.
 */
export class UnauthenticatedError extends Error {
  constructor() {
    super("Authentication required");
    this.name = "UnauthenticatedError";
  }
}

export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) throw new UnauthenticatedError();
  return user;
}

/** Roles that may reach the editorial surface. `/admin/connectors` requires `admin`. */
export function isEditor(role: UserRole): boolean {
  return role === "editor" || role === "admin";
}

export class ForbiddenError extends Error {
  constructor(message = "Insufficient role") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export async function requireEditor(): Promise<SessionUser> {
  const user = await requireUser();
  if (!isEditor(user.role)) throw new ForbiddenError();
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "admin") throw new ForbiddenError();
  return user;
}
