/**
 * `createSenderResolver` against REAL PGlite-backed `MailboxStore`/
 * `ImapConfigStore`/`ImapCredentialStore` (so the actual persistence + the
 * IMAP credential decrypt path are genuinely exercised, not just mocked)
 * plus fakes for the two injected sender factories and the Gmail token
 * service — mirrors `src/mail/imap-connect.test.ts`'s convention.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import type { GmailEmailSenderOptions } from '../providers/adapters/gmail/index.js'
import type { SmtpEmailSenderOptions } from '../providers/adapters/smtp/index.js'
import type { EmailSender } from '../providers/index.js'
import { createImapConfigStore, type ImapConfigStore } from '../store/imap-config.js'
import { createImapCredentialStore, type ImapCredentialStore } from '../store/imap-credentials.js'
import { createMailboxStore, type MailboxStore } from '../store/mailboxes.js'
import { ENCRYPTION_KEY_BYTES } from '../store/token-crypto.js'
import { createSenderResolver, SenderResolutionError } from './sender-resolver.js'

const ENC_KEY = Buffer.alloc(ENCRYPTION_KEY_BYTES, 9)
const DEFAULT_ADDRESS = 'support@example.test'

/** A fake `createGmailEmailSender` factory: records every call's options, returns a distinguishable dummy sender that is never actually invoked in these tests. */
function fakeCreateGmailEmailSender(): {
  factory: (options: GmailEmailSenderOptions) => EmailSender
  calls: GmailEmailSenderOptions[]
} {
  const calls: GmailEmailSenderOptions[] = []
  return {
    calls,
    factory: (options) => {
      calls.push(options)
      return {
        maxSendMs: 1,
        async send() {
          throw new Error('sender-resolver.test.ts: this fake sender is never sent through')
        },
      }
    },
  }
}

/** A fake `createSmtpEmailSender` factory: records every call's options, returns a distinguishable dummy sender that is never actually invoked in these tests. */
function fakeCreateSmtpEmailSender(): {
  factory: (options: SmtpEmailSenderOptions) => EmailSender
  calls: SmtpEmailSenderOptions[]
} {
  const calls: SmtpEmailSenderOptions[] = []
  return {
    calls,
    factory: (options) => {
      calls.push(options)
      return {
        maxSendMs: 1,
        async send() {
          throw new Error('sender-resolver.test.ts: this fake sender is never sent through')
        },
      }
    },
  }
}

/** A fake Gmail token service: records which mailboxId `getAccessToken` was called with, returns a token string derived from it (so a test can assert the RIGHT mailbox's token was requested). */
function fakeTokenService(): {
  tokenService: { getAccessToken(mailboxId: string): Promise<string> }
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    tokenService: {
      async getAccessToken(mailboxId: string) {
        calls.push(mailboxId)
        return `token-for-${mailboxId}`
      },
    },
  }
}

