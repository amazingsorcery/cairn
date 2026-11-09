import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";

import { SiteFooter } from "@/components/layout/site-footer";
import { SiteHeader } from "@/components/layout/site-header";
import { HeaderSessionProvider } from "@/components/layout/session-provider";
import { SkipLink } from "@/components/layout/skip-link";
import { THEME_INIT_SCRIPT } from "@/components/layout/theme";
import { rootMetadata } from "@/lib/metadata";
import { isSignInEnabled } from "@/lib/session-surface";

import "./globals.css";

/**
 * Application shell.
 *
 * Fonts: Sans 400/600 and Mono 400, Latin only, to keep the payload small. `next/font`
 * self-hosts them at build time so browsers never request Google (which would leak IP and
 * referrer); don't swap in a `fonts.googleapis.com` link.
 *
 * The `-loaded` suffix matters: `tokens.css` defines `--font-sans` as a stack starting with
 * `var(--font-sans-loaded)`, so `variable: "--font-sans"` would be self-referential. The
 * classes go on `<html>` because `--font-sans` is declared on `:root`.
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
  // Lets form controls and scrollbars follow the page theme.
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
      // The boot script sets `data-theme` before hydration.
      suppressHydrationWarning
    >
      <body className="flex min-h-dvh flex-col bg-background text-foreground">
        {/*
          Sets the theme before first paint (inline, synchronous). React writes `<script>`
          children as raw text, so no `dangerouslySetInnerHTML` is needed. The content is a
          constant; never interpolate user input into it.
        */}
        <script>{THEME_INIT_SCRIPT}</script>

        {/*
          In public-only mode there's no session, so skip the provider and its
          `/api/auth/session` request. The components that call `useSession` aren't rendered
          in that mode (it throws outside a provider).
        */}
        <HeaderSessionProvider enabled={isSignInEnabled()}>
          <SkipLink />
          <SiteHeader />
          {/* `tabIndex={-1}` so the skip link moves focus in Safari/Firefox, not just scroll. */}
          <main id="main" tabIndex={-1} className="flex-1">
            {children}
          </main>
          <SiteFooter />
        </HeaderSessionProvider>
      </body>
    </html>
  );
}
