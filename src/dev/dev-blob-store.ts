/**
 * A dev-only, in-memory `BlobStore` (`src/providers/blob.ts`) — attachment
 * bytes live in a `Map` for the life of the process and are gone on
 * restart. Mirrors `dev-sender.ts`'s role for `EmailSender` and
 * `dev-inbound-email.ts`'s for `InboundEmailProvider`: a real
 * implementation of the interface with no external dependency, so the
 * local harness can run the ingest pipeline without Supabase Storage
 * credentials.
 *
 * `getSignedUrl` returns a `dev-blob:` URL that nothing can actually
 * fetch. Nothing in the harness serves attachments, and a URL that
 * obviously is not a URL beats one that looks real and 404s.
 */

import type { BlobStore } from '../providers/blob.js'

export function createDevBlobStore(): BlobStore {
  const objects = new Map<string, Uint8Array>()

  return {
    async put(key, data) {
      objects.set(key, data)
    },
    async get(key) {
      const found = objects.get(key)
      if (found === undefined) {
        throw new Error(`dev blob store: no object at ${key}`)
      }
      return found
    },
    async getSignedUrl(key, expiresInSeconds) {
      return `dev-blob:${encodeURIComponent(key)}?expires_in=${expiresInSeconds}`
    },
    async delete(key) {
      objects.delete(key)
    },
    async exists(key) {
      return objects.has(key)
    },
  }
}
