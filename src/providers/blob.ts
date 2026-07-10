/**
 * `BlobStore` — the seam for attachment (and other binary object) storage.
 *
 * See `src/providers/README.md` for the pattern this fits into. First
 * adapter target (CHARTER.md §4): Supabase Storage.
 *
 * ## Key namespacing
 *
 * Callers are responsible for choosing `key` such that it is namespaced
 * per-tenant and, where applicable, per-conversation (e.g.
 * `<tenantId>/<conversationId>/<attachmentId>/<filename>`). `BlobStore`
 * implementations do not enforce or interpret key structure — they treat
 * `key` as an opaque string — but callers MUST namespace keys themselves
 * so that one tenant's or conversation's objects cannot collide with, or
 * be enumerated from, another's.
 *
 * ## Objects are never public
 *
 * A `BlobStore` never exposes objects at a stable public URL. The only
 * read path is `getSignedUrl`, which mints a time-limited URL for one
 * object. There is no method to make an object public, and adapters MUST
 * NOT configure their underlying bucket/container for public read access.
 */
export interface BlobStore {
  /**
   * Write `data` to `key`, creating or overwriting the object. Resolves
   * once the write is durable.
   */
  put(
    key: string,
    data: Uint8Array,
    opts: { contentType: string; contentLength?: number },
  ): Promise<void>;

  /**
   * Read the full contents of the object at `key`. Rejects if no object
   * exists at that key.
   */
  get(key: string): Promise<Uint8Array>;

  /**
   * Mint a time-limited, signed URL for reading the object at `key`. The
   * URL expires after `expiresInSeconds` and must not be usable
   * afterward. This is the only way callers outside the engine (e.g. a
   * browser rendering an attachment) ever read blob contents — attachments
   * are served via signed URLs, never a public path.
   */
  getSignedUrl(key: string, expiresInSeconds: number): Promise<string>;

  /**
   * Delete the object at `key`. Deleting a key that does not exist is a
   * no-op, not an error.
   */
  delete(key: string): Promise<void>;

  /** Whether an object currently exists at `key`. */
  exists(key: string): Promise<boolean>;
}
