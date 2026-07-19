'use server'

/**
 * Server actions — the ONLY write path from the browser to the Agent Inbox
 * API. Each action runs server-side (the Bearer token never leaves the
 * server), performs one API call, revalidates the affected routes, and
 * returns a plain serializable result so client components can render
 * precise outcomes (notably the reply flow's three failure modes, spec §4a).
 *
 * ## Every action re-checks the session itself (HT-51 review)
 *
 * `middleware.ts` gates page renders, but Next.js dispatches Server Actions
 * by a build-stable action-ID hash that is invokable directly against ANY
 * route — including `/login`, the one path `middleware.ts` waves through
 * with no session check (it has to: that's the page the login form itself
 * posts to). A request forged with a recovered action ID and `Next-Action`
 * header would otherwise run server-side with zero session, because
 * middleware never sees the mutation as "the app" — only as a POST to a
 * public path. So the middleware CANNOT be the only gate: per Next.js's own
 * guidance, Server Actions must authorize themselves. `requireSession` below
 * is that check, called first in every exported action here.
 */

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import {
  ApiError,
  type ConversationFolder,
  type ConversationStatus,
  type ConversationSummary,
  deleteConversation,
  listConversations,
  postNote,
  postReply,
  putAssignee,
  putTags,
  setStatus,
} from './api'
import { SESSION_COOKIE_NAME, verifySessionCookie } from './session'

export interface ActionResult {
  ok: boolean
  /** Machine-readable API error code when `ok` is false (spec §3). */
  code?: string
  message?: string
}

const UNAUTHORIZED_RESULT: ActionResult = {
  ok: false,
  code: 'unauthorized',
  message: 'Your session has expired. Please sign in again.',
}

/**
 * Verifies the operator session cookie on THIS invocation — never trusts
 * that middleware already checked it (see the module comment above). Returns
 * `true` once the cookie is valid, `false` otherwise; callers short-circuit
 * on `false` before touching the API.
 */
async function hasValidSession(): Promise<boolean> {
  const cookieStore = await cookies()
  const session = await verifySessionCookie(cookieStore.get(SESSION_COOKIE_NAME)?.value)
  return session !== null
}

/**
 * Send a reply. The client supplies the Idempotency-Key and MUST reuse it
 * when retrying after `retry_in_progress` or a network failure — the key is
 * what makes a retry safe (spec §4a). `html` is optional — the composer only
 * sends it when the Agent actually used the format toolbar (spec §4a: HTML
 * is optional alongside the required plain text).
 */
export async function sendReplyAction(
  conversationId: string,
  text: string,
  idempotencyKey: string,
  html?: string,
): Promise<ActionResult> {
  if (!(await hasValidSession())) return UNAUTHORIZED_RESULT
  try {
    await postReply(conversationId, { text, html }, idempotencyKey)
    revalidatePath(`/conversations/${conversationId}`)
    revalidatePath('/inbox/[folder]', 'page')
    return { ok: true }
  } catch (error) {
    if (error instanceof ApiError) {
      return { ok: false, code: error.code, message: error.message }
    }
    return { ok: false, code: 'network', message: 'Could not reach the server.' }
  }
}

/** Post an internal note (spec §4c) — never emailed, never touches the send path. */
export async function postNoteAction(conversationId: string, text: string): Promise<ActionResult> {
  if (!(await hasValidSession())) return UNAUTHORIZED_RESULT
  try {
    await postNote(conversationId, text)
    revalidatePath(`/conversations/${conversationId}`)
    revalidatePath('/inbox/[folder]', 'page')
    return { ok: true }
  } catch (error) {
    if (error instanceof ApiError) {
      return { ok: false, code: error.code, message: error.message }
    }
    return { ok: false, code: 'network', message: 'Could not reach the server.' }
  }
}

export async function setStatusAction(
  conversationId: string,
  status: ConversationStatus,
): Promise<ActionResult> {
  if (!(await hasValidSession())) return UNAUTHORIZED_RESULT
  try {
    await setStatus(conversationId, status)
    revalidatePath(`/conversations/${conversationId}`)
    revalidatePath('/inbox/[folder]', 'page')
    return { ok: true }
  } catch (error) {
    if (error instanceof ApiError) {
      return { ok: false, code: error.code, message: error.message }
    }
    return { ok: false, code: 'network', message: 'Could not reach the server.' }
  }
}

/** Replace-set tags update (spec §4e) — the caller passes the FULL next tag set. */
export async function putTagsAction(conversationId: string, tags: string[]): Promise<ActionResult> {
  if (!(await hasValidSession())) return UNAUTHORIZED_RESULT
  try {
    await putTags(conversationId, tags)
    revalidatePath(`/conversations/${conversationId}`)
    revalidatePath('/inbox/[folder]', 'page')
    return { ok: true }
  } catch (error) {
    if (error instanceof ApiError) {
      return { ok: false, code: error.code, message: error.message }
    }
    return { ok: false, code: 'network', message: 'Could not reach the server.' }
  }
}

/** Assign a conversation to an Agent, or release it (`null`) — spec §4f, HT-54 real-Agent shape. */
export async function putAssigneeAction(
  conversationId: string,
  assigneeAgentId: string | null,
): Promise<ActionResult> {
  if (!(await hasValidSession())) return UNAUTHORIZED_RESULT
  try {
    await putAssignee(conversationId, assigneeAgentId)
    revalidatePath(`/conversations/${conversationId}`)
    revalidatePath('/inbox/[folder]', 'page')
    return { ok: true }
  } catch (error) {
    if (error instanceof ApiError) {
      return { ok: false, code: error.code, message: error.message }
    }
    return { ok: false, code: 'network', message: 'Could not reach the server.' }
  }
}

export async function deleteConversationAction(conversationId: string): Promise<ActionResult> {
  if (!(await hasValidSession())) return UNAUTHORIZED_RESULT
  try {
    await deleteConversation(conversationId)
    revalidatePath(`/conversations/${conversationId}`)
    revalidatePath('/inbox/[folder]', 'page')
    return { ok: true }
  } catch (error) {
    if (error instanceof ApiError) {
      return { ok: false, code: error.code, message: error.message }
    }
    return { ok: false, code: 'network', message: 'Could not reach the server.' }
  }
}

/**
 * One more page of a keyset-paginated folder (Closed/Spam only — the other
 * five folders fetch unpaged). Plain data in, plain data out so the client
 * screen can append it to in-memory state without a route navigation.
 */
export async function loadOlderAction(
  folder: Extract<ConversationFolder, 'closed' | 'spam'>,
  cursor: string,
): Promise<{ conversations: ConversationSummary[]; nextCursor: string | null }> {
  // No ActionResult shape to carry an { ok: false } outcome here — the caller
  // (`InboxScreen`'s `loadOlder`) already wraps this call in a try/catch and
  // shows a generic "couldn't load" toast, so a thrown error is the right
  // signal for "no valid session" too.
  if (!(await hasValidSession())) {
    throw new Error('unauthorized')
  }
  const page = await listConversations({ folder, cursor })
  return { conversations: page.conversations, nextCursor: page.nextCursor }
}
