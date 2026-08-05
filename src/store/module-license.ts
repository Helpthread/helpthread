/**
 * `ModuleLicenseStore` — persistence for the operator's ONE marketplace
 * license key, encrypted at rest in a dedicated `module_license` table this
 * module expects but does not itself migrate (see "Migration dependency").
 *
 * ## Why this key gets its OWN encryption key
 *
 * `imap-credentials.ts` and `mailbox-tokens.ts` both encrypt under
 * `HELPTHREAD_TOKEN_ENC_KEY` because they protect the same class of secret —
 * credentials to the operator's own mail infrastructure — where a compromise
 * of one already implies the other is in the same blast radius. The
 * marketplace license key is a different class: it is what lets THIS engine
 * pull paid module artifacts from marketplace.helpthread.app
 * (`../modules/catalog/marketplace-client.ts`).
 *
 * So the composition root MUST decode a distinct key — e.g. from
 * `HELPTHREAD_MODULE_LICENSE_ENC_KEY`, via `token-crypto.ts`'s
 * `decodeEncryptionKey`, exactly as `createImapCredentialStore` does for its
 * own — and pass it to {@link createModuleLicenseStore}. A stolen
 * mailbox-token key must not also decrypt the license key, and vice versa;
 * two independent keys is what makes that true. The AES-256-GCM envelope
 * itself is reused from `token-crypto.ts`: the crypto is not class-specific,
 * only the key material is. One implementation, multiple independent keys,
 * never a second envelope format.
 *
 * ## What "encrypted at rest" actually buys
 *
 * It protects exactly one thing: a stolen COPY of the database — a leaked
 * backup, a misconfigured replica, a dump handed to the wrong party — does
 * not hand over a usable license key. The attacker gets ciphertext and needs
 * the separate `HELPTHREAD_MODULE_LICENSE_ENC_KEY`, held only in the running
 * engine's environment and never in the database.
 *
 * **It does NOT protect against a compromised running engine process.** That
 * process already holds the decryption key in memory and can call {@link
 * ModuleLicenseDecryptor.decryptForCatalogClient} itself, so an attacker with
 * code execution inside the engine reads the plaintext the same way the
 * catalog client does. The threat model here is a database dump, not a
 * compromised process; nothing should be read as a claim to the contrary.
 *
 * ## No read-back API returns plaintext
 *
 * {@link ModuleLicenseStore} — the interface an HTTP handler (a settings
 * screen, a "connect marketplace" endpoint) is meant to hold — exposes
 * `store`, `delete`, and `getDisplayInfo`: a one-way fingerprint plus the
 * key's last four characters, the same "enough to recognize, not enough to
 * reuse" convention as a stored payment card. None can produce the
 * plaintext.
 *
 * The plaintext-producing operation lives on a SEPARATE type, {@link
 * ModuleLicenseDecryptor}, returned by a separately named factory ({@link
 * createModuleLicenseDecryptor}). A handler wired only to
 * `ModuleLicenseStore` has no path to the plaintext by construction, not by
 * convention. Only `../modules/catalog/marketplace-client.ts` is meant to
 * hold a decryptor.
 *
 * ## Migration dependency (NOT included here)
 *
 * This module is scoped to store/decrypt logic only and adds no migration to
 * `src/db/migrate.ts`; `module_license` belongs at the next free id. It
 * expects a table shaped exactly like this:
 *
 * ```sql
 * CREATE TABLE module_license (
 *   -- A `boolean` primary key that must be `true` is a standard Postgres
 *   -- singleton-table trick: the CHECK forces the only legal value to
 *   -- `true`, and the PRIMARY KEY then forces at most one such row to ever
 *   -- exist — "one license, upsert only" is enforced by the schema itself,
 *   -- not by application discipline.
 *   id boolean PRIMARY KEY DEFAULT true CHECK (id),
 *   key_ciphertext bytea NOT NULL,
 *   fingerprint text NOT NULL,
 *   last_four text NOT NULL,
 *   created_at timestamptz NOT NULL DEFAULT now(),
 *   updated_at timestamptz NOT NULL DEFAULT now()
 * );
 * ```
 *
 * This module's own tests create that table directly rather than via
 * `migrate()`, so they exercise real PGlite SQL without reaching into a
 * migration file outside this module's scope. When the migration lands, its
 * SQL should match the block above so no drift accumulates between the
 * documented and the shipped schema.
 */

