import { type NextRequest, NextResponse } from 'next/server'
import {
  mintSessionCookie,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  verifySessionCookie,
} from './lib/session'

/**
 * The Agent login gate (HT-51; carries identity per HT-54, spec §8). Every
 * route in the app requires a valid session cookie except the handful
 * listed in `PUBLIC_PATHS`/`PUBLIC_PREFIXES` below — most importantly
 * `/login` itself, which would otherwise redirect to itself forever.
 * (`/login` and `/setup`'s form submits are Next.js Server Actions, which
 * POST back to the SAME URL rather than a separate endpoint, so no extra
 * path needs listing for either.) `/invite/{token}` is a PREFIX rule, not an
 * exact match — the token rides the path.
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
  '/setup',
  '/favicon.ico',
  '/robots.txt',
  '/sitemap.xml',
  '/manifest.webmanifest',
])

/** Path PREFIXES that are public regardless of what follows — currently just the invite-accept token route. */
const PUBLIC_PREFIXES: readonly string[] = ['/invite/']

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname) || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))
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
    // Thread `sub` through the re-stamp — spec §8's called-out trap: a
    // refresh that re-minted the cookie WITHOUT the just-verified identity
    // would silently drop the signed-in Agent mid-session. `sub` being a
    // required `mintSessionCookie` parameter makes the identity-less call
    // a compile error; this is the one call site that could have made it.
    response.cookies.set(
      SESSION_COOKIE_NAME,
      await mintSessionCookie(session.payload.sub),
      sessionCookieOptions(),
    )
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
