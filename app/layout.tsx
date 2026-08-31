import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";

import { SiteFooter } from "@/components/layout/site-footer";
import { SiteHeader } from "@/components/layout/site-header";
import { HeaderSessionProvider } from "@/components/layout/session-provider";
import { SkipLink } from "@/components/layout/skip-link";
import { THEME_INIT_SCRIPT } from "@/components/layout/theme";
import { rootMetadata } from "@/lib/metadata";

import "./globals.css";

/**
 * The application shell.
 *
 * FONTS — `docs/brand/type.md` §3, `docs/brand/HANDOFF.md` §4
 * ----------------------------------------------------------
 * Three files: Sans 400, Sans 600, Mono 400. Latin only. No italics, no Sans 500/700, no
 * Mono 600. Adding a weight needs a reason written into `type.md` first, because this
 * ships to a 2–4 GB VPS and to a reader on a train.
 *
 * `next/font/google` downloads the files at build time and self-hosts them from our own
 * origin, so **no reader's browser ever makes a request to Google**. That is a requirement
 * from product-brief §3.2, not an optimisation: a third-party font request would leak every
 * reader's IP and referrer to a third party, and Persona C would treat that as
 * disqualifying. Do not replace this with a `<link>` to `fonts.googleapis.com`.
 *
 * THE `-loaded` SUFFIX IS LOAD-BEARING. `app/tokens.css` §5 declares `--font-sans` and
 * `--font-mono` as the full fallback stacks, each beginning with `var(--font-*-loaded)`.
 * Passing `variable: "--font-sans"` here would make that token reference itself, which is
 * invalid at computed-value time and would silently drop the whole stack. `docs/brand/
 * HANDOFF.md` §4 shows the un-suffixed form; `tokens.css` is the shipped contract and wins.
 *
 * The variable classes go on `<html>`, not `<body>`. `--font-sans` is declared on `:root`
 * and a `var()` inside a custom property is resolved on the element that declares it — so
 * `--font-sans-loaded` must exist at `:root` too, or `--font-sans` resolves to nothing and
 * every element falls back to the browser's default face.
 */
const fontSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "600"],
  display: "swap",
  variable: "--font-sans-loaded",
});

const fontMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400"],
  display: "swap",
  variable: "--font-mono-loaded",
});

export const metadata: Metadata = rootMetadata;

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Both themes are real and both are supported, so the browser is told so — this is what
  // makes form controls and scrollbars follow the page instead of fighting it.
  colorScheme: "dark light",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0b0f15" },
    { media: "(prefers-color-scheme: light)", color: "#f7f9fb" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      dir="ltr"
      className={`${fontSans.variable} ${fontMono.variable}`}
      // The boot script below writes `data-theme` before React hydrates, so the server
      // markup and the client DOM legitimately differ on this one attribute.
      suppressHydrationWarning
    >
      <body className="flex min-h-dvh flex-col bg-background text-foreground">
        {/*
          Theme, applied before first paint. Inline and synchronous on purpose: a stored
          choice and `prefers-color-scheme` are only readable on the client, and anything
          React renders runs after the browser has already painted. ADR 0016 §4–§5.

          React writes the children of a `<script>` element as raw text — it escapes only a
          literal closing-script sequence — so this needs no `dangerouslySetInnerHTML`, and
          therefore needs no lint exception either. ADR 0016 §5 grants one for exactly this
          script; it turned out not to be necessary. See docs/frontend/HANDOFF-shell.md §8.

          The content is a module-level string literal in `components/layout/theme.ts` with
          nothing user-controlled interpolated into it, and nothing ever may be.
        */}
        <script>{THEME_INIT_SCRIPT}</script>

        <HeaderSessionProvider>
          <SkipLink />
          <SiteHeader />
          {/*
            `tabIndex={-1}` is what makes the skip link actually move focus rather than only
            scrolling. Without it Safari and Firefox jump the viewport and leave the focus
            ring back in the header, which is the classic broken skip link.
          */}
          <main id="main" tabIndex={-1} className="flex-1">
            {children}
          </main>
          <SiteFooter />
        </HeaderSessionProvider>
      </body>
    </html>
  );
}
