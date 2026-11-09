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
 * Auth.js v5: email magic link + GitHub OAuth, with database sessions (not JWT) so sessions
 * are revocable and `role` is read fresh on every request.
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

/** Only configured providers are offered (see `authProviders` in `lib/env.ts`). */
function buildProviders(): Provider[] {
  const providers: Provider[] = [];

  if (authProviders.github) {
    providers.push(
      GitHub({
        clientId: env.AUTH_GITHUB_ID,
        clientSecret: env.AUTH_GITHUB_SECRET,
        // Default scope only (`read:user user:email`).
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
        // 15 minutes (Auth.js default is 24 h). The sign-in copy reads this value at runtime.
        maxAge: 15 * 60,
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

          // nodemailer 9's SMTP transport has no `pending` field (despite @types/nodemailer@8).
          const rejected = result.rejected.filter(Boolean);
          if (rejected.length > 0) {
            // Masked: this reaches the Auth.js error page and logs.
            throw new Error(`Magic-link email was not accepted for ${maskEmail(identifier)}`);
          }

          // Never log `url` or `token`: both are bearer credentials.
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

  /** Database sessions: revocable, and `role` is always current. */
  session: {
    strategy: "database",
    maxAge: 30 * 24 * 60 * 60,
    /** Refresh the row at most daily. */
    updateAge: 24 * 60 * 60,
  },

  providers: buildProviders(),

  pages: {
    signIn: "/signin",
    verifyRequest: "/signin/check-email",
    error: "/signin/error",
  },

  /**
   * Needed behind Caddy (which terminates TLS) or callback URLs use `http://localhost:3000`.
   * Configurable because trusting forwarded headers is only safe behind an overwriting proxy.
   */
  trustHost: env.AUTH_TRUST_HOST,
  secret: env.AUTH_SECRET,

  callbacks: {
    /**
     * Runs before the magic-link email is sent, so returning `false` stops the send and the
     * transport is never opened.
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
        // Generic error page; don't reveal whether the account exists.
        return false;
      }

      return true;
    },

    /** The open-redirect surface. See `safeRedirect`. */
    redirect({ url, baseUrl }) {
      return safeRedirect(url, baseUrl);
    },

    /** The adapter passes the user row, so `id` and `role` are always current. */
    session({ session, user }) {
      session.user.id = user.id;
      session.user.role = (user as { role?: UserRole }).role ?? "user";
      return session;
    },
  },

  events: {
    /**
     * `ADMIN_EMAILS` is applied once, on account creation, so a later role change in the
     * database isn't undone on next login. Set it before that account first signs in.
     */
    async createUser({ user }) {
      const address = user.email?.trim().toLowerCase();
      // `id` is optional on `User`; guard so we never run `where undefined`.
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
    // No-op: Auth.js debug output includes tokens and verification URLs.
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
 * Thrown by `requireUser`. Server Actions call it before validating input. Throws rather than
 * redirecting so it works in route handlers too.
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
