/**
 * `createImapConnectService` against REAL PGlite-backed `MailboxStore`/
 * `ImapConfigStore`/`ImapCredentialStore`/`ImapWatchStateStore` (so the
 * atomic-persist transaction is genuinely exercised, not just mocked) plus
 * fakes for the network-facing seams (`createImapClient`, `verifySmtp`).
 * Exercises the module doc's contract: both legs run to completion
 * independently on `checkConnection`, `connect` aborts on the first failure
 * with nothing persisted, the baseline seeds at `uidNext - 1`, and the
 * password never leaks into a thrown/reported error.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import type { ImapClient, ImapClientOptions } from '../providers/adapters/imap/index.js'
import type { VerifySmtpConnectionOptions } from '../providers/adapters/smtp/index.js'
import { createImapConfigStore } from '../store/imap-config.js'
import { createImapCredentialStore } from '../store/imap-credentials.js'
import { createImapWatchStateStore } from '../store/imap-watch-state.js'
import { createMailboxStore } from '../store/mailboxes.js'
import { ENCRYPTION_KEY_BYTES } from '../store/token-crypto.js'
import {
  createImapConnectService,
  ImapConnectError,
  type ImapConnectInput,
  type ImapConnectServiceDeps,
} from './imap-connect.js'

const ENC_KEY = Buffer.alloc(ENCRYPTION_KEY_BYTES, 7)

const VALID_INPUT: ImapConnectInput = {
  address: 'support@example.test',
  imapHost: 'imap.example.test',
  imapPort: 993,
  smtpHost: 'smtp.example.test',
  smtpPort: 465,
  username: 'support@example.test',
  password: 'super-secret-app-password',
}

/** A fake `createImapClient` factory: `connect()`/`selectInbox()` behavior is configurable; `close()` is always tracked so tests can assert it runs on every path. */
function fakeCreateImapClient(
  behavior: {
    connectError?: Error
    selectInboxError?: Error
    mailbox?: { uidValidity: number; uidNext: number }
  } = {},
): {
  factory: (options: ImapClientOptions) => ImapClient
  state: { closeCalls: number; capturedOptions: ImapClientOptions[] }
} {
  const state = { closeCalls: 0, capturedOptions: [] as ImapClientOptions[] }
  const factory = (options: ImapClientOptions): ImapClient => {
    state.capturedOptions.push(options)
    return {
      async connect() {
        if (behavior.connectError) throw behavior.connectError
      },
      async selectInbox() {
        if (behavior.selectInboxError) throw behavior.selectInboxError
        return behavior.mailbox ?? { uidValidity: 1000, uidNext: 51 }
      },
      async uidFetchRawSince() {
        throw new Error('uidFetchRawSince: not used by the connect service')
      },
      async close() {
        state.closeCalls++
      },
    }
  }
  return { factory, state }
}

/** A fake `verifySmtp` dependency: resolves, or throws `behavior.error`. Records every call's options. */
function fakeVerifySmtp(behavior: { error?: Error } = {}): {
  fn: (options: VerifySmtpConnectionOptions) => Promise<void>
  calls: VerifySmtpConnectionOptions[]
} {
  const calls: VerifySmtpConnectionOptions[] = []
  const fn = async (options: VerifySmtpConnectionOptions): Promise<void> => {
    calls.push(options)
    if (behavior.error) throw behavior.error
  }
  return { fn, calls }
}

