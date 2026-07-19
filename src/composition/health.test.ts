import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import { createPostgresQueue } from '../providers/adapters/postgres-queue/index.js'
import { WEBHOOK_DELIVERY_TOPIC } from '../webhooks/delivery.js'
import { FORGED_TOKEN_ALERT_THRESHOLD, type HealthReport, runHealthCheck } from './health.js'

describe('runHealthCheck', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  /** A migrated PGlite database plus the REAL Postgres queue's stats over it — the exact production wiring (`src/composition/root.ts`), minus the network. */
  async function fresh() {
    const database = await createPgliteDb()
    db = database
    await migrate(database)
    const queue = createPostgresQueue(database)
    const check = () => runHealthCheck({ db: database, queue })
    return { database, check }
  }

  async function seedMailbox(
    database: Db,
    address: string,
    status: string,
    watch?: { historyId?: string; expiration: Date | null },
  ): Promise<string> {
    const [row] = await database.query<{ id: string }>(
      `INSERT INTO mailboxes (address, provider, status) VALUES ($1, 'gmail', $2) RETURNING id`,
      [address, status],
    )
    if (watch !== undefined) {
      await database.query(
        'INSERT INTO gmail_watch_state (mailbox_id, history_id, watch_expiration) VALUES ($1, $2, $3)',
        [row.id, watch.historyId ?? '100', watch.expiration],
      )
    }
    return row.id
  }

  /** Insert a ledger row whose CURRENT status was reached `updatedAgoHours` ago. */
  async function seedDelivery(
    database: Db,
    mailboxId: string,
    providerMessageId: string,
    status: string,
    { forged = 0, updatedAgoHours = 0 }: { forged?: number; updatedAgoHours?: number } = {},
  ): Promise<void> {
    await database.query(
      `INSERT INTO inbound_deliveries (mailbox_id, provider_message_id, status, forged_token_count, updated_at)
       VALUES ($1, $2, $3, $4, now() - ($5::double precision * interval '1 hour'))`,
      [mailboxId, providerMessageId, status, forged, updatedAgoHours],
    )
  }

  /** Insert a live (claimable) queue job that became ready `readyAgoSeconds` ago. */
  async function seedReadyJob(database: Db, readyAgoSeconds: number): Promise<void> {
    await database.query(
      `INSERT INTO queue_jobs (topic, payload, run_after)
       VALUES ('health-test', '{}'::jsonb, now() - ($1::double precision * interval '1 second'))`,
      [readyAgoSeconds],
    )
  }

  /** Insert a dead-lettered queue job parked `deadLetteredAgoHours` ago. */
  async function seedDeadLetteredJob(database: Db, deadLetteredAgoHours: number): Promise<void> {
    await database.query(
      `INSERT INTO queue_jobs (topic, payload, dead_lettered_at)
       VALUES ('health-test', '{}'::jsonb, now() - ($1::double precision * interval '1 hour'))`,
      [deadLetteredAgoHours],
    )
  }

  /** Insert a dead-lettered `WEBHOOK_DELIVERY_TOPIC` queue job (HT-69) parked `deadLetteredAgoHours` ago — distinct from {@link seedDeadLetteredJob}'s generic `'health-test'` topic, which must NOT trip the webhook-specific alert. */
  async function seedDeadLetteredWebhookJob(
    database: Db,
    deadLetteredAgoHours: number,
  ): Promise<void> {
    await database.query(
      `INSERT INTO queue_jobs (topic, payload, dead_lettered_at)
       VALUES ($2, '{}'::jsonb, now() - ($1::double precision * interval '1 hour'))`,
      [deadLetteredAgoHours, WEBHOOK_DELIVERY_TOPIC],
    )
  }

  /** Insert a `webhook_endpoints` row directly, at a given `status`/`consecutiveFailures` — bypassing `WebhookEndpointStore` (this suite only needs raw rows for the health query, not the store's encrypt-at-rest/auto-disable behavior, which has its own tests). */
  async function seedWebhookEndpoint(
    database: Db,
    url: string,
    status: 'active' | 'disabled' | 'auto_disabled',
    consecutiveFailures = 0,
  ): Promise<void> {
    await database.query(
      `INSERT INTO webhook_endpoints (url, secret_ciphertext, status, consecutive_failures)
       VALUES ($1, $2, $3, $4)`,
      [url, new Uint8Array(28), status, consecutiveFailures],
    )
  }

  it('an empty (fresh-deploy) database is fully healthy: ok, no alerts, zero-filled sections', async () => {
    const { check } = await fresh()

    const report = await check()

    expect(report.ok).toBe(true)
    expect(report.alerts).toEqual([])
    expect(report.queue).toEqual({
      ready: 0,
      oldestReadyAgeSeconds: null,
      deadLettered: 0,
      deadLetteredLast24h: 0,
    })
    expect(report.ingest).toEqual({
      last24hByStatus: { received: 0, stored: 0, suppressed: 0, failed: 0, 'dead-letter': 0 },
      deadLetterTotal: 0,
    })
    expect(report.forgedTokens).toEqual({
      deliveriesLast24h: 0,
      tokensLast24h: 0,
      alertThreshold: FORGED_TOKEN_ALERT_THRESHOLD,
    })
    expect(report.mailboxes).toEqual([])
    expect(report.webhooks).toEqual({ autoDisabled: [], deliveryFailuresLast24h: 0 })
    expect(report.webauthn).toEqual({ counterRegressionsLast24h: 0 })
    expect(new Date(report.generatedAt).getTime()).not.toBeNaN()
  })

  it('a ready job older than the drain threshold trips queue-drain-stalled; a fresh one does not', async () => {
    const { database, check } = await fresh()
    await seedReadyJob(database, 60)

    const healthy = await check()
    expect(healthy.ok).toBe(true)
    expect(healthy.queue.ready).toBe(1)

    await seedReadyJob(database, 600)
    const stalled = await check()

    expect(stalled.ok).toBe(false)
    expect(stalled.alerts).toHaveLength(1)
    expect(stalled.alerts[0]).toMatch(/^queue-drain-stalled: /)
    expect(stalled.queue.ready).toBe(2)
    expect(stalled.queue.oldestReadyAgeSeconds).toBeGreaterThan(300)
  })

  it('a queue job dead-lettered inside 24h trips queue-dead-letter-growth; an old parked one only counts in the standing total', async () => {
    const { database, check } = await fresh()
    await seedDeadLetteredJob(database, 48)

    const oldOnly = await check()
    expect(oldOnly.ok).toBe(true)
    expect(oldOnly.queue.deadLettered).toBe(1)
    expect(oldOnly.queue.deadLetteredLast24h).toBe(0)

    await seedDeadLetteredJob(database, 1)
    const grown = await check()

    expect(grown.ok).toBe(false)
    expect(grown.alerts).toHaveLength(1)
    expect(grown.alerts[0]).toMatch(/^queue-dead-letter-growth: 1 queue job/)
    expect(grown.queue).toMatchObject({ deadLettered: 2, deadLetteredLast24h: 1 })
  })

  it('ledger outcomes bucket into the 24h window; a fresh dead-letter trips ingest-dead-letter-growth, an old one only the total', async () => {
    const { database, check } = await fresh()
    const mailboxId = await seedMailbox(database, 'help@example.test', 'active', {
      expiration: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    })
    await seedDelivery(database, mailboxId, 'msg-stored-new', 'stored', { updatedAgoHours: 1 })
    await seedDelivery(database, mailboxId, 'msg-stored-old', 'stored', { updatedAgoHours: 30 })
    await seedDelivery(database, mailboxId, 'msg-dl-old', 'dead-letter', { updatedAgoHours: 72 })

    const oldOnly = await check()
    expect(oldOnly.ok).toBe(true)
    expect(oldOnly.ingest).toEqual({
      last24hByStatus: { received: 0, stored: 1, suppressed: 0, failed: 0, 'dead-letter': 0 },
      deadLetterTotal: 1,
    })

    await seedDelivery(database, mailboxId, 'msg-dl-new', 'dead-letter', { updatedAgoHours: 2 })
    const grown = await check()

    expect(grown.ok).toBe(false)
    expect(grown.alerts).toHaveLength(1)
    expect(grown.alerts[0]).toMatch(/^ingest-dead-letter-growth: 1 inbound delivery/)
    expect(grown.ingest.last24hByStatus['dead-letter']).toBe(1)
    expect(grown.ingest.deadLetterTotal).toBe(2)
  })

  it(`forged-token deliveries at the threshold trip forged-token-burst; below it (or aged out) they only report`, async () => {
    const { database, check } = await fresh()
    const mailboxId = await seedMailbox(database, 'help@example.test', 'active', {
      expiration: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    })
    // One old forged delivery (outside the window) plus threshold-minus-one
    // fresh ones: still healthy.
    await seedDelivery(database, mailboxId, 'msg-forged-old', 'stored', {
      forged: 4,
      updatedAgoHours: 30,
    })
    for (let i = 0; i < FORGED_TOKEN_ALERT_THRESHOLD - 1; i++) {
      await seedDelivery(database, mailboxId, `msg-forged-${i}`, 'stored', {
        forged: 1,
        updatedAgoHours: 1,
      })
    }

    const below = await check()
    expect(below.ok).toBe(true)
    expect(below.forgedTokens).toMatchObject({
      deliveriesLast24h: FORGED_TOKEN_ALERT_THRESHOLD - 1,
      tokensLast24h: FORGED_TOKEN_ALERT_THRESHOLD - 1,
    })

    // One more forged delivery reaches the threshold — and its 2 tokens show
    // in the token sum.
    await seedDelivery(database, mailboxId, 'msg-forged-last', 'stored', {
      forged: 2,
      updatedAgoHours: 1,
    })
    const burst = await check()

    expect(burst.ok).toBe(false)
    expect(burst.alerts).toHaveLength(1)
    expect(burst.alerts[0]).toMatch(/^forged-token-burst: /)
    expect(burst.forgedTokens).toMatchObject({
      deliveriesLast24h: FORGED_TOKEN_ALERT_THRESHOLD,
      tokensLast24h: FORGED_TOKEN_ALERT_THRESHOLD + 1,
    })
  })

  it('watch expiry: a healthy 7-day watch is silent; near-expiry, a NULL expiration, and a missing state row each trip watch-expiring', async () => {
    const { database, check } = await fresh()
    await seedMailbox(database, 'healthy@example.test', 'active', {
      expiration: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    })
    await seedMailbox(database, 'near@example.test', 'active', {
      expiration: new Date(Date.now() + 24 * 3600 * 1000),
    })
    await seedMailbox(database, 'never-armed@example.test', 'active', { expiration: null })
    await seedMailbox(database, 'no-state-row@example.test', 'active')

    const report = await check()

    expect(report.ok).toBe(false)
    expect(report.alerts).toHaveLength(3)
    expect(report.alerts.filter((a) => a.startsWith('watch-expiring: '))).toHaveLength(3)
    expect(report.alerts.join('\n')).toContain('near@example.test')
    expect(report.alerts.join('\n')).toContain('never-armed@example.test')
    expect(report.alerts.join('\n')).toContain('no-state-row@example.test')
    expect(report.alerts.join('\n')).not.toContain('healthy@example.test')

    const byAddress = new Map(report.mailboxes.map((m) => [m.address, m]))
    expect(byAddress.get('healthy@example.test')?.watchExpiresAt).toMatch(/^\d{4}-/)
    expect(byAddress.get('never-armed@example.test')?.watchExpiresAt).toBeNull()
    expect(byAddress.get('no-state-row@example.test')?.watchExpiresAt).toBeNull()
  })

  it("mailbox statuses: paused and needs_reconnect trip mailbox-needs-attention; disconnected is silent (an operator's own action)", async () => {
    const { database, check } = await fresh()
    await seedMailbox(database, 'paused@example.test', 'paused')
    await seedMailbox(database, 'reconnect@example.test', 'needs_reconnect')
    await seedMailbox(database, 'disconnected@example.test', 'disconnected')

    const report = await check()

    expect(report.ok).toBe(false)
    const attention = report.alerts.filter((a) => a.startsWith('mailbox-needs-attention: '))
    expect(attention).toHaveLength(2)
    expect(attention.join('\n')).toContain('paused@example.test')
    expect(attention.join('\n')).toContain('reconnect@example.test')
    // No watch-expiring for non-active mailboxes, and nothing at all for the
    // disconnected one.
    expect(report.alerts).toHaveLength(2)
    expect(report.mailboxes.map((m) => m.status).sort()).toEqual([
      'disconnected',
      'needs_reconnect',
      'paused',
    ])
  })

  it('multiple simultaneous alerts accumulate (ok stays false, every section still reported)', async () => {
    const { database, check } = await fresh()
    await seedReadyJob(database, 600)
    await seedMailbox(database, 'paused@example.test', 'paused')

    const report: HealthReport = await check()

    expect(report.ok).toBe(false)
    expect(report.alerts).toHaveLength(2)
    expect(report.alerts[0]).toMatch(/^queue-drain-stalled: /)
    expect(report.alerts[1]).toMatch(/^mailbox-needs-attention: /)
  })

  describe('webhooks (HT-69)', () => {
    it('an auto_disabled endpoint trips webhook-endpoint-auto-disabled and is listed; active/disabled endpoints are silent', async () => {
      const { database, check } = await fresh()
      await seedWebhookEndpoint(database, 'https://active.example.test/hook', 'active')
      await seedWebhookEndpoint(database, 'https://disabled.example.test/hook', 'disabled')
      await seedWebhookEndpoint(database, 'https://broken.example.test/hook', 'auto_disabled', 20)

      const report = await check()

      expect(report.ok).toBe(false)
      expect(report.webhooks.autoDisabled).toHaveLength(1)
      expect(report.webhooks.autoDisabled[0]).toMatchObject({
        url: 'https://broken.example.test/hook',
        consecutiveFailures: 20,
      })
      const alert = report.alerts.find((a) => a.startsWith('webhook-endpoint-auto-disabled: '))
      expect(alert).toBeDefined()
      expect(alert).toContain('1 webhook endpoint(s)')
    })

    it('a webhook.delivery dead-letter in the last 24h trips webhook-delivery-dead-letter-growth; an OLDER one, or one on a DIFFERENT topic, does not', async () => {
      const { database, check } = await fresh()
      // A generic dead-letter on an unrelated topic must not trip this
      // webhook-specific alert (queue-dead-letter-growth is the general one).
      await seedDeadLetteredJob(database, 1)

      const beforeWebhookDeadLetter = await check()
      expect(beforeWebhookDeadLetter.webhooks.deliveryFailuresLast24h).toBe(0)
      expect(
        beforeWebhookDeadLetter.alerts.some((a) =>
          a.startsWith('webhook-delivery-dead-letter-growth'),
        ),
      ).toBe(false)

      // An OLDER-than-24h webhook.delivery dead-letter is out of the window.
      await seedDeadLetteredWebhookJob(database, 30)
      const stillClean = await check()
      expect(stillClean.webhooks.deliveryFailuresLast24h).toBe(0)

      // A recent one trips it.
      await seedDeadLetteredWebhookJob(database, 1)
      const report = await check()

      expect(report.ok).toBe(false)
      expect(report.webhooks.deliveryFailuresLast24h).toBe(1)
      const alert = report.alerts.find((a) => a.startsWith('webhook-delivery-dead-letter-growth: '))
      expect(alert).toBeDefined()
      expect(alert).toContain('1 webhook delivery(ies)')
    })
  })

  describe('passkey counter regressions (HT-75; specs/auth/passkeys.md §8)', () => {
    /** Insert an Agent + a `webauthn_credentials` row directly (no `AgentStore`/`WebAuthnStore` needed for this fixture). */
    async function seedRegressedCredential(
      database: Db,
      regressedAgoHours: number | null,
    ): Promise<void> {
      const [agent] = await database.query<{ id: string }>(
        `INSERT INTO agents (email, name, role, status) VALUES ($1, 'Agent', 'agent', 'active') RETURNING id`,
        [`agent-${Math.random()}@example.test`],
      )
      await database.query(
        `INSERT INTO webauthn_credentials
           (agent_id, credential_id, public_key, sign_count, backup_eligible, backup_state, name, sign_count_regression_at)
         VALUES ($1, $2, $3, 10, false, false, 'Key', ${
           regressedAgoHours === null ? 'NULL' : `now() - interval '${regressedAgoHours} hours'`
})`,
        [agent.id, `cred-${Math.random()}`, new Uint8Array([1])],
      )
    }

    it('a credential regressed in the last 24h trips webauthn-counter-regression; one with no regression is silent', async () => {
      const { database, check } = await fresh()
      await seedRegressedCredential(database, null) // never regressed

      const clean = await check()
      expect(clean.webauthn.counterRegressionsLast24h).toBe(0)
      expect(clean.alerts.some((a) => a.startsWith('webauthn-counter-regression'))).toBe(false)

      await seedRegressedCredential(database, 1) // regressed 1h ago
      const report = await check()

      expect(report.ok).toBe(false)
      expect(report.webauthn.counterRegressionsLast24h).toBe(1)
      const alert = report.alerts.find((a) => a.startsWith('webauthn-counter-regression: '))
      expect(alert).toBeDefined()
      expect(alert).toContain('1 credential(s)')
    })

    it('a regression OLDER than 24h does not trip the alert (growth, not standing count)', async () => {
      const { database, check } = await fresh()
      await seedRegressedCredential(database, 30) // regressed 30h ago — outside the window

      const report = await check()
      expect(report.ok).toBe(true)
      expect(report.webauthn.counterRegressionsLast24h).toBe(0)
      expect(report.alerts.some((a) => a.startsWith('webauthn-counter-regression'))).toBe(false)
    })
  })
})
