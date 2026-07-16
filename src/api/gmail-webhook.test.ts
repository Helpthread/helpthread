import { describe, expect, it, vi } from 'vitest'
import type { EnqueueOptions, QueueProvider } from '../providers/queue.js'
import type { MailboxRecord, MailboxStore } from '../store/mailboxes.js'
import {
  GMAIL_RECONCILE_TOPIC,
  type GmailPushDeps,
  type GmailReconcileJob,
  handleGmailPushWebhook,
} from './gmail-webhook.js'

const WEBHOOK_URL = 'https://desk.example.test/api/v1/inbound/gmail'
const SUBSCRIPTION = 'projects/helpthread-prod/subscriptions/gmail-push'
const ACTIVE_MAILBOX: MailboxRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  address: 'support@example.test',
  provider: 'gmail',
  status: 'active',
}

/** Records every enqueue call; never throws unless `opts.throwing` is set. */
function fakeQueue(options: { throwing?: boolean } = {}): {
  queue: QueueProvider
  enqueued: Array<{ topic: string; payload: unknown; opts?: EnqueueOptions }>
} {
  const enqueued: Array<{ topic: string; payload: unknown; opts?: EnqueueOptions }> = []
  return {
    queue: {
      async enqueue(topic, payload, opts) {
        if (options.throwing === true) {
          throw new Error('queue provider unavailable (must never leak to the client)')
        }
        enqueued.push({ topic, payload, opts })
      },
    },
    enqueued,
  }
}

function fakeMailboxes(records: MailboxRecord[]): MailboxStore {
  return {
    async getMailboxByAddress(address) {
      return records.find((r) => r.address === address) ?? null
    },
    async getMailboxById(id) {
      return records.find((r) => r.id === id) ?? null
    },
    async markNeedsReconnect() {
      throw new Error('markNeedsReconnect: not used by the push-webhook path')
    },
    async markPaused() {
      throw new Error('markPaused: not used by the push-webhook path')
    },
    async markDisconnected() {
      throw new Error('markDisconnected: not used by the push-webhook path')
    },
    async upsertConnectedMailbox() {
      throw new Error('upsertConnectedMailbox: not used by the push-webhook path')
    },
    async listActiveMailboxes() {
      throw new Error('listActiveMailboxes: not used by the push-webhook path')
    },
  }
}

/** A `verifySignature` stub that always returns `alwaysVerified`, recording how many times it was called. */
function fakeVerifier(alwaysVerified: boolean): {
  verifySignature: (request: Request) => Promise<boolean>
  calls: number
} {
  const state = { calls: 0 }
  return {
    verifySignature: async () => {
      state.calls++
      return alwaysVerified
    },
    get calls() {
      return state.calls
    },
  }
}

function baseDeps(overrides: Partial<GmailPushDeps> = {}): GmailPushDeps {
  const { verifySignature } = fakeVerifier(true)
  const { queue } = fakeQueue()
  return {
    verifySignature,
    subscription: SUBSCRIPTION,
    mailboxes: fakeMailboxes([ACTIVE_MAILBOX]),
    queue,
    ...overrides,
  }
}

/** Base64url-encode a JSON value, matching gmail-push.md §1's `message.data` shape. */
function encodeData(value: unknown, encoding: 'base64' | 'base64url' = 'base64url'): string {
  return Buffer.from(JSON.stringify(value)).toString(encoding)
}

function pushEnvelopeBody(overrides: { subscription?: string; data?: string } = {}): string {
  return JSON.stringify({
    subscription: overrides.subscription ?? SUBSCRIPTION,
    message: {
      data:
        overrides.data ?? encodeData({ emailAddress: 'support@example.test', historyId: '12345' }),
      messageId: 'pubsub-message-1',
      publishTime: '2026-07-13T00:00:00.000Z',
    },
  })
}

function pushRequest(
  options: {
    body?: string
    method?: string
    contentType?: string | null
    contentLength?: string | null
  } = {},
): Request {
  const method = options.method ?? 'POST'
  const bodyText = options.body ?? pushEnvelopeBody()
  const headers: Record<string, string> = {}
  if (options.contentType !== null) {
    headers['Content-Type'] = options.contentType ?? 'application/json'
  }
  if (options.contentLength !== undefined && options.contentLength !== null) {
    headers['Content-Length'] = options.contentLength
  }
  // A plain string body makes Node's Request implementation auto-default
  // Content-Type to `text/plain;charset=UTF-8` when none is set explicitly
  // (WHATWG Fetch's body-extraction step) — verified against the Node
  // version this repo targets. To exercise a GENUINELY absent Content-Type
  // header (`contentType: null`), encode the body as raw bytes instead,
  // which the same spec step does NOT auto-tag with a MIME type.
  const body = options.contentType === null ? new TextEncoder().encode(bodyText) : bodyText
  // The Fetch spec forbids a body on GET/HEAD (the Request constructor
  // throws: "Request with GET/HEAD method cannot have body") — Pub/Sub
  // itself would never send either, so the "wrong method" rejection case
  // exercises the realistic, constructible shape: a bodyless GET.
  return new Request(WEBHOOK_URL, {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD' ? {} : { body }),
  })
}

