import { AdminNav, type AdminNavLink } from "@/components/admin/admin-nav";
import { requireEditorPage } from "@/components/admin/guard";

/**
 * The editorial shell. sitemap.md §8, caching.md §7.
 *
 * `force-dynamic` for everything beneath it: `/admin` sees drafts, and a draft in a cache is
 * a draft one revalidation away from being public. `middleware.ts` sets
 * `Cache-Control: private, no-store` and `X-Robots-Tag: noindex` on the whole `/admin` prefix,
 * so neither is repeated here; `app/robots.ts` disallows it as well.
 *
 * The role check here is a convenience for the nav. It is NOT the authorisation — every page
 * calls its own guard and every Server Action re-checks the role against the database.
 */

export const dynamic = "force-dynamic";

const EDITOR_LINKS: readonly AdminNavLink[] = [
  { href: "/admin", label: "overview" },
  { href: "/admin/queue", label: "queue" },
  { href: "/admin/tools", label: "tools" },
  { href: "/admin/playbooks", label: "playbooks" },
  { href: "/admin/cameras", label: "cameras" },
] as const;

const ADMIN_LINKS: readonly AdminNavLink[] = [
  { href: "/admin/connectors", label: "connectors" },
  { href: "/admin/taxonomy", label: "taxonomy" },
] as const;

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireEditorPage();
  const links = user.role === "admin" ? [...EDITOR_LINKS, ...ADMIN_LINKS] : EDITOR_LINKS;

  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-6 md:px-6 md:py-8">
      <AdminNav links={links} />
      <div className="pt-6">{children}</div>
    </div>
  );
}
