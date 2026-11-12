import path from 'node:path';
import type { NextConfig } from 'next';

// The browser only talks to the dashboard origin; /api/* is forwarded to the API (BUILD_PLAN 6.1).
const API_URL = process.env.API_URL ?? 'http://api:4000';

const config: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  // Compression buffers server-sent events (the live run log), so the dashboard server does not compress.
  compress: false,
  // Keeps the development badge off the sidebar's collapse button.
  devIndicators: { position: 'bottom-right' },
  outputFileTracingRoot: path.join(__dirname, '../../'),
  // frame-ancestors/X-Frame-Options stop the approve buttons from being clickjacked. A full script-src policy needs Next.js nonces (a known limit).
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_URL}/:path*` }];
  },
};

export default config;
