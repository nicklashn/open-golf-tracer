import type { NextConfig } from 'next';

const API = process.env.API_URL ?? 'http://127.0.0.1:8000';
const isDev = process.env.NODE_ENV !== 'production';

// Content Security Policy: same-origin everything; media may come from the API host directly
// when MEDIA_BASE_URL points there. 'unsafe-eval' only in dev (React refresh).
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  // Map tiles for "measure on the map": OpenStreetMap and Esri satellite imagery.
  "img-src 'self' data: blob: https://tile.openstreetmap.org https://server.arcgisonline.com",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  `connect-src 'self'${isDev ? ' ws: wss:' : ''}`,
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  // Linting runs once for the whole monorepo (npm run lint), not again inside next build.
  eslint: { ignoreDuringBuilds: true },
  transpilePackages: ['@golf/schema', '@golf/physics', '@golf/render', '@golf/compose'],
  // proxyTimeout: the API proxy otherwise cuts requests at 30 s, and validating a big upload
  // (ffprobe on a just-written file, which antivirus may scan first) can take longer.
  experimental: { optimizePackageImports: ['lucide-react'], proxyTimeout: 600_000 },
  // The app lives under /app; the old account page is now Settings.
  async redirects() {
    return [
      { source: '/', destination: '/app', permanent: false },
      { source: '/app/account', destination: '/app/settings', permanent: false },
    ];
  },
  async rewrites() {
    return [{ source: '/api/:path((?!internal).*)', destination: `${API}/api/:path` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
      { source: '/fonts/:path*', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
    ];
  },
};

export default config;
