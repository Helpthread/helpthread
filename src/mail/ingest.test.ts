import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db, type Queryable } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import type { BlobStore, RawInboundMessage } from '../providers/index.js'
import { createThreadAttachmentStore } from '../store/attachments.js'
import { createInboundDeliveryStore } from '../store/inbound-deliveries.js'
import {
  type IngestDeps,
  type IngestOutcome,
  ingestInboundMessage,
  isOwnMessageReflection,
  MAX_INGEST_ATTEMPTS,
  sanitizeAttachmentFilename,
} from './ingest.js'
import type { ParsedEmail } from './parse.js'
import { type Keyring, mintReplyMessageId, type SigningKey } from './reply-token.js'

// --- fixtures ----------------------------------------------------------------

const RANDOM_UUID = '00000000-0000-4000-8000-000000000000'

const KEY_A: SigningKey = { keyId: 'k1', secret: 'ingest-test-secret-0123456789abcdefgh' }
const keyring: Keyring = { current: KEY_A }
const MAIL_DOMAIN = 'mail.example.test'

/** Build raw RFC5322 bytes from a header map + body — `\r\n`-joined, matching the wire format `parseInboundEmail` expects. */
function rawMessage(headers: Record<string, string>, body: string): Uint8Array {
  const lines = Object.entries(headers).map(([key, value]) => `${key}: ${value}`)
  return new TextEncoder().encode(`${lines.join('\r\n')}\r\n\r\n${body}`)
}

/** A fresh customer message with no threading headers at all. */
function freshCustomerRaw(
  overrides: Record<string, string> = {},
  body = 'Where is my order?',
): Uint8Array {
  return rawMessage(
    {
      From: 'customer@example.test',
      To: 'support@example.test',
      Subject: 'Help with my order',
      'Message-ID': '<cust-1@customer.example.test>',
      ...overrides,
    },
    body,
  )
}

function inboundDelivery(
  mailboxId: string,
  providerMessageId: string,
  bytes: Uint8Array,
): RawInboundMessage {
  return {
    content: { kind: 'inline', bytes },
    mailboxId,
    providerMessageId,
    receivedAt: new Date('2026-07-13T12:00:00.000Z'),
  }
}

/** Minimal ParsedEmail builder for the pure `isOwnMessageReflection` unit tests. */
function parsedEmail(fields: Partial<Pick<ParsedEmail, 'messageId' | 'inReplyTo'>>): ParsedEmail {
  return {
    messageId: fields.messageId ?? null,
    inReplyTo: fields.inReplyTo ?? null,
    references: [],
    from: { address: 'customer@example.test' },
    to: [{ address: 'support@example.test' }],
    cc: [],
    subject: '',
    date: null,
    text: 'body',
    html: null,
    headers: {},
    attachments: [],
  }
}

/** An in-memory `BlobStore` fake — `get` throws for an unknown key, matching the real interface's documented contract. */
function fakeBlobStore(initial: Record<string, Uint8Array> = {}): BlobStore {
  const store = new Map(Object.entries(initial))
  return {
    async put(key, data) {
      store.set(key, data)
    },
    async get(key) {
      const data = store.get(key)
      if (data === undefined) throw new Error(`fakeBlobStore: no object at key ${key}`)
      return data
    },
    async getSignedUrl(key) {
      return `https://blob.example.test/${key}`
    },
    async delete(key) {
      store.delete(key)
    },
    async exists(key) {
      return store.has(key)
    },
  }
}

/**
 * Wraps a `BlobStore` fake to record every `put` key, in call order — used by
 * the attachment retry/orphan test to distinguish the FIRST (failed-attempt,
 * orphaned) blob write from the SECOND (retry, referenced) one without
 * needing to predict the random attachment id `src/mail/ingest.ts` mints for
 * each write.
 */
function trackingBlobStore(inner: BlobStore): BlobStore & { putKeys: string[] } {
  const putKeys: string[] = []
  return {
    putKeys,
    async put(key, data, opts) {
      putKeys.push(key)
      await inner.put(key, data, opts)
    },
    get: (key) => inner.get(key),
    getSignedUrl: (key, expiresInSeconds) => inner.getSignedUrl(key, expiresInSeconds),
    delete: (key) => inner.delete(key),
    exists: (key) => inner.exists(key),
  }
}

/**
 * Build a raw `multipart/mixed` RFC5322 message with one plain-text body part
 * plus one base64-encoded attachment per entry in `attachments` — the same
 * shape as `tests/mail/fixtures/attachment.eml` (plain `\n` line endings;
 * postal-mime, verified by that fixture's own test, tolerates them).
 */
