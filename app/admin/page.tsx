import Link from "next/link";

import { adminMetadata, requireEditorPage } from "@/components/admin/guard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getVerificationQueue } from "@/lib/queries/admin";

/**
 * `/admin` — the editorial overview. sitemap.md §8.
 *
 * It exists to answer one question on arrival: what needs a human today. The number it leads
 * with is the staleness count, because that is the only figure in this product that gets
 * worse while nobody does anything.
 */

export const dynamic = "force-dynamic";

export function generateMetadata() {
  return adminMetadata(
    {
      title: "Admin",
      description: "The editorial surface.",
      path: "/admin",
    },
    "editor",
  );
}

const STALE_AFTER_DAYS = 180;

export default async function AdminPage() {
  const user = await requireEditorPage();
  const queue = await getVerificationQueue();

  const attention = queue.filter((entry) => {
    if (!entry.lastVerifiedAt) return true;
    return Math.floor((Date.now() - entry.lastVerifiedAt.getTime()) / 86_400_000) > STALE_AFTER_DAYS;
  });

  const drafts = queue.filter((entry) => entry.status === "draft");

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Admin</h1>
      <p className="mt-3 max-w-[68ch] text-base leading-relaxed text-foreground-secondary">
        Signed in as {user.email ?? "an editor"} with the role{" "}
        <span className="font-mono">{user.role}</span>. This is the only place drafts are
        visible; everything public filters on <span className="font-mono">status</span>.
      </p>

      <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <StatCard
          href="/admin/queue"
          label="need verification"
          value={attention.length}
          note={`Never verified, or last verified more than ${STALE_AFTER_DAYS} days ago.`}
        />
        <StatCard
          href="/admin/tools"
          label="drafts across the catalogue"
          value={drafts.length}
          note="Not visible to anyone but an editor, and 404 for everyone else."
        />
        <StatCard
          href="/admin/connectors"
          label="live sources"
          value={queue.filter((entry) => entry.kind === "connector").length}
          note={
            user.role === "admin"
              ? "The kill-switch, the quota envelope and the recorded legal basis."
              : "Operator responsibilities. An admin holds these."
          }
          disabled={user.role !== "admin"}
        />
      </div>

      <section aria-labelledby="rules-heading" className="mt-12 max-w-[68ch]">
        <h2 id="rules-heading" className="text-xl font-semibold tracking-tight">
          Two rules this surface enforces
        </h2>
        <ul className="mt-3 space-y-3 text-base leading-relaxed text-foreground-secondary">
          <li>
            <strong className="text-foreground">Saving an edit never moves a verification date.</strong>{" "}
            Confirming an entry is still accurate is a separate, deliberate action on{" "}
            <Link href="/admin/queue" className="underline underline-offset-4 hover:text-foreground">
              the queue
            </Link>
            , because it is a claim a named human is making. Coupling the two would let a typo
            fix assert that every claim on a page had been re-checked.
          </li>
          <li>
            <strong className="text-foreground">A date is never back-dated or forward-dated.</strong>{" "}
            Every re-verification is stamped <span className="font-mono">now()</span> on the
            server. No form here accepts a verification date.
          </li>
        </ul>
      </section>
    </div>
  );
}

function StatCard({
  href,
  label,
  value,
  note,
  disabled = false,
}: {
  href: string;
  label: string;
  value: number;
  note: string;
  disabled?: boolean;
}) {
  const body = (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="tabular text-3xl">{value}</CardTitle>
        <p className="text-sm font-medium">{label}</p>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-foreground-secondary">{note}</p>
      </CardContent>
    </Card>
  );

  // A link an editor cannot follow is not rendered as a link. `/admin/connectors` 404s for a
  // non-admin, and offering the route would be a dead end dressed as a control.
  if (disabled) return body;

  return (
    <Link
      href={href}
      className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      {body}
    </Link>
  );
}
