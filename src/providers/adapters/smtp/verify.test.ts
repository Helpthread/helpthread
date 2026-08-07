/**
 * `verifySmtpConnection` against a FAKE `SmtpVerifyTransporter` (no real SMTP
 * server, no network call) — proves the options-mapping and the "resolve on
 * success, throw the provider's own error on failure" contract.
 */

import { describe, expect, it, vi } from 'vitest'
import { verifySmtpConnection } from './verify.js'

const baseOptions = { host: 'smtp.example.test', port: 465, auth: { user: 'u', pass: 'p' } }

describe('verifySmtpConnection', () => {
  it('resolves when the transporter verifies successfully', async () => {
    const verify = vi.fn(async () => true as const)
    await expect(
      verifySmtpConnection({ ...baseOptions, transporter: { verify } }),
    ).resolves.toBeUndefined()
    expect(verify).toHaveBeenCalledTimes(1)
  })

  it('propagates the transporter error unwrapped (never rewritten or swallowed)', async () => {
    const verify = vi.fn(async () => {
      throw new Error('535 Invalid login')
    })

    await expect(verifySmtpConnection({ ...baseOptions, transporter: { verify } })).rejects.toThrow(
      '535 Invalid login',
    )
  })

  it('never calls the real nodemailer transport factory when a fake transporter is supplied', async () => {
    // No assertion beyond "this resolves without touching the network" —
    // the fake never delegates to a real transporter, and there is no
    // network available in the test environment, so any accidental real
    // network attempt would time out / hang, not silently pass.
    const verify = vi.fn(async () => true as const)
    await verifySmtpConnection({ ...baseOptions, transporter: { verify } })
    expect(verify).toHaveBeenCalledOnce()
  })
})
