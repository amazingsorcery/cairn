import Link from "next/link";
import { cookies } from "next/headers";
import { Github, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { authProviders } from "@/lib/env";
import { pageMetadata } from "@/lib/metadata";
import { resolveCallbackUrl } from "../callback";
import { continueWithGithub } from "../actions";
import { SIGNIN_ADDRESS_COOKIE } from "../signin-state";
import { formatLinkLifetime } from "../link-lifetime";

/**
 * `/signin/error` — five distinct outcomes, each with its own copy and its own next move
 * (`docs/design/states.md` §6.5–§6.9, wireframe 10).
 *
 * The distinctions are not cosmetic. A user whose mail scanner opened the link first is not
 * looking at an expiry, and a user who declined at GitHub did not fail at anything — the
 * copy for each has to say the true thing, because the wrong one sends them to the wrong
 * remedy.
 *
 * WHAT AUTH.JS CAN AND CANNOT TELL US. Auth.js reports both "expired" and "already used" as
 * `error=Verification`: the token row is gone in both cases and nothing distinguishes them
 * at the point of failure. This page therefore maps `Verification` to the expiry copy — the
 * commoner cause — and keeps the "already used" state addressable as `?error=linkUsed` so it
 * is built, tested and ready. Splitting them properly needs a change in `lib/auth.ts` which
 * this engineer does not own; it is written up in
 * `docs/frontend/HANDOFF-workspaces.md` §7.
 *
 * EVERY VARIANT KEEPS `callbackUrl`. A reader who came here to start a case still starts
 * that case when they get in (wireframe 10).
 */

export const dynamic = "force-dynamic";

export const metadata = pageMetadata({
  title: "Sign-in problem",
  description: "That sign-in attempt did not complete. Request a new link, or try again.",
  path: "/signin/error",
  index: false,
});

type Variant = "expired" | "linkUsed" | "notCreated" | "githubDenied" | "githubUnreachable";

/** Auth.js error codes, plus the two this route addresses directly. */
function variantFor(raw: string | string[] | undefined): Variant {
  const code = Array.isArray(raw) ? raw[0] : raw;
  switch (code) {
    case "Verification":
    case "expired":
      return "expired";
    case "linkUsed":
      return "linkUsed";
    case "AccessDenied":
    case "githubDenied":
      return "githubDenied";
    case "OAuthSignin":
    case "OAuthCallbackError":
    case "OAuthCallback":
    case "githubUnreachable":
      return "githubUnreachable";
    default:
      // `CallbackRouteError`, `SessionRequired`, `EmailSignInError` and anything unmapped:
      // the link was accepted and no session came out of it, which is §6.7.
      return "notCreated";
  }
}

export default async function SignInErrorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const variant = variantFor(params.error);
  const callbackUrl = resolveCallbackUrl(params.callbackUrl);
  const address = (await cookies()).get(SIGNIN_ADDRESS_COOKIE)?.value ?? null;
  const lifetime = formatLinkLifetime();

  const newLinkHref = `/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`;

  const content: Record<Variant, { title: string; body: React.ReactNode }> = {
    expired: {
      title: "That sign-in link has expired",
      body: (
        <>
          {/*
            Omit the number when it cannot be read rather than guessing it. A specific wrong
            duration on a security page is worse than no duration at all.
          */}
          {lifetime === null
            ? "This link has expired."
            : `Links last ${lifetime}, and this one is older than that.`}{" "}
          Request a new one — it takes a moment.
        </>
      ),
    },
    linkUsed: {
      title: "That sign-in link has already been used",
      body: (
        <>
          Each link works once. If you&rsquo;re already signed in on another tab, you&rsquo;re
          fine — otherwise request a new one.
        </>
      ),
    },
    notCreated: {
      title: "That link didn’t sign you in",
      body: (
        <>
          It was valid, but the session wasn&rsquo;t created. Request a new link
          {authProviders.github ? ", or use GitHub instead" : ""}.
        </>
      ),
    },
    githubDenied: {
      title: "GitHub sign-in was cancelled",
      body: (
        <>
          Nothing was shared and no account was created. Sign in with an email link instead,
          or try GitHub again.
        </>
      ),
    },
    githubUnreachable: {
      title: "Couldn’t reach GitHub",
      body: (
        <>
          GitHub didn&rsquo;t respond. Try again in a minute, or sign in with an email link.
        </>
      ),
    },
  };

  const showEmailControl = authProviders.email;
  const showGithubControl =
    authProviders.github && (variant === "githubDenied" || variant === "githubUnreachable");

  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <div className="mx-auto w-full max-w-md md:rounded-lg md:border md:border-border md:bg-card md:p-8 md:shadow-md">
        {/* Icon and words together. The icon never carries the meaning on its own
            (`docs/brand/HANDOFF.md` §3). */}
        <TriangleAlert className="size-8 text-warning" aria-hidden="true" />

        <h1 className="mt-5 text-2xl font-semibold tracking-tight">{content[variant].title}</h1>

        <p className="mt-3 text-sm leading-relaxed text-foreground-secondary">
          {content[variant].body}
        </p>

        <div className="mt-6 flex flex-col gap-3">
          {variant === "linkUsed" ? (
            <Button asChild variant="outline" size="lg" className="w-full">
              <Link href="/workspaces">go to workspaces</Link>
            </Button>
          ) : null}

          {showEmailControl ? (
            <Button asChild size="lg" className="w-full">
              <Link href={newLinkHref}>
                {variant === "githubDenied" || variant === "githubUnreachable"
                  ? "email me a sign-in link"
                  : "email me a new link"}
              </Link>
            </Button>
          ) : null}

          {showGithubControl ? (
            <form action={continueWithGithub}>
              <input type="hidden" name="callbackUrl" value={callbackUrl} />
              <Button type="submit" variant="outline" size="lg" className="w-full">
                <Github aria-hidden="true" />
                try GitHub again
              </Button>
            </form>
          ) : null}

          {!showEmailControl && !showGithubControl ? (
            <Button asChild size="lg" className="w-full">
              <Link href={newLinkHref}>back to sign in</Link>
            </Button>
          ) : null}
        </div>

        {address && showEmailControl ? (
          <p className="mt-4 text-xs text-muted-foreground">
            The last address used on this device was{" "}
            <span className="break-all font-mono">{address}</span>.
          </p>
        ) : null}
      </div>
    </div>
  );
}