describe('handleGmailPushWebhook', () => {
  it('happy path: valid signature + matching subscription + known active mailbox -> 200, job enqueued', async () => {
    const { queue, enqueued } = fakeQueue()
    const deps = baseDeps({ queue })

    const res = await handleGmailPushWebhook(pushRequest(), deps)

    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.json()).toEqual({ ok: true })

    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].topic).toBe(GMAIL_RECONCILE_TOPIC)
    const job = enqueued[0].payload as GmailReconcileJob
    expect(job).toEqual({ mailboxId: ACTIVE_MAILBOX.id, historyId: '12345' })
    expect(enqueued[0].opts?.dedupeKey).toBe(`${ACTIVE_MAILBOX.id}:12345`)
  })

  it("accepts message.data encoded as standard base64 (Pub/Sub's actual wire form) as well as base64url", async () => {
    const { queue, enqueued } = fakeQueue()
    const deps = baseDeps({ queue })
    const data = encodeData({ emailAddress: 'support@example.test', historyId: '999' }, 'base64')

    const res = await handleGmailPushWebhook(
      pushRequest({ body: pushEnvelopeBody({ data }) }),
      deps,
    )

    expect(res.status).toBe(200)
    expect(enqueued).toHaveLength(1)
  })

  it('accepts a JSON-number historyId, normalized to a string', async () => {
    const { queue, enqueued } = fakeQueue()
    const deps = baseDeps({ queue })
    const data = encodeData({ emailAddress: 'support@example.test', historyId: 777 })

    const res = await handleGmailPushWebhook(
      pushRequest({ body: pushEnvelopeBody({ data }) }),
      deps,
    )

    expect(res.status).toBe(200)
    expect((enqueued[0].payload as GmailReconcileJob).historyId).toBe('777')
  })

  // --- uniform rejection: every failure mode produces the SAME response ------

  const rejectionCases: Array<{
    name: string
    build: () => { request: Request; deps: GmailPushDeps }
  }> = [
    {
      name: 'wrong method',
      build: () => ({ request: pushRequest({ method: 'GET' }), deps: baseDeps() }),
    },
    {
      name: 'wrong content-type',
      build: () => ({
        request: pushRequest({ contentType: 'text/plain' }),
        deps: baseDeps(),
      }),
    },
    {
      name: 'missing content-type',
      build: () => ({ request: pushRequest({ contentType: null }), deps: baseDeps() }),
    },
    {
      name: 'declared Content-Length over the cap',
      build: () => ({
        request: pushRequest({ contentLength: String(10_000_000) }),
        deps: baseDeps(),
      }),
    },
    {
      name: 'forged/rejected JWT',
      build: () => ({
        request: pushRequest(),
        deps: baseDeps({ verifySignature: fakeVerifier(false).verifySignature }),
      }),
    },
    {
      name: 'wrong subscription',
      build: () => ({
        request: pushRequest({
          body: pushEnvelopeBody({ subscription: 'projects/other/subscriptions/x' }),
        }),
        deps: baseDeps(),
      }),
    },
    {
      name: 'malformed JSON body',
      build: () => ({ request: pushRequest({ body: 'not json{' }), deps: baseDeps() }),
    },
    {
      name: 'envelope missing subscription field',
      build: () => ({
        request: pushRequest({
          body: JSON.stringify({
            message: { data: encodeData({ emailAddress: 'a@b.test', historyId: '1' }) },
          }),
        }),
        deps: baseDeps(),
      }),
    },
    {
      name: 'envelope missing message.data',
      build: () => ({
        request: pushRequest({ body: JSON.stringify({ subscription: SUBSCRIPTION, message: {} }) }),
        deps: baseDeps(),
      }),
    },
    {
      name: 'message.data decodes to JSON missing emailAddress/historyId',
      build: () => ({
        request: pushRequest({ body: pushEnvelopeBody({ data: encodeData({ foo: 'bar' }) }) }),
        deps: baseDeps(),
      }),
    },
    {
      name: 'unknown emailAddress (no such mailbox)',
      build: () => ({
        request: pushRequest({
          body: pushEnvelopeBody({
            data: encodeData({ emailAddress: 'nobody@example.test', historyId: '1' }),
          }),
        }),
        deps: baseDeps(),
      }),
    },
    {
      name: 'mailbox exists but is not active',
      build: () => ({
        request: pushRequest(),
        deps: baseDeps({
          mailboxes: fakeMailboxes([{ ...ACTIVE_MAILBOX, status: 'paused' }]),
        }),
      }),
    },
  ]

  let referenceRejection: { status: number; body: unknown } | undefined

  for (const { name, build } of rejectionCases) {
    it(`rejects uniformly: ${name} -> 403, nothing enqueued`, async () => {
      const { queue, enqueued } = fakeQueue()
      const { request, deps: partialDeps } = build()
      const deps = { ...partialDeps, queue }

      const res = await handleGmailPushWebhook(request, deps)

      expect(res.status).toBe(403)
      expect(res.headers.get('Cache-Control')).toBe('no-store')
      const body = await res.json()
      expect(body).toEqual({ error: { code: 'gmail_push_rejected', message: expect.any(String) } })
      expect(enqueued).toHaveLength(0)

      if (referenceRejection === undefined) {
        referenceRejection = { status: res.status, body }
      } else {
        // Every failure mode must be BYTE-IDENTICAL to the first one seen —
        // this is the "no oracle" property gmail-push.md §2 requires.
        expect({ status: res.status, body }).toEqual(referenceRejection)
      }
    })
  }

  it('an oversized body (no lying Content-Length) is caught by the streaming cap, not just the header check', async () => {
    const { queue, enqueued } = fakeQueue()
    const deps = baseDeps({ queue })
    const hugeBody = pushEnvelopeBody({
      data: encodeData({ emailAddress: 'support@example.test', historyId: 'x'.repeat(200_000) }),
    })

    const res = await handleGmailPushWebhook(
      pushRequest({ body: hugeBody, contentLength: null }),
      deps,
    )

    expect(res.status).toBe(403)
    expect(enqueued).toHaveLength(0)
  })

  it('the JWT is never checked for a wrong method or content-type (cheap checks run first)', async () => {
    const verifier = fakeVerifier(true)
    const deps = baseDeps({ verifySignature: verifier.verifySignature })

    await handleGmailPushWebhook(pushRequest({ method: 'GET' }), deps)
    expect(verifier.calls).toBe(0)

    await handleGmailPushWebhook(pushRequest({ contentType: 'text/plain' }), deps)
    expect(verifier.calls).toBe(0)
  })

  it('the body is never parsed when the JWT fails verification', async () => {
    const verifier = fakeVerifier(false)
    const deps = baseDeps({ verifySignature: verifier.verifySignature })
    // A body that would throw if JSON.parse'd against it.
    const res = await handleGmailPushWebhook(pushRequest({ body: 'not json at all{{{' }), deps)
    expect(res.status).toBe(403)
    expect(verifier.calls).toBe(1)
  })

  // --- internal errors: distinct from the uniform rejection -------------------

  it('an unexpected error (e.g. the queue provider throwing) is 500 server_error, not the uniform 403 -- only reachable after JWT+subscription already passed', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { queue } = fakeQueue({ throwing: true })
    const deps = baseDeps({ queue })

    const res = await handleGmailPushWebhook(pushRequest(), deps)

    expect(res.status).toBe(500)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const body = await res.json()
    expect(body).toEqual({ error: { code: 'server_error', message: expect.any(String) } })
    expect(JSON.stringify(body)).not.toContain('queue provider unavailable')
    errorSpy.mockRestore()
  })

  it('a mailbox store throwing is also 500, not the uniform 403', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const deps = baseDeps({
      mailboxes: {
        async getMailboxByAddress() {
          throw new Error('db unavailable')
        },
        async getMailboxById() {
          throw new Error('getMailboxById: not used by the push-webhook path')
        },
        async markNeedsReconnect() {
          throw new Error('markNeedsReconnect: not used by the push-webhook path')
        },
        async markPaused() {
          throw new Error('markPaused: not used by the push-webhook path')
        },
        async markDisconnected() {
          throw new Error('markDisconnected: not used by the push-webhook path')
        },
        async upsertConnectedMailbox() {
          throw new Error('upsertConnectedMailbox: not used by the push-webhook path')
        },
        async listActiveMailboxes() {
          throw new Error('listActiveMailboxes: not used by the push-webhook path')
        },
      },
    })

    const res = await handleGmailPushWebhook(pushRequest(), deps)
    expect(res.status).toBe(500)
    errorSpy.mockRestore()
  })

  // --- no inline Gmail API fetch ----------------------------------------------

  it('never calls global fetch (no inline Gmail API call) on the happy path or on any rejection', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { queue } = fakeQueue()
    const deps = baseDeps({ queue })

    await handleGmailPushWebhook(pushRequest(), deps)
    await handleGmailPushWebhook(pushRequest({ method: 'GET' }), deps)
    await handleGmailPushWebhook(
      pushRequest({ body: pushEnvelopeBody({ subscription: 'projects/other/subscriptions/x' }) }),
      deps,
    )

    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
