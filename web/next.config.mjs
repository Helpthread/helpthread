import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The engine is Node-bound (node:crypto HMAC) and so is this app's API
  // access; nothing here targets the Edge runtime.
  reactStrictMode: true,
  // The engine is mounted from the repo root's compiled `dist/` (see
  // `src/engine/mount.ts`), so file tracing must start one level up or the
  // deployed function bundle would omit it.
  outputFileTracingRoot: path.resolve(fileURLToPath(new URL('..', import.meta.url))),
  // Native-backed engine dependencies are loaded from node_modules at runtime
  // rather than bundled.
  serverExternalPackages: ['pg', 'imapflow', 'nodemailer'],
  // The engine owns `/api/**` byte-for-byte: a trailing-slash request must
  // reach its router (which answers 404, or the webhook's uniform 403) rather
  // than be answered by a framework 308. `src/middleware.ts` restores the
  // redirect for UI paths.
  skipTrailingSlashRedirect: true,
  // Don't advertise the framework in every response.
  poweredByHeader: false,
  // Baseline hardening headers on every response. Nothing in the app is
  // meant to be framed, so framing is refused outright (clickjacking).
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
          },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ]
  },
}

export default nextConfig
