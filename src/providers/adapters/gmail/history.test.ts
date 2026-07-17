/**
 * `createGmailHistoryClient` against a FAKE `fetchImpl` — no real network
 * call, no real Google credentials. Exercises the HTTP-transport contract:
 * pagination + id de-duplication + watermark extraction for `history.list`,
 * base64url raw decode + `internalDate` conversion for `messages.get`, the
 * two typed (not-thrown) 404 outcomes, throw-on-other-non-2xx, and that the
 * access token is never leaked in a thrown error.
 */

import { describe, expect, it, vi } from 'vitest'
import { createGmailHistoryClient } from './history.js'

interface RecordedCall {
  url: string
  init: RequestInit
}

/** A fake `fetch` that returns queued responses in order, one per call, and records every call. */
function sequencedFetch(responses: Array<{ status: number; body?: unknown; text?: string }>): {
  fetchImpl: typeof fetch
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  let callIndex = 0
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    const next = responses[callIndex]
    callIndex++
    if (next === undefined) {
      throw new Error(`sequencedFetch: no response queued for call #${callIndex}`)
    }
    if (next.text !== undefined) {
      return new Response(next.text, { status: next.status })
    }
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('createGmailHistoryClient', () => {
  describe('listAddedMessageIds', () => {
    it("follows nextPageToken pagination to the end, de-duplicates ids, returns the LAST page historyId, and lets a repeated id's labelIds be overwritten by the later record", async () => {
      const { fetchImpl, calls } = sequencedFetch([
        {
          status: 200,
          body: {
            history: [
              {
                messagesAdded: [
                  { message: { id: 'm1', labelIds: ['INBOX'] } },
                  { message: { id: 'm2', labelIds: ['INBOX'] } },
                ],
              },
            ],
            historyId: 'h-page1', // should be overwritten by the final page's value
            nextPageToken: 'page-2-token',
          },
        },
        {
          status: 200,
          body: {
            // m2 repeated across pages (Gmail's own history records can
            // repeat an id) — must be de-duplicated, and its LATER labelIds
            // (here: also labeled SENT) must win over the first page's; m3
            // is genuinely new.
            history: [
              {
                messagesAdded: [
                  { message: { id: 'm2', labelIds: ['INBOX', 'SENT'] } },
                  { message: { id: 'm3', labelIds: ['INBOX'] } },
                ],
              },
            ],
            historyId: 'h-final',
            // no nextPageToken — last page.
          },
        },
      ])
      const client = createGmailHistoryClient({
        getAccessToken: async () => 'token-abc',
        fetchImpl,
      })

      const result = await client.listAddedMessageIds('1000')

      expect(result).toEqual({
        kind: 'ok',
        messages: [
          { id: 'm1', labelIds: ['INBOX'] },
          { id: 'm2', labelIds: ['INBOX', 'SENT'] },
          { id: 'm3', labelIds: ['INBOX'] },
        ],
        newHistoryId: 'h-final',
      })
      expect(calls).toHaveLength(2)

      const firstUrl = new URL(calls[0].url)
      expect(firstUrl.pathname).toBe('/gmail/v1/users/me/history')
      expect(firstUrl.searchParams.get('startHistoryId')).toBe('1000')
      expect(firstUrl.searchParams.get('historyTypes')).toBe('messageAdded')
      expect(firstUrl.searchParams.has('pageToken')).toBe(false)

      const secondUrl = new URL(calls[1].url)
      expect(secondUrl.searchParams.get('pageToken')).toBe('page-2-token')
      expect(secondUrl.searchParams.get('startHistoryId')).toBe('1000')
    })

    it('sends Bearer auth built from a freshly-fetched token', async () => {
      const { fetchImpl, calls } = sequencedFetch([{ status: 200, body: { historyId: 'h1' } }])
      const getAccessToken = vi.fn(async () => 'token-xyz')
      const client = createGmailHistoryClient({ getAccessToken, fetchImpl })

      await client.listAddedMessageIds('1')

      expect(getAccessToken).toHaveBeenCalled()
      const headers = new Headers(calls[0].init.headers)
      expect(headers.get('Authorization')).toBe('Bearer token-xyz')
    })

    it("a single page with no history records returns an empty list and that page's historyId", async () => {
      const { fetchImpl } = sequencedFetch([{ status: 200, body: { historyId: 'h-unchanged' } }])
      const client = createGmailHistoryClient({ getAccessToken: async () => 'token', fetchImpl })

      const result = await client.listAddedMessageIds('500')

      expect(result).toEqual({ kind: 'ok', messages: [], newHistoryId: 'h-unchanged' })
    })

    it('defaults labelIds to [] when Gmail omits the field on a messagesAdded record', async () => {
      const { fetchImpl } = sequencedFetch([
        {
          status: 200,
          body: {
            history: [{ messagesAdded: [{ message: { id: 'm1' } }] }],
            historyId: 'h1',
          },
        },
      ])
      const client = createGmailHistoryClient({ getAccessToken: async () => 'token', fetchImpl })

      const result = await client.listAddedMessageIds('1')

      expect(result).toEqual({
        kind: 'ok',
        messages: [{ id: 'm1', labelIds: [] }],
        newHistoryId: 'h1',
      })
    })

    it('returns { kind: "expired" } on a 404, without throwing', async () => {
      const { fetchImpl } = sequencedFetch([{ status: 404, body: { error: 'not found' } }])
      const client = createGmailHistoryClient({ getAccessToken: async () => 'token', fetchImpl })

      const result = await client.listAddedMessageIds('1')

      expect(result).toEqual({ kind: 'expired' })
    })

    it('throws on a non-404 non-2xx response, and never leaks the access token', async () => {
      const { fetchImpl } = sequencedFetch([{ status: 500, text: 'internal server error, sorry' }])
      const secretToken = 'super-secret-history-token-do-not-leak'
      const client = createGmailHistoryClient({
        getAccessToken: async () => secretToken,
        fetchImpl,
      })

      let caught: unknown
      try {
        await client.listAddedMessageIds('1')
      } catch (err) {
        caught = err
      }

      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).message).toContain('500')
      expect(String(caught)).not.toContain(secretToken)
    })

    it('fetches a fresh token for every page (a long pagination run never carries a stale token)', async () => {
      const { fetchImpl } = sequencedFetch([
        {
          status: 200,
          body: {
            history: [{ messagesAdded: [{ message: { id: 'm1' } }] }],
            historyId: 'h1',
            nextPageToken: 'p2',
          },
        },
        { status: 200, body: { historyId: 'h2' } },
      ])
      const getAccessToken = vi.fn(async () => 'token')
      const client = createGmailHistoryClient({ getAccessToken, fetchImpl })

      await client.listAddedMessageIds('1')

      expect(getAccessToken).toHaveBeenCalledTimes(2)
    })
  })

  describe('getRawMessage', () => {
    it('decodes the base64url raw field and converts internalDate to receivedAt', async () => {
      const mime = 'From: a@example.test\r\nSubject: hi\r\n\r\nbody'
      const rawEncoded = Buffer.from(mime, 'utf8').toString('base64url')
      const { fetchImpl, calls } = sequencedFetch([
        {
          status: 200,
          body: { raw: rawEncoded, internalDate: '1735689600000' },
        },
      ])
      const client = createGmailHistoryClient({ getAccessToken: async () => 'token', fetchImpl })

      const result = await client.getRawMessage('gmail-msg-1')

      if (result === null) throw new Error('expected getRawMessage to return a result')
      expect(Buffer.from(result.rawBytes).toString('utf8')).toBe(mime)
      expect(result.receivedAt.toISOString()).toBe('2025-01-01T00:00:00.000Z')

      const url = new URL(calls[0].url)
      expect(url.pathname).toBe('/gmail/v1/users/me/messages/gmail-msg-1')
      expect(url.searchParams.get('format')).toBe('raw')
    })

    it('returns null on a 404 (message deleted between list and get), without throwing', async () => {
      const { fetchImpl } = sequencedFetch([{ status: 404, body: {} }])
      const client = createGmailHistoryClient({ getAccessToken: async () => 'token', fetchImpl })

      const result = await client.getRawMessage('gone')

      expect(result).toBeNull()
    })

    it('throws on a non-404 non-2xx response, and never leaks the access token', async () => {
      const { fetchImpl } = sequencedFetch([{ status: 401, text: 'unauthorized' }])
      const secretToken = 'super-secret-raw-fetch-token'
      const client = createGmailHistoryClient({
        getAccessToken: async () => secretToken,
        fetchImpl,
      })

      let caught: unknown
      try {
        await client.getRawMessage('m1')
      } catch (err) {
        caught = err
      }

      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).message).toContain('401')
      expect(String(caught)).not.toContain(secretToken)
    })

    it('throws a clear error when the 200 response is missing raw (malformed)', async () => {
      const { fetchImpl } = sequencedFetch([{ status: 200, body: { internalDate: '123' } }])
      const client = createGmailHistoryClient({ getAccessToken: async () => 'token', fetchImpl })

      await expect(client.getRawMessage('m1')).rejects.toThrow(/raw/)
    })

    it('throws a clear error when the 200 response is missing internalDate (malformed)', async () => {
      const { fetchImpl } = sequencedFetch([
        { status: 200, body: { raw: Buffer.from('x').toString('base64url') } },
      ])
      const client = createGmailHistoryClient({ getAccessToken: async () => 'token', fetchImpl })

      await expect(client.getRawMessage('m1')).rejects.toThrow(/internalDate/)
    })

    it("throws when 'raw' is not well-formed base64url (out-of-alphabet chars) rather than silently truncating it", async () => {
      // Buffer.from(x, 'base64url') would decode this to truncated garbage
      // instead of throwing — see BASE64URL_RE in history.ts.
      const { fetchImpl } = sequencedFetch([
        { status: 200, body: { raw: 'has spaces & !@# not base64url', internalDate: '123' } },
      ])
      const client = createGmailHistoryClient({ getAccessToken: async () => 'token', fetchImpl })

      await expect(client.getRawMessage('m1')).rejects.toThrow(/malformed base64url/)
    })

    it('uses the given userId in both endpoint URLs instead of the default "me"', async () => {
      const { fetchImpl, calls } = sequencedFetch([{ status: 200, body: { historyId: 'h1' } }])
      const client = createGmailHistoryClient({
        getAccessToken: async () => 'token',
        fetchImpl,
        userId: 'mailbox@example.test',
      })

      await client.listAddedMessageIds('1')

      expect(new URL(calls[0].url).pathname).toBe('/gmail/v1/users/mailbox%40example.test/history')
    })

    it('passes an abort signal to fetch and rejects when the call outlives timeoutMs', async () => {
      const fetchImpl = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal
            expect(signal).toBeDefined()
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
          }),
      ) as unknown as typeof fetch
      const client = createGmailHistoryClient({
        getAccessToken: async () => 'token',
        fetchImpl,
        timeoutMs: 20,
      })

      await expect(client.getRawMessage('m1')).rejects.toThrow(/timeout|timed out|aborted/i)
    })
  })
})
