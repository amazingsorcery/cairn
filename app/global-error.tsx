"use client";

import { THEME_INIT_SCRIPT } from "@/components/layout/theme";

import "./globals.css";

/**
 * The last-resort boundary: it catches a failure in the root layout itself, and it
 * therefore has to render its own `<html>` and `<body>`.
 *
 * Deliberately self-contained. It imports the stylesheet and the theme script and nothing
 * else — no header, no footer, no session provider, no fonts. Anything it imported could be
 * the thing that just failed, and an error page that throws is not an error page.
 *
 * No `next/font` call here either. Adding one would download a second copy of the family at
 * build time to serve a page nobody should ever see, so `<body>` names the fallback stack
 * directly: `--font-sans-loaded` is not defined without the layout's class, which would make
 * `--font-sans` resolve to nothing at all.
 *
 * Copy is `docs/design/states.md` §1.3. Nothing from `error` is rendered — see `app/error.tsx`.
 */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <body
        className="flex min-h-dvh flex-col bg-background text-foreground"
        style={{
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        }}
      >
        <script>{THEME_INIT_SCRIPT}</script>
        <main className="mx-auto w-full max-w-[80rem] flex-1 px-4 py-16 md:px-6 md:py-24">
          <div className="max-w-[68ch]">
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
              Couldn&rsquo;t load this page
            </h1>
            <p className="mt-3 text-base text-foreground-secondary">
              Something on our side failed. Reload, or try again in a minute.
            </p>
            <div className="mt-8">
              <button
                type="button"
                onClick={reset}
                className="inline-flex h-11 items-center justify-center rounded-md bg-primary px-6 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                reload
              </button>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
