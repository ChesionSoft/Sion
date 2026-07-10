import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  devIndicators: false,
  // pdf-parse (pdfjs-dist) sets up a "fake worker" by dynamically importing
  // pdf.worker.mjs; when Next.js bundles it into a server chunk that import
  // resolves to a non-existent path and every PDF parse throws
  // "Setting up fake worker failed". Load them as native Node modules instead.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist"],
};

export default nextConfig;
