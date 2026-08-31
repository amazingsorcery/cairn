/**
 * Type declaration for pdfkit's self-contained build.
 *
 * WHY THE STANDALONE BUILD AND NOT `import PDFDocument from "pdfkit"`.
 *
 * pdfkit's normal entry point loads the Adobe font metrics for its built-in faces with
 * `fs.readFileSync("<bundle dir>/data/Helvetica.afm")`. webpack bundles the JavaScript into
 * `.next/server/vendor-chunks/` and does not copy the `.afm` files next to it, so the very
 * first `doc.font(...)` throws `ENOENT .../vendor-chunks/data/Helvetica.afm` at run time.
 * Nothing about it is visible to `tsc` or to `eslint`; it appears the first time somebody
 * actually asks for a PDF, which is how it was found here.
 *
 * `pdfkit/js/pdfkit.standalone.js` is the same library with those metrics inlined, so it has
 * no run-time file dependency and survives bundling unchanged. It costs about 2.5 MB in the
 * SERVER bundle only — nothing reaches the browser — which on the target box is a rounding
 * error next to keeping Chromium out of the deployment.
 *
 * THE TIDIER FIX IS ONE LINE IN `next.config.ts`: `serverExternalPackages: ["pdfkit"]`
 * leaves the package unbundled, its `data/` directory intact, and lets this file and the
 * subpath import go away. That file belongs to another engineer; see
 * `docs/frontend/HANDOFF-workspaces.md` 7.
 *
 * The build is UMD and ships no types of its own, so the constructor is re-exported here
 * with the types from `@types/pdfkit` that the package entry point would have given us.
 */
declare module "pdfkit/js/pdfkit.standalone.js" {
  const PDFDocument: typeof import("pdfkit");
  export default PDFDocument;
}
