/**
 * The first focusable thing on every page. Off-screen until it takes focus, at which point
 * the `.skip-link` utility in `app/globals.css` brings it into view.
 *
 * It targets `#main`, which `app/layout.tsx` puts on the `<main>` landmark. `<main>` also
 * carries `tabIndex={-1}` so that following this link actually moves focus rather than
 * only scrolling — without that, Safari and Firefox scroll the page and leave the focus
 * ring back in the header, which is the classic broken skip link.
 */
export function SkipLink() {
  return (
    <a href="#main" className="skip-link text-sm font-semibold">
      Skip to main content
    </a>
  );
}
