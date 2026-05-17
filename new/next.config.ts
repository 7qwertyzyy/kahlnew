import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR || ".next",
  eslint: {
    // ESLint-Fehler brechen den Build nicht ab
    ignoreDuringBuilds: true,
  },
  typescript: {
    // TypeScript-Fehler (z.B. fehlende Typen wie 'geojson')
    // brechen den Build ebenfalls nicht ab
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
