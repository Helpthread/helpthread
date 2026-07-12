/**
 * A hand-rolled bridge between `node:http` and the web-standard
 * `Request`/`Response` pair `createInboxApi` (`src/api/index.ts`) is built
 * on — the whole point of that module's framework-agnostic design (its own
 * doc comment: "a Vercel/Next.js route is a thin deploy-time wrapper, not
 * part of this spec"). This is the "plain Node HTTP server" wrapper it
 * anticipates, written for the local dev harness (HT-24) rather than
 * pulling in a web framework: the API surface is exactly one handler
 * function, so a full framework (Express, Fastify, …) would be a dependency
 * spent on a problem two small functions already solve.
 *
 * No new runtime dependency: both directions are built from Node's own
 * `node:http` and `node:stream` plus the global `Request`/`Response`
 * (undici, bundled in Node since 18).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

/**
 * Build a web-standard `Request` from an incoming Node request. `baseUrl`
 * supplies the scheme/host/port that `IncomingMessage.url` (which is only
 * ever a path, per the HTTP/1.1 request line) doesn't carry — `new URL`
 * needs an absolute base to resolve it against.
 *
 * `GET`/`HEAD` requests are given no body at all (rather than an empty
 * stream) — the Fetch `Request` constructor rejects a body on either
 * method. Every other method streams the incoming request body straight
 * through via `Readable.toWeb`, with `duplex: 'half'` — required by the
 * Fetch spec (and enforced by undici) whenever a `Request`'s body is a
 * stream rather than a buffered value.
 */
export function toWebRequest(req: IncomingMessage, baseUrl: string): Request {
  const url = new URL(req.url ?? '/', baseUrl)

  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    for (const v of Array.isArray(value) ? value : [value]) {
      headers.append(name, v)
    }
  }

  const method = req.method ?? 'GET'
  const hasBody = method !== 'GET' && method !== 'HEAD'

  const init: RequestInit & { duplex?: 'half' } = { method, headers }
  if (hasBody) {
    init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>
    init.duplex = 'half'
  }

  return new Request(url, init)
}

/**
 * Write a web-standard `Response` back onto a Node `ServerResponse`: status,
 * every header, then the fully-buffered body. Buffered (via `arrayBuffer()`)
 * rather than streamed — every response this API ever produces
 * (`src/api/responses.ts`) is a small JSON envelope, so the simplicity of
 * "read it all, write it once" costs nothing in practice and avoids a second
 * stream-plumbing path alongside {@link toWebRequest}'s.
 */
export async function sendWebResponse(response: Response, res: ServerResponse): Promise<void> {
  res.statusCode = response.status
  response.headers.forEach((value, name) => {
    res.setHeader(name, value)
  })
  const body = Buffer.from(await response.arrayBuffer())
  res.end(body)
}

/**
 * Adapt a `(Request) => Promise<Response>` handler (i.e. `createInboxApi`'s
 * return value) into the `(req, res) => void` shape `node:http`'s
 * `createServer` expects. Any error the handler throws (it shouldn't —
 * `createInboxApi` catches its own internals — but a bridge-layer bug, e.g.
 * a body-stream error, is still possible) is logged and answered with a bare
 * 500, never left to hang the connection or crash the process.
 */
export function createHttpBridge(
  handler: (request: Request) => Promise<Response>,
  baseUrl: string,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async () => {
      try {
        const request = toWebRequest(req, baseUrl)
        const response = await handler(request)
        await sendWebResponse(response, res)
      } catch (err) {
        console.error('[dev-api] request bridge error', err)
        if (!res.headersSent) {
          res.statusCode = 500
        }
        res.end()
      }
    })()
  }
}
