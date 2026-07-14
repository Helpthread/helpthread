/**
 * AES-256-GCM authenticated encryption for OAuth token ciphertext columns
 * (`mailbox_oauth_tokens.refresh_token_ciphertext` /
 * `access_token_ciphertext`, migration 010, `src/db/migrate.ts`).
 *
 * This is the ONLY place in the codebase that turns an OAuth bearer
 * credential into ciphertext or back — migration 010's doc comment is
 * explicit that the schema only reserves `bytea` columns and holds no
 * opinion on how they're encrypted ("HT-38 owns the encrypt/decrypt; this
 * migration only reserves the column"). This module is that opinion, and
 * `src/store/mailbox-tokens.ts` is its only caller.
 *
 * ## Wire format
 *
 * {@link encrypt} returns a single flat `Uint8Array`:
 *
 * ```
 * iv (12 bytes) || authTag (16 bytes) || ciphertext (N bytes)
 * ```
 *
 * 12 bytes is the NIST SP 800-38D–recommended (and Node's default) GCM
 * nonce size; 16 bytes is the full 128-bit GCM authentication tag, also
 * Node's default. Packing IV + tag + ciphertext into one value — rather than
 * three separate columns — keeps the ciphertext column shape migration 010
 * already committed to (one `bytea` per secret); the format lives entirely
 * inside this module's read/write pair and nowhere else needs to know it.
 *
 * ## Key handling
 *
 * The key is a 32-byte `Buffer` (AES-256), supplied by the CALLER on every
 * call — this module never reads an env var, never caches a key, and never
 * hardcodes one. The intended shape (per the HT-38 task): decode it ONCE
 * (base64, via {@link decodeEncryptionKey}) at the deploy-time composition
 * root — from `HELPTHREAD_TOKEN_ENC_KEY` or equivalent — and thread the
 * resulting `Buffer` down through `createMailboxTokenStore`
 * (`src/store/mailbox-tokens.ts`). This key is exactly as sensitive as the
 * mailbox tokens it protects (losing it makes every stored token permanently
 * undecryptable; leaking it defeats the point of encrypting the column at
 * all) and MUST come from a secret manager in any real deployment, never a
 * repo file or a hardcoded literal.
 *
 * ## Random IV per encryption
 *
 * {@link encrypt} draws a fresh CSPRNG IV (`node:crypto.randomBytes`) on
 * every call. GCM's confidentiality guarantee is void if the SAME (key, IV)
 * pair is ever reused for two different plaintexts, so every encryption of
 * the same token value — e.g. re-encrypting an unchanged refresh token
 * alongside a freshly-refreshed access token — produces different ciphertext
 * bytes. This is why {@link encrypt} is not, and must never be made,
 * deterministic.
 *
 * ## Tamper detection is the whole point
 *
 * {@link decrypt} calls `decipher.final()`, which THROWS if the GCM
 * authentication tag does not verify — a single flipped bit anywhere in the
 * IV, tag, or ciphertext (storage corruption, or a deliberate tamper attempt
 * against the raw DB row) is rejected outright, never silently "decrypted"
 * into garbage plaintext. This is authenticated encryption, not merely
 * confidentiality: a `decrypt` throw means "this ciphertext is not
 * trustworthy," and callers must not treat it as a soft/ignorable failure.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/** AES-256 key size in bytes. `aes-256-gcm` accepts nothing else. */
export const ENCRYPTION_KEY_BYTES = 32

/** GCM nonce (IV) size in bytes — NIST SP 800-38D's recommended size, and Node's default for `aes-256-gcm`. */
const IV_BYTES = 12

/** GCM authentication tag size in bytes — the full 128-bit tag, Node's default. */
const AUTH_TAG_BYTES = 16

/** Minimum valid {@link encrypt} output length: an IV and a tag, even for an empty plaintext. */
const MIN_CIPHERTEXT_BYTES = IV_BYTES + AUTH_TAG_BYTES

const ALGORITHM = 'aes-256-gcm'

/** Throw a clear, non-secret-leaking error unless `key` is exactly a {@link ENCRYPTION_KEY_BYTES}-byte `Buffer`. */
function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== ENCRYPTION_KEY_BYTES) {
    throw new Error(
      `token-crypto: encryption key must be a ${ENCRYPTION_KEY_BYTES}-byte Buffer (got ${
        Buffer.isBuffer(key) ? `${key.length} bytes` : typeof key
      })`,
    )
  }
}

/**
 * Encrypt `plaintext` under `key` (AES-256-GCM, fresh random 12-byte IV).
 * Returns `iv || authTag || ciphertext` as one `Uint8Array` — see the module
 * doc for the wire format and why the IV must be fresh on every call.
 */
export function encrypt(plaintext: string, key: Buffer): Uint8Array {
  assertKey(key)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return new Uint8Array(Buffer.concat([iv, authTag, ciphertext]))
}

/**
 * Decrypt `bytes` produced by {@link encrypt} under the SAME `key`. Verifies
 * the GCM authentication tag — throws if `bytes` is too short to even
 * contain an IV + tag, or if the tag does not match (wrong key, or the bytes
 * were corrupted/tampered with since encryption). Never returns unverified
 * plaintext.
 */
export function decrypt(bytes: Uint8Array, key: Buffer): string {
  assertKey(key)
  const buf = Buffer.from(bytes)
  if (buf.length < MIN_CIPHERTEXT_BYTES) {
    throw new Error(
      `token-crypto: ciphertext is ${buf.length} bytes, too short to contain a ${IV_BYTES}-byte IV + ${AUTH_TAG_BYTES}-byte auth tag`,
    )
  }
  const iv = buf.subarray(0, IV_BYTES)
  const authTag = buf.subarray(IV_BYTES, MIN_CIPHERTEXT_BYTES)
  const ciphertext = buf.subarray(MIN_CIPHERTEXT_BYTES)

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return plaintext.toString('utf8')
  } catch (cause) {
    // Never include the ciphertext or key material in the thrown message —
    // only the fact of the failure is safe/useful to surface.
    throw new Error(
      'token-crypto: decrypt failed — ciphertext is corrupted, tampered with, or was encrypted under a different key',
      { cause },
    )
  }
}

/**
 * Decode a base64-encoded encryption key (e.g. the `HELPTHREAD_TOKEN_ENC_KEY`
 * env var) into the `Buffer` {@link encrypt}/{@link decrypt} expect. Validates
 * the decoded length eagerly — meant to be called once at composition-root
 * startup, not lazily on the first token operation — so a misconfigured key
 * fails loudly at boot rather than on a mailbox's first connection attempt.
 */
export function decodeEncryptionKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64')
  if (key.length !== ENCRYPTION_KEY_BYTES) {
    throw new Error(
      `token-crypto: decoded encryption key is ${key.length} bytes, expected ${ENCRYPTION_KEY_BYTES} ` +
        `(base64-encode a ${ENCRYPTION_KEY_BYTES}-byte key, e.g. \`openssl rand -base64 32\`)`,
    )
  }
  return key
}
