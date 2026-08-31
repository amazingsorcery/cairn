import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * A camera slug that is not in the registry, or is still a draft. `states.md` §0.
 *
 * A draft camera 404s for an anonymous visitor exactly as a draft tool does (architecture
 * HANDOFF §7). The copy does not distinguish "never existed" from "not published", because
 * telling a visitor which one it is confirms that an unpublished entry exists.
 */
export default function CameraNotFound() {
  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <div className="max-w-[68ch]">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
          That camera isn&rsquo;t in the registry
        </h1>
        <p className="mt-3 text-base leading-relaxed text-foreground-secondary">
          The registry lists officially published feeds only, and entries are removed when an
          operator stops publishing one. Browse what is currently listed.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button asChild className="h-11">
            <Link href="/live/cameras">all cameras</Link>
          </Button>
          <Button asChild variant="outline" className="h-11">
            <Link href="/live">about our sources</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
