/**
 * `runImapFetch` against REAL PGlite-backed `MailboxStore`/`ImapConfigStore`/
 * `ImapCredentialStore`/`ImapWatchStateStore` (so the lease/config/cursor SQL
 * is genuinely exercised) plus a fake `createImapClient` bound to
 * `fetchImapInboundMessages`'s real (pure) logic, and a fake `ingest`.
 * Exercises the module doc's SACRED contracts: the cursor advances only when
 * every ingest outcome is terminal, a UIDVALIDITY reset pauses without
 * ingesting or advancing, and per-mailbox failure isolation.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import type {
  ImapClient,
  ImapClientOptions,
  ImapRawMessage,
} from '../providers/adapters/imap/index.js'
import type { RawInboundMessage } from '../providers/index.js'
import { createImapConfigStore, type ImapConfigStore } from '../store/imap-config.js'
import { createImapCredentialStore, type ImapCredentialStore } from '../store/imap-credentials.js'
import { createImapWatchStateStore, type ImapWatchStateStore } from '../store/imap-watch-state.js'
import { createMailboxStore, type MailboxStore } from '../store/mailboxes.js'
import { ENCRYPTION_KEY_BYTES } from '../store/token-crypto.js'
import { DEFAULT_IMAP_FETCH_LEASE_MS, type ImapFetchDeps, runImapFetch } from './imap-fetch.js'
import type { IngestOutcome } from './ingest.js'

const ENC_KEY = Buffer.alloc(ENCRYPTION_KEY_BYTES, 3)

/** A fake `ImapClient` factory driven by per-mailbox UID data — mirrors `../providers/adapters/imap/client.test.ts`'s fake-flow shape, but at the `ImapClient` level (this file exercises `imap-fetch.ts`'s orchestration, not the adapter's own UID-discovery logic). */
function fakeCreateImapClient(behavior: {
  uidValidity: number
  uidNext: number
  messages: ImapRawMessage[]
}): (options: ImapClientOptions) => ImapClient {
  return () => ({
    async connect() {},
    async selectInbox() {
      return { uidValidity: behavior.uidValidity, uidNext: behavior.uidNext }
    },
    async uidFetchRawSince(sinceUid, max) {
      return behavior.messages.filter((m) => m.uid > sinceUid).slice(0, max)
    },
    async close() {},
  })
}

function textBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function rawMessage(uid: number, internalDate = new Date('2026-01-01T00:00:00Z')): ImapRawMessage {
  return { uid, raw: textBytes(`msg-${uid}`), internalDate }
}

function storedOutcome(
  raw: RawInboundMessage,
  overrides: Partial<IngestOutcome> = {},
): IngestOutcome {
  return {
    kind: 'stored',
    deliveryId: `d-${raw.providerMessageId}`,
    mailboxId: raw.mailboxId,
    providerMessageId: raw.providerMessageId,
    conversationId: 'c1',
    threadId: `t-${raw.providerMessageId}`,
    ...overrides,
  } as IngestOutcome
}

