'use server'

/**
 * Server actions — the ONLY write path from the browser to the Agent Inbox
 * API. Each action runs server-side (the Bearer token never leaves the
 * server), performs one API call, revalidates the affected routes, and
 * returns a plain serializable result so client components can render
 * precise outcomes (notably the reply flow's three failure modes, spec §4a).
 */

import { revalidatePath } from 'next/cache'
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

export interface ActionResult {
  ok: boolean
  /** Machine-readable API error code when `ok` is false (spec §3). */
  code?: string
  message?: string
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

/** Claim or release the single-Agent assignee flag (spec §4f). */
export async function putAssigneeAction(
  conversationId: string,
  assignee: 'me' | null,
): Promise<ActionResult> {
  try {
    await putAssignee(conversationId, assignee)
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
  const page = await listConversations({ folder, cursor })
  return { conversations: page.conversations, nextCursor: page.nextCursor }
}
