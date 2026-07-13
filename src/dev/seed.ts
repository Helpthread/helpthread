/**
 * Dev seed data for the local API harness (HT-24) — enough variety in one
 * boot for the upcoming Agent Inbox UI (HT-23) to exercise every state it
 * must render: an inbound-only conversation, a threaded back-and-forth, one
 * outbound thread in each delivery state (`sent`/`failed`/stale `pending`),
 * a closed conversation, and one inbound message with a rich HTML body (so
 * the UI's sanitized-HTML path — spec §5's stored-XSS contract — is exercised
 * against real data). Every name and message below is invented for this
 * seed — never real customer data (CLAUDE.md).
 *
 * Reuses the real engine paths wherever practical rather than raw SQL, so
 * seeding itself exercises the store and the send pipeline:
 * `ConversationStore.createConversation`/`appendThread` for inbound
 * messages, and `sendReply` (`src/mail/send.ts` — the same
 * mint→persist→send→mark path `POST .../replies` uses) for outbound ones.
 * The one deliberate exception is the "stale pending" demo, documented at
 * its call site below.
 */

import { randomUUID } from 'node:crypto'
import type { Db } from '../db/client.js'
import type { Keyring } from '../mail/reply-token.js'
import { mintReplyMessageId } from '../mail/reply-token.js'
import { sendReply } from '../mail/send.js'
import type { EmailSender } from '../providers/index.js'
import type { ConversationStore } from '../store/conversations.js'

export interface SeedDevDataDeps {
  db: Db
  store: ConversationStore
  /** The dev sender every SUCCESSFUL seed reply is sent through (logs to stdout, delivers nothing). */
  sender: EmailSender
  keyring: Keyring
  mailDomain: string
  supportAddress: string
}

export interface SeedDevDataResult {
  conversationCount: number
}

/**
 * A sender that always rejects — used for exactly one seed reply, so that
 * conversation's outbound thread lands in the real `'failed'` delivery
 * state via the engine's own send-failure handling (`sendReply` marks the
 * thread `'failed'` when the provider throws), rather than being faked up
 * with a raw status write.
 */
const FAILING_SEED_SENDER: EmailSender = {
  maxSendMs: 5_000,
  async send() {
    throw new Error('dev seed: simulated provider rejection (the "failed" delivery-state demo)')
  },
}

/**
 * Seed the demo conversations. Safe to call once against a fresh (just-
 * migrated, empty) database — every conversation is newly created, so a
 * second call would simply add a second copy of each rather than erroring,
 * but the dev harness only ever calls this once per fresh in-memory boot
 * (`scripts/dev-api.ts`).
 */
