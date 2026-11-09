/**
 * Values shared by the sign-in action, the form and the result pages. Not in `actions.ts`
 * because a `"use server"` module may only export async functions.
 */

/**
 * Carries the address from the sign-in action to `/signin/check-email`. httpOnly,
 * `sameSite=lax`, scoped to `/signin`. Never a query parameter: URLs end up in browser
 * history and access logs.
 */
export const SIGNIN_ADDRESS_COOKIE = "signin-address";

export type SignInFormState =
  | { status: "idle" }
  /** Shown inline on the field, `aria-invalid` set. */
  | { status: "invalidEmail"; email: string; message: string }
  /** The field stays enabled; the button carries a countdown. */
  | { status: "rateLimited"; email: string; resetAt: string }
  /** The send itself failed; the retry advice differs from a refusal. */
  | { status: "sendFailed"; email: string };

export const IDLE_SIGNIN_STATE: SignInFormState = { status: "idle" };
