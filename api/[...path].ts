/**
 * The single Vercel Function fronting the whole Helpthread engine (HT-43) — a
 * catch-all under `/api` that hands every request to the composition root's
 * unified handler (`src/composition/root.ts`). Vercel's Node runtime is the
 * target (NOT Edge): the engine needs `node:crypto` (HMAC reply tokens,
 * AES-GCM token encryption), which the Edge runtime lacks.
 *
 * ## Why one catch-all + the `fetch` Web Standard export
 *
 * Vercel's Node runtime supports the `fetch` Web Standard export
 * (`export default { fetch(request: Request): Response }`), which handles ALL
 * HTTP methods in one function and hands us a web-standard `Request` directly
 * — so `createInboxApi`'s framework-agnostic `Request => Response` shape wires
 * in with no `node:http` bridge at all (the dev harness's bridge,
 * `src/dev/http-adapter.ts`, exists only because a bare `node:http` server
 * gives `(req, res)`; Vercel does not). A catch-all `[...path]` file receives
 * every `/api/v1/...` path with `request.url` intact, so the engine's own
 * router (and the composition root's internal-cron routing) does all path
 * dispatch — no per-route function files duplicating that knowledge.
 *
 * This file is deliberately thin: all wiring lives in the typechecked
 * `src/composition/**`. It only awaits the memoized handler and guards against
 * a construction/handler failure with a generic 500 (never leaking the error's
 * text, which could name a missing env var).
 */

import { getApp } from '../src/composition/root.js'

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      const handler = await getApp()
      return await handler(request)
    } catch (err) {
      // A thrown error here is a build/config failure (getApp rejected) or a
      // bug that escaped the handler's own catch-alls. Log server-side; answer
      // with the standard, detail-free error envelope.
      console.error('[api] failed to build or run the app handler', err)
      return new Response(
        JSON.stringify({ error: { code: 'server_error', message: 'Internal server error.' } }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        },
      )
    }
  },
}
