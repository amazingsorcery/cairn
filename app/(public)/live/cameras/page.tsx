import Link from "next/link";
import { Info } from "lucide-react";

import { CameraCard } from "@/components/live/camera-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CAMERA_VIEW_KINDS } from "@/db/schema";
import { pageMetadata } from "@/lib/metadata";
import { listCameras } from "@/lib/queries/live";
import { parseCameraFilters } from "@/lib/validation/filters";
import { cn } from "@/lib/utils";

/**
 * `/live/cameras`: the camera registry.
 *
 * No outbound requests on page load: tiles are our own registry rows, with no thumbnails,
 * `preconnect` or prefetch. Dynamic because it reads `searchParams`; the query is cached.
 * The filter bar is a plain GET form so it works without JavaScript.
 */

export const dynamic = "force-dynamic";

export const metadata = pageMetadata({
  title: "Live cameras",
  description:
    "A curated registry of traffic, transport and tourism cameras their operators publish deliberately. Nothing loads until you choose it, and no image is proxied or stored.",
  path: "/live/cameras",
});

export default async function LiveCamerasPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filters = parseCameraFilters(await searchParams);

  // Filtered list, plus the full set for facet values and the "of n" count. Same cache tag.
  const [cameras, all] = await Promise.all([
    listCameras(filters),
    listCameras({ q: "", jurisdiction: undefined, view: undefined }),
  ]);

  const jurisdictions = [...new Set(all.map((c) => c.jurisdiction))].sort((a, b) =>
    a.localeCompare(b, "en"),
  );
  const activeFilters = [filters.q, filters.jurisdiction, filters.view].filter(Boolean).length;

  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <Breadcrumb items={[{ label: "live", href: "/live" }, { label: "cameras" }]} />

      <h1 className="mt-4 text-2xl font-semibold tracking-tight md:text-3xl">Cameras</h1>

      {/* Not dismissible: the disclosure has to be seen before any connection is made. */}
      <Alert variant="info" className="mt-4 max-w-[80ch]">
        <Info aria-hidden="true" />
        <AlertTitle>Nothing loads until you choose it</AlertTitle>
        <AlertDescription>
          These are camera feeds their operators publish deliberately. We don&rsquo;t proxy or
          store any image. Loading a view connects your browser straight to the operator, who
          will see your IP address — nothing loads until you choose it.
        </AlertDescription>
      </Alert>

      <form method="get" className="mt-8 flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 basis-64">
          <label htmlFor="camera-q" className="mb-1.5 block text-sm font-medium">
            filter by place or name
          </label>
          <Input
            id="camera-q"
            name="q"
            type="search"
            defaultValue={filters.q}
            placeholder="Piccadilly, A406, Hanko…"
          />
        </div>

        <div>
          <label htmlFor="camera-jurisdiction" className="mb-1.5 block text-sm font-medium">
            jurisdiction
          </label>
          <select
            id="camera-jurisdiction"
            name="jurisdiction"
            defaultValue={filters.jurisdiction ?? ""}
            className={SELECT_CLASS}
          >
            <option value="">any</option>
            {jurisdictions.map((code) => (
              <option key={code} value={code.toLowerCase()}>
                {code}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="camera-view" className="mb-1.5 block text-sm font-medium">
            view kind
          </label>
          <select
            id="camera-view"
            name="view"
            defaultValue={filters.view ?? ""}
            className={SELECT_CLASS}
          >
            <option value="">any</option>
            {CAMERA_VIEW_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </div>

        <Button type="submit" className="h-11">
          apply filters
        </Button>
        {activeFilters > 0 ? (
          <Button asChild variant="ghost" className="h-11">
            <Link href="/live/cameras">clear</Link>
          </Button>
        ) : null}
      </form>

      {/* Announces the count on filter change without moving focus. */}
      <p aria-live="polite" className="sr-only">
        {`${cameras.length} of ${all.length} cameras match these filters`}
      </p>

      <p className="mt-6 tabular text-sm text-foreground-secondary">
        {cameras.length === all.length
          ? `${all.length} ${all.length === 1 ? "camera" : "cameras"}`
          : `${cameras.length} of ${all.length} cameras`}
      </p>

      {all.length === 0 ? (
        <div className="mt-6 max-w-[68ch] rounded-lg border border-border bg-card p-5">
          <h2 className="text-lg font-semibold tracking-tight">No cameras published yet</h2>
          <p className="mt-2 text-base leading-relaxed text-foreground-secondary">
            The registry lists officially published feeds only.{" "}
            <Link href="/live" className="underline underline-offset-4 hover:text-foreground">
              Read what that means and why.
            </Link>
          </p>
        </div>
      ) : cameras.length === 0 ? (
        <div className="mt-6 max-w-[68ch] rounded-lg border border-border bg-card p-5">
          <h2 className="text-lg font-semibold tracking-tight">No cameras match these filters</h2>
          <p className="mt-2 text-base leading-relaxed text-foreground-secondary">
            {activeFilters === 1 ? "1 filter is" : `${activeFilters} filters are`} active. Clear
            them to see all {all.length} cameras.
          </p>
          <Button asChild variant="secondary" className="mt-4 h-11">
            <Link href="/live/cameras">clear filters</Link>
          </Button>
        </div>
      ) : (
        <ul className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {cameras.map((camera) => (
            <li key={camera.id}>
              <CameraCard camera={camera} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Native `<select>` styling; the Radix select doesn't submit with a no-JS form. */
const SELECT_CLASS = cn(
  "flex h-10 w-full min-w-32 rounded-md border border-input bg-background px-3 py-2 text-sm",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
  "focus-visible:ring-offset-background",
);
