/**
 * `createGmailWatchClient` against a FAKE `fetchImpl` — no real network
 * call, no real Google credentials. Exercises the HTTP-transport contract:
 * `watch()`'s historyId/expiration parsing, `getProfile()`'s emailAddress/
 * historyId parsing, throw-on-non-2xx, throw-on-malformed-2xx, that a fresh
 * token is fetched per request, and that the access token is never leaked
 * in a thrown error. Mirrors `./history.test.ts`'s style.
 */

import { describe, expect, it, vi } from 'vitest'
import { createGmailWatchClient } from './watch.js'

interface RecordedCall {
  url: string
  init: RequestInit
}

/** A fake `fetch` that returns queued responses in order, one per call, and records every call. Mirrors `history.test.ts`'s helper of the same name. */
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

describe('createGmailWatchClient', () => {
  describe('watch', () => {
    it('parses historyId and expiration (as a Date) from a 200 response', async () => {
      const { fetchImpl, calls } = sequencedFetch([
        { status: 200, body: { historyId: 'h-100', expiration: '1735689600000' } },
      ])
      const client = createGmailWatchClient({ getAccessToken: async () => 'token', fetchImpl })

      const result = await client.watch({ topicName: 'projects/p/topics/t' })

      expect(result.historyId).toBe('h-100')
      expect(result.expiration.toISOString()).toBe('2025-01-01T00:00:00.000Z')

      const url = new URL(calls[0].url)
      expect(url.pathname).toBe('/gmail/v1/users/me/watch')
      expect(calls[0].init.method).toBe('POST')
      const headers = new Headers(calls[0].init.headers)
      expect(headers.get('Content-Type')).toBe('application/json')
      const body = JSON.parse(String(calls[0].init.body))
      expect(body).toEqual({ topicName: 'projects/p/topics/t' })
    })

    it('includes labelIds and labelFilterBehavior in the request body when given, omits them when undefined', async () => {
      const { fetchImpl, calls } = sequencedFetch([
        { status: 200, body: { historyId: 'h1', expiration: '1000' } },
      ])
      const client = createGmailWatchClient({ getAccessToken: async () => 'token', fetchImpl })

      await client.watch({
        topicName: 'projects/p/topics/t',
        labelIds: ['INBOX'],
        labelFilterBehavior: 'include',
      })

      const body = JSON.parse(String(calls[0].init.body))
      expect(body).toEqual({
        topicName: 'projects/p/topics/t',
        labelIds: ['INBOX'],
        labelFilterBehavior: 'include',
      })
    })

    it('sends Bearer auth built from a freshly-fetched token', async () => {
      const { fetchImpl, calls } = sequencedFetch([
        { status: 200, body: { historyId: 'h1', expiration: '1000' } },
      ])
      const getAccessToken = vi.fn(async () => 'token-xyz')
      const client = createGmailWatchClient({ getAccessToken, fetchImpl })

      await client.watch({ topicName: 'projects/p/topics/t' })

      expect(getAccessToken).toHaveBeenCalled()
      const headers = new Headers(calls[0].init.headers)
      expect(headers.get('Authorization')).toBe('Bearer token-xyz')
    })

    it('throws on a non-2xx response, with a bounded snippet and NO token in the message', async () => {
      const { fetchImpl } = sequencedFetch([
        { status: 403, text: 'insufficient permissions, sorry' },
      ])
      const secretToken = 'super-secret-watch-token-do-not-leak'
      const client = createGmailWatchClient({ getAccessToken: async () => secretToken, fetchImpl })

      let caught: unknown
      try {
        await client.watch({ topicName: 'projects/p/topics/t' })
      } catch (err) {
        caught = err
      }

      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).message).toContain('403')
      expect((caught as Error).message).toContain('insufficient permissions')
      expect(String(caught)).not.toContain(secretToken)
    })

    it('throws a clear error when the 200 response is missing historyId', async () => {
      const { fetchImpl } = sequencedFetch([{ status: 200, body: { expiration: '1000' } }])
      const client = createGmailWatchClient({ getAccessToken: async () => 'token', fetchImpl })

      await expect(client.watch({ topicName: 't' })).rejects.toThrow(/historyId/)
    })

    it('throws a clear error when the 200 response is missing expiration', async () => {
      const { fetchImpl } = sequencedFetch([{ status: 200, body: { historyId: 'h1' } }])
      const client = createGmailWatchClient({ getAccessToken: async () => 'token', fetchImpl })

      await expect(client.watch({ topicName: 't' })).rejects.toThrow(/expiration/)
    })

    it('throws a clear error when expiration is not a numeric string', async () => {
      const { fetchImpl } = sequencedFetch([
        { status: 200, body: { historyId: 'h1', expiration: 'not-a-number' } },
      ])
      const client = createGmailWatchClient({ getAccessToken: async () => 'token', fetchImpl })

      await expect(client.watch({ topicName: 't' })).rejects.toThrow(/expiration/)
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
      const client = createGmailWatchClient({
        getAccessToken: async () => 'token',
        fetchImpl,
        timeoutMs: 20,
      })

      await expect(client.watch({ topicName: 't' })).rejects.toThrow(/timeout|timed out|aborted/i)
    })
  })

  describe('getProfile', () => {
    it('returns emailAddress and historyId from a 200 response', async () => {
      const { fetchImpl, calls } = sequencedFetch([
        { status: 200, body: { emailAddress: 'mailbox@example.test', historyId: 'h-42' } },
      ])
      const client = createGmailWatchClient({ getAccessToken: async () => 'token', fetchImpl })

      const result = await client.getProfile()

      expect(result).toEqual({ emailAddress: 'mailbox@example.test', historyId: 'h-42' })
      const url = new URL(calls[0].url)
      expect(url.pathname).toBe('/gmail/v1/users/me/profile')
      expect(calls[0].init.method).toBe('GET')
    })

    it('uses the given userId in the endpoint URL instead of the default "me"', async () => {
      const { fetchImpl, calls } = sequencedFetch([
        { status: 200, body: { emailAddress: 'x@example.test', historyId: 'h1' } },
      ])
      const client = createGmailWatchClient({
        getAccessToken: async () => 'token',
        fetchImpl,
        userId: 'mailbox@example.test',
      })

      await client.getProfile()

      expect(new URL(calls[0].url).pathname).toBe('/gmail/v1/users/mailbox%40example.test/profile')
    })

    it('throws on a non-2xx response, with a bounded snippet and NO token in the message', async () => {
      const { fetchImpl } = sequencedFetch([{ status: 401, text: 'invalid credentials' }])
      const secretToken = 'super-secret-profile-token'
      const client = createGmailWatchClient({ getAccessToken: async () => secretToken, fetchImpl })

      let caught: unknown
      try {
        await client.getProfile()
      } catch (err) {
        caught = err
      }

      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).message).toContain('401')
      expect(String(caught)).not.toContain(secretToken)
    })

    it('throws a clear error when the 200 response is missing emailAddress', async () => {
      const { fetchImpl } = sequencedFetch([{ status: 200, body: { historyId: 'h1' } }])
      const client = createGmailWatchClient({ getAccessToken: async () => 'token', fetchImpl })

      await expect(client.getProfile()).rejects.toThrow(/emailAddress/)
    })

    it('throws a clear error when the 200 response is missing historyId', async () => {
      const { fetchImpl } = sequencedFetch([
        { status: 200, body: { emailAddress: 'x@example.test' } },
      ])
      const client = createGmailWatchClient({ getAccessToken: async () => 'token', fetchImpl })

      await expect(client.getProfile()).rejects.toThrow(/historyId/)
    })

    it('fetches a fresh token for every request (watch + getProfile each get their own call)', async () => {
      const { fetchImpl } = sequencedFetch([
        { status: 200, body: { emailAddress: 'x@example.test', historyId: 'h1' } },
        { status: 200, body: { historyId: 'h2', expiration: '1000' } },
      ])
      const getAccessToken = vi.fn(async () => 'token')
      const client = createGmailWatchClient({ getAccessToken, fetchImpl })

      await client.getProfile()
      await client.watch({ topicName: 't' })

      expect(getAccessToken).toHaveBeenCalledTimes(2)
    })
  })
})
