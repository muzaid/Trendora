import type { NextConfig } from 'next';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  {
    key: 'Content-Security-Policy',
    value: "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'" + (process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : '') + "; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  },
];

const config: NextConfig = {
  transpilePackages: ['@trendora/contracts', '@trendora/core', '@trendora/db', '@trendora/services', '@trendora/ui'],
  serverExternalPackages: ['pg', '@anthropic-ai/sdk'],
  outputFileTracingRoot: root,
  turbopack: { root },
  poweredByHeader: false,
  experimental: {},
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default config;
