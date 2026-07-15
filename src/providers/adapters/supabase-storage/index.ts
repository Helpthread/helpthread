/**
 * Supabase Storage `BlobStore` adapter (HT-43; CHARTER.md §4 names Supabase
 * Storage as the first blob adapter target). Implements the `BlobStore`
 * interface (`src/providers/blob.ts`) over a Supabase Storage bucket via
 * `@supabase/supabase-js`'s Storage client.
 *
 * Per `src/providers/README.md`'s adapter-boundary rule, this is wired in
 * ONLY at the composition root (`../../../composition/root.ts`) — engine code
 * (`src/mail/ingest.ts`, `src/mail/gmail-reconcile.ts`) only ever sees the
 * `BlobStore` interface type, never this module or the `@supabase/*` SDK.
 *
 * ## Private bucket, signed reads only
 *
 * The bucket MUST be private (runbook Part B3). `BlobStore`'s contract
 * (`src/providers/blob.ts`) is explicit that objects are never public: the
 * only read path this adapter exposes outward is {@link BlobStore.getSignedUrl},
 * a time-limited URL for one object. This adapter never configures the bucket
 * for public read and never mints a permanent public URL.
 *
 * ## Key namespacing is the caller's job
 *
 * A `key` is passed to the Storage API verbatim as the object path (its `/`
 * separators become Storage "folders", which is fine). Per `blob.ts`'s
 * key-namespacing contract, callers — not this adapter — are responsible for
 * choosing per-mailbox/per-conversation keys so one tenant's objects can't
 * collide with or be enumerated from another's; this adapter treats `key` as
 * an opaque string.
 *
 * ## The service_role key is a server-only secret
 *
 * The Supabase client is built with the `service_role` key, which bypasses
 * Row-Level Security and grants full Storage access — it must only ever live
 * server-side (the runbook is explicit). This adapter never logs it, and
 * `auth.persistSession`/`autoRefreshToken` are disabled: there is no browser
 * session to persist and no interactive user to refresh a token for, and a
 * background refresh timer would be a resource leak in a serverless function.
 */

import { createClient, type SupabaseClientOptions } from '@supabase/supabase-js'
import type { BlobStore } from '../../blob.js'

/**
 * The narrow slice of a Supabase Storage bucket client
 * (`SupabaseClient.storage.from(bucket)`) this adapter uses. Declared
 * structurally rather than importing the SDK's `StorageFileApi` type so a
 * test can pass a hand-rolled fake with no SDK client at all — the real
 * `.from(bucket)` result is structurally assignable to this. Every method
 * mirrors the SDK's `{ data, error }` result convention (an operation either
 * yields `data` or a non-null `error`, never throws for an expected failure).
 */
export interface SupabaseStorageBucket {
  upload(
    path: string,
    body: Uint8Array,
    options?: { contentType?: string; upsert?: boolean },
  ): Promise<{ data: unknown; error: { message: string } | null }>
  download(path: string): Promise<{ data: Blob | null; error: { message: string } | null }>
  createSignedUrl(
    path: string,
    expiresIn: number,
  ): Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }>
  remove(paths: string[]): Promise<{ data: unknown; error: { message: string } | null }>
  exists(path: string): Promise<{ data: boolean; error: { message: string } | null }>
}

/** Options for {@link createSupabaseStorageBlobStore}. */
export interface SupabaseStorageBlobStoreOptions {
  /** Supabase project URL (`SUPABASE_URL`). */
  url: string
  /** Supabase `service_role` key (`SUPABASE_SERVICE_ROLE_KEY`) — server-only secret. */
  serviceRoleKey: string
  /** The private Storage bucket name (`HELPTHREAD_BLOB_BUCKET`). */
  bucket: string
  /**
   * A pre-built bucket client, injected for tests so the adapter's own
   * mapping logic is exercised without a real Supabase client or network.
   * Omitted in production — the adapter builds one from `url`/`serviceRoleKey`/
   * `bucket`.
   */
  bucketClient?: SupabaseStorageBucket
}

/** Extract a safe, non-secret message from a Storage `{ error }` result. */
function errorMessage(error: { message: string } | null): string {
  return error?.message ?? 'unknown error'
}

/**
 * Build a `BlobStore` backed by a Supabase Storage bucket. See the module doc
 * for the private-bucket / signed-read / server-only-secret contract.
 */
export function createSupabaseStorageBlobStore(
  options: SupabaseStorageBlobStoreOptions,
): BlobStore {
  const bucket = options.bucketClient ?? buildBucketClient(options)

  return {
    async put(key, data, opts): Promise<void> {
      // upsert: true — `BlobStore.put` is "create OR overwrite"; without it
      // Supabase errors when an object already exists at the key.
      const { error } = await bucket.upload(key, data, {
        upsert: true,
        ...(opts.contentType !== undefined ? { contentType: opts.contentType } : {}),
      })
      if (error !== null) {
        throw new Error(
          `supabase-storage: put failed for key ${JSON.stringify(key)}: ${errorMessage(error)}`,
        )
      }
    },

    async get(key): Promise<Uint8Array> {
      const { data, error } = await bucket.download(key)
      if (error !== null || data === null) {
        // `BlobStore.get` rejects if no object exists at the key.
        throw new Error(
          `supabase-storage: get failed for key ${JSON.stringify(key)}: ${
            error !== null ? errorMessage(error) : 'no object at key'
          }`,
        )
      }
      return new Uint8Array(await data.arrayBuffer())
    },

    async getSignedUrl(key, expiresInSeconds): Promise<string> {
      const { data, error } = await bucket.createSignedUrl(key, expiresInSeconds)
      if (error !== null || data === null) {
        throw new Error(
          `supabase-storage: getSignedUrl failed for key ${JSON.stringify(key)}: ${
            error !== null ? errorMessage(error) : 'no signed URL returned'
          }`,
        )
      }
      return data.signedUrl
    },

    async delete(key): Promise<void> {
      // `BlobStore.delete` of a missing key is a no-op, not an error: Supabase
      // `remove` of a nonexistent path returns an empty result WITHOUT an
      // error, so only a genuine infrastructure error surfaces here.
      const { error } = await bucket.remove([key])
      if (error !== null) {
        throw new Error(
          `supabase-storage: delete failed for key ${JSON.stringify(key)}: ${errorMessage(error)}`,
        )
      }
    },

    async exists(key): Promise<boolean> {
      const { data, error } = await bucket.exists(key)
      if (error !== null) {
        throw new Error(
          `supabase-storage: exists check failed for key ${JSON.stringify(key)}: ${errorMessage(error)}`,
        )
      }
      return data
    },
  }
}

/** Construct the real Supabase Storage bucket client from connection config. See the module doc on the disabled auth options. */
function buildBucketClient(options: SupabaseStorageBlobStoreOptions): SupabaseStorageBucket {
  const clientOptions: SupabaseClientOptions<'public'> = {
    auth: { persistSession: false, autoRefreshToken: false },
  }
  const client = createClient(options.url, options.serviceRoleKey, clientOptions)
  return client.storage.from(options.bucket)
}
