import { describe, expect, it } from 'vitest'
import { createSupabaseStorageBlobStore, type SupabaseStorageBucket } from './index.js'

/** Records the last options `upload` was called with, for asserting upsert/contentType are forwarded. */
interface UploadCall {
  path: string
  body: Uint8Array
  options?: { contentType?: string; upsert?: boolean }
}

/** An in-memory fake of the narrow bucket-client slice the adapter uses, mirroring the SDK's `{ data, error }` convention. */
function fakeBucket(initial: Record<string, Uint8Array> = {}): {
  bucket: SupabaseStorageBucket
  store: Map<string, Uint8Array>
  uploads: UploadCall[]
} {
  const store = new Map(Object.entries(initial))
  const uploads: UploadCall[] = []
  const bucket: SupabaseStorageBucket = {
    async upload(path, body, options) {
      uploads.push({ path, body, options })
      store.set(path, body)
      return { data: { path }, error: null }
    },
    async download(path) {
      const data = store.get(path)
      if (data === undefined) return { data: null, error: { message: 'Object not found' } }
      // Copy into a fresh ArrayBuffer so the element satisfies the DOM lib's
      // BlobPart (a generic Uint8Array<ArrayBufferLike> does not).
      return { data: new Blob([new Uint8Array(data).buffer as ArrayBuffer]), error: null }
    },
    async createSignedUrl(path, expiresIn) {
      if (!store.has(path)) return { data: null, error: { message: 'Object not found' } }
      return {
        data: { signedUrl: `https://signed.example.test/${path}?exp=${expiresIn}` },
        error: null,
      }
    },
    async remove(paths) {
      for (const p of paths) store.delete(p)
      return { data: [], error: null }
    },
    async exists(path) {
      return { data: store.has(path), error: null }
    },
  }
  return { bucket, store, uploads }
}

describe('createSupabaseStorageBlobStore — round trips', () => {
  it('put then get returns the same bytes', async () => {
    const { bucket } = fakeBucket()
    const blob = createSupabaseStorageBlobStore({
      url: 'u',
      serviceRoleKey: 'k',
      bucket: 'b',
      bucketClient: bucket,
    })
    const bytes = new Uint8Array([1, 2, 3, 250, 0, 128])

    await blob.put('inbound/raw/mbox-1/msg-1', bytes, { contentType: 'message/rfc822' })
    const got = await blob.get('inbound/raw/mbox-1/msg-1')

    expect(Array.from(got)).toEqual(Array.from(bytes))
  })

  it('forwards upsert:true and contentType to the underlying upload (put is create-OR-overwrite)', async () => {
    const { bucket, uploads } = fakeBucket()
    const blob = createSupabaseStorageBlobStore({
      url: 'u',
      serviceRoleKey: 'k',
      bucket: 'b',
      bucketClient: bucket,
    })

    await blob.put('k1', new Uint8Array([9]), { contentType: 'application/octet-stream' })

    expect(uploads).toHaveLength(1)
    expect(uploads[0].options).toEqual({ upsert: true, contentType: 'application/octet-stream' })
  })

  it('get rejects for a missing key (BlobStore.get contract)', async () => {
    const { bucket } = fakeBucket()
    const blob = createSupabaseStorageBlobStore({
      url: 'u',
      serviceRoleKey: 'k',
      bucket: 'b',
      bucketClient: bucket,
    })
    await expect(blob.get('does-not-exist')).rejects.toThrow(/get failed/)
  })

  it('getSignedUrl returns the signed URL and forwards the expiry', async () => {
    const { bucket } = fakeBucket({ k1: new Uint8Array([1]) })
    const blob = createSupabaseStorageBlobStore({
      url: 'u',
      serviceRoleKey: 'k',
      bucket: 'b',
      bucketClient: bucket,
    })
    const url = await blob.getSignedUrl('k1', 300)
    expect(url).toBe('https://signed.example.test/k1?exp=300')
  })

  it('delete removes the object; a subsequent get rejects', async () => {
    const { bucket } = fakeBucket({ k1: new Uint8Array([1]) })
    const blob = createSupabaseStorageBlobStore({
      url: 'u',
      serviceRoleKey: 'k',
      bucket: 'b',
      bucketClient: bucket,
    })
    await blob.delete('k1')
    await expect(blob.get('k1')).rejects.toThrow()
  })

  it('exists reflects presence', async () => {
    const { bucket } = fakeBucket({ here: new Uint8Array([1]) })
    const blob = createSupabaseStorageBlobStore({
      url: 'u',
      serviceRoleKey: 'k',
      bucket: 'b',
      bucketClient: bucket,
    })
    expect(await blob.exists('here')).toBe(true)
    expect(await blob.exists('gone')).toBe(false)
  })
})

describe('createSupabaseStorageBlobStore — error propagation', () => {
  /** A bucket whose every method returns a Storage error, to prove the adapter surfaces (never swallows) them. */
  function erroringBucket(message: string): SupabaseStorageBucket {
    const err = { data: null, error: { message } }
    return {
      async upload() {
        return { data: null, error: { message } }
      },
      async download() {
        return err
      },
      async createSignedUrl() {
        return err
      },
      async remove() {
        return { data: null, error: { message } }
      },
      async exists() {
        return { data: false, error: { message } }
      },
    }
  }

  it('put surfaces an upload error (never a silent success)', async () => {
    const blob = createSupabaseStorageBlobStore({
      url: 'u',
      serviceRoleKey: 'k',
      bucket: 'b',
      bucketClient: erroringBucket('quota exceeded'),
    })
    await expect(blob.put('k', new Uint8Array([1]), { contentType: 'text/plain' })).rejects.toThrow(
      /put failed.*quota exceeded/,
    )
  })

  it('get surfaces a download infrastructure error (distinct from a plain missing object)', async () => {
    const blob = createSupabaseStorageBlobStore({
      url: 'u',
      serviceRoleKey: 'k',
      bucket: 'b',
      bucketClient: erroringBucket('storage 503'),
    })
    await expect(blob.get('k')).rejects.toThrow(/get failed.*storage 503/)
  })

  it('getSignedUrl surfaces a signing error rather than returning a bad URL', async () => {
    const blob = createSupabaseStorageBlobStore({
      url: 'u',
      serviceRoleKey: 'k',
      bucket: 'b',
      bucketClient: erroringBucket('signing key rotated'),
    })
    await expect(blob.getSignedUrl('k', 300)).rejects.toThrow(
      /getSignedUrl failed.*signing key rotated/,
    )
  })

  it('exists surfaces an infrastructure error rather than reporting false', async () => {
    const blob = createSupabaseStorageBlobStore({
      url: 'u',
      serviceRoleKey: 'k',
      bucket: 'b',
      bucketClient: erroringBucket('storage unreachable'),
    })
    await expect(blob.exists('k')).rejects.toThrow(/exists check failed.*storage unreachable/)
  })

  it('delete surfaces a genuine error (but the fake here proves the throw path)', async () => {
    const blob = createSupabaseStorageBlobStore({
      url: 'u',
      serviceRoleKey: 'k',
      bucket: 'b',
      bucketClient: erroringBucket('permission denied'),
    })
    await expect(blob.delete('k')).rejects.toThrow(/delete failed.*permission denied/)
  })
})
