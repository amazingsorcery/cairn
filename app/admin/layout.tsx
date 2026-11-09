import { AdminNav, type AdminNavLink } from "@/components/admin/admin-nav";
import { requireEditorPage } from "@/components/admin/guard";

/**
 * Editorial shell. `force-dynamic` because `/admin` renders drafts, which must never be
 * cached; no-store/noindex headers come from `middleware.ts`.
 *
 * The role check only picks nav links. Each page and Server Action does its own auth.
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