export async function seedDevData(deps: SeedDevDataDeps): Promise<SeedDevDataResult> {
  const { db, store, sender, keyring, mailDomain, supportAddress } = deps
  let conversationCount = 0

  // --- 1. Inbound-only: a customer message with no reply yet. ---------------
  await store.createConversation({
    subject: "Can't log into my account",
    customerEmail: 'mia.chen@example.test',
    firstMessage: {
      direction: 'inbound',
      messageId: '<inbound-1@mia-chen.example.test>',
      fromAddress: 'mia.chen@example.test',
      bodyText:
        "Hi, I've tried resetting my password twice and I'm still locked out. Can you help?",
    },
  })
  conversationCount++

  // --- 2. Threaded back-and-forth: inbound, outbound (sent), inbound, outbound (sent). ---
  const threaded = await store.createConversation({
    subject: 'Refund request for order #4821',
    customerEmail: 'devon.brooks@example.test',
    firstMessage: {
      direction: 'inbound',
      messageId: '<inbound-1@devon-brooks.example.test>',
      fromAddress: 'devon.brooks@example.test',
      bodyText: "Hi, I'd like a refund for order #4821 — it arrived damaged.",
    },
  })
  conversationCount++
  const threadedReply1 = await sendReply(
    {
      conversationId: threaded.conversationId,
      from: supportAddress,
      to: ['devon.brooks@example.test'],
      subject: 'Re: Refund request for order #4821',
      text: 'Sorry to hear that! Could you send a photo of the damage so we can process the refund?',
      inReplyTo: '<inbound-1@devon-brooks.example.test>',
      references: ['<inbound-1@devon-brooks.example.test>'],
      idempotencyKey: 'seed-devon-brooks-reply-1',
    },
    { store, sender, keyring, mailDomain },
  )
  if (!threadedReply1.ok) {
    throw new Error("seed: expected the threaded demo's first reply to send successfully")
  }
  await store.appendThread(threaded.conversationId, {
    direction: 'inbound',
    messageId: '<inbound-2@devon-brooks.example.test>',
    inReplyTo: threadedReply1.messageId,
    fromAddress: 'devon.brooks@example.test',
    bodyText: 'Sure — attached is a photo of the damaged packaging.',
  })
  const threadedReply2 = await sendReply(
    {
      conversationId: threaded.conversationId,
      from: supportAddress,
      to: ['devon.brooks@example.test'],
      subject: 'Re: Refund request for order #4821',
      text: 'Thanks for the photo — refund processed, should appear in 3-5 business days.',
      inReplyTo: '<inbound-2@devon-brooks.example.test>',
      references: [
        '<inbound-1@devon-brooks.example.test>',
        threadedReply1.messageId,
        '<inbound-2@devon-brooks.example.test>',
      ],
      idempotencyKey: 'seed-devon-brooks-reply-2',
    },
    { store, sender, keyring, mailDomain },
  )
  if (!threadedReply2.ok) {
    throw new Error("seed: expected the threaded demo's second reply to send successfully")
  }

  // --- 3. Outbound delivery state: 'sent'. -----------------------------------
  const sentDemo = await store.createConversation({
    subject: 'Question about Pro plan pricing',
    customerEmail: 'priya.natarajan@example.test',
    firstMessage: {
      direction: 'inbound',
      messageId: '<inbound-1@priya-natarajan.example.test>',
      fromAddress: 'priya.natarajan@example.test',
      bodyText: "What's included in the Pro plan, and is there a seat minimum?",
    },
  })
  conversationCount++
  const sentReply = await sendReply(
    {
      conversationId: sentDemo.conversationId,
      from: supportAddress,
      to: ['priya.natarajan@example.test'],
      subject: 'Re: Question about Pro plan pricing',
      text: 'Pro includes unlimited shared inboxes and no seat minimum — happy to send the full comparison if useful!',
      inReplyTo: '<inbound-1@priya-natarajan.example.test>',
      references: ['<inbound-1@priya-natarajan.example.test>'],
      idempotencyKey: 'seed-priya-natarajan-reply-1',
    },
    { store, sender, keyring, mailDomain },
  )
  if (!sentReply.ok) {
    throw new Error("seed: expected the 'sent' delivery-state demo's reply to send successfully")
  }

  // --- 4. Outbound delivery state: 'failed'. ---------------------------------
  const failedDemo = await store.createConversation({
    subject: 'Shipping delay on order #77',
    customerEmail: 'sam.oyelaran@example.test',
    firstMessage: {
      direction: 'inbound',
      messageId: '<inbound-1@sam-oyelaran.example.test>',
      fromAddress: 'sam.oyelaran@example.test',
      bodyText: "My order #77 hasn't shipped yet and it's been over a week. What's going on?",
    },
  })
  conversationCount++
  // Sent through FAILING_SEED_SENDER instead of the dev sender: sendReply's
  // own failure handling (src/mail/send.ts) is what marks this thread
  // 'failed' — a genuine engine-produced failure, not a hand-set status.
  await sendReply(
    {
      conversationId: failedDemo.conversationId,
      from: supportAddress,
      to: ['sam.oyelaran@example.test'],
      subject: 'Re: Shipping delay on order #77',
      text: "We're sorry for the delay — checking with the warehouse now and will follow up shortly.",
      inReplyTo: '<inbound-1@sam-oyelaran.example.test>',
      references: ['<inbound-1@sam-oyelaran.example.test>'],
      idempotencyKey: 'seed-sam-oyelaran-reply-1',
    },
    { store, sender: FAILING_SEED_SENDER, keyring, mailDomain },
  )

  // --- 5. Outbound delivery state: stale 'pending'. --------------------------
  const staleDemo = await store.createConversation({
    subject: 'Question about API rate limits',
    customerEmail: 'jordan.kwame@example.test',
    firstMessage: {
      direction: 'inbound',
      messageId: '<inbound-1@jordan-kwame.example.test>',
      fromAddress: 'jordan.kwame@example.test',
      bodyText: 'What are the current API rate limits for the REST endpoints?',
    },
  })
  conversationCount++
  // Modeling a crash between persist and send (specs/mail/sending.md §3: the
  // ordering that leaves a thread truthfully 'pending' rather than falsely
  // 'sent') is not something `sendReply` itself can produce on demand — it
  // always resolves to 'sent' or 'failed'. So this row is persisted directly
  // via `ConversationStore.appendThread` (a real store call, not raw SQL),
  // with a properly minted Message-ID and a send envelope, exactly as
  // `sendReply` would have left it mid-flight.
  const staleThreadId = randomUUID()
  const staleMessageId = mintReplyMessageId(
    { conversationId: staleDemo.conversationId, threadId: staleThreadId, mailDomain },
    keyring,
  )
  const staleAppended = await store.appendThread(staleDemo.conversationId, {
    id: staleThreadId,
    direction: 'outbound',
    messageId: staleMessageId,
    inReplyTo: '<inbound-1@jordan-kwame.example.test>',
    fromAddress: supportAddress,
    bodyText: "We're pulling together the current limits for you now.",
    deliveryStatus: 'pending',
    sendEnvelope: {
      to: ['jordan.kwame@example.test'],
      subject: 'Re: Question about API rate limits',
      references: ['<inbound-1@jordan-kwame.example.test>'],
    },
  })
  if (!staleAppended.ok) {
    throw new Error("seed: expected the stale-pending demo's thread to persist")
  }
  // Backdate just this one row so it reads as genuinely STALE — older than
  // the delivery worker's default 5-minute staleAfterMs
  // (`DEFAULT_STALE_AFTER_MS`, src/mail/delivery-worker.ts) — rather than a
  // send that merely hasn't resolved yet. There is no `ConversationStore`
  // method for setting `created_at` (no real code path ever backdates a
  // row), so this is the one deliberate raw-SQL step in this seed script,
  // scoped to exactly the row it demonstrates.
  await db.query("UPDATE threads SET created_at = now() - interval '1 hour' WHERE id = $1", [
    staleThreadId,
  ])

  // --- 6. Closed conversation. ------------------------------------------------
  const closedDemo = await store.createConversation({
    subject: 'Thanks for the help!',
    customerEmail: 'elena.vasquez@example.test',
    firstMessage: {
      direction: 'inbound',
      messageId: '<inbound-1@elena-vasquez.example.test>',
      fromAddress: 'elena.vasquez@example.test',
      bodyText: 'Just wanted to say thanks for resolving my login issue last week!',
    },
  })
  conversationCount++
  const closedReply = await sendReply(
    {
      conversationId: closedDemo.conversationId,
      from: supportAddress,
      to: ['elena.vasquez@example.test'],
      subject: 'Re: Thanks for the help!',
      text: "You're very welcome! Glad it's all sorted now.",
      inReplyTo: '<inbound-1@elena-vasquez.example.test>',
      references: ['<inbound-1@elena-vasquez.example.test>'],
      idempotencyKey: 'seed-elena-vasquez-reply-1',
    },
    { store, sender, keyring, mailDomain },
  )
  if (!closedReply.ok) {
    throw new Error("seed: expected the closed-conversation demo's reply to send successfully")
  }
  await store.setConversationStatus(closedDemo.conversationId, 'closed')

  // --- 7. Inbound-only with a rich HTML body. --------------------------------
  // The one demo that exercises the inbox UI's sanitized-HTML path (spec
  // §5's stored-XSS contract). The parser stores inbound HTML verbatim —
  // `<script>` and all (specs/mail/threading.md §5, fixtures/mail/observed/
  // html-body.json) — so this `bodyHtml` deliberately carries the four
  // things the UI's sanitizer, its "HTML email · sanitized · external images
  // blocked" caption, and its Show-original modal must all handle: formatting,
  // a link, a remote `<img>` (a tracking pixel), and a `<script>`. The store
  // returns it untouched (safe as JSON); sanitization is the renderer's job.
  // `bodyText` is the plain-text alternative the same mail would carry.
  await store.createConversation({
    subject: 'Unexpected charge on my March invoice',
    customerEmail: 'noah.feldman@example.test',
    firstMessage: {
      direction: 'inbound',
      messageId: '<inbound-1@noah-feldman.example.test>',
      fromAddress: 'noah.feldman@example.test',
      bodyText:
        'Hi there,\n\n' +
        "My March invoice shows a charge I don't recognize — a line item for " +
        '"Priority Support" that I never signed up for.\n\n' +
        'Here is the invoice in question: https://billing.example.com/invoices/48213\n\n' +
        'Could you take a look and let me know? Thanks,\nNoah',
      bodyHtml:
        '<p>Hi there,</p>' +
        '<p>My <strong>March invoice</strong> shows a charge I don&rsquo;t recognize &mdash; ' +
        'a line item for <em>&ldquo;Priority Support&rdquo;</em> that I never signed up for.</p>' +
        '<p>Here is the invoice in question: ' +
        '<a href="https://billing.example.com/invoices/48213">billing.example.com/invoices/48213</a></p>' +
        '<p>Could you take a look and let me know? Thanks,<br>Noah</p>' +
        '<img src="https://tracker.example.com/o.gif?u=48213" width="1" height="1" alt="">' +
        '<script>document.title = "pwned"</script>',
    },
  })
  conversationCount++

  return { conversationCount }
}
