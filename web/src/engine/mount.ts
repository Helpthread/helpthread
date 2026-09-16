/**
 * The engine mount — the ONE file in this package that may import the
 * engine. A single-project deployment serves the whole Helpthread API from
 * this app: `app/api/route.ts` and `app/api/[...path]/route.ts` hand every
 * `/api/**` request to the composition root's handler, unchanged. The
 * engine's own router, auth, and error envelopes do all the work; nothing
 * here inspects the request or the response.
 *
 * This is a mount, not a client. The UI itself still reaches the engine
 * only over HTTP through `src/lib/api.ts` (CHARTER.md: the operator inbox
 * is a client). `tests/web-engine-boundary.test.ts` fails the build if any
 * other file under `web/src` imports the engine.
 *
 * The `@helpthread/engine` alias (`tsconfig.json` `paths`) resolves to the
 * repo root's compiled `dist/composition/root.js`, produced by
 * `npm run build:engine` — wired as this package's `prebuild`/`predev`.
 */

import 'server-only'
import { getApp } from '@helpthread/engine'

export async function handleEngineRequest(request: Request): Promise<Response> {
  try {
    const handler = await getApp()
    return await handler(request)
  } catch (err) {
    // A thrown error here is a build/config failure (getApp rejected) or a
    // bug that escaped the handler's own catch-alls. Log server-side; answer
    // with the API's standard, detail-free error envelope so a caller never
    // sees a framework error page — and never an env var's name.
    console.error('[engine-mount] failed to build or run the app handler', err)
    return new Response(
      JSON.stringify({ error: { code: 'server_error', message: 'Internal server error.' } }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      },
    )
  }
}
