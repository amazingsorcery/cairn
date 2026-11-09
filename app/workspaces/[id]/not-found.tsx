import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * Shown when the case doesn't exist or isn't this user's. Same page for both: a 403 would
 * confirm the workspace exists, so the copy says nothing about ownership.
 */
export default function WorkspaceNotFound() {
  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-16 md:px-6 md:py-24">
      <div className="max-w-[68ch]">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Not found</h1>
        <p className="mt-3 text-base text-foreground-secondary">
          There is no case at this address. Open one of your own cases, or start a new one.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link href="/workspaces">your cases</Link>
          </Button>
          <Button asChild variant="outline" size="lg">
            <Link href="/playbooks">browse playbooks</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