import { createHash } from 'node:crypto'
import type { Db, Queryable } from '../db/client.js'
import { decrypt, encrypt } from './token-crypto.js'

/** The one row `module_license` may ever hold — see the module doc's singleton-table trick. */
const SINGLETON_ID = true

/** Domain-separation prefix for {@link fingerprintOf} — so this hash can never be confused with, or collide in intent with, a hash of the same string computed for an unrelated purpose elsewhere in the codebase. */
const FINGERPRINT_DOMAIN_PREFIX = 'helpthread-module-license:'

/** How many hex characters of the domain-separated SHA-256 to surface for display — enough to distinguish one license from another at a glance, short enough that nobody mistakes it for the key itself. */
const FINGERPRINT_DISPLAY_CHARS = 16

/** How many trailing characters of the plaintext key are safe to store and display — the same "last four" convention stored payment cards use: enough to let an operator recognize which key is installed, nowhere near enough to reconstruct or brute-force the rest. */
const LAST_FOUR_CHARS = 4

/** A license key shorter than this cannot yield a meaningful last-four without exposing most or all of the key — refused outright rather than silently displaying more of the key than the "last four" contract promises. */
const MIN_LICENSE_KEY_LENGTH = 8

function fingerprintOf(licenseKey: string): string {
  return createHash('sha256')
    .update(FINGERPRINT_DOMAIN_PREFIX + licenseKey)
    .digest('hex')
    .slice(0, FINGERPRINT_DISPLAY_CHARS)
}

/** What an operator-facing screen may show for the installed license: enough to recognize it, never enough to reuse it. */
export interface LicenseDisplayInfo {
  fingerprint: string
  lastFour: string
  updatedAt: string
}

/**
 * The stored license ciphertext could not be decrypted — a wrong
 * `HELPTHREAD_MODULE_LICENSE_ENC_KEY`, or a tampered/corrupt row. Mirrors
 * `imap-credentials.ts`'s `ImapCredentialDecryptError` split: this is
 * distinct from a database fault so a caller can tell "the license is
 * unreadable" (a real, actionable state — prompt the operator to
 * re-enter it) from "the database had a transient problem" (retry).
 *
 * Carries no ciphertext and no key material.
 */
export class ModuleLicenseDecryptError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('module license could not be decrypted', options)
    this.name = 'ModuleLicenseDecryptError'
  }
}

/** Raw `module_license` row shape. */
interface ModuleLicenseRow {
  key_ciphertext: Uint8Array
  fingerprint: string
  last_four: string
  updated_at: string
}

/**
 * The operator-facing surface: store, delete, and display a fingerprint —
 * never the plaintext key. This is the ONLY module-license type any HTTP
 * handler should ever hold. See the module doc's "No read-back API"
 * section.
 */
export interface ModuleLicenseStore {
  /**
   * Insert or replace the operator's license key — encrypted with this
   * store's configured key before the write (module doc). An upsert
   * against the singleton row (`id = true`), so calling this again simply
   * replaces whatever license was previously installed.
   *
   * Throws if `licenseKey` is shorter than {@link MIN_LICENSE_KEY_LENGTH}
   * characters — too short to derive a "last four" that respects the
   * display contract above.
   *
   * NEVER log `licenseKey` or the ciphertext this method derives from it.
   */
  store(licenseKey: string, tx?: Queryable): Promise<void>

  /** Remove the installed license, if any. A no-op if none is installed. */
  delete(tx?: Queryable): Promise<void>

  /** The installed license's display info, or `null` if none is installed. Never returns or derives the plaintext key. */
  getDisplayInfo(): Promise<LicenseDisplayInfo | null>
}

