/**
 * `createSmtpEmailSender` against a FAKE `SmtpTransporter` (no real SMTP
 * server, no network call) for the mapping/timeout/guard logic, PLUS one
 * test against nodemailer's own REAL `streamTransport` (still zero
 * network — it composes the message in memory) for a genuine wire-level
 * proof that `Message-ID`/`In-Reply-To`/`References` reach the actual
 * composed RFC 5322 bytes verbatim — the "strongest form of contract test"
 * `../../email-sender.ts`'s module doc calls for, mirroring
 * `../gmail/sender.test.ts` + `../gmail/mime.test.ts`'s combined coverage
 * but for nodemailer's architecture (which composes internally rather than
 * handing us a raw-MIME string to build ourselves).
 */

import nodemailer from 'nodemailer'
import { describe, expect, it, vi } from 'vitest'
import type { OutboundEmail } from '../../email-sender.js'
import { createSmtpEmailSender, type SmtpTransporter } from './sender.js'

const email: OutboundEmail = {
  messageId: '<ht.k1.c1.t1.deadbeefsig@mail.example.test>',
  inReplyTo: '<original-msg-id@customer.example.test>',
  references: ['<ref-1@customer.example.test>', '<original-msg-id@customer.example.test>'],
  from: 'support@example.test',
  to: ['customer@example.test'],
  cc: ['cc@example.test'],
  subject: 'Re: Help with my order',
  text: 'body text',
}

const baseOptions = { host: 'smtp.example.test', port: 465, auth: { user: 'u', pass: 'p' } }

describe('createSmtpEmailSender', () => {
  it('maps OutboundEmail onto the transporter verbatim, and returns the TRANSPORTER-reported id, never a copy of email.messageId', async () => {
    const sendMail = vi.fn(async (_mailOptions: nodemailer.SendMailOptions) => ({
      messageId: 'transporter-generated-id-999',
    }))
    const transporter: SmtpTransporter = { sendMail }
    const sender = createSmtpEmailSender({ ...baseOptions, transporter })

    const result = await sender.send(email)

    expect(sendMail).toHaveBeenCalledTimes(1)
    const mailOptions = sendMail.mock.calls[0][0]
    expect(mailOptions.messageId).toBe(email.messageId)
    expect(mailOptions.inReplyTo).toBe(email.inReplyTo)
    expect(mailOptions.references).toEqual(email.references)
    expect(mailOptions.from).toBe(email.from)
    expect(mailOptions.to).toEqual(email.to)
    expect(mailOptions.cc).toEqual(email.cc)
    expect(mailOptions.subject).toBe(email.subject)
    expect(mailOptions.text).toBe(email.text)

    // The provider's OWN id, not a hardcoded echo of email.messageId — the
    // fake deliberately returns a DIFFERENT string to prove this.
    expect(result.providerMessageId).toBe('transporter-generated-id-999')
    expect(result.providerMessageId).not.toBe(email.messageId)
  })

  it('declares maxSendMs equal to the timeout it actually enforces (default and custom)', () => {
    const transporter: SmtpTransporter = { sendMail: async () => ({ messageId: 'x' }) }

    const defaulted = createSmtpEmailSender({ ...baseOptions, transporter })
    expect(defaulted.maxSendMs).toBe(30_000)

    const custom = createSmtpEmailSender({ ...baseOptions, transporter, timeoutMs: 5_000 })
    expect(custom.maxSendMs).toBe(5_000)
  })

  it('rejects when the transporter outlives timeoutMs — send() always settles within its declared bound', async () => {
    // A transporter whose sendMail() never resolves on its own — settles
    // ONLY via this module's own race timer (see sender.ts's withTimeout doc:
    // unlike the Gmail adapter's AbortSignal, nothing here cancels the
    // underlying operation, but the send() PROMISE must still settle).
    const transporter: SmtpTransporter = { sendMail: () => new Promise(() => {}) }
    const sender = createSmtpEmailSender({ ...baseOptions, transporter, timeoutMs: 20 })

    await expect(sender.send(email)).rejects.toThrow(/timed out/i)
  })

  it('refuses to send a bodyless message (neither text nor html)', async () => {
    const sendMail = vi.fn(async () => ({ messageId: 'x' }))
    const transporter: SmtpTransporter = { sendMail }
    const sender = createSmtpEmailSender({ ...baseOptions, transporter })

    const bodyless: OutboundEmail = { ...email, text: undefined, html: undefined }

    await expect(sender.send(bodyless)).rejects.toThrow(/bodyless/)
    expect(sendMail).not.toHaveBeenCalled()
  })

  it.each(['\r', '\n', '\r\n', '\u0007'])(
    'refuses to send when messageId contains a control/newline character (%j) — the verbatim contract guard',
    async (badChar) => {
      const sendMail = vi.fn(async () => ({ messageId: 'x' }))
      const transporter: SmtpTransporter = { sendMail }
      const sender = createSmtpEmailSender({ ...baseOptions, transporter })

      const malformed: OutboundEmail = { ...email, messageId: `<ht.bad${badChar}id@example.test>` }

      await expect(sender.send(malformed)).rejects.toThrow(/control or newline/)
      expect(sendMail).not.toHaveBeenCalled()
    },
  )

  // --- Wire-level proof: nodemailer's REAL streamTransport (no network,
  // composes in memory) — the strongest form of the Message-ID contract
  // test (module doc). ---------------------------------------------------

  interface StreamSentInfo {
    message: Buffer
    messageId: string
  }

  it('wire-level: Message-ID/In-Reply-To/References reach the actual composed RFC 5322 bytes verbatim', async () => {
    const real = nodemailer.createTransport({ streamTransport: true, buffer: true })
    let captured: StreamSentInfo | undefined
    const transporter: SmtpTransporter = {
      async sendMail(mailOptions) {
        const info = (await real.sendMail(mailOptions)) as unknown as StreamSentInfo
        captured = info
        return info
      },
    }
    const sender = createSmtpEmailSender({ ...baseOptions, transporter })

    const result = await sender.send(email)

    expect(captured).toBeDefined()
    const wireText = captured?.message.toString('utf8') ?? ''

    expect(wireText).toContain(`Message-ID: ${email.messageId}`)
    expect(wireText).toContain(`In-Reply-To: ${email.inReplyTo}`)
    for (const ref of email.references ?? []) {
      expect(wireText).toContain(ref)
    }

    // Confirms empirically (not just from reading source) that nodemailer's
    // own info.messageId is an ECHO of the Message-ID header we set, not a
    // separate provider id — see sender.ts's module doc, and
    // specs/mail/mailbox-connection.md's still-open self-echo-suppression
    // question this is relevant to (not resolved here).
    expect(captured?.messageId).toBe(email.messageId)
    expect(result.providerMessageId).toBe(captured?.messageId)
  })
})
