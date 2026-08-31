import Link from "next/link";

import { NewCaseForm } from "@/components/workspaces/new-case-form";
import { PlaybookMeta } from "@/components/playbooks/playbook-meta";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { pageMetadata } from "@/lib/metadata";
import { getPlaybookBySlug } from "@/lib/queries/playbooks";
import { requireSession } from "../session";

/**
 * `/workspaces/new` — start a case, optionally from a playbook.
 *
 * THIS ROUTE IS THE LANDING POINT FOR "start a case from this playbook".
 * `/playbooks/[slug]` links here for everyone, signed in or out. Signed out, `requireSession`
 * redirects to `/signin?callbackUrl=/workspaces/new?playbook=<slug>`, and the reader comes
 * back to this form with the playbook still attached — so the intent survives the round trip
 * instead of dropping them on a bare page (`docs/design/flows.md` ⚠ W0).
 *
 * `docs/design/states.md` §4.7 says "the case is created on return". It is created by one
 * click on return rather than zero, deliberately: a GET that writes a row is triggerable
 * from any link a reader can be sent, and the click buys the reader the chance to name the
 * case, which matters once they have more than three. Recorded as a decision the
 * maintainer may overrule in `docs/frontend/HANDOFF-workspaces.md` §8.
 *
 * A `?playbook=` slug that does not resolve is NOT an error: the reader still wanted a case,
 * so they get a blank one and are told the playbook could not be attached. Failing the whole
 * page because a query parameter went stale would be worse service.
 */

export const dynamic = "force-dynamic";

export const metadata = pageMetadata({
  title: "New case",
  description: "Start a case workspace, optionally from a playbook.",
  path: "/workspaces/new",
  index: false,
});

export default async function NewWorkspacePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const rawSlug = Array.isArray(params.playbook) ? params.playbook[0] : params.playbook;
  const slug = typeof rawSlug === "string" && rawSlug.length > 0 ? rawSlug : null;

  const callbackPath = slug
    ? `/workspaces/new?playbook=${encodeURIComponent(slug)}`
    : "/workspaces/new";
  await requireSession(callbackPath);

  const playbook = slug ? await getPlaybookBySlug(slug) : null;

  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <Breadcrumb
        items={[{ label: "your cases", href: "/workspaces" }, { label: "new case" }]}
      />

      <div className="mt-6 max-w-[68ch]">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
          {playbook ? "Start this case" : "Start a blank case"}
        </h1>

        {playbook ? (
          <>
            <p className="mt-3 text-lg text-foreground-secondary">
              The checklist is copied from{" "}
              <Link
                href={`/playbooks/${playbook.slug}`}
                className="text-primary underline underline-offset-4"
              >
                {playbook.title}
              </Link>{" "}
              as it reads today. It becomes yours: later edits to the playbook do not change
              your case, and your ticks and notes are not visible to anyone else.
            </p>
            <div className="mt-4">
              <PlaybookMeta
                difficulty={playbook.difficulty}
                stepCount={playbook.steps.length}
                estimatedMinutes={playbook.estimatedMinutes}
              />
            </div>
          </>
        ) : (
          <p className="mt-3 text-lg text-foreground-secondary">
            A blank case holds saved tools and timestamped notes. To get a checklist as well,
            start from{" "}
            <Link href="/playbooks" className="text-primary underline underline-offset-4">
              a playbook
            </Link>
            .
          </p>
        )}

        {slug && !playbook ? (
          <p className="mt-4 rounded-md border border-border bg-muted px-3 py-2 text-sm">
            That playbook is no longer published, so no checklist can be copied from it. The
            case below will start empty.
          </p>
        ) : null}

        <NewCaseForm
          playbookId={playbook ? playbook.id : null}
          defaultTitle={playbook ? playbook.title : "Untitled case"}
          cancelHref={playbook ? `/playbooks/${playbook.slug}` : "/workspaces"}
        />
      </div>
    </div>
  );
}