describe('createImapConnectService', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshDeps(
    overrides: {
      createImapClient?: ImapConnectServiceDeps['createImapClient']
      verifySmtp?: ImapConnectServiceDeps['verifySmtp']
    } = {},
  ): Promise<{ db: Db; deps: ImapConnectServiceDeps }> {
    db = await createPgliteDb()
    await migrate(db)
    const deps: ImapConnectServiceDeps = {
      db,
      mailboxStore: createMailboxStore(db),
      configStore: createImapConfigStore(db),
      credentialStore: createImapCredentialStore(db, ENC_KEY),
      watchStateStore: createImapWatchStateStore(db),
      createImapClient: overrides.createImapClient ?? fakeCreateImapClient().factory,
      verifySmtp: overrides.verifySmtp ?? fakeVerifySmtp().fn,
    }
    return { db, deps }
  }

  async function countMailboxes(rawDb: Db): Promise<number> {
    const rows = await rawDb.query<{ n: number }>('SELECT count(*)::int AS n FROM mailboxes')
    return rows[0].n
  }

  // --- checkConnection -------------------------------------------------------

  describe('checkConnection', () => {
    it('both legs succeed: reports { ok: true } for each, persists nothing', async () => {
      const { db: rawDb, deps } = await freshDeps()
      const service = createImapConnectService(deps)

      const result = await service.checkConnection(VALID_INPUT)

      expect(result).toEqual({ imap: { ok: true }, smtp: { ok: true } })
      expect(await countMailboxes(rawDb)).toBe(0)
    })

    it('a failing IMAP leg does not suppress the SMTP leg — both are reported independently', async () => {
      const { deps } = await freshDeps({
        createImapClient: fakeCreateImapClient({ connectError: new Error('ECONNREFUSED') }).factory,
      })
      const service = createImapConnectService(deps)

      const result = await service.checkConnection(VALID_INPUT)

      expect(result.imap).toEqual({ ok: false, error: expect.stringContaining('ECONNREFUSED') })
      expect(result.smtp).toEqual({ ok: true })
    })

    it('a failing SMTP leg does not suppress the IMAP leg — both are reported independently', async () => {
      const { deps } = await freshDeps({
        verifySmtp: fakeVerifySmtp({ error: new Error('535 Invalid login') }).fn,
      })
      const service = createImapConnectService(deps)

      const result = await service.checkConnection(VALID_INPUT)

      expect(result.imap).toEqual({ ok: true })
      expect(result.smtp).toEqual({
        ok: false,
        error: expect.stringContaining('535 Invalid login'),
      })
    })

    it('both legs fail: both are reported, persists nothing', async () => {
      const { db: rawDb, deps } = await freshDeps({
        createImapClient: fakeCreateImapClient({ connectError: new Error('imap down') }).factory,
        verifySmtp: fakeVerifySmtp({ error: new Error('smtp down') }).fn,
      })
      const service = createImapConnectService(deps)

      const result = await service.checkConnection(VALID_INPUT)

      expect(result.imap.ok).toBe(false)
      expect(result.smtp.ok).toBe(false)
      expect(await countMailboxes(rawDb)).toBe(0)
    })

    it('closes the IMAP client even when connect() throws', async () => {
      const { factory, state } = fakeCreateImapClient({ connectError: new Error('boom') })
      const { deps } = await freshDeps({ createImapClient: factory })
      const service = createImapConnectService(deps)

      await service.checkConnection(VALID_INPUT)

      expect(state.closeCalls).toBe(1)
    })

    it('redacts the literal password from a reported error message', async () => {
      const leaky = new Error(`auth failed for password ${VALID_INPUT.password}`)
      const { deps } = await freshDeps({
        createImapClient: fakeCreateImapClient({ connectError: leaky }).factory,
      })
      const service = createImapConnectService(deps)

      const result = await service.checkConnection(VALID_INPUT)

      expect(result.imap.ok).toBe(false)
      const imapResult = result.imap as { ok: false; error: string }
      expect(imapResult.error).not.toContain(VALID_INPUT.password)
      expect(imapResult.error).toContain('[redacted]')
    })
  })

  // --- connect -----------------------------------------------------------

  describe('connect', () => {
    it('both legs pass: persists the mailbox/config/credential/cursor atomically, seeding the baseline at uidNext - 1', async () => {
      const { db: rawDb, deps } = await freshDeps({
        createImapClient: fakeCreateImapClient({ mailbox: { uidValidity: 4242, uidNext: 101 } })
          .factory,
      })
      const service = createImapConnectService(deps)

      const mailbox = await service.connect(VALID_INPUT)

      expect(mailbox).toMatchObject({
        address: VALID_INPUT.address,
        provider: 'imap',
        status: 'active',
      })

      const config = await createImapConfigStore(rawDb).getConfig(mailbox.id)
      expect(config).toEqual({
        imapHost: VALID_INPUT.imapHost,
        imapPort: VALID_INPUT.imapPort,
        smtpHost: VALID_INPUT.smtpHost,
        smtpPort: VALID_INPUT.smtpPort,
        username: VALID_INPUT.username,
        secure: true, // defaulted — VALID_INPUT.secure is omitted
      })

      const password = await createImapCredentialStore(rawDb, ENC_KEY).getPassword(mailbox.id)
      expect(password).toBe(VALID_INPUT.password)

      // SACRED: lastUid = uidNext - 1 — the baseline starts strictly AFTER
      // whatever is already in the mailbox (module doc).
      const cursor = await createImapWatchStateStore(rawDb).getCursor(mailbox.id)
      expect(cursor).toEqual({ uidValidity: 4242, lastUid: 100 })
    })

    it('respects an explicit secure: false, persisting it verbatim', async () => {
      const { db: rawDb, deps } = await freshDeps()
      const service = createImapConnectService(deps)

      const mailbox = await service.connect({ ...VALID_INPUT, secure: false })

      const config = await createImapConfigStore(rawDb).getConfig(mailbox.id)
      expect(config?.secure).toBe(false)
    })

    it('a failed IMAP leg throws ImapConnectError(imap_failed) and persists NOTHING', async () => {
      const { db: rawDb, deps } = await freshDeps({
        createImapClient: fakeCreateImapClient({ connectError: new Error('ECONNREFUSED') }).factory,
      })
      const service = createImapConnectService(deps)

      await expect(service.connect(VALID_INPUT)).rejects.toThrow(ImapConnectError)
      await expect(service.connect(VALID_INPUT)).rejects.toMatchObject({ code: 'imap_failed' })
      expect(await countMailboxes(rawDb)).toBe(0)
    })

    it('a failed SMTP leg (IMAP already passed) throws ImapConnectError(smtp_failed) and STILL persists nothing — the IMAP leg alone never commits a partial connect', async () => {
      const { db: rawDb, deps } = await freshDeps({
        verifySmtp: fakeVerifySmtp({ error: new Error('535 Invalid login') }).fn,
      })
      const service = createImapConnectService(deps)

      await expect(service.connect(VALID_INPUT)).rejects.toMatchObject({ code: 'smtp_failed' })
      expect(await countMailboxes(rawDb)).toBe(0)
    })

    it('does not attempt the SMTP leg at all when the IMAP leg already failed', async () => {
      const { calls, fn } = fakeVerifySmtp()
      const { deps } = await freshDeps({
        createImapClient: fakeCreateImapClient({ connectError: new Error('down') }).factory,
        verifySmtp: fn,
      })
      const service = createImapConnectService(deps)

      await expect(service.connect(VALID_INPUT)).rejects.toThrow(ImapConnectError)
      expect(calls).toHaveLength(0)
    })

    it('never echoes the password in the thrown ImapConnectError message', async () => {
      const leaky = new Error(`535 auth failed: ${VALID_INPUT.password}`)
      const { deps } = await freshDeps({ verifySmtp: fakeVerifySmtp({ error: leaky }).fn })
      const service = createImapConnectService(deps)

      let caught: unknown
      try {
        await service.connect(VALID_INPUT)
      } catch (err) {
        caught = err
      }

      expect(caught).toBeInstanceOf(ImapConnectError)
      const message = (caught as Error).message
      expect(message).not.toContain(VALID_INPUT.password)
      expect(message).toContain('[redacted]')
    })

    it('a reconnect (same address) re-baselines the cursor and replaces the stored config/credential — idempotent by address', async () => {
      const { db: rawDb, deps } = await freshDeps({
        createImapClient: fakeCreateImapClient({ mailbox: { uidValidity: 1, uidNext: 5 } }).factory,
      })
      const service = createImapConnectService(deps)
      const first = await service.connect(VALID_INPUT)

      // A fresh service instance over the SAME underlying stores, but a
      // different IMAP client behavior (a new epoch) — mirrors an operator
      // re-running connect against a since-changed mailbox.
      const secondService = createImapConnectService({
        ...deps,
        createImapClient: fakeCreateImapClient({ mailbox: { uidValidity: 999, uidNext: 30 } })
          .factory,
      })
      const second = await secondService.connect({
        ...VALID_INPUT,
        imapHost: 'new-imap.example.test',
      })

      expect(second.id).toBe(first.id)
      expect(await countMailboxes(rawDb)).toBe(1)
      const config = await createImapConfigStore(rawDb).getConfig(second.id)
      expect(config?.imapHost).toBe('new-imap.example.test')
      const cursor = await createImapWatchStateStore(rawDb).getCursor(second.id)
      expect(cursor).toEqual({ uidValidity: 999, lastUid: 29 })
    })
  })
})
