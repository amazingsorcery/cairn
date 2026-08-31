import { brand } from "@/config/brand";

/**
 * The shared Open Graph card frame. `app/opengraph-image.tsx` renders it, and any per-route
 * `opengraph-image.tsx` a future page adds should render it too so every card in the product
 * is the same object with different words in it.
 *
 * WHY THE COLOURS ARE HEX LITERALS HERE
 * -------------------------------------
 * Everywhere else in this codebase a hardcoded colour is a defect: components use the
 * semantic tokens in `app/tokens.css`. An Open Graph card is not rendered by a browser. It
 * is rasterised at build or request time by Satori, which has no stylesheet, no cascade and
 * no custom properties — so the values have to be literals. They are copied from the dark
 * theme in `app/tokens.css` §2 and are listed in `docs/brand/HANDOFF.md` §2:
 *
 *   #0b0f15  --background       (--slate-900)
 *   #111821  --card             (--slate-850)
 *   #e5ecf3  --foreground       (--slate-100)
 *   #a8b9c9  --foreground-secondary (--slate-300)
 *   #74c6f2  --primary          (--azure-300)
 *   #1f2937  --border           (--slate-750)
 *
 * The card is always dark. A social card has no reader preference to respect, and the dark
 * treatment is the one the product is designed against.
 *
 * If a token value changes in `tokens.css`, change it here in the same commit. There is no
 * mechanism that can do it for us.
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
 * The monogram as a data URI.
 *
 * Satori renders `<img>` from a data URI reliably; its support for arbitrary inline SVG
 * elements is narrower. The geometry is the same three stones as
 * `components/layout/logo.tsx` and `docs/brand/logo/monogram.svg` — change all three
 * together. `currentColor` cannot work here, so the colour is passed in.
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
  /** The headline. Keep it short; it is set large and does not wrap gracefully past three lines. */
  title: string;
  /** One supporting line. */
  description: string;
}

/**
 * Satori implements a subset of CSS: every container needs an explicit `display: "flex"`,
 * there is no `gap` shorthand inheritance to rely on, and shorthand properties are limited.
 * The verbose style objects below are that constraint, not a preference.
 */
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
        {/* eslint-disable-next-line @next/next/no-img-element -- Satori rasterises this card
            server-side; `next/image` is a browser component and cannot run inside an
            ImageResponse. */}
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
        {/*
          The four pillars, not the tagline. The default card already uses the tagline as
          its headline, so repeating it here said the same thing twice — visible only once
          the image was actually looked at rather than checked for a 200 and a byte count.
          The pillars tell a reader what the product is, which is what a share card is for.
        */}
        {PILLARS.join("  ·  ")}
      </div>
    </div>
  );
}