describe('createSenderResolver', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshDeps(): Promise<{
    db: Db
    mailboxStore: MailboxStore
    imapConfigStore: ImapConfigStore
    imapCredentialStore: ImapCredentialStore
  }> {
    db = await createPgliteDb()
    await migrate(db)
    return {
      db,
      mailboxStore: createMailboxStore(db),
      imapConfigStore: createImapConfigStore(db),
      imapCredentialStore: createImapCredentialStore(db, ENC_KEY),
    }
  }

  it("a gmail mailbox resolves to a gmail sender built with THAT mailbox's own token, from = mailbox.address", async () => {
    const { mailboxStore, imapConfigStore, imapCredentialStore } = await freshDeps()
    const mailbox = await mailboxStore.upsertConnectedMailbox({
      address: 'inbox-gmail@example.test',
      provider: 'gmail',
    })
    const { factory: createGmailEmailSender, calls: gmailCalls } = fakeCreateGmailEmailSender()
    const { factory: createSmtpEmailSender, calls: smtpCalls } = fakeCreateSmtpEmailSender()
    const { tokenService, calls: tokenCalls } = fakeTokenService()

    const resolver = createSenderResolver({
      mailboxStore,
      tokenService,
      imapConfigStore,
      imapCredentialStore,
      createGmailEmailSender,
      createSmtpEmailSender,
      defaultAddress: DEFAULT_ADDRESS,
    })

    const result = await resolver.resolve(mailbox.id)

    expect(result.from).toBe(mailbox.address)
    expect(gmailCalls).toHaveLength(1)
    expect(smtpCalls).toHaveLength(0)

    // The sender factory was handed a getAccessToken bound to THIS mailbox's
    // id, not some other mailbox's — verified by actually invoking it.
    await gmailCalls[0].getAccessToken()
    expect(tokenCalls).toEqual([mailbox.id])
  })

  it('an imap mailbox resolves to an smtp sender built from ITS OWN config + decrypted credential, from = mailbox.address', async () => {
    const { mailboxStore, imapConfigStore, imapCredentialStore } = await freshDeps()
    const mailbox = await mailboxStore.upsertConnectedMailbox({
      address: 'inbox-imap@example.test',
      provider: 'imap',
    })
    await imapConfigStore.upsertConfig(mailbox.id, {
      imapHost: 'imap.example.test',
      imapPort: 993,
      smtpHost: 'smtp.example.test',
      smtpPort: 465,
      username: 'inbox-imap@example.test',
      secure: true,
    })
    await imapCredentialStore.upsertPassword(mailbox.id, 'super-secret-app-password')

    const { factory: createGmailEmailSender, calls: gmailCalls } = fakeCreateGmailEmailSender()
    const { factory: createSmtpEmailSender, calls: smtpCalls } = fakeCreateSmtpEmailSender()
    const { tokenService } = fakeTokenService()

    const resolver = createSenderResolver({
      mailboxStore,
      tokenService,
      imapConfigStore,
      imapCredentialStore,
      createGmailEmailSender,
      createSmtpEmailSender,
      defaultAddress: DEFAULT_ADDRESS,
    })

    const result = await resolver.resolve(mailbox.id)

    expect(result.from).toBe(mailbox.address)
    expect(gmailCalls).toHaveLength(0)
    expect(smtpCalls).toHaveLength(1)
    expect(smtpCalls[0]).toEqual({
      host: 'smtp.example.test',
      port: 465,
      secure: true,
      auth: { user: 'inbox-imap@example.test', pass: 'super-secret-app-password' },
    })
  })

  it('an imap mailbox with NO connection config throws SenderResolutionError (missing-imap-connection), never touching the credential store result', async () => {
    const { mailboxStore, imapConfigStore, imapCredentialStore } = await freshDeps()
    const mailbox = await mailboxStore.upsertConnectedMailbox({
      address: 'inbox-no-config@example.test',
      provider: 'imap',
    })
    await imapCredentialStore.upsertPassword(mailbox.id, 'super-secret-app-password')
    // No imapConfigStore.upsertConfig call for this mailbox.

    const { factory: createGmailEmailSender } = fakeCreateGmailEmailSender()
    const { factory: createSmtpEmailSender, calls: smtpCalls } = fakeCreateSmtpEmailSender()
    const { tokenService } = fakeTokenService()
    const resolver = createSenderResolver({
      mailboxStore,
      tokenService,
      imapConfigStore,
      imapCredentialStore,
      createGmailEmailSender,
      createSmtpEmailSender,
      defaultAddress: DEFAULT_ADDRESS,
    })

    await expect(resolver.resolve(mailbox.id)).rejects.toThrow(SenderResolutionError)
    await expect(resolver.resolve(mailbox.id)).rejects.toMatchObject({
      code: 'missing-imap-connection',
    })
    expect(smtpCalls).toHaveLength(0)
  })

  it('an imap mailbox with NO stored credential throws SenderResolutionError (missing-imap-connection)', async () => {
    const { mailboxStore, imapConfigStore, imapCredentialStore } = await freshDeps()
    const mailbox = await mailboxStore.upsertConnectedMailbox({
      address: 'inbox-no-credential@example.test',
      provider: 'imap',
    })
    await imapConfigStore.upsertConfig(mailbox.id, {
      imapHost: 'imap.example.test',
      imapPort: 993,
      smtpHost: 'smtp.example.test',
      smtpPort: 465,
      username: 'inbox-no-credential@example.test',
      secure: true,
    })
    // No imapCredentialStore.upsertPassword call for this mailbox.

    const { factory: createGmailEmailSender } = fakeCreateGmailEmailSender()
    const { factory: createSmtpEmailSender } = fakeCreateSmtpEmailSender()
    const { tokenService } = fakeTokenService()
    const resolver = createSenderResolver({
      mailboxStore,
      tokenService,
      imapConfigStore,
      imapCredentialStore,
      createGmailEmailSender,
      createSmtpEmailSender,
      defaultAddress: DEFAULT_ADDRESS,
    })

    await expect(resolver.resolve(mailbox.id)).rejects.toMatchObject({
      code: 'missing-imap-connection',
    })
  })

  it('an unknown mailboxId throws SenderResolutionError (mailbox-not-found)', async () => {
    const { mailboxStore, imapConfigStore, imapCredentialStore } = await freshDeps()
    const { factory: createGmailEmailSender } = fakeCreateGmailEmailSender()
    const { factory: createSmtpEmailSender } = fakeCreateSmtpEmailSender()
    const { tokenService } = fakeTokenService()
    const resolver = createSenderResolver({
      mailboxStore,
      tokenService,
      imapConfigStore,
      imapCredentialStore,
      createGmailEmailSender,
      createSmtpEmailSender,
      defaultAddress: DEFAULT_ADDRESS,
    })

    await expect(resolver.resolve('00000000-0000-4000-8000-000000000abc')).rejects.toMatchObject({
      code: 'mailbox-not-found',
    })
  })

  it('a mailbox with an unrecognized provider throws SenderResolutionError (unknown-provider)', async () => {
    const { db, mailboxStore, imapConfigStore, imapCredentialStore } = await freshDeps()
    const rows = await db.query<{ id: string }>(
      'INSERT INTO mailboxes (address, provider) VALUES ($1, $2) RETURNING id',
      ['inbox-weird@example.test', 'carrier-pigeon'],
    )
    const mailboxId = rows[0].id

    const { factory: createGmailEmailSender } = fakeCreateGmailEmailSender()
    const { factory: createSmtpEmailSender } = fakeCreateSmtpEmailSender()
    const { tokenService } = fakeTokenService()
    const resolver = createSenderResolver({
      mailboxStore,
      tokenService,
      imapConfigStore,
      imapCredentialStore,
      createGmailEmailSender,
      createSmtpEmailSender,
      defaultAddress: DEFAULT_ADDRESS,
    })

    await expect(resolver.resolve(mailboxId)).rejects.toMatchObject({ code: 'unknown-provider' })
  })

  it('mailboxId null resolves the mailbox whose address is defaultAddress (the pre-2b-i / deployment-default fallback)', async () => {
    const { mailboxStore, imapConfigStore, imapCredentialStore } = await freshDeps()
    const defaultMailbox = await mailboxStore.upsertConnectedMailbox({
      address: DEFAULT_ADDRESS,
      provider: 'gmail',
    })
    // A second, unrelated mailbox — proves the resolver picks the DEFAULT
    // one by address, not merely "some" mailbox.
    await mailboxStore.upsertConnectedMailbox({
      address: 'someone-else@example.test',
      provider: 'gmail',
    })

    const { factory: createGmailEmailSender, calls: gmailCalls } = fakeCreateGmailEmailSender()
    const { factory: createSmtpEmailSender } = fakeCreateSmtpEmailSender()
    const { tokenService, calls: tokenCalls } = fakeTokenService()
    const resolver = createSenderResolver({
      mailboxStore,
      tokenService,
      imapConfigStore,
      imapCredentialStore,
      createGmailEmailSender,
      createSmtpEmailSender,
      defaultAddress: DEFAULT_ADDRESS,
    })

    const result = await resolver.resolve(null)

    expect(result.from).toBe(DEFAULT_ADDRESS)
    expect(gmailCalls).toHaveLength(1)
    await gmailCalls[0].getAccessToken()
    expect(tokenCalls).toEqual([defaultMailbox.id])
  })

  it('mailboxId null with NO mailbox at defaultAddress throws SenderResolutionError (mailbox-not-found)', async () => {
    const { mailboxStore, imapConfigStore, imapCredentialStore } = await freshDeps()
    // No mailbox at all connected.
    const { factory: createGmailEmailSender } = fakeCreateGmailEmailSender()
    const { factory: createSmtpEmailSender } = fakeCreateSmtpEmailSender()
    const { tokenService } = fakeTokenService()
    const resolver = createSenderResolver({
      mailboxStore,
      tokenService,
      imapConfigStore,
      imapCredentialStore,
      createGmailEmailSender,
      createSmtpEmailSender,
      defaultAddress: DEFAULT_ADDRESS,
    })

    await expect(resolver.resolve(null)).rejects.toMatchObject({ code: 'mailbox-not-found' })
  })
})
