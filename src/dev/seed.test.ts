import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import type { Keyring } from '../mail/reply-token.js'
import type { EmailSender, OutboundEmail } from '../providers/index.js'
import { createConversationStore } from '../store/conversations.js'
import { seedDevData } from './seed.js'

const KEYRING: Keyring = { current: { keyId: 'k1', secret: 'a'.repeat(32) } }
const MAIL_DOMAIN = 'mail.example.test'
const SUPPORT_ADDRESS = 'support@example.test'

/** A recording `EmailSender` that never fails — for counting real sends the dev sender would have logged. */
function createRecordingSender(): { sender: EmailSender; sent: OutboundEmail[] } {
  const sent: OutboundEmail[] = []
  return {
    sender: {
      maxSendMs: 5_000,
      async send(email) {
        sent.push(email)
        return {}
      },
    },
    sent,
  }
}

describe('seedDevData', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  it('seeds every conversation/delivery-state variety the dev harness promises', async () => {
    db = await createPgliteDb()
    await migrate(db)
    const store = createConversationStore(db)
    const { sender, sent } = createRecordingSender()

    const result = await seedDevData({
      db,
      store,
      sender,
      keyring: KEYRING,
      mailDomain: MAIL_DOMAIN,
      supportAddress: SUPPORT_ADDRESS,
    })

    expect(result.conversationCount).toBe(6)

    // Real sends went through the injected sender for every reply EXCEPT the
    // one deliberately routed through the seed's own failing sender — see
    // seed.ts's "failed" demo.
    expect(sent.length).toBe(4)

    const open = await store.listConversations({ limit: 50, folder: 'open' })
    const closed = await store.listConversations({ limit: 50, folder: 'closed' })
    expect(open).toHaveLength(5)
    expect(closed).toHaveLength(1)

    const allThreads = await Promise.all(
      [...open, ...closed].map((c) => store.getConversation(c.id, { includeDeleted: false })),
    )
    const deliveryStatuses = allThreads
      .flatMap((c) => c?.threads ?? [])
      .map((t) => t.deliveryStatus)
      .filter((s): s is 'pending' | 'sent' | 'failed' => s !== null)

    // Exact distribution: the threaded demo's 2 replies + the lone 'sent'
    // demo's reply + the closed demo's reply = 4 'sent'; 1 'failed' (the
    // simulated provider rejection); 1 'pending' (the backdated stale demo).
    expect(deliveryStatuses.filter((s) => s === 'sent')).toHaveLength(4)
    expect(deliveryStatuses.filter((s) => s === 'failed')).toHaveLength(1)
    expect(deliveryStatuses.filter((s) => s === 'pending')).toHaveLength(1)

    // The stale-pending demo's row must actually be old enough for the
    // delivery worker's default staleAfterMs window (src/mail/delivery-worker.ts) —
    // otherwise it's indistinguishable from an ordinary in-flight send.
    const pendingThread = allThreads
      .flatMap((c) => c?.threads ?? [])
      .find((t) => t.deliveryStatus === 'pending')
    expect(pendingThread).toBeDefined()
    expect(Date.now() - (pendingThread?.createdAt.getTime() ?? 0)).toBeGreaterThan(5 * 60_000)
  })
})
