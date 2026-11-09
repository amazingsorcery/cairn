"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { z } from "zod";

import { safeRedirect, signIn } from "@/lib/auth";
import { authProviders, env } from "@/lib/env";
import { logger, maskEmail } from "@/lib/logger";
import { consumeSafely, RATE_LIMIT_POLICIES, windowEnd, windowStart } from "@/lib/rate-limit";
import { SIGNIN_ADDRESS_COOKIE, type SignInFormState } from "./signin-state";

/**
 * Sign-in actions. Must not reveal whether an address has an account: every valid address
 * gets the same "check your email" outcome.
 *
 * The rate-limit reset is computed from the clock (fixed, epoch-aligned windows) because
 * calling the limiter again would burn a slot; it's already consumed in the `signIn` callback.
 *
 * The address goes to `/signin/check-email` in an httpOnly cookie, never the query string.
 */

const emailSchema = z
  .string()
  .trim()
  .min(1, "Enter the address to send the link to")
  .email("That doesn't look like an email address. Check it and try again.");



/** A same-origin path, or `/workspaces`. Never an absolute URL reflected from the client. */
function safeCallbackUrl(raw: FormDataEntryValue | null): string {
  if (typeof raw !== "string" || raw.length === 0) return "/workspaces";
  const resolved = safeRedirect(raw, env.APP_URL);
  // `safeRedirect` returns the base URL unchanged when it rejects the candidate.
  return resolved.startsWith("/") ? resolved : "/workspaces";
}

/** The next epoch-aligned boundary of the sign-in window. See the note above. */
function signInWindowResetAt(now: Date = new Date()): Date {
  const policy = RATE_LIMIT_POLICIES["signin-email"];
  return windowEnd(windowStart(now, policy.windowSeconds), policy.windowSeconds);
}

export async function requestMagicLink(
  _previous: SignInFormState,
  formData: FormData,
): Promise<SignInFormState> {
  // No email provider means this didn't come from our form; refuse like a failed send.
  if (!authProviders.email) return { status: "sendFailed", email: "" };

  const raw = formData.get("email");
  const parsed = emailSchema.safeParse(typeof raw === "string" ? raw : "");
  const attempted = typeof raw === "string" ? raw : "";

  if (!parsed.success) {
    return {
      status: "invalidEmail",
      email: attempted,
      message: parsed.error.issues[0]?.message ?? "That doesn't look like an email address.",
    };
  }

  const email = parsed.data;
  const callbackUrl = safeCallbackUrl(formData.get("callbackUrl"));

  /*
   * Per-client limit. The per-recipient limit in the `signIn` callback stops mailbombing one
   * address, but not one client sending to many addresses.
   *
   * The subject is HMAC-hashed before use. `x-forwarded-for` is trusted because Caddy sets
   * it and is the only ingress; a missing header means a direct dev connection.
   */
  const forwarded = (await headers()).get("x-forwarded-for");
  const client = forwarded?.split(",")[0]?.trim() ?? "unknown-client";
  const senderDecision = await consumeSafely("signin-sender", client);
  if (!senderDecision.ok) {
    logger.warn(
      { scope: "signin.magic-link", count: senderDecision.count },
      "Magic-link request refused: per-client send limit",
    );
    // Same shape as the per-recipient refusal, so callers can't tell which limit hit.
    return { status: "rateLimited", email, resetAt: signInWindowResetAt().toISOString() };
  }

  try {
    // `redirect: false` so we do the redirect; the email is still sent.
    await signIn("nodemailer", { email, redirect: false, redirectTo: callbackUrl });
  } catch (error) {
    if (error instanceof AuthError && error.type === "AccessDenied") {
      // The limiter refused. The copy must not imply the address is known to us.
      return { status: "rateLimited", email, resetAt: signInWindowResetAt().toISOString() };
    }
    logger.error(
      { scope: "signin.magic-link", to: maskEmail(email), err: error },
      "Magic-link request failed",
    );
    return { status: "sendFailed", email };
  }

  const store = await cookies();
  store.set(SIGNIN_ADDRESS_COOKIE, email, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.APP_URL.startsWith("https://"),
    path: "/signin",
    maxAge: 60 * 60,
  });

  // Outside the try: `redirect` throws.
  redirect("/signin/check-email");
}

/**
 * GitHub. `signIn` redirects itself. A denial at GitHub lands on `/signin/error`.
 */
export async function continueWithGithub(formData: FormData): Promise<void> {
  if (!authProviders.github) return;
  const callbackUrl = safeCallbackUrl(formData.get("callbackUrl"));
  await signIn("github", { redirectTo: callbackUrl });
}