/**
 * Internal-only decrypt boundary for the marketplace catalog client
 * (`../modules/catalog/marketplace-client.ts`) — the ONE caller allowed to
 * see the plaintext license key, because it is the one thing that needs to
 * put it on the wire (as the download endpoint's Bearer token). See the
 * module doc's "No read-back API" section for why this lives on a
 * separate type from {@link ModuleLicenseStore} rather than as another
 * method on it.
 *
 * DO NOT wire this into any HTTP handler, log statement, or error path.
 * The plaintext this returns must go straight into an `Authorization`
 * header and nowhere else.
 */
export interface ModuleLicenseDecryptor {
  /**
   * The installed license key, decrypted, or `null` if none is installed.
   * Throws {@link ModuleLicenseDecryptError} if the stored ciphertext
   * cannot be decrypted under the configured key.
   */
  decryptForCatalogClient(): Promise<string | null>
}

/**
 * Create a {@link ModuleLicenseStore} backed by `db`, encrypting with
 * `encryptionKey` — a 32-byte `Buffer`, decoded ONCE at the composition
 * root via `token-crypto.ts`'s `decodeEncryptionKey` from a key DISTINCT
 * from the mailbox-token key (module doc). Never hardcode a key or read an
 * env var inside this module.
 */
export function createModuleLicenseStore(db: Db, encryptionKey: Buffer): ModuleLicenseStore {
  return {
    async store(licenseKey, tx) {
      if (licenseKey.length < MIN_LICENSE_KEY_LENGTH) {
        throw new Error(
          `module-license: license key is ${licenseKey.length} characters, ` +
            `expected at least ${MIN_LICENSE_KEY_LENGTH}`,
        )
      }
      const keyCiphertext = encrypt(licenseKey, encryptionKey)
      const fingerprint = fingerprintOf(licenseKey)
      const lastFour = licenseKey.slice(-LAST_FOUR_CHARS)
      await (tx ?? db).query(
        `INSERT INTO module_license (id, key_ciphertext, fingerprint, last_four, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (id) DO UPDATE SET
           key_ciphertext = EXCLUDED.key_ciphertext,
           fingerprint = EXCLUDED.fingerprint,
           last_four = EXCLUDED.last_four,
           updated_at = now()`,
        [SINGLETON_ID, keyCiphertext, fingerprint, lastFour],
      )
    },

    async delete(tx) {
      await (tx ?? db).query('DELETE FROM module_license WHERE id = $1', [SINGLETON_ID])
    },

    async getDisplayInfo() {
      const rows = await db.query<
        Pick<ModuleLicenseRow, 'fingerprint' | 'last_four' | 'updated_at'>
      >('SELECT fingerprint, last_four, updated_at FROM module_license WHERE id = $1', [
        SINGLETON_ID,
      ])
      const row = rows[0]
      if (row === undefined) {
        return null
      }
      return { fingerprint: row.fingerprint, lastFour: row.last_four, updatedAt: row.updated_at }
    },
  }
}

/**
 * Create a {@link ModuleLicenseDecryptor} backed by `db`, decrypting with
 * `encryptionKey` — the SAME key passed to {@link createModuleLicenseStore}
 * for the same table (both read/write the same `module_license` singleton
 * row). See that type's doc for why this is a separate factory rather than
 * a method on `ModuleLicenseStore`, and the module doc for why this key is
 * distinct from the mailbox-token encryption key.
 */
export function createModuleLicenseDecryptor(
  db: Db,
  encryptionKey: Buffer,
): ModuleLicenseDecryptor {
  return {
    async decryptForCatalogClient() {
      const rows = await db.query<Pick<ModuleLicenseRow, 'key_ciphertext'>>(
        'SELECT key_ciphertext FROM module_license WHERE id = $1',
        [SINGLETON_ID],
      )
      const row = rows[0]
      if (row === undefined) {
        return null
      }
      try {
        return decrypt(row.key_ciphertext, encryptionKey)
      } catch (cause) {
        throw new ModuleLicenseDecryptError({ cause })
      }
    },
  }
}
