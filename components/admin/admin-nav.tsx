"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

/**
 * The secondary nav inside `/admin`. `wireframes/11-admin-queue.txt`, 1280px.
 *
 * `/admin/connectors` and `/admin/taxonomy` are rendered only for an `admin`, because the
 * layout knows the role and does not pass them otherwise. That is a convenience, not
 * authorisation: the routes themselves call `requireAdminPage()` and a non-admin gets 404
 * whether or not the link was ever drawn. A hidden nav link has never been a control.
 *
 * `aria-current="page"` is driven by the same prefix rule the primary nav uses, so a detail
 * route under a section still marks its section current.
 */

export interface AdminNavLink {
  href: string;
  label: string;
}

export function AdminNav({ links }: { links: readonly AdminNavLink[] }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Admin" className="border-b border-border">
      <ul className="-mb-px flex flex-wrap gap-1 overflow-x-auto">
        {links.map((link) => {
          const current = pathname === link.href || pathname.startsWith(`${link.href}/`);
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "inline-flex h-11 items-center border-b-2 px-3 text-sm font-medium",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  current
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