function rawMessageWithAttachments(
  overrides: Record<string, string> = {},
  attachments: { filename: string; contentType: string; content: string }[] = [
    { filename: 'hello.txt', contentType: 'text/plain', content: 'Hello, world!' },
  ],
): Uint8Array {
  const boundary = 'BOUNDARY-INGEST-TEST'
  const headers: Record<string, string> = {
    From: 'customer@example.test',
    To: 'support@example.test',
    Subject: 'Message with attachment',
    'Message-ID': '<cust-attach-1@customer.example.test>',
    'MIME-Version': '1.0',
    'Content-Type': `multipart/mixed; boundary="${boundary}"`,
    ...overrides,
  }
  const headerText = Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')

  const bodyParts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'See attached.',
  ]
  for (const attachment of attachments) {
    bodyParts.push(
      `--${boundary}`,
      `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(attachment.content, 'utf-8').toString('base64'),
    )
  }
  bodyParts.push(`--${boundary}--`)

  return new TextEncoder().encode(`${headerText}\n\n${bodyParts.join('\n')}\n`)
}

/** Insert a `mailboxes` row directly — `inbound_deliveries.mailbox_id` is a real FK, and creating mailboxes is not this ticket's concern. */
async function createMailbox(db: Db, address = 'support@example.test'): Promise<string> {
  const rows = await db.query<{ id: string }>(
    "INSERT INTO mailboxes (address, provider) VALUES ($1, 'gmail') RETURNING id",
    [address],
  )
  return rows[0].id
}

async function countRows(
  db: Db,
  table: 'conversations' | 'threads' | 'inbound_deliveries',
): Promise<number> {
  const rows = await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`)
  return rows[0].count
}

/**
 * Both fault injectors below rely on `ingestInboundMessage`'s own call order:
 * `InboundDeliveryStore.claim` opens exactly ONE `.transaction()` per
 * `ingestInboundMessage` call (whether it's a fresh claim or a `failed`-row
 * reclaim — both paths run inside claim's single transaction), and — only if
 * claimed — `storeAndMarkDelivered` opens exactly one more (step 5). No other
 * step opens a transaction (`markSuppressed`/`markFailed`/`markDeadLetter`
 * are plain `db.query` calls). So calls strictly ALTERNATE claim, store,
 * claim, store, ... across repeated `ingestInboundMessage` invocations, and
 * "the Nth call" reliably targets the same PHASE every time. `query`/`close`
 * always delegate untouched on both wrappers.
 */

/**
 * A `Db` wrapper that throws exactly ONCE, on the `failOnCall`-th call to
 * `.transaction()` (1-indexed), then delegates normally forever after — used
 * to simulate spec §4's "a blob write that succeeds then a transaction that
 * aborts" partial-failure scenario at exactly step 5 (the store-write +
 * ledger-mark transaction), for a test that expects a SUBSEQUENT retry to
 * succeed.
 */
function dbFailingOnCall(real: Db, failOnCall: number): Db {
  let callCount = 0
  return {
    query: (sql, params) => real.query(sql, params),
    close: () => real.close(),
    transaction: async <T>(fn: (tx: Queryable) => Promise<T>): Promise<T> => {
      callCount += 1
      if (callCount === failOnCall) {
        throw new Error('simulated transaction abort')
      }
      return real.transaction(fn)
    },
  }
}

/**
 * A `Db` wrapper that throws on EVERY `n`-th call to `.transaction()`
 * (1-indexed, so `n = 2` fails every store-step call while every claim call
 * succeeds — see the module-level doc comment above) — used to simulate a
 * delivery whose store step NEVER succeeds, so it exhausts its retry budget.
 */
function dbFailingEveryNthTransaction(real: Db, n: number): Db {
  let callCount = 0
  return {
    query: (sql, params) => real.query(sql, params),
    close: () => real.close(),
    transaction: async <T>(fn: (tx: Queryable) => Promise<T>): Promise<T> => {
      callCount += 1
      if (callCount % n === 0) {
        throw new Error('simulated transaction abort')
      }
      return real.transaction(fn)
    },
  }
}

// --- suite ---------------------------------------------------------------------

