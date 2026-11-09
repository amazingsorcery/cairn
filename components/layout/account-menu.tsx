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
 * Header account area. Shows a "sign in" link while signed out or loading.
 *
 * `callbackUrl` is re-checked server-side by `safeRedirect` (`lib/auth-redirect.ts`), so it
 * can't become an open redirect. Sign-out uses `signOut()`, which POSTs with a CSRF token.
 *
 * In public-only mode (`signInEnabled` false) this renders nothing and never calls
 * `useSession`; see `site-nav.tsx`.
 */
export function AccountMenu({ signInEnabled }: { signInEnabled: boolean }) {
  if (!signInEnabled) return null;
  return <SignedInAccountMenu />;
}

function SignedInAccountMenu() {
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

  // `email` can be null (e.g. GitHub accounts with no public address).
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
