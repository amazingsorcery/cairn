/**
 * Values shared between the sign-in server action, the form leaf and the two result pages.
 *
 * They live here rather than in `actions.ts` because a `"use server"` module may export
 * only async functions: a constant exported alongside the actions is a build error, and
 * inlining the cookie name in three files is how two of them end up disagreeing.
 */

/**
 * Carries the address from the sign-in action to `/signin/check-email`.
 *
 * httpOnly, `sameSite=lax`, scoped to `/signin`. NEVER a query parameter: a URL lands in
 * browser history and in every access log between the reader and us, and for a shared
 * machine that is the same class of failure as writing a case note to `localStorage`
 * (`docs/design/states.md` §7.4).
 */
export const SIGNIN_ADDRESS_COOKIE = "signin-address";

export type SignInFormState =
  | { status: "idle" }
  /** §6.3 — inline on the field, `aria-invalid` set. */
  | { status: "invalidEmail"; email: string; message: string }
  /** §6.2 — the field stays enabled, the button carries a countdown. */
  | { status: "rateLimited"; email: string; resetAt: string }
  /** The send itself failed. Distinct from a refusal, because the retry advice differs. */
  | { status: "sendFailed"; email: string };

export const IDLE_SIGNIN_STATE: SignInFormState = { status: "idle" };
