import { ImageResponse } from "next/og";

import { brand } from "@/config/brand";
import { BrandFrame, OG_CONTENT_TYPE, OG_SIZE } from "@/lib/og/brand-frame";

/**
 * The default Open Graph card, inherited by every route that does not define its own.
 *
 * `next/og` is built into Next 15 — no dependency is added. The card is generated at build
 * time for this static route, so it costs nothing per request.
 *
 * The words come from `config/brand.ts`, like every other user-facing string. A social card
 * is the single most-copied surface a product has; a product name typed into it by hand
 * would be the one place a rename silently missed.
 *
 * No font files are passed. `ImageResponse` falls back to its own bundled face, which keeps
 * this route independent of the `next/font` setup in `app/layout.tsx` — loading the Plex
 * files a second time to rasterise one image would add build cost for a difference nobody
 * sees at card scale.
 */

export const alt = `${brand.name} — ${brand.tagline}`;
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <BrandFrame title={brand.tagline} description={brand.pitch} />
    ),
    { ...size },
  );
}
