/**
 * THE acceptance-bar test for HT-70 (specs/plugins/substrate-v1.md §6's
 * closing paragraph, CHARTER.md invariant #5's mail-semantics-equivalence
 * rule): the wire-level RFC 5322 output of (assistant draft → unedited
 * approve → delivery) must equal `sendReply`'s output for the same
 * conversation state and body, modulo Message-ID token randomness — same
 * headers, same References chain, same body handling, same pixel behavior
 * in both configs.
 *
 * Modeled on `src/providers/adapters/gmail/mime.test.ts` — the existing
 * wire-level contract test for `sendReply` itself — reusing the exact same
 * `buildRawMessage` (`src/providers/adapters/gmail/mime.ts`) to turn each
 * path's captured `OutboundEmail` into actual RFC 5322 bytes, then diffing
 * those bytes directly rather than comparing structured fields (a
 * byte-for-byte comparison is the strongest form of "these are the same
 * mail" a test can assert).
 *
 * The two paths necessarily mint DIFFERENT Message-IDs (different
 * `threadId`s — `sendReply` mints a fresh one per call; `approveDraft`
 * mints for the draft's own, already-existing thread id): the messageId
 * itself is deliberately excluded from the comparison ("modulo Message-ID
 * token randomness", spec §6), by substituting a shared placeholder for
 * each path's own token everywhere it appears (including as the final
 * References entry — the HT-49 rule applies identically to both paths).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import { buildRawMessage } from '../providers/adapters/gmail/mime.js'
import type { EmailSender, OutboundEmail } from '../providers/index.js'
import { type ConversationStore, createConversationStore } from '../store/conversations.js'
import { approveDraft } from './approve-draft.js'
import { deriveReplyHeaders } from './reply-headers.js'
import type { Keyring, SigningKey } from './reply-token.js'
import { sendReply } from './send.js'

const KEY_A: SigningKey = { keyId: 'k1', secret: 'secret-A-high-entropy-0123456789abcdef' }
const keyring: Keyring = { current: KEY_A }
const mailDomain = 'mail.example.test'
const supportAddress = 'support@example.test'
const BODY_TEXT = 'Thanks for reaching out — here is the update on your order.'
const BODY_HTML = '<p>Thanks for reaching out — here is the update on your order.</p>'

function fakeSender(): EmailSender & { sent: OutboundEmail[] } {
  const sent: OutboundEmail[] = []
  return {
    sent,
    maxSendMs: 30_000,
    async send(email) {
      sent.push(email)
      return { providerMessageId: 'provider-1' }
    },
  }
}

async function createTestAssistant(db: Db): Promise<string> {
  const [row] = await db.query<{ id: string }>(
    `INSERT INTO assistants (name, module, token_hash) VALUES ('Draft Bot', 'draft-reply', 'hash') RETURNING id`,
  )
  return row.id
}

async function createTestAgent(db: Db): Promise<string> {
  const [row] = await db.query<{ id: string }>(
    `INSERT INTO agents (email, name, role, status) VALUES ('agent@example.test', 'Agent', 'agent', 'active') RETURNING id`,
  )
  return row.id
}

/** Seed a conversation with exactly one inbound message — the ancestor every reply in this suite answers. */
async function seedConversation(store: ConversationStore, customerEmail: string) {
  return store.createConversation({
    subject: 'Help with my order',
    customerEmail,
    firstMessage: {
      direction: 'inbound',
      messageId: '<inbound-1@customer.example.test>',
      fromAddress: customerEmail,
      bodyText: 'Please help, my order is late.',
    },
  })
}

/**
 * Normalize away the sources of PER-CALL randomness an `OutboundEmail`
 * carries that are not part of the equivalence claim — done at THIS layer
 * (before `buildRawMessage`'s base64 body encoding), not on the raw wire
 * text after the fact: a placeholder substituted into already-base64-encoded
 * bytes would only line up with the original if it happened to share the
 * source string's exact byte length AND land on a 3-byte encoding boundary,
 * neither of which is guaranteed — normalizing the plaintext first and
 * THEN encoding sidesteps that entirely.
 *
 * 1. The minted Message-ID token — `sendReply` and `approveDraft`
 *    necessarily mint against different `threadId`s (different
 *    conversations), so their tokens, and every occurrence of the LATTER
 *    as the final `References` entry (HT-49), can never match by
 *    construction. "Modulo Message-ID token randomness" (spec §6) is the
 *    whole point of this substitution.
 * 2. The HT-32 pixel's view token, embedded in the HTML body
 *    (`v.<keyId>.<threadId>.<sig>` — `src/mail/open-tracking.ts`), which is
 *    likewise threadId-derived and therefore path-specific.
 */
function normalizeOutboundEmail(email: OutboundEmail): OutboundEmail {
  return {
    ...email,
    messageId: '<MESSAGE_ID>',
    references: email.references?.map((ref) => (ref === email.messageId ? '<MESSAGE_ID>' : ref)),
    html: email.html?.replace(
      /v\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.gif/g,
      '<PIXEL>.gif',
    ),
  }
}

/**
 * Strip `mimetext`'s MIME multipart boundary from an already-built raw
 * message — a fresh random string EVERY `buildRawMessage` call, even for
 * two calls on the byte-identical `OutboundEmail`; not an engine-controlled
 * value and not part of the mail-semantics equivalence this test asserts.
 * Applied AFTER `buildRawMessage` (unlike {@link normalizeOutboundEmail}'s
 * pre-encoding substitutions) because the boundary is generated BY that
 * call, not present in its input.
 */
function normalizeBoundary(raw: string): string {
  const boundary = /boundary=(\S+)/.exec(raw)?.[1]
  return boundary === undefined ? raw : raw.split(boundary).join('<BOUNDARY>')
}

