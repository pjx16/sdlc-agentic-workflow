import path from 'node:path';
import type { NextConfig } from 'next';

// The browser only talks to the dashboard origin; /api/* is forwarded to the API (BUILD_PLAN 6.1).
const API_URL = process.env.API_URL ?? 'http://api:4000';

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../../'),
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_URL}/:path*` }];
  },
};

export default config;