describe('runImapFetch', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshStores(): Promise<{
    db: Db
    mailboxStore: MailboxStore
    configStore: ImapConfigStore
    credentialStore: ImapCredentialStore
    watchStateStore: ImapWatchStateStore
  }> {
    db = await createPgliteDb()
    await migrate(db)
    return {
      db,
      mailboxStore: createMailboxStore(db),
      configStore: createImapConfigStore(db),
      credentialStore: createImapCredentialStore(db, ENC_KEY),
      watchStateStore: createImapWatchStateStore(db),
    }
  }

  /** Seed one active, fully-connected IMAP mailbox (config + credential + baseline cursor) — the shape `ImapConnectService.connect` produces. */
  async function seedImapMailbox(
    stores: Awaited<ReturnType<typeof freshStores>>,
    options: { address: string; cursor: { uidValidity: number; lastUid: number } },
  ): Promise<string> {
    const mailbox = await stores.mailboxStore.upsertConnectedMailbox({
      address: options.address,
      provider: 'imap',
    })
    await stores.configStore.upsertConfig(mailbox.id, {
      imapHost: 'imap.example.test',
      imapPort: 993,
      smtpHost: 'smtp.example.test',
      smtpPort: 465,
      username: options.address,
      secure: true,
    })
    await stores.credentialStore.upsertPassword(mailbox.id, 'app-password')
    await stores.watchStateStore.seedBaseline(mailbox.id, options.cursor)
    return mailbox.id
  }

  it('happy path: fetches, ingests each message in order, and advances the cursor to the new watermark', async () => {
    const stores = await freshStores()
    const mailboxId = await seedImapMailbox(stores, {
      address: 'a@example.test',
      cursor: { uidValidity: 100, lastUid: 5 },
    })
    const ingested: RawInboundMessage[] = []
    const ingest = vi.fn(async (raw: RawInboundMessage) => {
      ingested.push(raw)
      return storedOutcome(raw)
    })

    const report = await runImapFetch({
      mailboxStore: stores.mailboxStore,
      configStore: stores.configStore,
      credentialStore: stores.credentialStore,
      watchStateStore: stores.watchStateStore,
      createImapClient: fakeCreateImapClient({
        uidValidity: 100,
        uidNext: 8,
        messages: [rawMessage(6), rawMessage(7)],
      }),
      ingest,
    })

    expect(report).toEqual({
      total: 1,
      fetched: 1,
      messagesIngested: 2,
      paused: 0,
      skipped: 0,
      failed: 0,
    })
    expect(ingested.map((r) => r.providerMessageId)).toEqual(['imap:100:6', 'imap:100:7'])
    expect(await stores.watchStateStore.getCursor(mailboxId)).toEqual({
      uidValidity: 100,
      lastUid: 7,
    })
  })

  it('an empty batch (no new messages) leaves the cursor exactly where it was — no spurious advance', async () => {
    const stores = await freshStores()
    const mailboxId = await seedImapMailbox(stores, {
      address: 'empty@example.test',
      cursor: { uidValidity: 100, lastUid: 10 },
    })
    const ingest = vi.fn()

    const report = await runImapFetch({
      mailboxStore: stores.mailboxStore,
      configStore: stores.configStore,
      credentialStore: stores.credentialStore,
      watchStateStore: stores.watchStateStore,
      createImapClient: fakeCreateImapClient({ uidValidity: 100, uidNext: 11, messages: [] }),
      ingest,
    })

    expect(report.fetched).toBe(1)
    expect(report.messagesIngested).toBe(0)
    expect(ingest).not.toHaveBeenCalled()
    // An empty batch must NOT move the watermark — `fetchImapInboundMessages`
    // returns `lastUid === sinceUid` ("no spurious advance on an empty tick"),
    // so the stored cursor is unchanged. The title claimed an advance this
    // never asserted and never got (review, 2026-07-25).
    expect(await stores.watchStateStore.getCursor(mailboxId)).toEqual({
      uidValidity: 100,
      lastUid: 10,
    })
  })

  // --- SACRED: cursor advances only when every outcome is terminal --------

  it('a `failed` ingest outcome BLOCKS the cursor advance — the mailbox is retried next tick', async () => {
    const stores = await freshStores()
    const mailboxId = await seedImapMailbox(stores, {
      address: 'blocked@example.test',
      cursor: { uidValidity: 100, lastUid: 0 },
    })
    const ingest = vi.fn(async (raw: RawInboundMessage) =>
      raw.providerMessageId === 'imap:100:2'
        ? ({
            kind: 'failed',
            deliveryId: 'd2',
            mailboxId: raw.mailboxId,
            providerMessageId: raw.providerMessageId,
            attempts: 1,
            error: 'transient store error',
          } satisfies IngestOutcome)
        : storedOutcome(raw),
    )

    const report = await runImapFetch({
      mailboxStore: stores.mailboxStore,
      configStore: stores.configStore,
      credentialStore: stores.credentialStore,
      watchStateStore: stores.watchStateStore,
      createImapClient: fakeCreateImapClient({
        uidValidity: 100,
        uidNext: 3,
        messages: [rawMessage(1), rawMessage(2)],
      }),
      ingest,
    })

    expect(report).toEqual({
      total: 1,
      fetched: 0,
      messagesIngested: 0,
      paused: 0,
      skipped: 0,
      failed: 1,
    })
    // Cursor is UNCHANGED — the next tick re-fetches the whole batch (ingest
    // dedup makes the already-terminal message1 free to re-process).
    expect(await stores.watchStateStore.getCursor(mailboxId)).toEqual({
      uidValidity: 100,
      lastUid: 0,
    })
  })

  it('an `in-progress` ingest outcome ALSO blocks the cursor advance', async () => {
    const stores = await freshStores()
    const mailboxId = await seedImapMailbox(stores, {
      address: 'inprogress@example.test',
      cursor: { uidValidity: 100, lastUid: 0 },
    })
    const ingest = vi.fn(
      async (raw: RawInboundMessage) =>
        ({
          kind: 'in-progress',
          deliveryId: 'd1',
          mailboxId: raw.mailboxId,
          providerMessageId: raw.providerMessageId,
        }) satisfies IngestOutcome,
    )

    const report = await runImapFetch({
      mailboxStore: stores.mailboxStore,
      configStore: stores.configStore,
      credentialStore: stores.credentialStore,
      watchStateStore: stores.watchStateStore,
      createImapClient: fakeCreateImapClient({
        uidValidity: 100,
        uidNext: 2,
        messages: [rawMessage(1)],
      }),
      ingest,
    })

    expect(report.failed).toBe(1)
    expect(await stores.watchStateStore.getCursor(mailboxId)).toEqual({
      uidValidity: 100,
      lastUid: 0,
    })
  })

  it('a `dead-letter` outcome is TERMINAL — the cursor still advances (mirrors gmail-reconcile.ts)', async () => {
    const stores = await freshStores()
    const mailboxId = await seedImapMailbox(stores, {
      address: 'deadletter@example.test',
      cursor: { uidValidity: 100, lastUid: 0 },
    })
    const ingest = vi.fn(
      async (raw: RawInboundMessage) =>
        ({
          kind: 'dead-letter',
          deliveryId: 'd1',
          mailboxId: raw.mailboxId,
          providerMessageId: raw.providerMessageId,
          attempts: 5,
          error: 'poison message',
        }) satisfies IngestOutcome,
    )

    const report = await runImapFetch({
      mailboxStore: stores.mailboxStore,
      configStore: stores.configStore,
      credentialStore: stores.credentialStore,
      watchStateStore: stores.watchStateStore,
      createImapClient: fakeCreateImapClient({
        uidValidity: 100,
        uidNext: 2,
        messages: [rawMessage(1)],
      }),
      ingest,
    })

    expect(report).toMatchObject({ fetched: 1, failed: 0 })
    expect(await stores.watchStateStore.getCursor(mailboxId)).toEqual({
      uidValidity: 100,
      lastUid: 1,
    })
  })

  it('a `suppressed` outcome is also TERMINAL — the cursor advances', async () => {
    const stores = await freshStores()
    const mailboxId = await seedImapMailbox(stores, {
      address: 'suppressed@example.test',
      cursor: { uidValidity: 100, lastUid: 0 },
    })
    const ingest = vi.fn(
      async (raw: RawInboundMessage) =>
        ({
          kind: 'suppressed',
          deliveryId: 'd1',
          mailboxId: raw.mailboxId,
          providerMessageId: raw.providerMessageId,
          reason: 'own-message-loop',
        }) satisfies IngestOutcome,
    )

    const report = await runImapFetch({
      mailboxStore: stores.mailboxStore,
      configStore: stores.configStore,
      credentialStore: stores.credentialStore,
      watchStateStore: stores.watchStateStore,
      createImapClient: fakeCreateImapClient({
        uidValidity: 100,
        uidNext: 2,
        messages: [rawMessage(1)],
      }),
      ingest,
    })

    expect(report).toMatchObject({ fetched: 1, failed: 0 })
    expect(await stores.watchStateStore.getCursor(mailboxId)).toEqual({
      uidValidity: 100,
      lastUid: 1,
    })
  })

  // --- SACRED: UIDVALIDITY reset -------------------------------------------

  it('a UIDVALIDITY reset pauses the mailbox, does NOT ingest, and does NOT advance the cursor', async () => {
    const stores = await freshStores()
    const mailboxId = await seedImapMailbox(stores, {
      address: 'reset@example.test',
      cursor: { uidValidity: 100, lastUid: 20 },
    })
    const ingest = vi.fn()

    const report = await runImapFetch({
      mailboxStore: stores.mailboxStore,
      configStore: stores.configStore,
      credentialStore: stores.credentialStore,
      watchStateStore: stores.watchStateStore,
      // A DIFFERENT uidValidity than the stored cursor's 100 — a genuine
      // reset. fetchImapInboundMessages rebuilds from UID 1 under it.
      createImapClient: fakeCreateImapClient({
        uidValidity: 200,
        uidNext: 3,
        messages: [rawMessage(1), rawMessage(2)],
      }),
      ingest,
    })

    expect(report).toEqual({
      total: 1,
      fetched: 0,
      messagesIngested: 0,
      paused: 1,
      skipped: 0,
      failed: 0,
    })
    expect(ingest).not.toHaveBeenCalled()
    // Cursor is UNTOUCHED — still the OLD epoch/UID, never silently reseeded.
    expect(await stores.watchStateStore.getCursor(mailboxId)).toEqual({
      uidValidity: 100,
      lastUid: 20,
    })
    expect((await stores.mailboxStore.getMailboxById(mailboxId))?.status).toBe('paused')
  })

  // --- Per-mailbox isolation -----------------------------------------------

  it('one mailbox failing (unexpected throw) does not stop the others', async () => {
    const stores = await freshStores()
    const healthy = await seedImapMailbox(stores, {
      address: 'healthy@example.test',
      cursor: { uidValidity: 100, lastUid: 0 },
    })
    const broken = await seedImapMailbox(stores, {
      address: 'broken@example.test',
      cursor: { uidValidity: 100, lastUid: 0 },
    })
    const ingest = vi.fn(async (raw: RawInboundMessage) => storedOutcome(raw))

    const report = await runImapFetch({
      mailboxStore: stores.mailboxStore,
      configStore: stores.configStore,
      credentialStore: stores.credentialStore,
      watchStateStore: stores.watchStateStore,
      createImapClient: (options) => {
        if (options.host === 'imap.example.test' && options.auth.user === 'broken@example.test') {
          return {
            async connect() {
              throw new Error('ECONNREFUSED')
            },
            async selectInbox() {
              throw new Error('unreachable')
            },
            async uidFetchRawSince() {
              throw new Error('unreachable')
            },
            async close() {},
          }
        }
        return fakeCreateImapClient({
          uidValidity: 100,
          uidNext: 2,
          messages: [rawMessage(1)],
        })(options)
      },
      ingest,
    })

    expect(report.total).toBe(2)
    expect(report.fetched).toBe(1)
    expect(report.failed).toBe(1)
    expect(await stores.watchStateStore.getCursor(healthy)).toEqual({
      uidValidity: 100,
      lastUid: 1,
    })
    expect(await stores.watchStateStore.getCursor(broken)).toEqual({
      uidValidity: 100,
      lastUid: 0,
    })
  })

  it('a Gmail-provider mailbox is never touched — only provider === "imap" mailboxes are fetched', async () => {
    const stores = await freshStores()
    await stores.mailboxStore.upsertConnectedMailbox({
      address: 'gmail-user@example.test',
      provider: 'gmail',
    })
    const ingest = vi.fn()

    const report = await runImapFetch({
      mailboxStore: stores.mailboxStore,
      configStore: stores.configStore,
      credentialStore: stores.credentialStore,
      watchStateStore: stores.watchStateStore,
      createImapClient: fakeCreateImapClient({ uidValidity: 1, uidNext: 1, messages: [] }),
      ingest,
    })

    expect(report.total).toBe(0)
    expect(ingest).not.toHaveBeenCalled()
  })

  it('a mailbox with no imap_watch_state row (no baseline yet) is skipped, not an error', async () => {
    const stores = await freshStores()
    await stores.mailboxStore.upsertConnectedMailbox({
      address: 'nobaseline@example.test',
      provider: 'imap',
    })
    const ingest = vi.fn()

    const report = await runImapFetch({
      mailboxStore: stores.mailboxStore,
      configStore: stores.configStore,
      credentialStore: stores.credentialStore,
      watchStateStore: stores.watchStateStore,
      createImapClient: fakeCreateImapClient({ uidValidity: 1, uidNext: 1, messages: [] }),
      ingest,
    })

    expect(report).toEqual({
      total: 1,
      fetched: 0,
      messagesIngested: 0,
      paused: 0,
      skipped: 1,
      failed: 0,
    })
    expect(ingest).not.toHaveBeenCalled()
  })

  it('a lease already held by another invocation is skipped, not re-fetched', async () => {
    const stores = await freshStores()
    await seedImapMailbox(stores, {
      address: 'leased@example.test',
      cursor: { uidValidity: 100, lastUid: 0 },
    })
    // Simulate a concurrent invocation already holding the lease.
    const held = await stores.watchStateStore.claimFetchLease(
      (await stores.mailboxStore.listActiveMailboxes())[0].id,
      60_000,
    )
    expect(held).not.toBeNull()
    const ingest = vi.fn()

    const report = await runImapFetch({
      mailboxStore: stores.mailboxStore,
      configStore: stores.configStore,
      credentialStore: stores.credentialStore,
      watchStateStore: stores.watchStateStore,
      createImapClient: fakeCreateImapClient({ uidValidity: 100, uidNext: 5, messages: [] }),
      ingest,
    })

    expect(report.skipped).toBe(1)
    expect(ingest).not.toHaveBeenCalled()
  })

  it('releases the fetch lease even when ingest throws unexpectedly — the mailbox is not locked out', async () => {
    const stores = await freshStores()
    const mailboxId = await seedImapMailbox(stores, {
      address: 'throws@example.test',
      cursor: { uidValidity: 100, lastUid: 0 },
    })
    const ingest = vi.fn(async () => {
      throw new Error('unexpected ingest failure')
    })

    const report = await runImapFetch({
      mailboxStore: stores.mailboxStore,
      configStore: stores.configStore,
      credentialStore: stores.credentialStore,
      watchStateStore: stores.watchStateStore,
      createImapClient: fakeCreateImapClient({
        uidValidity: 100,
        uidNext: 2,
        messages: [rawMessage(1)],
      }),
      ingest,
    })

    expect(report.failed).toBe(1)
    // Lease released — immediately re-claimable, not stuck until leaseMs elapses.
    const reclaimed = await stores.watchStateStore.claimFetchLease(mailboxId, 30_000)
    expect(reclaimed).not.toBeNull()
  })

  it('defaults maxPerInvocation and leaseMs when not overridden', async () => {
    const stores = await freshStores()
    await seedImapMailbox(stores, {
      address: 'defaults@example.test',
      cursor: { uidValidity: 100, lastUid: 0 },
    })
    const deps: ImapFetchDeps = {
      mailboxStore: stores.mailboxStore,
      configStore: stores.configStore,
      credentialStore: stores.credentialStore,
      watchStateStore: stores.watchStateStore,
      createImapClient: fakeCreateImapClient({ uidValidity: 100, uidNext: 1, messages: [] }),
      ingest: vi.fn(),
    }

    await runImapFetch(deps)

    // No throw, and DEFAULT_IMAP_FETCH_LEASE_MS is a sane 5-minute value —
    // this test just proves the module exports it and the call above didn't
    // need an explicit override to succeed.
    expect(DEFAULT_IMAP_FETCH_LEASE_MS).toBe(5 * 60_000)
  })
})
