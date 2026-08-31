"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { LogOut, UserRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The account area at the right end of the header.
 *
 * Signed out — and while the session is still resolving — this is a "sign in" link, which
 * is what the server renders and what the overwhelming majority of visitors will see.
 * Reference content is readable without an account (`docs/brand/positioning.md` §8.4), so
 * this is an offer, never a gate.
 *
 * The `callbackUrl` carries the reader back to the page they were on. It is a same-origin
 * path and `safeRedirect` in `lib/auth-redirect.ts` re-checks the origin server-side, so a
 * crafted value cannot turn this into an open redirect.
 *
 * Sign-out goes through `signOut()`, which POSTs with a CSRF token. A GET sign-out is
 * triggerable from any page that can embed an image (`docs/architecture/sitemap.md` §6).
 */
export function AccountMenu() {
  const { data: session, status } = useSession();
  const pathname = usePathname();

  if (status !== "authenticated" || !session.user) {
    const callbackUrl = encodeURIComponent(pathname);
    return (
      <Button asChild variant="outline" size="sm" className="h-11">
        <Link href={`/signin?callbackUrl=${callbackUrl}`}>sign in</Link>
      </Button>
    );
  }

  // `email` is nullable on the Auth.js user. A GitHub account with no public address is a
  // real case, so the menu falls back to a label that is true rather than an empty line.
  const identity = session.user.email ?? "signed in";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="account menu">
          <UserRound className="size-5" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="max-w-56 truncate font-mono">{identity}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/workspaces">your cases</Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut({ callbackUrl: "/" })}>
          <LogOut aria-hidden="true" />
          sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
