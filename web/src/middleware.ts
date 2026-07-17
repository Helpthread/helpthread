import { type NextRequest, NextResponse } from 'next/server'
import {
  mintSessionCookie,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  verifySessionCookie,
} from './lib/session'

/**
 * The operator login gate (HT-51). Every route in the app requires a valid
 * session cookie except the handful listed in `PUBLIC_PATHS` below — most
 * importantly `/login` itself, which would otherwise redirect to itself
 * forever. (The login form's submit is a Next.js Server Action, which POSTs
 * back to the SAME `/login` URL rather than a separate endpoint, so no extra
 * path needs listing for it.)
 *
 * This runs on Next's Edge runtime (see `lib/session.ts`'s module comment for
 * why that means Web Crypto, not `node:crypto`), so it stays deliberately
 * thin: verify the cookie, redirect if it's missing/invalid, re-stamp it if
 * it's aging out. No API calls, no business logic — that's what
 * `AuthFailure` and the route handlers are for (see CLAUDE.md's item 5 on
 * this ticket: a bad `HELPTHREAD_API_TOKEN` is a DIFFERENT failure mode from
 * "not logged in", and this file has no opinion about the former at all).
 */

const PUBLIC_PATHS = new Set<string>([
  '/login',
  '/favicon.ico',
  '/robots.txt',
  '/sitemap.xml',
  '/manifest.webmanifest',
])

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname)
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  if (isPublicPath(request.nextUrl.pathname)) {
    return NextResponse.next()
  }

  const session = await verifySessionCookie(request.cookies.get(SESSION_COOKIE_NAME)?.value)

  if (session === null) {
    const loginUrl = new URL('/login', request.url)
    // Built from THIS request's own already-same-origin path — never
    // attacker-supplied — so no `sanitizeNextPath` call is needed here. The
    // read side (the login action consuming `?next=` back) is where that
    // validation actually matters; see `lib/next-path.ts`.
    loginUrl.searchParams.set('next', `${request.nextUrl.pathname}${request.nextUrl.search}`)
    return NextResponse.redirect(loginUrl, 307)
  }

  const response = NextResponse.next()
  if (session.shouldRefresh) {
    response.cookies.set(SESSION_COOKIE_NAME, await mintSessionCookie(), sessionCookieOptions())
  }
  return response
}

export const config = {
  // Next/static build assets and image-optimizer output are never
  // meaningfully "the app" — no session check needed, and running one on
  // every asset request would be pure overhead. Everything else (including
  // routes not yet imagined) is guarded by default; PUBLIC_PATHS above is
  // the only other carve-out.
  matcher: ['/((?!_next/static|_next/image).*)'],
}
