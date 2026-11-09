import Link from "next/link";
import { cookies } from "next/headers";
import { Mail } from "lucide-react";

import { Button } from "@/components/ui/button";
import { pageMetadata } from "@/lib/metadata";
import { metadataUnlessPublicOnly, requireSignInEnabled } from "@/lib/session-surface";
import { SIGNIN_ADDRESS_COOKIE } from "../signin-state";
import { formatLinkLifetime } from "../link-lifetime";

/**
 * `/signin/check-email`. No polling or "waiting" UI: the link works in any browser.
 *
 * Dynamic because the address comes from an httpOnly cookie set by the sign-in action
 * (a query param would leak it to history and logs). Without the cookie, the address is
 * omitted.
 */

export const dynamic = "force-dynamic";

export const metadata = metadataUnlessPublicOnly(
  pageMetadata({
    title: "Check your email",
    description: "A sign-in link has been sent. It works once and can be opened in any browser.",
    path: "/signin/check-email",
    index: false,
  }),
);

export default async function CheckEmailPage() {
  /* Public-only mode (no provider configured): 404. See `lib/session-surface.ts`. */
  requireSignInEnabled();

  const address = (await cookies()).get(SIGNIN_ADDRESS_COOKIE)?.value ?? null;
  const lifetime = formatLinkLifetime();

  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <div className="mx-auto w-full max-w-md md:rounded-lg md:border md:border-border md:bg-card md:p-8 md:shadow-md">
        <Mail className="size-8 text-primary" aria-hidden="true" />

        <h1 className="mt-5 text-2xl font-semibold tracking-tight">Check your email</h1>

        <p className="mt-3 text-sm leading-relaxed text-foreground-secondary">
          We sent a sign-in link to{" "}
          {address ? (
            <span className="break-all font-mono text-foreground">{address}</span>
          ) : (
            "the address you gave"
          )}
          .{" "}
          {/* Unknown lifetime: don't guess a number. */}
          {lifetime === null
            ? "It works once and expires shortly."
            : `It works once and expires in ${lifetime}.`}{" "}
          You can open it in any browser.
        </p>

        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          Nothing more happens in this tab. It&rsquo;s safe to close it.
        </p>

        <Button asChild variant="outline" size="lg" className="mt-6 w-full">
          <Link href="/signin">use a different address</Link>
        </Button>
      </div>
    </div>
  );
}