/** The full normalize-then-build pipeline both equivalence assertions below use. */
function normalizedRawMessage(email: OutboundEmail): string {
  return normalizeBoundary(buildRawMessage(normalizeOutboundEmail(email)))
}

/** Run both paths (sendReply vs. assistant-draft-then-approve) against fresh, otherwise-identical conversations, and return each path's captured OutboundEmail. */
async function runBothFlows(openTracking?: {
  publicBaseUrl: string
}): Promise<{ sentA: OutboundEmail; sentB: OutboundEmail; db: Db }> {
  const db = await createPgliteDb()
  await migrate(db)
  const store = createConversationStore(db)
  const assistantId = await createTestAssistant(db)
  const agentId = await createTestAgent(db)

  // --- Path A: sendReply, the ordinary Agent-reply path ---
  const senderA = fakeSender()
  const { conversationId: convA } = await seedConversation(store, 'customer@example.test')
  const conversationA = await store.getConversation(convA, { includeDeleted: false })
  if (conversationA === null) throw new Error('unreachable: just-created conversation missing')
  const headersA = deriveReplyHeaders(conversationA)
  const resultA = await sendReply(
    {
      conversationId: conversationA.id,
      from: supportAddress,
      to: [conversationA.customerEmail],
      subject: headersA.subject,
      text: BODY_TEXT,
      html: BODY_HTML,
      inReplyTo: headersA.inReplyTo,
      references: headersA.references,
    },
    {
      store,
      sender: senderA,
      keyring,
      mailDomain,
      ...(openTracking !== undefined ? { openTracking } : {}),
    },
  )
  if (!resultA.ok) throw new Error(`sendReply failed: ${JSON.stringify(resultA)}`)

  // --- Path B: assistant posts a draft with the SAME body -> unedited approve -> delivery ---
  const senderB = fakeSender()
  const { conversationId: convB } = await seedConversation(store, 'customer@example.test')
  const draftResult = await store.appendDraft(convB, {
    assistantId,
    bodyText: BODY_TEXT,
    bodyHtml: BODY_HTML,
    fromAddress: supportAddress,
    idempotencyKey: 'draft-equivalence-1',
  })
  if (!draftResult.ok) throw new Error(`appendDraft failed: ${JSON.stringify(draftResult)}`)
  const conversationB = await store.getConversation(convB, { includeDeleted: false })
  if (conversationB === null) throw new Error('unreachable: just-created conversation missing')

  const resultB = await approveDraft(
    {
      conversation: conversationB,
      draftThreadId: draftResult.threadId,
      resolvedByAgentId: agentId,
      // No `edit` — an UNEDITED approve, per the spec's acceptance bar.
    },
    {
      store,
      sender: senderB,
      keyring,
      mailDomain,
      ...(openTracking !== undefined ? { openTracking } : {}),
    },
  )
  if (!resultB.ok) throw new Error(`approveDraft failed: ${JSON.stringify(resultB)}`)

  return { sentA: senderA.sent[0], sentB: senderB.sent[0], db }
}

describe('draft-approval vs. sendReply: wire-level equivalence (HT-70, spec §6)', () => {
  let dbToClose: Db | undefined

  afterEach(async () => {
    await dbToClose?.close()
    dbToClose = undefined
  })

  it('produces byte-identical RFC 5322 output modulo the Message-ID token, with HT-32 pixel injection OFF', async () => {
    const { sentA, sentB, db } = await runBothFlows()
    dbToClose = db

    const rawA = normalizedRawMessage(sentA)
    const rawB = normalizedRawMessage(sentB)

    expect(rawA).toBe(rawB)
    // Sanity: the equivalence isn't vacuous — both are real, non-empty
    // replies, and the pixel is genuinely absent from each pre-encoding body.
    expect(rawA).toContain(`Subject:`)
    expect(sentA.html).not.toContain('<img ')
    expect(sentB.html).not.toContain('<img ')
  })

  it('produces byte-identical RFC 5322 output modulo the Message-ID token, with HT-32 pixel injection ON', async () => {
    const openTracking = { publicBaseUrl: 'https://desk.example.test' }
    const { sentA, sentB, db } = await runBothFlows(openTracking)
    dbToClose = db

    const rawA = normalizedRawMessage(sentA)
    const rawB = normalizedRawMessage(sentB)

    expect(rawA).toBe(rawB)
    // Sanity: pixel injection actually fired on BOTH paths (not vacuously
    // equal empties) — checked on the pre-encoding OutboundEmail.html, since
    // buildRawMessage base64-encodes the body (an `<img ` substring is not
    // literally present in the raw wire text).
    expect(sentA.html).toContain('<img ')
    expect(sentB.html).toContain('<img ')
  })

  it('both paths derive the identical References chain — ancestor inbound id, then the (distinct) minted token as the FINAL entry (HT-49)', async () => {
    const { sentA, sentB, db } = await runBothFlows()
    dbToClose = db

    expect(sentA.references).toEqual(['<inbound-1@customer.example.test>', sentA.messageId])
    expect(sentB.references).toEqual(['<inbound-1@customer.example.test>', sentB.messageId])
    expect(sentA.inReplyTo).toBe('<inbound-1@customer.example.test>')
    expect(sentB.inReplyTo).toBe('<inbound-1@customer.example.test>')
  })

  it('both paths derive the identical subject, from, and to', async () => {
    const { sentA, sentB, db } = await runBothFlows()
    dbToClose = db

    expect(sentB.subject).toBe(sentA.subject)
    expect(sentB.from).toBe(sentA.from)
    expect(sentB.to).toEqual(sentA.to)
  })
})
