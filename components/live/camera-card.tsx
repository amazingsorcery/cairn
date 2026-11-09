import Link from "next/link";
import { ExternalLink } from "lucide-react";

import { ConfidenceChipLink } from "@/components/layout/methodology-anchor";
import { VerificationDate } from "@/components/verification-date";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CameraCard as CameraCardData } from "@/lib/queries/live";

/**
 * One registry entry on `/live/cameras`. Renders only our own data: no image, thumbnail,
 * preconnect or prefetch, so the listing makes no requests to any operator origin (covered
 * by a Playwright network test).
 *
 * Embeddable entries link to their detail page instead of loading in the tile;
 * `listCameras()` doesn't even select `embed_url`.
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
                  /* `noreferrer` hides which of our pages the reader came from. */
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
