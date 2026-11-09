import Link from "next/link";
import { Github } from "lucide-react";

import { Monogram } from "@/components/layout/logo";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { authProviders } from "@/lib/env";
import { metadataUnlessPublicOnly, requireSignInEnabled } from "@/lib/session-surface";
import { pageMetadata } from "@/lib/metadata";
import { continueWithGithub } from "./actions";
import { SignInForm } from "./signin-form";
import { resolveCallbackUrl, signInContextLine } from "./callback";

/**
 * `/signin`: email magic link and/or GitHub, whichever `authProviders` has configured.
 * With neither (public-only mode) the route 404s.
 *
 * Dynamic because it reads `searchParams`; `noindex`. Email is primary; the page notes that
 * GitHub will learn about the sign-in.
 */

export const dynamic = "force-dynamic";

export const metadata = metadataUnlessPublicOnly(
  pageMetadata({
    title: "Sign in",
    description:
      "Sign in to open a case workspace. The directory, the playbooks and the live views are readable without an account.",
    path: "/signin",
    index: false,
  }),
);

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  /* Public-only mode (no provider configured): 404. See `lib/session-surface.ts`. */
  requireSignInEnabled();

  const params = await searchParams;
  const callbackUrl = resolveCallbackUrl(params.callbackUrl);
  const contextLine = signInContextLine(callbackUrl);

  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <div className="mx-auto w-full max-w-md md:rounded-lg md:border md:border-border md:bg-card md:p-8 md:shadow-md">
        <Monogram className="size-8" decorative />

        <h1 className="mt-5 text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-3 text-sm leading-relaxed text-foreground-secondary">
          An account is only needed for case workspaces. The directory, the playbooks and the
          live views are readable without one.
        </p>

        {contextLine ? (
          <p className="mt-4 rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground">
            {contextLine}
          </p>
        ) : null}

        {authProviders.email ? <SignInForm callbackUrl={callbackUrl} /> : null}

        {authProviders.email && authProviders.github ? (
          <div className="mt-6 flex items-center gap-3" aria-hidden="true">
            <Separator className="flex-1" />
            <span className="text-xs uppercase tracking-wide text-muted-foreground">or</span>
            <Separator className="flex-1" />
          </div>
        ) : null}

        {authProviders.github ? (
          <>
            <form action={continueWithGithub} className="mt-6">
              <input type="hidden" name="callbackUrl" value={callbackUrl} />
              <Button type="submit" variant="outline" size="lg" className="w-full">
                <Github aria-hidden="true" />
                continue with GitHub
              </Button>
            </form>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              GitHub will know you signed in here. The email link doesn&rsquo;t tell anyone but
              us.
            </p>
          </>
        ) : null}

        <Separator className="my-6" />
        <p className="text-xs leading-relaxed text-muted-foreground">
          By signing in you accept the{" "}
          <Link href="/legal/terms" className="text-primary underline underline-offset-4">
            terms
          </Link>{" "}
          and the{" "}
          <Link
            href="/legal/acceptable-use"
            className="text-primary underline underline-offset-4"
          >
            acceptable use policy
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
