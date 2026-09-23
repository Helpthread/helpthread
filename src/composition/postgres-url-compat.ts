/**
 * `sslmode=require` libpq-compat shim for the `POSTGRES_URL` fallback
 * (issue #151/#153; the Vercel⇄Supabase Marketplace integration's pooled
 * connection string).
 *
 * The integration writes a transaction-pooler URI with `?sslmode=require`
 * (Supabase's own name for "encrypt the connection; don't verify the server
 * certificate chain"). Our installed `pg`/`pg-connection-string` (8.23 /
 * 2.14) instead treats `require` as an alias for `verify-full` — the
 * pre-libpq-compat legacy behavior — so `parse()` returns `ssl: {}`
 * (`rejectUnauthorized` defaults to `true`) and logs a "SECURITY WARNING"
 * about it. Supabase's server certificate chains to Supabase's own CA, which
 * is not in Node's trust store, so every query would fail with
 * `SELF_SIGNED_CERT_IN_CHAIN`.
 *
 * `pg-connection-string`'s own documented fix is `uselibpqcompat=true`,
 * which makes `sslmode=require` mean what Supabase's docs say it means:
 * encrypted, chain unverified (`ssl: { rejectUnauthorized: false }`) — see
 * https://supabase.com/docs/guides/platform/ssl-enforcement.
 *
 * Applied ONLY to the `POSTGRES_URL` fallback value, in both
 * `./config.ts`'s `resolvePlatformIntegrationOverrides` and
 * `./migration-gate.ts`'s `resolveDatabaseUrl` — never to an explicit
 * `DATABASE_URL`, which must reach `PostgresDb` byte-for-byte untouched. An
 * operator who wants full chain verification sets `DATABASE_URL` explicitly
 * with Supabase's CA (`sslmode=verify-full&sslrootcert=...`), bypassing this
 * fallback entirely.
 *
 * Lives in its own module rather than being shared off `./config.ts` so
 * `./migration-gate.ts` keeps the zero-dependency-on-config.ts property its
 * own module doc calls out.
 */
export function withLibpqSslCompat(postgresUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(postgresUrl)
  } catch {
    // Not a parseable URL at all — leave it exactly as given; `pg` will
    // raise its own error when it tries to connect.
    return postgresUrl
  }
  if (parsed.searchParams.get('sslmode') !== 'require') return postgresUrl
  if (parsed.searchParams.has('uselibpqcompat')) return postgresUrl
  parsed.searchParams.set('uselibpqcompat', 'true')
  return parsed.toString()
}
