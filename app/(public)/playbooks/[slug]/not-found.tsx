import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * Unknown or unpublished playbook. Same page for both so slug guessing can't reveal drafts.
 */
export default function PlaybookNotFound() {
  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-16 md:px-6 md:py-24">
      <div className="max-w-[68ch]">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Not found</h1>
        <p className="mt-3 text-base text-foreground-secondary">
          There is no playbook at this address. Try the full list, or the directory of tools.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link href="/playbooks">all playbooks</Link>
          </Button>
          <Button asChild variant="outline" size="lg">
            <Link href="/directory">browse the directory</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
