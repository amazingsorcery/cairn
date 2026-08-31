import Link from "next/link";
import { ExternalLink } from "lucide-react";

import { ConfidenceChipLink } from "@/components/layout/methodology-anchor";
import { VerificationDate } from "@/components/verification-date";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CameraCard as CameraCardData } from "@/lib/queries/live";

/**
 * One registry entry on `/live/cameras`. `wireframes/09-live-cameras.txt`.
 *
 * EVERY FIELD HERE IS OUR OWN DATA. No image, no thumbnail, no `<link rel=preconnect>`, no
 * lazy-load prefetch, no auto-playing grid — the listing makes ZERO outbound requests to any
 * operator origin, and that is a Playwright network assertion rather than a manual check
 * (ADR 0015 §4, architecture HANDOFF §9.10).
 *
 * WHY AN EMBEDDABLE ENTRY LINKS TO ITS DETAIL PAGE RATHER THAN LOADING IN THE TILE.
 * `listCameras()` in `lib/queries/live.ts` deliberately does not select `embed_url`: "the
 * listing never embeds, so shipping the embed URL to the browser would be handing out an
 * origin the page has no business contacting". That is the stricter reading of ADR 0015 and
 * the tile therefore cannot load an image even if it wanted to. The wireframe draws the
 * embed loading in the tile; this is a deviation, and it is recorded in
 * `docs/frontend/HANDOFF-live.md` for the maintainer to overrule if the wireframe was
 * meant literally.
 *
 * Confidence and last-verified render on every camera entry, exactly as on a directory card.
 * There is no view of an entry in this product that omits them (architecture HANDOFF §9.1).
 */

export function CameraCard({ camera }: { camera: CameraCardData }) {
  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <CardTitle className="text-base">
          <Link
            href={`/live/cameras/${camera.slug}`}
            className="rounded-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {camera.name}
          </Link>
        </CardTitle>
        <p className="text-sm text-foreground-secondary">{camera.operatorName}</p>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{camera.viewKind}</Badge>
          <Badge variant="muted">{camera.jurisdiction}</Badge>
        </div>

        <p className="text-foreground-secondary">{camera.locationLabel}</p>

        <div className="flex flex-wrap items-center gap-2">
          <ConfidenceChipLink level={camera.confidence} />
        </div>
        <VerificationDate lastVerifiedAt={camera.lastVerifiedAt} />

        <div className="mt-auto pt-2">
          {camera.embedPermitted ? (
            <Button asChild className="h-auto min-h-11 w-full whitespace-normal py-2 text-left">
              <Link href={`/live/cameras/${camera.slug}`}>
                view this camera — nothing loads until you choose it
              </Link>
            </Button>
          ) : (
            <div className="space-y-3">
              <p className="text-foreground-secondary">
                {camera.operatorName} doesn&rsquo;t permit embedding this view. Opening it takes
                you to their page, where they will see your IP address.
              </p>
              <Button
                asChild
                variant="secondary"
                className="h-auto min-h-11 w-full whitespace-normal py-2 text-left"
              >
                <a
                  href={camera.sourceUrl}
                  target="_blank"
                  /*
                   * `noreferrer` is not optional here. It stops the operator learning which of
                   * our pages the reader came from — the link-out equivalent of the
                   * `referrerpolicy="no-referrer"` an embed carries (ADR 0015 §3, §5).
                   */
                  rel="noopener noreferrer nofollow"
                >
                  <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
                  open on {camera.operatorName}&rsquo;s site
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
