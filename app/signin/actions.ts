"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { z } from "zod";

import { safeRedirect, signIn } from "@/lib/auth";
import { authProviders, env } from "@/lib/env";
import { logger, maskEmail } from "@/lib/logger";
import { RATE_LIMIT_POLICIES, windowEnd, windowStart } from "@/lib/rate-limit";
import { SIGNIN_ADDRESS_COOKIE, type SignInFormState } from "./signin-state";

/**
 * The sign-in write path.
 *
 * THIS FILE MUST NOT LEAK WHETHER AN ADDRESS HAS AN ACCOUNT. Every branch below returns the
 * same shape whether the address is known or unknown: a valid address always produces the
 * "check your email" outcome. An enumeration oracle here is not a theoretical weakness —
 * "does this journalist have an account on the OSINT site" is exactly the question this
 * product's audience is targeted with (`docs/design/states.md` §6, ADR 0009).
 *
 * That is also why the rate-limit reset is COMPUTED rather than read from the limiter.
 * `consumeSafely` is called inside the Auth.js `signIn` callback (`lib/auth.ts`), and
 * calling it a second time here to learn the reset time would burn a slot from the user's
 * own budget. The windows are fixed and aligned to the epoch (ADR 0009), so the boundary is
 * derivable from the clock alone — no read, no side effect, same answer.
 *
 * The address is carried to `/signin/check-email` in an httpOnly cookie, NEVER in the query
 * string. A URL lands in browser history and in every access log on the path; for a shared
 * machine that is the same class of failure as writing a case note to `localStorage`
 * (`states.md` §7.4). The cookie is httpOnly, `sameSite=lax`, and expires with the link.
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
  // A button for an unconfigured provider is never rendered, so reaching this action with
  // the provider absent means the request did not come from our form. Refuse it the same
  // way a misconfigured send would be refused, and say nothing more.
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

  try {
    // `redirect: false` keeps the HTTP redirect ours to make; the email is still sent, and
    // the rate-limit decision still happens inside the `signIn` callback.
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

  // Outside the try: `redirect` signals by throwing, and catching it here would turn a
  // successful send into the failure branch.
  redirect("/signin/check-email");
}

/**
 * GitHub. `signIn` performs the redirect itself, so there is no success branch to return.
 * A denial at GitHub comes back to `/signin/error`, where it is read as a decision rather
 * than a failure (`states.md` §6.8).
 */
export async function continueWithGithub(formData: FormData): Promise<void> {
  if (!authProviders.github) return;
  const callbackUrl = safeCallbackUrl(formData.get("callbackUrl"));
  await signIn("github", { redirectTo: callbackUrl });
}