describe('ingestInboundMessage', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshDeps(): Promise<{ db: Db; deps: IngestDeps; mailboxId: string }> {
    db = await createPgliteDb()
    await migrate(db)
    const mailboxId = await createMailbox(db)
    const inboundDeliveryStore = createInboundDeliveryStore(db)
    return {
      db,
      mailboxId,
      deps: { db, inboundDeliveryStore, blobStore: fakeBlobStore(), keyring },
    }
  }

  // --- spec §8: a fresh message → a new conversation. -----------------------

  it('a fresh message with no valid token → a new conversation', async () => {
    const { db, deps, mailboxId } = await freshDeps()
    const raw = inboundDelivery(mailboxId, 'provider-msg-1', freshCustomerRaw())

    const outcome = await ingestInboundMessage(raw, deps)

    expect(outcome).toMatchObject({
      kind: 'stored',
      mailboxId,
      providerMessageId: 'provider-msg-1',
    })
    if (outcome.kind !== 'stored') throw new Error('unreachable')

    const threads = await db.query<{ from_address: string; body_text: string }>(
      'SELECT from_address, body_text FROM threads WHERE id = $1',
      [outcome.threadId],
    )
    // .toContain, not .toBe: postal-mime may append trailing whitespace to a
    // plain-text body (see src/mail/parse.test.ts's own convention).
    expect(threads[0].from_address).toBe('customer@example.test')
    expect(threads[0].body_text).toContain('Where is my order?')
    expect(await countRows(db, 'conversations')).toBe(1)
  })

  // --- spec §8: a valid-token reply → appends to that conversation. --------

  it('a valid-token reply appends to the conversation the token names', async () => {
    const { db, deps, mailboxId } = await freshDeps()

    const first = await ingestInboundMessage(
      inboundDelivery(mailboxId, 'provider-msg-1', freshCustomerRaw()),
      deps,
    )
    if (first.kind !== 'stored') throw new Error('unreachable')

    // Simulate an outbound reply's minted Message-ID for that SAME
    // conversation (decideThreading routes on conversationId alone —
    // threading.md/sending.md §2 — so the threadId embedded here need not
    // correspond to a real outbound row for this test's purposes).
    const replyToken = mintReplyMessageId(
      { conversationId: first.conversationId, threadId: 'outbound-t1', mailDomain: MAIL_DOMAIN },
      keyring,
    )
    const replyRaw = rawMessage(
      {
        From: 'customer@example.test',
        To: 'support@example.test',
        Subject: 'Re: Help with my order',
        'Message-ID': '<cust-2@customer.example.test>',
        'In-Reply-To': replyToken,
      },
      'Still broken, please help.',
    )

    const second = await ingestInboundMessage(
      inboundDelivery(mailboxId, 'provider-msg-2', replyRaw),
      deps,
    )

    expect(second).toMatchObject({ kind: 'stored', conversationId: first.conversationId })
    expect(await countRows(db, 'conversations')).toBe(1)
    expect(await countRows(db, 'threads')).toBe(2)
  })

  // --- HT-49: the exact live-production failure, reproduced as a fixture ---
  //
  // Live evidence (2026-07-17, first HT-44 run against real Gmail): Gmail's
  // `users.messages.send` REPLACED the engine-minted Message-ID with a
  // Gmail-generated one on the wire. The customer's reply therefore carried
  // `In-Reply-To`/a trailing `References` entry naming Gmail's FOREIGN id —
  // our token was nowhere to be found by a scan that only checked those —
  // and `decideThreading` (correctly, per invariant #5: no verified token ⇒
  // new conversation) forked a new conversation instead of appending.
  //
  // The fix (`src/mail/send.ts`): the outbound reply's own minted messageId
  // rides as the FINAL entry of the OUTBOUND References chain, which Gmail
  // does NOT rewrite. An RFC-5322-compliant reply's own References becomes
  // `{our outbound References} + {gmail's rewritten id}` — so the customer's
  // reply carries our token ONE POSITION BEFORE the trailing foreign id,
  // never in In-Reply-To, never last. `decideThreading`'s existing
  // newest-first scan (`src/mail/thread.ts`, unmodified by this fix) skips
  // the foreign trailing id and finds our token immediately behind it.
  it('HT-49: a reply whose In-Reply-To is a FOREIGN (Gmail-rewritten) id and whose References carries our token mid-chain still threads into the original conversation', async () => {
    const { db, deps, mailboxId } = await freshDeps()

    const first = await ingestInboundMessage(
      inboundDelivery(mailboxId, 'provider-msg-1', freshCustomerRaw()),
      deps,
    )
    if (first.kind !== 'stored') throw new Error('unreachable')

    // The outbound reply this engine sent: its own minted token, which
    // `send.ts` placed as the FINAL References entry of ITS outbound mail.
    const replyToken = mintReplyMessageId(
      { conversationId: first.conversationId, threadId: 'outbound-t1', mailDomain: MAIL_DOMAIN },
      keyring,
    )
    // Gmail's server-side substitute for the wire Message-ID of that SAME
    // outbound reply (the id the customer's mail client actually observed as
    // the message's Message-ID, and therefore what its own In-Reply-To/
    // trailing References entry names) — never one of our tokens.
    const gmailRewrittenId = '<CAKWkAL3-gmail-generated-id@mail.gmail.com>'

    const replyRaw = rawMessage(
      {
        From: 'customer@example.test',
        To: 'support@example.test',
        Subject: 'Re: Help with my order',
        'Message-ID': '<cust-2@customer.example.test>',
        // Foreign — NOT our token. A scan that only checked In-Reply-To
        // would find nothing and (wrongly) start a new conversation.
        'In-Reply-To': gmailRewrittenId,
        // Our token rides mid-chain: ancestor, then our token, then the
        // foreign id the customer's client appended last.
        References: `<cust-1@customer.example.test> ${replyToken} ${gmailRewrittenId}`,
      },
      'Still broken, please help.',
    )

    const second = await ingestInboundMessage(
      inboundDelivery(mailboxId, 'provider-msg-2', replyRaw),
      deps,
    )

    expect(second).toMatchObject({ kind: 'stored', conversationId: first.conversationId })
    expect(await countRows(db, 'conversations')).toBe(1)
    expect(await countRows(db, 'threads')).toBe(2)
  })

  // --- spec §8: re-delivery of the same key → a no-op. ----------------------

  it('re-delivery of the same (mailboxId, providerMessageId) is a no-op: one conversation, one thread, one stored ledger row', async () => {
    const { db, deps, mailboxId } = await freshDeps()
    const raw = inboundDelivery(mailboxId, 'provider-msg-1', freshCustomerRaw())

    const first = await ingestInboundMessage(raw, deps)
    const second = await ingestInboundMessage(raw, deps)

    expect(first.kind).toBe('stored')
    expect(second).toEqual(first)
    expect(await countRows(db, 'conversations')).toBe(1)
    expect(await countRows(db, 'threads')).toBe(1)
    expect(await countRows(db, 'inbound_deliveries')).toBe(1)

    const ledgerRows = await db.query<{ status: string }>(
      'SELECT status FROM inbound_deliveries WHERE mailbox_id = $1 AND provider_message_id = $2',
      [mailboxId, 'provider-msg-1'],
    )
    expect(ledgerRows).toHaveLength(1)
    expect(ledgerRows[0].status).toBe('stored')
  })

  // --- spec §8: two concurrent deliveries of the same key → exactly one conversation. ---

  it('two concurrent deliveries of the same key → exactly one conversation (the second returns/observes the first)', async () => {
    const { db, deps, mailboxId } = await freshDeps()
    const raw = inboundDelivery(mailboxId, 'provider-msg-1', freshCustomerRaw())

    const [a, b] = await Promise.all([
      ingestInboundMessage(raw, deps),
      ingestInboundMessage(raw, deps),
    ])

    // Whatever the exact interleaving, both calls observed the SAME ledger row.
    expect(a.deliveryId).toBe(b.deliveryId)
    // At least one call actually stored it.
    expect([a.kind, b.kind]).toContain('stored')
    // Exactly one conversation/thread exists, regardless of which call's
    // outcome ended up 'stored' vs. 'in-progress' (the claim's `received`
    // conflict) or a 'stored'-replay.
    expect(await countRows(db, 'conversations')).toBe(1)
    expect(await countRows(db, 'threads')).toBe(1)
  })

  // --- HT-45: a crash strands a delivery at 'received'; the lease closes it. ---

  it('a delivery still within its lease reports in-progress and is NOT reprocessed (a genuinely concurrent claim, not a crash)', async () => {
    const { db, deps, mailboxId } = await freshDeps()
    const raw = inboundDelivery(mailboxId, 'provider-msg-1', freshCustomerRaw())
    // Claim directly against the ledger, as a concurrent ingestInboundMessage
    // call's own step 1 would — and never mark it, simulating that call
    // still being genuinely in flight.
    const stuck = await deps.inboundDeliveryStore.claim(mailboxId, 'provider-msg-1', 30_000)
    expect(stuck.claimed).toBe(true)

    const outcome = await ingestInboundMessage(raw, deps)

    expect(outcome).toMatchObject({ kind: 'in-progress', deliveryId: stuck.delivery.id })
    expect(await countRows(db, 'conversations')).toBe(0)
  })

  it("a delivery stranded at 'received' by a simulated crash (claimed, never marked) is reclaimed and reprocessed once its lease expires", async () => {
    const { db, deps, mailboxId } = await freshDeps()
    const raw = inboundDelivery(mailboxId, 'provider-msg-1', freshCustomerRaw())

    // Simulate the crash this ticket closes: claim the delivery (exactly
    // ingestInboundMessage's own step 1) but never run parse/store/mark —
    // the window between claim() committing 'received' and step 5's store
    // transaction (or the catch-block markFailed), if the process died
    // right there.
    const stuck = await deps.inboundDeliveryStore.claim(mailboxId, 'provider-msg-1', 30_000)
    expect(stuck.claimed).toBe(true)
    await db.query(
      "UPDATE inbound_deliveries SET claimed_until = now() - interval '1 second' WHERE id = $1",
      [stuck.delivery.id],
    )

    // Nothing has processed this message yet: no conversation exists, the
    // ledger row is still 'received'.
    expect(await countRows(db, 'conversations')).toBe(0)

    // Re-delivery (a redelivered push notification, or the reconcile sweep
    // re-listing the same stuck message because the cursor never advanced
    // past it — HT-41) calls ingestInboundMessage again for the SAME key.
    // With the lease lapsed, this must reclaim and fully reprocess it, not
    // report 'in-progress' forever.
    const outcome = await ingestInboundMessage(raw, deps)

    expect(outcome).toMatchObject({ kind: 'stored', deliveryId: stuck.delivery.id })
    expect(await countRows(db, 'conversations')).toBe(1)
    expect(await countRows(db, 'threads')).toBe(1)

    const ledgerRows = await db.query<{ status: string }>(
      'SELECT status FROM inbound_deliveries WHERE id = $1',
      [stuck.delivery.id],
    )
    expect(ledgerRows[0].status).toBe('stored')
  })

  it('two concurrent re-deliveries of a lease-expired stranded row resolve to exactly one conversation (the reclaim itself is claim-safe)', async () => {
    const { db, deps, mailboxId } = await freshDeps()
    const raw = inboundDelivery(mailboxId, 'provider-msg-1', freshCustomerRaw())
    const stuck = await deps.inboundDeliveryStore.claim(mailboxId, 'provider-msg-1', 30_000)
    expect(stuck.claimed).toBe(true)
    await db.query(
      "UPDATE inbound_deliveries SET claimed_until = now() - interval '1 second' WHERE id = $1",
      [stuck.delivery.id],
    )

    const [a, b] = await Promise.all([
      ingestInboundMessage(raw, deps),
      ingestInboundMessage(raw, deps),
    ])

    expect([a.kind, b.kind]).toContain('stored')
    expect(await countRows(db, 'conversations')).toBe(1)
    expect(await countRows(db, 'threads')).toBe(1)
  })

  // --- HT-45 review fix (should-fix #2): a message that always crashes
  // (never reaches a recorded failed/dead-letter outcome, only ever a lapsed
  // lease) must still converge to dead-letter, the same as one that always
  // throws — not retry forever. ------------------------------------------

  it('a delivery whose lease keeps lapsing (simulating a crash-poison message) converges to dead-letter once the reclaim budget is exhausted', async () => {
    const { db, deps, mailboxId } = await freshDeps()
    const raw = inboundDelivery(mailboxId, 'provider-msg-1', freshCustomerRaw())
    const stuck = await deps.inboundDeliveryStore.claim(mailboxId, 'provider-msg-1', 30_000)
    expect(stuck.claimed).toBe(true)

    // Simulate MAX_INGEST_ATTEMPTS - 1 prior lease-expiry reclaims (each one
    // a crash) by setting attempts directly to what that many real reclaims
    // would have produced, then lapsing the lease one more time — the next
    // claim's own reclaim bumps attempts the rest of the way to the budget.
    await db.query(
      "UPDATE inbound_deliveries SET attempts = $2, claimed_until = now() - interval '1 second' WHERE id = $1",
      [stuck.delivery.id, MAX_INGEST_ATTEMPTS - 1],
    )

    const outcome = await ingestInboundMessage(raw, deps)

    // The reclaim's own bump already carried attempts to MAX_INGEST_ATTEMPTS
    // (the budget check reads that post-reclaim value); markDeadLetter's
    // unconditional `attempts = attempts + 1` (same as every other caller)
    // then carries it one further, to MAX_INGEST_ATTEMPTS + 1 — dead-lettering
    // is still recorded as an accumulated attempt, same as the ordinary
    // parse/store failure path.
    expect(outcome).toMatchObject({
      kind: 'dead-letter',
      deliveryId: stuck.delivery.id,
      attempts: MAX_INGEST_ATTEMPTS + 1,
    })
    // Dead-lettered before ever parsing/storing — no conversation created.
    expect(await countRows(db, 'conversations')).toBe(0)

    const ledgerRows = await db.query<{ status: string; attempts: number }>(
      'SELECT status, attempts FROM inbound_deliveries WHERE id = $1',
      [stuck.delivery.id],
    )
    expect(ledgerRows[0]).toMatchObject({
      status: 'dead-letter',
      attempts: MAX_INGEST_ATTEMPTS + 1,
    })

    // A further re-delivery must NOT auto-retry a dead-lettered message.
    const again = await ingestInboundMessage(raw, deps)
    expect(again).toMatchObject({ kind: 'dead-letter', attempts: MAX_INGEST_ATTEMPTS + 1 })
  })

  // --- spec §8: a partial failure → failed → retried → stored. -------------

  it('a partial failure in step 5 (the store+ledger transaction aborts) → failed, then a retry → stored, with no orphaned/duplicate conversation', async () => {
    const { db, deps, mailboxId } = await freshDeps()
    // 1st .transaction() call = the claim (succeeds); 2nd = step 5's
    // store-write + ledger-mark transaction — fails exactly ONCE, so the
    // retry's own store-step call (the 4th call overall) succeeds normally.
    const faultyDb = dbFailingOnCall(db, 2)
    const faultyDeps: IngestDeps = {
      ...deps,
      db: faultyDb,
      inboundDeliveryStore: createInboundDeliveryStore(faultyDb),
    }
    const raw = inboundDelivery(mailboxId, 'provider-msg-1', freshCustomerRaw())

    const failedOutcome = await ingestInboundMessage(raw, faultyDeps)
    expect(failedOutcome).toMatchObject({ kind: 'failed', attempts: 1 })
    expect(await countRows(db, 'conversations')).toBe(0)
    expect(await countRows(db, 'threads')).toBe(0)

    const retried = await ingestInboundMessage(raw, faultyDeps)
    expect(retried.kind).toBe('stored')
    expect(await countRows(db, 'conversations')).toBe(1)
    expect(await countRows(db, 'threads')).toBe(1)
  })

  it('a delivery that exhausts MAX_INGEST_ATTEMPTS lands in dead-letter, and further re-delivery does not reprocess it', async () => {
    const { db, deps, mailboxId } = await freshDeps()
    // Every store-step transaction fails (every even .transaction() call).
    const faultyDb = dbFailingEveryNthTransaction(db, 2)
    const faultyDeps: IngestDeps = {
      ...deps,
      db: faultyDb,
      inboundDeliveryStore: createInboundDeliveryStore(faultyDb),
    }
    const raw = inboundDelivery(mailboxId, 'provider-msg-1', freshCustomerRaw())

    let last: IngestOutcome | undefined
    for (let i = 0; i < MAX_INGEST_ATTEMPTS; i++) {
      last = await ingestInboundMessage(raw, faultyDeps)
    }
    expect(last).toMatchObject({ kind: 'dead-letter', attempts: MAX_INGEST_ATTEMPTS })

    // A further re-delivery must NOT auto-retry a dead-lettered message.
    const again = await ingestInboundMessage(raw, faultyDeps)
    expect(again).toMatchObject({ kind: 'dead-letter', attempts: MAX_INGEST_ATTEMPTS })
    expect(await countRows(db, 'conversations')).toBe(0)
  })

  // --- spec §5 / §8: the loop guard. ----------------------------------------

  describe('isOwnMessageReflection (pure unit)', () => {
    it("true when the message's OWN Message-ID verifies as one of our tokens", () => {
      const ownToken = mintReplyMessageId(
        { conversationId: 'c1', threadId: 't1', mailDomain: MAIL_DOMAIN },
        keyring,
      )
      expect(isOwnMessageReflection(parsedEmail({ messageId: ownToken }), keyring)).toBe(true)
    })

    it('false when a valid token appears only in In-Reply-To (the ordinary reply case, not a loop)', () => {
      const ownToken = mintReplyMessageId(
        { conversationId: 'c1', threadId: 't1', mailDomain: MAIL_DOMAIN },
        keyring,
      )
      expect(
        isOwnMessageReflection(
          parsedEmail({ messageId: '<cust-1@customer.example.test>', inReplyTo: ownToken }),
          keyring,
        ),
      ).toBe(false)
    })

    it('false for a message with no Message-ID, or one that is not shaped like our token', () => {
      expect(isOwnMessageReflection(parsedEmail({ messageId: null }), keyring)).toBe(false)
      expect(
        isOwnMessageReflection(parsedEmail({ messageId: '<real-client-id@gmail.com>' }), keyring),
      ).toBe(false)
    })
  })

  it('a verifiable own-message loop (own Message-ID) → suppressed, nothing created', async () => {
    const { db, deps, mailboxId } = await freshDeps()
    const ownToken = mintReplyMessageId(
      { conversationId: 'c-loop', threadId: 't-loop', mailDomain: MAIL_DOMAIN },
      keyring,
    )
    const raw = inboundDelivery(
      mailboxId,
      'provider-msg-1',
      rawMessage(
        {
          From: 'support@example.test',
          To: 'support@example.test',
          Subject: 'Re: reflected',
          'Message-ID': ownToken,
        },
        'This is our own mail looping back.',
      ),
    )

    const outcome = await ingestInboundMessage(raw, deps)

    expect(outcome).toMatchObject({ kind: 'suppressed', reason: 'own-message-loop' })
    expect(await countRows(db, 'conversations')).toBe(0)
    expect(await countRows(db, 'threads')).toBe(0)
  })

  it('a message that merely CLAIMS our From address, with no verifiable correlation, is ingested — not dropped', async () => {
    const { db, deps, mailboxId } = await freshDeps()
    const raw = inboundDelivery(
      mailboxId,
      'provider-msg-1',
      rawMessage(
        {
          From: 'support@example.test', // claims to be US — sender identity is untrusted
          To: 'support@example.test',
          Subject: 'Spoofed-looking mail',
          'Message-ID': '<attacker-1@evil.example.test>', // NOT one of our tokens
        },
        'This is not actually from us.',
      ),
    )

    const outcome = await ingestInboundMessage(raw, deps)

    expect(outcome.kind).toBe('stored')
    expect(await countRows(db, 'conversations')).toBe(1)
  })

  // --- spec §3 step 5 / threading.md §5: append → deleted / not-found. -----

  it('append to a DELETED conversation falls back to a fresh conversation — mail never lost', async () => {
    const { db, deps, mailboxId } = await freshDeps()
    const first = await ingestInboundMessage(
      inboundDelivery(mailboxId, 'provider-msg-1', freshCustomerRaw()),
      deps,
    )
    if (first.kind !== 'stored') throw new Error('unreachable')

    await db.query("UPDATE conversations SET status = 'deleted' WHERE id = $1", [
      first.conversationId,
    ])

    const replyToken = mintReplyMessageId(
      { conversationId: first.conversationId, threadId: 'outbound-t1', mailDomain: MAIL_DOMAIN },
      keyring,
    )
    const replyRaw = rawMessage(
      {
        From: 'customer@example.test',
        To: 'support@example.test',
        Subject: 'Re: Help with my order',
        'Message-ID': '<cust-2@customer.example.test>',
        'In-Reply-To': replyToken,
      },
      'Following up.',
    )

    const second = await ingestInboundMessage(
      inboundDelivery(mailboxId, 'provider-msg-2', replyRaw),
      deps,
    )

    expect(second.kind).toBe('stored')
    if (second.kind !== 'stored') throw new Error('unreachable')
    expect(second.conversationId).not.toBe(first.conversationId)
    // The original (deleted) conversation plus the fresh fallback one.
    expect(await countRows(db, 'conversations')).toBe(2)
  })

  it('append to a token whose conversation never existed (not-found) falls back to a fresh conversation', async () => {
    const { db, deps, mailboxId } = await freshDeps()
    const tokenForNothing = mintReplyMessageId(
      { conversationId: RANDOM_UUID, threadId: 'outbound-t1', mailDomain: MAIL_DOMAIN },
      keyring,
    )
    const raw = inboundDelivery(
      mailboxId,
      'provider-msg-1',
      rawMessage(
        {
          From: 'customer@example.test',
          To: 'support@example.test',
          Subject: 'Re: something',
          'Message-ID': '<cust-1@customer.example.test>',
          'In-Reply-To': tokenForNothing,
        },
        'Replying to a token for a conversation that never existed.',
      ),
    )

    const outcome = await ingestInboundMessage(raw, deps)

    expect(outcome.kind).toBe('stored')
    if (outcome.kind !== 'stored') throw new Error('unreachable')
    expect(outcome.conversationId).not.toBe(RANDOM_UUID)
    expect(await countRows(db, 'conversations')).toBe(1)
  })

  // --- providers/inbound-email.ts: blobRef content resolution. -------------

  it('resolves a blobRef message via BlobStore.get before parsing', async () => {
    db = await createPgliteDb()
    await migrate(db)
    const mailboxId = await createMailbox(db)
    const bytes = freshCustomerRaw({ 'Message-ID': '<via-blob-1@customer.example.test>' })
    const blobStore = fakeBlobStore({ 'mbox-1/raw/provider-msg-1': bytes })
    const deps: IngestDeps = {
      db,
      inboundDeliveryStore: createInboundDeliveryStore(db),
      blobStore,
      keyring,
    }

    const raw: RawInboundMessage = {
      content: { kind: 'blobRef', blobKey: 'mbox-1/raw/provider-msg-1' },
      mailboxId,
      providerMessageId: 'provider-msg-1',
      receivedAt: new Date(),
    }

    const outcome = await ingestInboundMessage(raw, deps)

    expect(outcome.kind).toBe('stored')
    expect(await countRows(db, 'conversations')).toBe(1)
  })

  // --- HT-46: attachment blob persistence. ----------------------------------

  describe('sanitizeAttachmentFilename (pure unit)', () => {
    /** Exactly the adapter-valid charset `src/providers/adapters/supabase-storage/` accepts in an object key segment. */
    const ADAPTER_SAFE = /^[A-Za-z0-9._-]+$/

    it('leaves a plain ASCII filename untouched', () => {
      expect(sanitizeAttachmentFilename('hello.txt')).toBe('hello.txt')
    })

    it('null and empty-string filenames both fall back to the fixed placeholder', () => {
      // `null` is the "no filename at all" case; `''` is the "client sent an
      // empty filename attribute" case — `?? 'attachment'` alone only catches
      // the former, which is exactly the must-fix this test guards against.
      expect(sanitizeAttachmentFilename(null)).toBe('attachment')
      expect(sanitizeAttachmentFilename('')).toBe('attachment')
    })

    it('replaces "/" and "\\" so a crafted filename cannot add a segment inside the blob key', () => {
      expect(sanitizeAttachmentFilename('a/b.txt')).toBe('a_b.txt')
      expect(sanitizeAttachmentFilename('..\\..\\evil.txt')).toBe('.._.._evil.txt')
      expect(sanitizeAttachmentFilename('a/b.txt')).not.toContain('/')
    })

    it('replaces non-ASCII and other adapter-unsafe characters (unicode, "#", "%", quotes, control chars)', () => {
      expect(sanitizeAttachmentFilename('Résumé.pdf')).toBe('R_sum_.pdf')
      expect(sanitizeAttachmentFilename('a#b%c".txt')).toBe('a_b_c_.txt')
      // A literal NUL (not an escaped placeholder) previously sat here by
      // accident — invisible in most editors/diffs and enough to make this
      // file read as binary to tools that sniff for one (e.g. `grep -I`).
      // Written as an explicit escape so the control-character case this
      // test's name promises is actually legible.
      expect(sanitizeAttachmentFilename('a\x00b.txt')).toBe('a_b.txt')
    })

    it('every result matches the adapter-safe charset and is non-empty, for a battery of hostile inputs', () => {
      for (const filename of [
        null,
        '',
        '/',
        '\\',
        '///',
        'Résumé.pdf',
        'a/b/../c.txt',
        '文件.txt',
      ]) {
        const sanitized = sanitizeAttachmentFilename(filename)
        expect(sanitized.length).toBeGreaterThan(0)
        expect(sanitized).toMatch(ADAPTER_SAFE)
      }
    })
  })

  describe('attachments (HT-46)', () => {
    it('a message with one attachment writes its bytes to the BlobStore and persists exactly one blob-key reference', async () => {
      const { db, deps, mailboxId } = await freshDeps()
      const raw = inboundDelivery(mailboxId, 'provider-msg-1', rawMessageWithAttachments())

      const outcome = await ingestInboundMessage(raw, deps)

      expect(outcome.kind).toBe('stored')
      if (outcome.kind !== 'stored') throw new Error('unreachable')

      const attachmentStore = createThreadAttachmentStore(db)
      const rows = await attachmentStore.listByConversationId(outcome.conversationId)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        threadId: outcome.threadId,
        filename: 'hello.txt',
        contentType: 'text/plain',
        size: 13,
      })
      // The blob key is mailbox-namespaced (<mailboxId>/<attachmentId>/<filename>).
      expect(rows[0].blobKey.startsWith(`${mailboxId}/`)).toBe(true)
      expect(rows[0].blobKey.endsWith('/hello.txt')).toBe(true)

      // The bytes actually landed in the BlobStore, byte-exact.
      const storedBytes = await deps.blobStore.get(rows[0].blobKey)
      expect(new TextDecoder().decode(storedBytes)).toBe('Hello, world!')
    })

    it('a message with multiple attachments persists one thread_attachments row per attachment, each with its own blob key', async () => {
      const { db, deps, mailboxId } = await freshDeps()
      const raw = inboundDelivery(
        mailboxId,
        'provider-msg-1',
        rawMessageWithAttachments({}, [
          { filename: 'one.txt', contentType: 'text/plain', content: 'first file' },
          { filename: 'two.txt', contentType: 'text/plain', content: 'second file, longer' },
        ]),
      )

      const outcome = await ingestInboundMessage(raw, deps)

      expect(outcome.kind).toBe('stored')
      if (outcome.kind !== 'stored') throw new Error('unreachable')

      const attachmentStore = createThreadAttachmentStore(db)
      const rows = await attachmentStore.listByConversationId(outcome.conversationId)
      expect(rows).toHaveLength(2)
      // Distinct blob keys — no collision between the two attachments.
      expect(new Set(rows.map((r) => r.blobKey)).size).toBe(2)

      const byFilename = new Map(rows.map((r) => [r.filename, r]))
      const one = byFilename.get('one.txt')
      const two = byFilename.get('two.txt')
      expect(one).toBeDefined()
      expect(two).toBeDefined()
      if (one === undefined || two === undefined) throw new Error('unreachable')
      expect(new TextDecoder().decode(await deps.blobStore.get(one.blobKey))).toBe('first file')
      expect(new TextDecoder().decode(await deps.blobStore.get(two.blobKey))).toBe(
        'second file, longer',
      )
    })

    it('a slash-bearing, unicode attachment filename is sanitized in the actual blob key the pipeline writes (not just in the unit-tested sanitizer)', async () => {
      const { db, deps, mailboxId } = await freshDeps()
      const raw = inboundDelivery(
        mailboxId,
        'provider-msg-1',
        rawMessageWithAttachments({}, [
          { filename: 'a/../évil.pdf', contentType: 'application/pdf', content: 'bytes' },
        ]),
      )

      const outcome = await ingestInboundMessage(raw, deps)

      expect(outcome.kind).toBe('stored')
      if (outcome.kind !== 'stored') throw new Error('unreachable')

      const attachmentStore = createThreadAttachmentStore(db)
      const rows = await attachmentStore.listByConversationId(outcome.conversationId)
      expect(rows).toHaveLength(1)
      // The stored `filename` COLUMN keeps the original, verbatim filename —
      // only the blob KEY segment is sanitized.
      expect(rows[0].filename).toBe('a/../évil.pdf')

      // The blob key stays exactly three `/`-segments deep — the crafted
      // filename cannot add a fourth segment or escape the mailbox/attachment
      // namespace — and every segment is non-empty and adapter-safe ASCII.
      const segments = rows[0].blobKey.split('/')
      expect(segments).toHaveLength(3)
      for (const segment of segments) {
        expect(segment.length).toBeGreaterThan(0)
        expect(segment).toMatch(/^[A-Za-z0-9._-]+$/)
      }

      // The bytes are still retrievable at the sanitized key.
      expect(new TextDecoder().decode(await deps.blobStore.get(rows[0].blobKey))).toBe('bytes')
    })

    it('a message with no attachments persists no thread_attachments rows', async () => {
      const { db, deps, mailboxId } = await freshDeps()
      const outcome = await ingestInboundMessage(
        inboundDelivery(mailboxId, 'provider-msg-1', freshCustomerRaw()),
        deps,
      )

      expect(outcome.kind).toBe('stored')
      if (outcome.kind !== 'stored') throw new Error('unreachable')
      expect(
        await createThreadAttachmentStore(db).listByConversationId(outcome.conversationId),
      ).toEqual([])
    })

    it('the retry/orphan story: a step-5 abort after the blob write leaves that blob orphaned, and the retry writes a FRESH blob the stored reference actually points at', async () => {
      const { db, mailboxId } = await freshDeps()
      const blobStore = trackingBlobStore(fakeBlobStore())
      // 1st .transaction() call = the claim (succeeds); 2nd = step 5's
      // store-write + ledger-mark transaction — fails exactly ONCE (see the
      // module-level doc comment on dbFailingOnCall). The attachment blob
      // write happens between steps 4 and 5, OUTSIDE any transaction, so it
      // is NOT counted here and always runs on every attempt.
      const faultyDb = dbFailingOnCall(db, 2)
      const faultyDeps: IngestDeps = {
        db: faultyDb,
        inboundDeliveryStore: createInboundDeliveryStore(faultyDb),
        blobStore,
        keyring,
      }
      const raw = inboundDelivery(mailboxId, 'provider-msg-1', rawMessageWithAttachments())

      const failedOutcome = await ingestInboundMessage(raw, faultyDeps)
      expect(failedOutcome).toMatchObject({ kind: 'failed', attempts: 1 })
      // The blob write for this FIRST attempt already happened (it precedes
      // the aborted transaction) — orphaned: written, but referenced by no
      // thread_attachments row, since the transaction that would have
      // inserted one rolled back along with the thread it belonged to.
      expect(blobStore.putKeys).toHaveLength(1)
      const orphanKey = blobStore.putKeys[0]
      expect(await blobStore.exists(orphanKey)).toBe(true)
      expect(await countRows(db, 'conversations')).toBe(0)

      const retried = await ingestInboundMessage(raw, faultyDeps)
      expect(retried.kind).toBe('stored')
      if (retried.kind !== 'stored') throw new Error('unreachable')

      // The retry wrote a SECOND, fresh blob (a new attachment id each
      // attempt, per src/mail/ingest.ts's writeAttachmentBlobs) rather than
      // reusing or repairing the orphan.
      expect(blobStore.putKeys).toHaveLength(2)
      const liveKey = blobStore.putKeys[1]
      expect(liveKey).not.toBe(orphanKey)

      const rows = await createThreadAttachmentStore(db).listByConversationId(
        retried.conversationId,
      )
      expect(rows).toHaveLength(1)
      // The persisted reference points at the SECOND (retry) blob, not the
      // orphaned first one.
      expect(rows[0].blobKey).toBe(liveKey)

      // The orphan is still sitting in the BlobStore, untouched and
      // unreferenced — tolerable per the ticket's design, not cleaned up
      // here (a future GC pass, not built by this ticket).
      expect(await blobStore.exists(orphanKey)).toBe(true)
    })
  })
})
