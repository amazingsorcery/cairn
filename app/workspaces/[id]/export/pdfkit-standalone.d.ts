/**
 * Types for pdfkit's standalone build. The normal entry point reads `data/*.afm` font
 * metrics from disk, which webpack doesn't copy, so the first `doc.font(...)` throws ENOENT.
 * The standalone build inlines them (~2.5 MB, server bundle only).
 *
 * Alternative: `serverExternalPackages: ["pdfkit"]` in `next.config.ts` would make this
 * file unnecessary. The build is UMD with no types, so re-export the `@types/pdfkit` ones.
 */
declare module "pdfkit/js/pdfkit.standalone.js" {
  const PDFDocument: typeof import("pdfkit");
  export default PDFDocument;
}
