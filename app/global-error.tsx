"use client";

import { THEME_INIT_SCRIPT } from "@/components/layout/theme";

import "./globals.css";

/**
 * Catches failures in the root layout, so it renders its own `<html>` and `<body>`. Imports
 * only the stylesheet and theme script, since anything else could be what failed.
 *
 * No `next/font`: without the layout's class `--font-sans` resolves to nothing, so `<body>`
 * names the fallback stack directly. Nothing from `error` is rendered (see `app/error.tsx`).
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
