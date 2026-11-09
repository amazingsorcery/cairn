import type { NextConfig } from "next";

/** `standalone` output is required by the Dockerfile. */
const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  compress: false, // Caddy compresses.
  eslint: {
    // CI runs `pnpm lint` separately.
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  images: {
    // No remote images; third-party hosts shouldn't learn what users view.
    remotePatterns: [],
    formats: ["image/avif", "image/webp"],
  },
  /**
   * pdfkit reads AFM font metrics from disk at require time; bundling it causes
   * `ENOENT Helvetica.afm` at runtime.
   */
  serverExternalPackages: ["pdfkit"],
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
};

export default nextConfig;
