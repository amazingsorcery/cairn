import Link from "next/link";
import { cookies } from "next/headers";
import { Mail } from "lucide-react";

import { Button } from "@/components/ui/button";
import { pageMetadata } from "@/lib/metadata";
import { SIGNIN_ADDRESS_COOKIE } from "../signin-state";
import { formatLinkLifetime } from "../link-lifetime";

/**
 * `/signin/check-email` — the link was sent (`docs/design/states.md` §6.4).
 *
 * NO AUTO-REFRESH, NO POLLING, NO "waiting…" ANIMATION. Nothing is being waited for in this
 * tab: the link works in any browser, and an animation here would claim otherwise. This tab
 * is usually abandoned, which is why the copy says so out loud.
 *
 * DYNAMIC, NOT STATIC — a deliberate deviation from `sitemap.md` §6, recorded in
 * `docs/frontend/HANDOFF-workspaces.md` §7. The address is read from an httpOnly cookie set
 * by the sign-in action. The alternative was `?address=…`, which puts a reader's email in
 * their browser history and in every access log between them and us; for a shared machine
 * that is the same class of failure as writing a case note to `localStorage`
 * (`states.md` §7.4). When the cookie is absent — a different browser, a cleared jar — the
 * sentence drops the address rather than inventing one.
 */

export const dynamic = "force-dynamic";

export const metadata = pageMetadata({
  title: "Check your email",
  description: "A sign-in link has been sent. It works once and can be opened in any browser.",
  path: "/signin/check-email",
  index: false,
});

export default async function CheckEmailPage() {
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
          . It works once and expires in {lifetime}. You can open it in any browser.
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
