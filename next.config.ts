import type { NextConfig } from "next";

/**
 * Deployment target is a single small VPS behind Caddy (see docs/deploy/RUNBOOK.md).
 * `standalone` output is required by the multi-stage Dockerfile — do not remove it.
 */
const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  compress: false, // Caddy handles compression; doing it twice wastes CPU on a 2 GB box.
  eslint: {
    // CI runs `pnpm lint` as its own gate; failing the build on lint too would
    // only slow the container build without catching anything new.
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  images: {
    // No remote images are rendered: the directory links out rather than embedding
    // third-party assets, which also avoids leaking user interest to those hosts.
    remotePatterns: [],
    formats: ["image/avif", "image/webp"],
  },
  /**
   * pdfkit is CommonJS and resolves its AFM font metrics from disk at require time. Bundling
   * it makes those files unreachable and the PDF export throws `ENOENT Helvetica.afm` at
   * runtime — after a green build, in production only. `app/workspaces/[id]/export/pdf.ts`
   * already imports the standalone build (which embeds the metrics), and this keeps webpack
   * from touching it at all. Belt and braces on the one route that produces an evidence
   * artefact people rely on.
   */
  serverExternalPackages: ["pdfkit"],
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
};

export default nextConfig;
