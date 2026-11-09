import { brand } from "@/config/brand";

/**
 * Shared Open Graph card frame, used by `opengraph-image.tsx` routes.
 *
 * Satori has no CSS custom properties, so colours are hex literals copied from the dark theme
 * in `app/tokens.css`. Keep them in sync:
 *
 *   #0b0f15  --background       (--slate-900)
 *   #111821  --card             (--slate-850)
 *   #e5ecf3  --foreground       (--slate-100)
 *   #a8b9c9  --foreground-secondary (--slate-300)
 *   #74c6f2  --primary          (--azure-300)
 *   #1f2937  --border           (--slate-750)
 */

export const OG_SIZE = { width: 1200, height: 630 } as const;
export const OG_CONTENT_TYPE = "image/png";

export const OG_COLORS = {
  background: "#0b0f15",
  card: "#111821",
  foreground: "#e5ecf3",
  foregroundSecondary: "#a8b9c9",
  accent: "#74c6f2",
  border: "#1f2937",
} as const;

/**
 * The monogram as a data URI (Satori handles `<img>` data URIs better than inline SVG). Same
 * geometry as `components/layout/logo.tsx`; keep in sync.
 */
export function monogramDataUri(color: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="${color}">` +
    `<rect x="12" y="4" width="8" height="6" rx="2"/>` +
    `<rect x="8" y="12" width="16" height="6" rx="2"/>` +
    `<rect x="4" y="20" width="24" height="8" rx="2"/>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export interface BrandFrameProps {
  /** Small line above the title — a section name such as "methodology". Optional. */
  eyebrow?: string;
  /** The headline. Keep it under three lines. */
  title: string;
  /** One supporting line. */
  description: string;
}

/* Satori supports a CSS subset: every container needs `display: "flex"`. */
/** Kept in sync with the nav in `components/layout/nav-links.ts`. */
const PILLARS = ["Directory", "Playbooks", "Live", "Workspaces"] as const;

export function BrandFrame({ eyebrow, title, description }: BrandFrameProps) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        backgroundColor: OG_COLORS.background,
        padding: "72px",
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center" }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- `next/image` can't run in an ImageResponse. */}
        <img src={monogramDataUri(OG_COLORS.accent)} width={64} height={64} alt="" />
        <div
          style={{
            display: "flex",
            marginLeft: "20px",
            fontSize: "40px",
            fontWeight: 600,
            color: OG_COLORS.foreground,
          }}
        >
          {brand.name}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        {eyebrow ? (
          <div
            style={{
              display: "flex",
              fontSize: "24px",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: OG_COLORS.accent,
              marginBottom: "20px",
            }}
          >
            {eyebrow}
          </div>
        ) : null}
        <div
          style={{
            display: "flex",
            fontSize: "68px",
            fontWeight: 600,
            lineHeight: 1.1,
            color: OG_COLORS.foreground,
          }}
        >
          {title}
        </div>
        <div
          style={{
            display: "flex",
            marginTop: "28px",
            fontSize: "30px",
            lineHeight: 1.35,
            color: OG_COLORS.foregroundSecondary,
          }}
        >
          {description}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          borderTop: `2px solid ${OG_COLORS.border}`,
          paddingTop: "24px",
          fontSize: "24px",
          color: OG_COLORS.foregroundSecondary,
        }}
      >
        {/* Pillars rather than the tagline, which the default card already uses as its headline. */}
        {PILLARS.join("  ·  ")}
      </div>
    </div>
  );
}
