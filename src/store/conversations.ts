/**
 * `ConversationStore` — persistence for conversations and their threads.
 *
 * A conversation has many threads; a thread is exactly ONE message
 * (inbound customer mail, or outbound agent/assistant mail). This is the
 * layer the inbound threading decision (`src/mail/thread.ts`,
 * `decideThreading`) lands on: a `{ kind: 'new' }` decision becomes a
 * {@link createConversation} call, a `{ kind: 'append', conversationId,
 * threadId }` decision becomes an {@link appendThread} call. The
 * `conversationId`/`threadId` pair minted here for a NEW conversation's
 * first outbound reply is exactly what later gets signed into that
 * reply's outbound `Message-ID` via `mintReplyMessageId`
 * (`src/mail/reply-token.ts`) — this module is the source of the ids that
 * token embeds, not the other way around.
 *
 * **Threading decisions still live in `src/mail/thread.ts`.** This module
 * does not decide *which* conversation a message belongs to — it only
 * persists the decision it's handed, and enforces what happens at the
 * storage layer when that target conversation is closed, deleted, or
 * missing. Keeping that line sharp matters: `decideThreading` is a pure
 * function with no I/O (specs/mail/threading.md §3) precisely so it stays
 * fixture-testable in isolation; this module is where the I/O — and the
 * storage-side policy below — actually happens.
 *
 * ## Resolving specs/mail/threading.md §5's open questions
 *
 * §5 left three related questions open pending an implementation to
 * resolve them. This module is that implementation, and the behavior
 * below is the resolution:
 *
 * - **A valid token to a CLOSED (or SPAM) conversation** → {@link appendThread}
 *   inserts the thread AND reopens the conversation (`status` to
 *   `'active'` — HT-26's four-state model; spec §4a). This is the Help
 *   Scout-like behavior the charter holds itself to (CHARTER.md §1): a
 *   customer replying to a resolved ticket should not silently fall on the
 *   floor or spawn a confusing duplicate — it reopens the same
 *   conversation, matching what an agent would expect to see. A `pending`
 *   conversation deliberately STAYS `pending` on append: `pending` is an
 *   Agent statement (spec §2's status semantics — "nothing sets it
 *   automatically in v1"), and silently flipping it on new mail would be
 *   exactly such an automatic set.
 * - **A valid token to a DELETED conversation** → {@link appendThread}
 *   inserts NOTHING and returns `{ ok: false, reason: 'deleted' }`. Unlike
 *   the closed case, a deleted conversation is not a live target to reopen
 *   — the caller (the mail-ingestion pipeline, not yet built) is expected
 *   to fall back to starting a fresh conversation for the message rather
 *   than resurrecting a deleted one, so the token's orphaned target is
 *   never silently dropped (CHARTER.md invariant #1: never lose or corrupt
 *   customer mail) but also never writes into a conversation an operator
 *   intentionally removed.
 * - **A valid token whose conversation doesn't exist at all** (never
 *   observed in practice — a token only exists if `createConversation`
 *   minted the ids it carries — but not something this layer can assume
 *   away, since inputs here are only as trustworthy as whatever called
 *   in) → {@link appendThread} returns `{ ok: false, reason: 'not-found' }`,
 *   the same "don't crash, don't silently drop, tell the caller" shape as
 *   the deleted case.
 *
 * All three are enforced inside a single transaction per {@link appendThread}
 * call — see its doc comment for the concurrency reasoning.
 *
 * ## Send idempotency + delivery leasing (HT-16)
 *
 * Migration 003 adds three outbound-only columns this module now exposes:
 * `idempotency_key`, `send_envelope`, and `claimed_until` (see the migration's
 * doc comment, `src/db/migrate.ts`, for the full schema-level rationale).
 * {@link appendThread} implements the "atomic get-or-insert" a caller-supplied
 * idempotency key needs: `INSERT ... ON CONFLICT (conversation_id,
 * idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING
 * *`, falling back to a `SELECT` of the pre-existing row when the insert is
 * skipped — both inside the SAME transaction that already takes the `FOR
 * UPDATE` lock on the conversation row, so a concurrent retry with the same
 * key is fully serialized against the original attempt rather than racing
 * it. {@link AppendResult}'s `created` flag tells the caller (`src/mail/
 * send.ts`) which case happened: `true` for a fresh insert (no key, or a key
 * never seen before), `false` when an existing row was found instead — at
 * which point `thread` carries that row's ALREADY-PERSISTED `messageId` and
 * `sendEnvelope`, which a retry must reuse verbatim rather than re-minting or
 * recomputing (see migration 003's doc comment on why the envelope is a
 * snapshot).
 *
 * {@link ConversationStore.claimThreadForDelivery} and
 * {@link ConversationStore.releaseThreadLease} are the lease pair a keyed
 * retry or the delivery worker (`src/mail/delivery-worker.ts`) uses to make
 * sure at most one in-flight attempt is ever sending a given outbound thread
 * at a time — see their own doc comments below.
 *
 * ## Transaction-scoped cores (HT-37)
 *
 * {@link createConversationInTx} and {@link appendThreadInTx} are the bodies
 * of {@link ConversationStore.createConversation}/{@link
 * ConversationStore.appendThread}, factored out to accept an
 * externally-supplied `tx: Queryable` instead of opening their own
 * `db.transaction(...)`. Both `ConversationStore` methods are now thin
 * wrappers around them (`db.transaction((tx) => createConversationInTx(tx,
 * input))`), so their behavior is unchanged. They are exported so a caller
 * that must commit this write atomically alongside a DIFFERENT store's write
 * — the inbound ingest pipeline's store-write + delivery-ledger `received →
 * stored` transition, specs/mail/inbound-ingestion.md §4 — can run both
 * inside ONE transaction it opens itself (`src/mail/ingest.ts`), rather than
 * this store committing independently. See that module's doc comment for why
 * this composition is otherwise impossible: a transaction opened by one
 * `db.transaction` call cannot be joined by a second, separate call.
 *
 * ## The actor model + draft lifecycle (HT-68; specs/plugins/substrate-v1.md
 * §2, migration 021 — "module" below means an out-of-process Helpthread
 * extension, never the legal "plugin exception" phrase CHARTER.md §7 uses)
 *
 * Every thread now carries `author_kind` (`'customer'|'agent'|'assistant'`)
 * plus nullable author identity. {@link insertThread} DERIVES it from
 * `direction` when the caller doesn't supply one explicitly — `inbound` →
 * `'customer'`, `outbound`/`note` → `'agent'` — the same "coerce a sensible
 * default, let an explicit value override it" shape `deliveryStatus` already
 * used before this change. This is why every EXISTING caller
 * (`src/mail/ingest.ts`, `src/mail/send.ts`, `src/api/conversations.ts`'s
 * notes handler) compiles and behaves correctly with zero edits: none of
 * them author assistant rows, so the default derivation is always right for
 * them. Only the NEW draft path ({@link ConversationStore.appendDraft})
 * passes `authorKind: 'assistant'` explicitly.
 *
 * A draft is an outbound thread with `draft_status = 'awaiting_review'` — no
 * `send_envelope`, no `message_id`, and critically `delivery_status = NULL`
 * (spec §2's CHECK: an unapproved draft must be structurally invisible to
 * the delivery worker). {@link insertThread}'s existing `deliveryStatus ??
 * 'pending'` outbound coercion is made draft-aware: an insert carrying
 * `draftStatus: 'awaiting_review'` (the only draft-status value ever
 * INSERTed fresh — `'approved'`/`'discarded'` only ever arrive via {@link
 * ConversationStore.resolveDraft}'s UPDATE, never a fresh row) skips the
 * `'pending'` coercion and leaves `delivery_status NULL`, exactly as spec §2
 * requires ("today it would silently arm a draft for delivery").
 *
 * {@link ConversationStore.appendDraft} reuses {@link appendThreadInTx} —
 * same not-found/deleted policy, same `FOR UPDATE` lock, same idempotency-
 * key get-or-insert — but {@link appendThreadInTx} gains an explicit
 * carve-out: a draft insert (`thread.draftStatus !== undefined`) causes NO
 * reopen and NO `updated_at` bump, stronger than even a note (spec §6: "an
 * assistant call can never directly cause outbound mail," and posting a
 * draft is not activity the way a note or a real reply is — approval is).
 * Every OTHER row's reopen/bump behavior is byte-identical to before this
 * change; only the new carve-out branch is added.
 */

import type { Db, Queryable, SqlValue } from '../db/client.js'
import { appendOutboxEventInTx } from './event-outbox.js'

/**
 * A snapshot of the mail headers an outbound reply was sent with:
 * recipients, subject, and the `References` chain. Persisted VERBATIM into
 * `threads.send_envelope` at insert and read back unchanged on every retry —
 * never recomputed from the conversation's current state (migration 003's
 * doc comment explains why: recomputing `references` could silently absorb
 * inbound mail that arrived between the original attempt and the retry).
 */
export interface SendEnvelope {
  to: string[]
  cc?: string[]
  subject: string
  references?: string[]
}

/** The actor kind that authored a thread (HT-68; specs/plugins/substrate-v1.md §2). `'customer'` for inbound mail, `'agent'` for human-authored outbound/notes, `'assistant'` for an AI-authored draft. */
export type ThreadAuthorKind = 'customer' | 'agent' | 'assistant'

/** A draft's lifecycle state (HT-68; spec §2) — `null` on every non-draft thread. */
export type DraftStatus = 'awaiting_review' | 'approved' | 'discarded'

/** One message to be persisted as a new thread — inbound customer mail, or outbound agent/assistant mail. */
export interface NewThread {
  /**
   * Caller-supplied thread id (a v4 UUID), for outbound threads whose id
   * must be known BEFORE the row is inserted — the outbound `Message-ID`
   * embeds a signed token over `{conversationId, threadId}`
   * (specs/mail/sending.md §2's "id/token knot"), so `mintReplyMessageId`
   * must run before this insert, not after it. When omitted, the database's
   * `gen_random_uuid()` default generates the id (the inbound path, which
   * has no such circularity).
   */
  id?: string
  /** `'note'` (v1.1, HT-28) is Agent-only context — never emailed, no delivery concept; see spec §4c. */
  direction: 'inbound' | 'outbound' | 'note'
  /**
   * The RFC `Message-ID` of this message, verbatim. For an inbound
   * message this is whatever the sending client wrote (or `null` if
   * absent). For an outbound message this is the reply token minted by
   * `mintReplyMessageId` (`src/mail/reply-token.ts`) — the value that,
   * signed, is what makes a future reply to this thread threadable at
   * all.
   */
  messageId: string | null
  /** The `In-Reply-To` header of this message, verbatim, if present. */
  inReplyTo?: string | null
  fromAddress: string
  bodyText?: string | null
  bodyHtml?: string | null
  /**
   * Outbox status for an OUTBOUND thread: `'pending'` immediately after
   * mint-and-persist, `'sent'`/`'failed'` once the send attempt resolves
   * (specs/mail/sending.md §3). Inbound threads leave this `null` (or
   * omitted) — delivery status is not a meaningful concept for mail we
   * received, and the column stays `NULL` for those rows.
   */
  deliveryStatus?: 'pending' | 'sent' | 'failed' | null
  /**
   * Caller-supplied dedup key for an OUTBOUND thread (HT-16;
   * `SendReplyInput.idempotencyKey`, `src/mail/send.ts`). Omitted (or
   * `undefined`) means "no dedup protection for this send" — see
   * {@link ConversationStore.appendThread}'s doc comment for what that
   * means at the storage layer. Never set for an inbound thread — migration
   * 003's CHECK constraint rejects that.
   */
  idempotencyKey?: string
  /**
   * A snapshot of this OUTBOUND thread's mail envelope, written once at
   * insert (see {@link SendEnvelope}'s doc comment for why it is a snapshot,
   * not a live derivation). Never set for an inbound thread.
   */
  sendEnvelope?: SendEnvelope
  /**
   * The actor kind that authored this thread (HT-68; spec §2). Omitted
   * (the common case — every pre-substrate caller) is DERIVED from
   * `direction` by {@link insertThread}: `inbound` → `'customer'`,
   * `outbound`/`note` → `'agent'`. Pass `'assistant'` explicitly only for
   * an assistant-authored row (a draft — see {@link
   * ConversationStore.appendDraft}); nothing in this codebase authors an
   * assistant note yet (spec §6, wave 2/3).
   */
  authorKind?: ThreadAuthorKind
  /** The acting Agent's id, when known (spec §3's acting-agent header). `null`/omitted is legal for an `'agent'`-authored row (the pre-HT-54 posture) — never set for `'customer'`/`'assistant'` rows, per {@link StoredThread.authorAgentId}'s CHECK. */
  authorAgentId?: string | null
  /** The authoring Assistant's id — REQUIRED (non-null) exactly when `authorKind: 'assistant'`, per the schema's `threads_author_identity_check`. */
  authorAssistantId?: string | null
  /**
   * Draft lifecycle (HT-68; spec §2) — legal only on `direction: 'outbound'`.
   * Omitted means "not a draft" (an ordinary send or note, the pre-substrate
   * shape). `'awaiting_review'` is the only value {@link insertThread} ever
   * INSERTs fresh; `'approved'`/`'discarded'` are UPDATE-only transitions
   * applied by {@link ConversationStore.resolveDraft}, never passed here.
   * Setting this makes {@link insertThread} leave `delivery_status NULL`
   * (see the module doc's "actor model + draft lifecycle" section) and
   * makes {@link appendThreadInTx} skip its reopen/`updated_at`-bump branch
   * entirely.
   */
  draftStatus?: DraftStatus
}

/** Input to {@link ConversationStore.createConversation}: a new conversation plus its first thread. */
export interface NewConversation {
  subject: string
  customerEmail: string
  firstMessage: NewThread
}

/** A thread as read back from storage — camelCase, timestamps as `Date`. */
export interface StoredThread {
  id: string
  conversationId: string
  direction: 'inbound' | 'outbound' | 'note'
  messageId: string | null
  inReplyTo: string | null
  fromAddress: string
  bodyText: string | null
  bodyHtml: string | null
  /** Outbox status — `null` for inbound threads, `'pending'|'sent'|'failed'` for outbound ones. See {@link NewThread.deliveryStatus}. */
  deliveryStatus: 'pending' | 'sent' | 'failed' | null
  /** Dedup key this OUTBOUND thread was sent with, or `null` if it was sent (or received) without one. See {@link NewThread.idempotencyKey}. */
  idempotencyKey: string | null
  /** This OUTBOUND thread's persisted envelope snapshot, or `null` for an inbound thread. See {@link SendEnvelope}. */
  sendEnvelope: SendEnvelope | null
  /**
   * The delivery lease: non-`null` while a `sendReply` retry or the
   * delivery worker is actively attempting this OUTBOUND thread, `null`
   * otherwise (never attempted, or the last attempt already released it).
   * See {@link ConversationStore.claimThreadForDelivery}.
   */
  claimedUntil: Date | null
  /**
   * Open tracking (v1.1, HT-32; spec §4g): the FIRST time the customer's
   * mail client fetched this OUTBOUND reply's tracking pixel — `null` until
   * then, and always `null` when the feature is off or for inbound/note
   * threads (schema-enforced, migration 008). Recorded idempotently by
   * {@link ConversationStore.recordThreadView}.
   */
  customerViewedAt: Date | null
  createdAt: Date
  /** The actor kind that authored this thread (HT-68; spec §2) — see {@link ThreadAuthorKind}. */
  authorKind: ThreadAuthorKind
  /** The acting Agent's id, or `null` — legal only alongside `authorKind: 'agent'`. See {@link NewThread.authorAgentId}. */
  authorAgentId: string | null
  /** The authoring Assistant's id, or `null` — non-null exactly when `authorKind: 'assistant'`. See {@link NewThread.authorAssistantId}. */
  authorAssistantId: string | null
  /** Draft lifecycle state, or `null` for a non-draft thread. See {@link NewThread.draftStatus}. */
  draftStatus: DraftStatus | null
  /** The Agent who approved or discarded this draft, or `null`. Set only alongside a resolved (`'approved'`/`'discarded'`) `draftStatus`. */
  approvedByAgentId: string | null
  /** When this draft was approved or discarded, or `null` while `'awaiting_review'` (or for a non-draft thread). */
  draftResolvedAt: Date | null
  /** Did the approving Agent change the body before sending (spec §2)? Always `false` for a non-draft thread. */
  draftEdited: boolean
}

/**
 * The four surfaceable conversation states (HT-26; specs/api/agent-inbox-v1.md
 * §2, v1.1). `active` is the working state — inbound mail creates
 * conversations `active` (the schema default, migration 004). `pending` and
 * `spam` are Agent statements; nothing sets either automatically. `deleted`
 * is deliberately NOT a member: it is a storage-internal state that is never
 * surfaced and never settable through {@link ConversationStore.setConversationStatus}.
 */
export type ConversationStatus = 'active' | 'pending' | 'closed' | 'spam'

/**
 * An inbox folder — the reading grain of
 * {@link ConversationStore.listConversations} (spec §3a's folder semantics):
 * `open` is the working folder and returns `active` + `pending` rows;
 * `closed` and `spam` return exactly that status. Individual statuses
 * (`active`/`pending`) are deliberately not folders.
 */
export type ConversationFolder = 'open' | 'closed' | 'spam'

/** A conversation as read back from storage — camelCase, timestamps as `Date`. */
export interface StoredConversation {
  id: string
  /**
   * Sequential per-deployment human-facing id (v1.1, HT-27; spec §2),
   * assigned by `conversation_number_seq` at insert (migration 005). Display
   * only — the uuid `id` remains the canonical key, and `number` is never
   * accepted as an identifier anywhere.
   */
  number: number
  subject: string
  customerEmail: string
  status: ConversationStatus | 'deleted'
  /** Short lowercase labels, replace-set via {@link ConversationStore.setConversationTags} (v1.1, HT-29). `[]` default. */
  tags: string[]
  /**
   * The assigned Agent's id, or `null` for Anyone (v1.1, HT-31; HT-54:
   * graduated from the single-operator `'me'` flag to a real Agent identity
   * — specs/auth/agents-and-auth.md §3.3, a coordinated breaking change with
   * `PUT /api/v1/conversations/{id}/assignee`'s new body shape).
   */
  assigneeAgentId: string | null
  createdAt: Date
  updatedAt: Date
}

/**
 * The outcome of {@link ConversationStore.appendThread}. Modeled as an
 * explicit discriminated result rather than throw/catch — a reply landing
 * on a deleted or nonexistent conversation is an expected, not exceptional,
 * outcome of running arbitrary inbound mail through the threading decision
 * (see the module doc's resolution of specs/mail/threading.md §5), and
 * callers should handle it as ordinary control flow.
 *
 * `reopened` (HT-69; specs/modules/substrate-v1.md §4's `conversation.
 * message_received` event, `reopened` field) is `true` exactly when THIS
 * call's `created && thread.draftStatus === undefined` reopen branch fired
 * (module doc: a genuinely new, non-draft, non-note thread landing on a
 * `closed`/`spam` conversation) — `false` for every other case, including a
 * replay (`created: false`) and a note/draft insert, which never reopen by
 * construction. Exposed so a caller that fires `conversation.message_
 * received` (the inbound ingest pipeline, `src/mail/ingest.ts`) can report
 * the spec's `reopened` fact without re-deriving it from a second read of
 * the conversation's pre-append status.
 */
export type AppendResult =
  | { ok: true; threadId: string; created: boolean; thread: StoredThread; reopened: boolean }
  | { ok: false; reason: 'not-found' | 'deleted' }

/**
 * Input to {@link ConversationStore.appendDraft} (HT-68; spec §6). Mirrors
 * `POST /api/v1/conversations/{id}/drafts`'s body — `bodyText`/`bodyHtml` —
 * plus the identity/idempotency fields the wave-2 API handler supplies.
 */
export interface NewDraft {
  /** The authoring Assistant's id — becomes `author_assistant_id` on the inserted row. */
  assistantId: string
  bodyText: string
  bodyHtml?: string | null
  /**
   * `From` address for the eventual outbound mail. Not yet meaningful at
   * draft time (the real envelope is derived at approval, spec §6 step 2) —
   * defaults to `''` when omitted; the caller is free to supply the
   * mailbox's address if known.
   */
  fromAddress?: string
  /**
   * Caller-supplied dedup key, UNPREFIXED — {@link
   * createConversationStore}'s `appendDraft` stores it as `` `draft:${key}` ``
   * (spec §6: "the engine stores it prefixed... so the shared
   * `(conversation_id, idempotency_key)` uniqueness namespace can never
   * replay a reply as a draft or vice versa"). Required — spec §6 states
   * `Idempotency-Key` is required on this endpoint.
   */
  idempotencyKey: string
}

/**
 * A keyset pagination cursor for {@link ConversationStore.listAwaitingDrafts}
 * — the `(createdAt, id)` of the last row a previous page returned. Same
 * shape/reasoning as {@link ConversationListCursor}, scoped to `threads.
 * created_at` (a draft's own creation moment) instead of a conversation's
 * `updated_at`.
 */
export interface ListAwaitingDraftsCursor {
  createdAt: Date
  id: string
}

/**
 * Input to {@link ConversationStore.resolveDraft} (HT-68/HT-70; spec §6):
 * either branch of `POST /api/v1/drafts/{threadId}/approve` or
 * `.../discard`. `resolvedByAgentId` is written to
 * `threads.approved_by_agent_id` on both branches (spec §2: that column is
 * the resolution audit field generally, not "approval" specifically).
 *
 * The `approve` branch takes `messageId`/`sendEnvelope` as OPAQUE inputs —
 * this store does NOT mint a reply token or derive an envelope (spec §6
 * steps 1-3 are the caller's job; `sendReply` cannot be reused for an
 * existing row, see spec §6's "what approval actually does").
 *
 * `edit` and `edited` are DELIBERATELY separate (HT-70 — the wave-1 shape
 * fused them into one `edit !== undefined` check, revised during the
 * approval-orchestration build): `edit`, when present, replaces the
 * draft's stored `body_text`/`body_html` (omitted fields left unchanged via
 * `COALESCE`) — but the caller (`src/mail/approve-draft.ts`) also uses it
 * to persist an HT-32 pixel-injected `bodyHtml` even when the approving
 * Agent submitted no edit at all. `edited` is therefore the ONLY signal for
 * spec §2's `draft_edited` audit column ("did the approving Agent change
 * the body before sending") — the caller computes it from whether an Agent
 * override was actually submitted, never from whether `edit` happens to be
 * present.
 */
export type ResolveDraftInput =
  | {
      action: 'approve'
      threadId: string
      resolvedByAgentId: string
      messageId: string
      sendEnvelope: SendEnvelope
      /**
       * The `In-Reply-To` header for the eventual outbound mail (HT-70) —
       * derived by the caller (`src/mail/approve-draft.ts`, the same
       * `deriveReplyHeaders` derivation `handleReply` uses) at APPROVAL
       * time, exactly like `sendEnvelope`. A draft's own `in_reply_to`
       * column is never set at draft-creation time (spec §6 scopes envelope
       * derivation to approval, not draft creation) — this is what makes
       * {@link StoredThread.inReplyTo} correct on the approved row, which
       * `attemptDeliveryOfClaimedThread` (`src/mail/send.ts`) reads
       * directly (never from `sendEnvelope`) when rebuilding the
       * `OutboundEmail` to send.
       */
      inReplyTo: string | null
      edit?: { bodyText?: string; bodyHtml?: string }
      /** Did the APPROVING AGENT explicitly change the body before sending — spec §2's `draft_edited` audit column. See this type's doc comment for why it is decoupled from `edit`'s presence. */
      edited: boolean
    }
  | {
      action: 'discard'
      threadId: string
      resolvedByAgentId: string
    }

/** Persistence operations for conversations and their threads. See the module doc for the storage-layer policy this implements. */
export interface ConversationStore {
  /**
   * Insert a new conversation and its first thread in ONE transaction:
   * atomic, so if the thread insert fails (e.g. a constraint violation) NO
   * conversation row survives — there is no such thing as a conversation
   * with zero threads as a persisted state.
   */
  createConversation(input: NewConversation): Promise<{ conversationId: string; threadId: string }>

  /**
   * Append `thread` to the conversation `conversationId`, applying the
   * closed/deleted/missing policy documented at the top of this module.
   * See that doc for the full behavior; summarized: missing → `not-found`,
   * deleted → `deleted` (nothing inserted), closed or spam → inserted AND
   * reopened to `active`, active/pending → inserted (pending stays pending
   * — see the module doc). A genuinely NEW row (`created: true`) also
   * bumps the conversation's `updated_at` (and reopens a closed/spam one,
   * per the above); a REPLAY that found an existing row instead (`created:
   * false`) touches the conversation row not at all — nothing new
   * happened, so nothing about the conversation should look like it did.
   *
   * ## The `idempotencyKey` case: atomic get-or-insert
   *
   * When `thread.idempotencyKey` is set, this is NOT a plain insert: it is
   * `INSERT ... ON CONFLICT (conversation_id, idempotency_key) WHERE
   * idempotency_key IS NOT NULL DO NOTHING RETURNING *`, and on a conflict
   * (0 rows — this exact key already exists on this conversation) a
   * `SELECT` of that pre-existing row, all inside the same transaction that
   * takes the `FOR UPDATE` lock on the conversation row above. That lock is
   * what makes this safe under concurrency: two callers racing with the
   * SAME key on the SAME conversation are serialized by it, so the second
   * one's `INSERT ... ON CONFLICT` always sees the first one's already-committed
   * row rather than racing its own insert against it. `created` tells the
   * caller which happened; `thread` is the row either way — for a replay,
   * `thread.messageId` and `thread.sendEnvelope` are the ORIGINAL attempt's,
   * never regenerated (see the module doc and migration 003's doc comment).
   *
   * When `thread.idempotencyKey` is omitted, this behaves exactly as before
   * HT-16: a plain insert, `created` is always `true`. This is the "no key ⇒
   * no dedup protection" contract `src/mail/send.ts`'s module doc names
   * explicitly — deliberate, and covered by a permanent regression test.
   */
  appendThread(conversationId: string, thread: NewThread): Promise<AppendResult>

  /**
   * Claim `threadId` for delivery: an atomic `UPDATE ... SET claimed_until =
   * now() + leaseMs WHERE id = $1 AND (claimed_until IS NULL OR
   * claimed_until < now()) AND delivery_status IN ('pending', 'failed')
   * RETURNING *`, scoped to outbound rows. Ordinary Postgres row-level
   * locking on the `UPDATE` is what makes "at most one claimant wins" hold
   * even under true concurrency (two overlapping calls for the same
   * `threadId`, from two processes or two `Promise.all`-ed calls in one) —
   * no advisory lock or explicit transaction is needed here, a single
   * `UPDATE` is already atomic with respect to itself.
   *
   * The `delivery_status` re-check is not redundant with the lease check: it
   * closes a TOCTOU where a row reaches `'sent'` (via `releaseThreadLease`,
   * which clears `claimed_until` in the SAME write that records the
   * outcome) between whenever a caller last observed it as `'pending'`/
   * `'failed'` and this claim call. Without it, that now-`'sent'` row still
   * has a free lease and would be claimed again, and the caller (a keyed
   * `sendReply` replay, or `src/mail/delivery-worker.ts`'s sweep) would
   * re-send an already-delivered message. Because both checks ride the same
   * row-locked `UPDATE`, a row can never be claimed once it is `'sent'` —
   * there is no window where the lease is free but the status check hasn't
   * "caught up" yet.
   *
   * Returns the freshly-claimed {@link StoredThread} (with the new
   * `claimedUntil`) on success, or `null` if the row is missing, not
   * outbound, already `'sent'`, or already claimed by someone else whose
   * lease hasn't expired — the caller (`src/mail/send.ts`'s retry path, or
   * `src/mail/delivery-worker.ts`'s sweep) must treat `null` as "don't send
   * this row right now" and, if it needs to distinguish "already delivered"
   * from "genuinely in flight," re-read the row's `delivery_status` itself
   * (see `sendReply`'s honest-409 handling).
   */
  claimThreadForDelivery(threadId: string, leaseMs: number): Promise<StoredThread | null>

  /**
   * Release `threadId`'s delivery lease and record the outcome in one
   * write: `UPDATE ... SET delivery_status = status, claimed_until = NULL
   * WHERE id = $1 AND direction = 'outbound' RETURNING id`, scoped and
   * throwing-on-zero-rows exactly like {@link setThreadDeliveryStatus} (see
   * its doc comment for why a silent no-op would be worse than a throw).
   * Kept as a SEPARATE method from `setThreadDeliveryStatus` — not a
   * parameter that also clears the lease — so the ORIGINAL (pre-HT-16,
   * no-idempotency-key) `sendReply` flow keeps calling
   * `setThreadDeliveryStatus` completely unchanged, byte-identical to
   * before this feature existed.
   */
  releaseThreadLease(threadId: string, status: 'sent' | 'failed'): Promise<void>

  /**
   * List OUTBOUND threads eligible for a delivery-worker retry sweep
   * (`src/mail/delivery-worker.ts`): `delivery_status = 'failed'`, OR
   * `delivery_status = 'pending'` AND `created_at` older than
   * `options.staleAfterMs` (a `'pending'` row younger than that may simply
   * be a normal send still in flight — not yet a candidate); AND the lease
   * is free (`claimed_until IS NULL OR claimed_until < now()`); AND
   * `send_envelope IS NOT NULL` — a row with no stored envelope (only
   * possible for a `threads` row written before migration 003 shipped)
   * cannot be safely retried: rebuilding its `to`/`subject`/`references`
   * from the conversation's CURRENT state would be exactly the silent
   * mail-semantics drift migration 003's envelope snapshot exists to
   * prevent, so such a row is left for manual/administrative handling
   * instead of a worker guessing at it. Ordered oldest-`created_at`-first,
   * capped at `options.batchSize` — the worker's own batch limit, not an
   * over-fetch-by-one pagination trick (there is no pagination here; a
   * skipped row is simply picked up on the NEXT sweep).
   */
  listDeliverableThreads(options: {
    staleAfterMs: number
    batchSize: number
  }): Promise<StoredThread[]>

  /**
   * Read one conversation with all of its threads, ordered oldest-first
   * (`created_at, id` — the `id` tiebreak makes ordering stable even for
   * threads inserted within the same timestamp tick). Returns `null` if no
   * conversation exists with that id.
   *
   * `options.includeDeleted` defaults to `true` (the row is returned whatever
   * its status). Pass `false` on a public read path (the Agent Inbox API):
   * a `deleted` conversation then returns `null` — decided by the
   * conversation lookup itself, BEFORE any threads are loaded — so a deleted
   * id is indistinguishable from a nonexistent one not just in the response
   * body but in the work done (no thread-count-dependent latency signal;
   * specs/api/agent-inbox-v1.md §5 "no existence leak").
   */
  getConversation(
    conversationId: string,
    options?: { includeDeleted?: boolean },
  ): Promise<(StoredConversation & { threads: StoredThread[] }) | null>

  /**
   * Update an outbound thread's outbox status in place (specs/mail/sending.md
   * §3's persist→send→mark ordering — this is the "mark" step). Callers
   * (`src/mail/send.ts`) invoke this AFTER the send attempt resolves, moving
   * a thread from `'pending'` to `'sent'` or `'failed'`. Not transactional
   * with anything else — this is a single-row status flip by primary key,
   * and the row was already durably persisted before the send was attempted.
   */
  setThreadDeliveryStatus(threadId: string, status: 'pending' | 'sent' | 'failed'): Promise<void>

  /**
   * List conversation summaries for the agent inbox — the read path behind
   * `GET /api/v1/conversations` (specs/api/agent-inbox-v1.md §3a). Ordered
   * `updated_at DESC, id DESC` (most-recently-active first, `id` as a
   * stable tiebreak for rows updated in the same instant — the same
   * stable-tiebreak pattern {@link getConversation} uses for threads). A
   * `deleted` conversation is NEVER returned, regardless of
   * `options.status` — see {@link ListConversationsOptions.status}.
   *
   * Returns exactly `options.limit` rows (or fewer, at the end of the
   * result set) — this method does no over-fetching of its own. Detecting
   * "is there a next page" by asking for `limit + 1` is the HTTP layer's
   * job (`src/api/conversations.ts`), which knows about `nextCursor`; this
   * store method only knows how to fetch a page.
   */
  listConversations(options: ListConversationsOptions): Promise<ConversationSummary[]>

  /**
   * Set a conversation's `status` to any {@link ConversationStatus} — the
   * write path behind `PATCH /api/v1/conversations/{id}`
   * (specs/api/agent-inbox-v1.md §4b, v1.1: all four values are settable
   * here). A single `UPDATE ... RETURNING` statement, scoped to `status <>
   * 'deleted'` so a deleted conversation is NOT reachable through this
   * method — the spec's explicit carve-out (§4b), and `'deleted'` itself is
   * not a {@link ConversationStatus}, so it is unsettable by type. Returns
   * the updated {@link ConversationSummary} on success, or `null` when no
   * row matched (the id doesn't exist, or names a `deleted` conversation) —
   * the same "missing or deleted, indistinguishable" shape
   * {@link getConversation}'s `includeDeleted: false` uses, so the HTTP
   * layer can map both to a single generic `404` without an extra existence
   * check.
   */
  setConversationStatus(
    conversationId: string,
    status: ConversationStatus,
  ): Promise<ConversationSummary | null>

  /**
   * Soft-delete a conversation — the write path behind `DELETE
   * /api/v1/conversations/{id}` (specs/api/agent-inbox-v1.md §4d, v1.1). A
   * single `UPDATE ... SET status = 'deleted' ... RETURNING`, scoped to
   * `status <> 'deleted'` so deleting twice reports the second call as a
   * miss. Returns `true` when a live conversation was deleted, `false` when
   * no row matched (never existed, or already deleted — indistinguishable,
   * per the API's no-existence-leak rule, §5).
   *
   * Soft, permanently: the row and its threads stay in storage (charter
   * invariant #1 — never lose customer mail) but nothing surfaces them
   * again. Every read/write path already treats `'deleted'` as nonexistent
   * — `getConversation({includeDeleted: false})`, `listConversations` (any
   * folder), `appendThread` (returns `{reason: 'deleted'}`; a reply token
   * minted against it starts a fresh conversation, threading.md §5), and
   * `setConversationStatus` (not reachable) — so this method only has to
   * flip the flag, not chase down consumers.
   */
  deleteConversation(conversationId: string): Promise<boolean>

  /**
   * Replace a conversation's whole tag set — the write path behind `PUT
   * /api/v1/conversations/{id}/tags` (specs/api/agent-inbox-v1.md §4e,
   * v1.1). Persists `tags` VERBATIM — normalization (trim, lowercase,
   * dedupe) is the HTTP layer's job, done before this call; the store does
   * not second-guess it. Does NOT bump `updated_at` (tagging is metadata,
   * not activity — spec §4e). Returns the updated summary, or `null` for a
   * missing/deleted conversation (same shape as
   * {@link ConversationStore.setConversationStatus}).
   */
  setConversationTags(conversationId: string, tags: string[]): Promise<ConversationSummary | null>

  /**
   * Assign a conversation to `assigneeAgentId`, or release it (`null`) —
   * the write path behind `PUT /api/v1/conversations/{id}/assignee`
   * (spec §4f, v1.1; graduated to a real Agent id by HT-54,
   * specs/auth/agents-and-auth.md §3.3/§10 — the new body shape is
   * `{ assigneeAgentId: uuid | null }`, breaking). The caller
   * (`src/api/conversations.ts`) is what validates `assigneeAgentId`
   * names an existing Agent before calling this — but that check-then-act
   * pair is not atomic (the Agent can be hard-deleted between the two), so
   * the `assignee_agent_id` FK (migration 018) is the real guard and its
   * violation is translated here to `'invalid_agent'` rather than escaping
   * as an uncontrolled error. Does NOT bump `updated_at` (spec §4f).
   * Returns the updated summary, `null` for a missing/deleted conversation,
   * or `'invalid_agent'` when the id no longer names an Agent.
   */
  setConversationAssignee(
    conversationId: string,
    assigneeAgentId: string | null,
  ): Promise<ConversationSummary | null | 'invalid_agent'>

  /**
   * Record that the customer viewed an outbound thread (open tracking, spec
   * §4g, v1.1) — FIRST view wins: a single `UPDATE ... SET customer_viewed_at
   * = now() WHERE id = $1 AND direction = 'outbound' AND customer_viewed_at
   * IS NULL`. Idempotent and deliberately SILENT on every miss (already
   * viewed, not outbound, no such thread): the pixel endpoint must respond
   * identically whatever happened (spec §4g's no-validity-leak), so there is
   * nothing useful for this method to report — and a throw would be worse.
   */
  recordThreadView(threadId: string): Promise<void>

  /**
   * Append an assistant-authored draft to `conversationId` (HT-68; spec §6):
   * `direction: 'outbound'`, `author_kind: 'assistant'`, `draft_status:
   * 'awaiting_review'`, `delivery_status NULL`. Reuses {@link
   * appendThreadInTx}'s not-found/deleted policy and idempotency-key
   * get-or-insert (the caller's key is stored `` `draft:${key}` `` — see
   * {@link NewDraft.idempotencyKey}), but causes NO reopen and NO
   * `updated_at` bump on the conversation, even if it is closed or spam
   * (see the module doc's "actor model + draft lifecycle" section) —
   * approval, not draft creation, is what later follows the normal
   * reply-reopen rule (spec §6).
   */
  appendDraft(conversationId: string, draft: NewDraft): Promise<AppendResult>

  /**
   * Cross-conversation review queue (HT-68; spec §6): every thread with
   * `direction = 'outbound' AND draft_status = 'awaiting_review'`, newest
   * first (`created_at DESC, id DESC`, keyset-paginated — same tiebreak
   * shape as {@link listConversations}), EXCLUDING any draft whose
   * conversation is soft-deleted (spec §6: "such drafts are unreachable
   * everywhere and simply never surface").
   */
  listAwaitingDrafts(options: {
    limit: number
    cursor?: ListAwaitingDraftsCursor
  }): Promise<StoredThread[]>

  /**
   * Resolve an awaiting-review draft — approve or discard (HT-68; spec §6).
   * See {@link ResolveDraftInput}'s doc comment for the opaque-input
   * contract on approval. Scoped to `direction = 'outbound' AND draft_status
   * = 'awaiting_review'`: returns `null` when `threadId` names no thread,
   * a non-outbound thread, or a draft that was already resolved (or was
   * never a draft) — the same "no such row in the state this method
   * requires" shape {@link setConversationStatus} uses for a missing/deleted
   * conversation. This method does not check conversation status (spam,
   * soft-deleted) — spec §6 assigns those refusals to the API layer, which
   * has the conversation already loaded.
   */
  resolveDraft(input: ResolveDraftInput): Promise<StoredThread | null>

  /**
   * Read one conversation (with all of its threads) by the id of ANY thread
   * within it (HT-70). The draft-approval path (`POST /api/v1/drafts/{threadId}/approve`
   * and `.../discard`) is handed only a `threadId` in the URL, never the
   * conversation id, so it needs this lookup to derive the reply envelope
   * (spec §6 step 2) and check the conversation's status (soft-deleted/spam)
   * before resolving. Same `includeDeleted` contract as {@link getConversation}
   * (default `true`; pass `false` on a public read path so a soft-deleted
   * conversation's thread is indistinguishable from a nonexistent one).
   * Returns `null` when `threadId` names no thread at all, or (with
   * `includeDeleted: false`) names a thread whose conversation is
   * soft-deleted.
   */
  getConversationByThreadId(
    threadId: string,
    options?: { includeDeleted?: boolean },
  ): Promise<(StoredConversation & { threads: StoredThread[] }) | null>
}

/**
 * Correlated subquery for a conversation's thread count, cast to `::int` so
 * PGlite/`pg` hand back a plain JS `number` rather than a `bigint`-shaped
 * string (Postgres's `count()` aggregate returns `bigint` by default,
 * which node-postgres-family drivers serialize as a string specifically to
 * avoid silently truncating a value bigger than `Number.MAX_SAFE_INTEGER`;
 * a per-conversation thread count will never approach that, so the `::int`
 * cast is safe and keeps the mapped {@link ConversationSummary} shape a
 * plain `number` like every other count in this codebase, e.g. the
 * `count(*)::int` precedent in `conversations.test.ts`).
 */
// HT-70 (spec §7): an unresolved or discarded draft is "not conversation
// content until sent" — both subqueries below exclude
// `draft_status IN ('awaiting_review','discarded')` rows. `IS DISTINCT FROM`
// (not `NOT IN`) on each value handles the three-valued-logic NULL trap
// correctly for every non-draft row (`draft_status IS NULL`) — the same
// guard this file's other draft-aware queries already use (e.g.
// `claimThreadForDelivery`), rather than a `NOT IN` that would silently
// exclude every non-draft row too (`NULL NOT IN (...)` is NULL, not TRUE).
const THREAD_COUNT_SUBQUERY =
  "(SELECT count(*) FROM threads t WHERE t.conversation_id = c.id AND t.draft_status IS DISTINCT FROM 'awaiting_review' AND t.draft_status IS DISTINCT FROM 'discarded')::int AS thread_count"

/**
 * Correlated subquery for a conversation's most recent thread body that has
 * text — the raw input to {@link derivePreview} (spec §2's `preview`
 * derivation: "the most recent thread with a non-null `bodyText`", any
 * direction). The whitespace collapse and truncation happen in JS
 * ({@link derivePreview}), not SQL — string munging is clearer and cheaper
 * to test there; SQL's only job is picking the right row.
 *
 * HT-70 (spec §7): also excludes `draft_status IN ('awaiting_review',
 * 'discarded')` rows — see {@link THREAD_COUNT_SUBQUERY}'s comment above.
 */
const LATEST_BODY_TEXT_SUBQUERY =
  "(SELECT t.body_text FROM threads t WHERE t.conversation_id = c.id AND t.body_text IS NOT NULL AND t.draft_status IS DISTINCT FROM 'awaiting_review' AND t.draft_status IS DISTINCT FROM 'discarded' ORDER BY t.created_at DESC, t.id DESC LIMIT 1) AS latest_body_text"

/** Maximum length of a derived `preview`, per spec §2 (v1.1, HT-27). */
const PREVIEW_MAX_LENGTH = 120

/**
 * The RETURNING clause every summary-shaped single-row UPDATE shares
 * (`setConversationStatus`/`setConversationTags`/`setConversationAssignee`) —
 * the same columns + correlated subqueries `listConversations` selects, so
 * all four paths map through {@link toConversationSummary} identically.
 * `idParam` is the placeholder (e.g. `'$2'`) already bound to the
 * conversation id in the caller's own query — always our own literal, never
 * caller data.
 */
function summaryReturningSql(idParam: string): string {
  return `RETURNING id, number, subject, customer_email, status, tags, assignee_agent_id, created_at, updated_at,
           (SELECT count(*)::int FROM threads WHERE conversation_id = ${idParam}) AS thread_count,
           (SELECT t.body_text FROM threads t WHERE t.conversation_id = ${idParam} AND t.body_text IS NOT NULL ORDER BY t.created_at DESC, t.id DESC LIMIT 1) AS latest_body_text`
}

/**
 * Is `err` the `conversations.assignee_agent_id` FK rejecting a
 * just-deleted Agent? Matched by SQLSTATE 23503 (foreign_key_violation)
 * when the driver surfaces it (`pg` and PGlite both set `code`), with the
 * constraint/message text as a fallback so a driver that doesn't is still
 * recognized. Total: any non-object input is simply "no".
 */
function isAssigneeFkViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const { code, message } = err as { code?: unknown; message?: unknown }
  if (code === '23503') return true
  return typeof message === 'string' && message.includes('assignee_agent_id')
}

/**
 * Derive a `ConversationSummary.preview` from a thread body (spec §2, v1.1):
 * whitespace collapsed to single spaces, trimmed, first
 * {@link PREVIEW_MAX_LENGTH} characters; `''` when there is no text at all.
 * Exported because the API's conversation-detail handler applies the SAME
 * rule to the threads it already holds (`src/api/conversations.ts`) — one
 * definition, two call sites.
 */
export function derivePreview(bodyText: string | null): string {
  if (bodyText === null) return ''
  return bodyText.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_MAX_LENGTH)
}

/**
 * A conversation summary as read back for the inbox list — the same
 * conversation fields as {@link StoredConversation} minus the internal
 * `deleted` status (never surfaced, per spec §3a) plus `threadCount`, a
 * count that would otherwise cost every list consumer a second round trip.
 * This is the store-layer shape `src/api/conversations.ts`'s list handler
 * serializes to the wire `ConversationSummary` (specs/api/agent-inbox-v1.md
 * §2) with `Date` → ISO string.
 */
export interface ConversationSummary {
  id: string
  /** Sequential per-deployment display id — see {@link StoredConversation.number}. */
  number: number
  subject: string
  customerEmail: string
  status: ConversationStatus
  threadCount: number
  /** Derived excerpt of the latest thread with text — see {@link derivePreview}. */
  preview: string
  /** Short lowercase labels — see {@link StoredConversation.tags}. */
  tags: string[]
  /** The assigned Agent's id, or `null` for Anyone — see {@link StoredConversation.assigneeAgentId}. */
  assigneeAgentId: string | null
  createdAt: Date
  updatedAt: Date
}

/**
 * A keyset pagination cursor: the `(updatedAt, id)` of the last row a
 * previous page returned. Paired with {@link ListConversationsOptions.status}
 * and the ordering `listConversations` commits to (`updated_at DESC, id
 * DESC`), this lets the next page ask for rows strictly AFTER this position
 * without an OFFSET — correct even if conversations are inserted/updated
 * between page fetches, which an offset-based scheme would skip or
 * duplicate under (specs/api/agent-inbox-v1.md §3a).
 */
export interface ConversationListCursor {
  updatedAt: Date
  id: string
}

/** Input to {@link ConversationStore.listConversations}. */
export interface ListConversationsOptions {
  /**
   * When given, filter to this FOLDER (spec §3a's folder semantics —
   * {@link ConversationFolder}): `'open'` returns `active` + `pending`
   * rows; `'closed'` and `'spam'` return exactly that status. When omitted,
   * return every conversation EXCEPT `deleted` — there is no filter value
   * that returns deleted rows; they are never surfaced by this call.
   */
  folder?: ConversationFolder
  /** Exact row count to fetch — callers (the HTTP layer) decide over-fetch-by-one for pagination detection themselves. */
  limit: number
  /** Keyset cursor: return rows ordered strictly after this position. Omit for the first page. */
  cursor?: ConversationListCursor
}

/** Raw `conversations` row shape, before mapping to {@link StoredConversation}. */
interface ConversationRow {
  id: string
  number: number
  subject: string
  customer_email: string
  status: string
  /** jsonb — arrives already-decoded (same driver behavior as `send_envelope`); this codebase only ever writes string arrays. */
  tags: unknown
  assignee_agent_id: string | null
  created_at: Date | string
  updated_at: Date | string
}

/**
 * Raw row shape for {@link createConversationStore}'s `listConversations`
 * query — a conversation row plus its correlated `thread_count`. Cast to
 * `::int` in the query itself (see `THREAD_COUNT_SUBQUERY`), and PGlite
 * (verified against the installed 0.5.4) returns Postgres `int4` as a plain
 * JS `number`, matching the existing `count(*)::int` precedent in
 * `conversations.test.ts`.
 */
interface ConversationSummaryRow extends ConversationRow {
  thread_count: number
  /** Raw latest thread body with text (see `LATEST_BODY_TEXT_SUBQUERY`) — `null` when no thread has text. */
  latest_body_text: string | null
}

/**
 * Raw `threads` row shape, before mapping to {@link StoredThread}. `send_envelope`
 * is typed `unknown` at this layer (not `SendEnvelope | null`) because it
 * arrives already-parsed from a `jsonb` column (PGlite, verified against the
 * installed 0.5.4, decodes `jsonb` to a plain JS value automatically — no
 * `JSON.parse` needed on read), but nothing here has actually validated its
 * shape; {@link toStoredThread} does the one authoritative cast, since this
 * codebase controls every writer of the column (see {@link insertThread}).
 */
interface ThreadRow {
  id: string
  conversation_id: string
  direction: string
  message_id: string | null
  in_reply_to: string | null
  from_address: string
  body_text: string | null
  body_html: string | null
  delivery_status: string | null
  idempotency_key: string | null
  send_envelope: unknown
  claimed_until: Date | string | null
  customer_viewed_at: Date | string | null
  created_at: Date | string
  author_kind: string
  author_agent_id: string | null
  author_assistant_id: string | null
  draft_status: string | null
  approved_by_agent_id: string | null
  draft_resolved_at: Date | string | null
  draft_edited: boolean
}

const THREAD_COLUMNS =
  'id, conversation_id, direction, message_id, in_reply_to, from_address, body_text, body_html, delivery_status, idempotency_key, send_envelope, claimed_until, customer_viewed_at, created_at, author_kind, author_agent_id, author_assistant_id, draft_status, approved_by_agent_id, draft_resolved_at, draft_edited'

/**
 * {@link THREAD_COLUMNS}, `t.`-qualified — needed only by {@link
 * ConversationStore.listAwaitingDrafts}'s query, which JOINs `threads` to
 * `conversations` (to exclude soft-deleted ones) and would otherwise be
 * ambiguous on the `id` column both tables share. Same qualification shape
 * `src/store/attachments.ts`'s `ATTACHMENT_COLUMNS` uses for its own join.
 */
const THREAD_COLUMNS_T = THREAD_COLUMNS.split(', ')
  .map((column) => `t.${column}`)
  .join(', ')

/**
 * Create a {@link ConversationStore} backed by `db`. Every operation opens
 * its own transaction (or, for the read-only {@link ConversationStore.getConversation},
 * plain queries) against `db` — this factory holds no state of its own.
 */
/**
 * Transaction-scoped core of {@link ConversationStore.createConversation} —
 * see the module doc's "Transaction-scoped cores (HT-37)" section for why
 * this is exported and accepts an external `tx` rather than opening its own
 * transaction.
 */
export async function createConversationInTx(
  tx: Queryable,
  input: NewConversation,
): Promise<{ conversationId: string; threadId: string }> {
  const [conversation] = await tx.query<{ id: string }>(
    'INSERT INTO conversations (subject, customer_email) VALUES ($1, $2) RETURNING id',
    [input.subject, input.customerEmail],
  )
  const { threadId } = await insertThread(tx, conversation.id, input.firstMessage)
  return { conversationId: conversation.id, threadId }
}

/**
 * Transaction-scoped core of {@link ConversationStore.appendThread} — see
 * that method's doc comment for the full closed/deleted/missing policy and
 * the idempotency-key get-or-insert, and the module doc's "Transaction-scoped
 * cores (HT-37)" section for why this is exported and accepts an external
 * `tx` rather than opening its own transaction.
 */
export async function appendThreadInTx(
  tx: Queryable,
  conversationId: string,
  thread: NewThread,
): Promise<AppendResult> {
  // FOR UPDATE: lock the conversation row for the life of this
  // transaction so a concurrent appendThread/delete against the same
  // conversation can't race between this status check and the insert
  // below (e.g. two replies arriving for the same closed conversation
  // at once should both observe-and-reopen deterministically, not
  // interleave into an inconsistent status). This same lock is what
  // makes the idempotency-key get-or-insert below safe under
  // concurrency — see the interface doc comment above.
  const rows = await tx.query<{ status: string }>(
    'SELECT status FROM conversations WHERE id = $1 FOR UPDATE',
    [conversationId],
  )
  const row = rows[0]
  if (row === undefined) {
    return { ok: false, reason: 'not-found' }
  }
  if (row.status === 'deleted') {
    return { ok: false, reason: 'deleted' }
  }

  const { threadId, created, row: threadRow } = await insertThread(tx, conversationId, thread)

  // A REPLAY (an existing row was found, nothing new inserted) touches
  // the conversation not at all — no reopen, no updated_at bump. Only
  // a genuinely new row counts as new activity on the conversation.
  // Reopen policy (spec §4a, v1.1): closed OR spam → active; pending
  // deliberately stays pending (see the module doc). A NOTE never
  // reopens anything (spec §4c — noting a closed conversation is not
  // the customer coming back), but it IS activity: updated_at bumps.
  //
  // HT-68 draft carve-out (spec §6): a draft insert (thread.draftStatus is
  // set — only ever 'awaiting_review' on a fresh insert, see insertThread's
  // doc comment) causes NEITHER a reopen NOR an updated_at bump, stronger
  // than even a note. This is checked FIRST, ahead of the direction check
  // below, so a draft row (direction: 'outbound') never falls into the
  // reopen/bump branch a plain outbound send would.
  //
  // HT-69: `reopened` (AppendResult's own field — see its doc comment)
  // mirrors this exact condition, computed here where the pre-append
  // `row.status` is still in scope, rather than asking a caller to
  // re-derive it from a second read.
  let reopened = false
  if (created && thread.draftStatus === undefined) {
    if ((row.status === 'closed' || row.status === 'spam') && thread.direction !== 'note') {
      reopened = true
      await tx.query(
        "UPDATE conversations SET status = 'active', updated_at = now() WHERE id = $1",
        [conversationId],
      )
    } else {
      await tx.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [conversationId])
    }
  }

  return { ok: true, threadId, created, thread: toStoredThread(threadRow), reopened }
}

export function createConversationStore(db: Db): ConversationStore {
  return {
    async createConversation(input) {
      return db.transaction((tx) => createConversationInTx(tx, input))
    },

    async appendThread(conversationId, thread) {
      return db.transaction((tx) => appendThreadInTx(tx, conversationId, thread))
    },

    async getConversation(conversationId, options) {
      const includeDeleted = options?.includeDeleted ?? true
      // When excluding deleted, filter in the CONVERSATION lookup so a deleted
      // row short-circuits to null here, before the threads query runs — no
      // work is done proportional to a deleted conversation's size.
      const conversationRows = await db.query<ConversationRow>(
        includeDeleted
          ? 'SELECT id, number, subject, customer_email, status, tags, assignee_agent_id, created_at, updated_at FROM conversations WHERE id = $1'
          : "SELECT id, number, subject, customer_email, status, tags, assignee_agent_id, created_at, updated_at FROM conversations WHERE id = $1 AND status <> 'deleted'",
        [conversationId],
      )
      const conversationRow = conversationRows[0]
      if (conversationRow === undefined) {
        return null
      }

      const threadRows = await db.query<ThreadRow>(
        `SELECT ${THREAD_COLUMNS} FROM threads WHERE conversation_id = $1 ORDER BY created_at, id`,
        [conversationId],
      )

      return {
        ...toStoredConversation(conversationRow),
        threads: threadRows.map(toStoredThread),
      }
    },

    async setThreadDeliveryStatus(threadId, status) {
      // Scope to outbound rows and confirm exactly one was updated. Without
      // `direction = 'outbound'` an inbound thread id could be marked
      // 'sent'/'failed' (violating the direction↔status invariant the schema
      // now enforces); without `RETURNING`, a wrong id or a row deleted
      // between send and mark would no-op silently and let a caller believe a
      // send was recorded when it wasn't. Both surface loudly instead.
      const updated = await db.query<{ id: string }>(
        "UPDATE threads SET delivery_status = $1 WHERE id = $2 AND direction = 'outbound' RETURNING id",
        [status, threadId],
      )
      if (updated.length === 0) {
        throw new Error(
          `setThreadDeliveryStatus: no outbound thread with id ${threadId} (wrong id, an inbound thread, or the row was deleted)`,
        )
      }
    },

    async claimThreadForDelivery(threadId, leaseMs) {
      // A single UPDATE is already atomic with respect to itself under
      // Postgres row-level locking: two overlapping calls for the same
      // threadId serialize on the row, and the second one's WHERE clause is
      // re-evaluated against the FIRST call's committed result — so at most
      // one of them ever sees `claimed_until IS NULL OR claimed_until <
      // now()` as true and gets a row back. No explicit transaction needed.
      //
      // `delivery_status IN ('pending', 'failed')` re-checks the OUTCOME on
      // the same locked row, not just the lease: a row that reached 'sent'
      // (via releaseThreadLease, which clears claimed_until in the same
      // write that records the status) between a caller last observing it
      // as pending/failed and this claim call must never be reclaimed —
      // that would resend an already-delivered message. See this method's
      // doc comment on the interface for the full TOCTOU it closes.
      // draft_status IS DISTINCT FROM 'awaiting_review' (HT-68; spec §2's
      // closing paragraph): belt on top of migration 021's CHECK, which
      // already makes an awaiting_review row with a non-null delivery_status
      // structurally unrepresentable — this guard is defense-in-depth, not
      // load-bearing on its own.
      const rows = await db.query<ThreadRow>(
        `UPDATE threads
         SET claimed_until = now() + ($2::double precision * interval '1 millisecond')
         WHERE id = $1 AND direction = 'outbound'
           AND (claimed_until IS NULL OR claimed_until < now())
           AND delivery_status IN ('pending', 'failed')
           AND draft_status IS DISTINCT FROM 'awaiting_review'
         RETURNING ${THREAD_COLUMNS}`,
        [threadId, leaseMs],
      )
      return rows.length === 0 ? null : toStoredThread(rows[0])
    },

    async releaseThreadLease(threadId, status) {
      // Same scoping and throw-on-zero-rows contract as setThreadDeliveryStatus
      // (see its doc comment) — kept as a separate method rather than a
      // parameter there so the pre-HT-16 no-idempotency-key send path keeps
      // calling setThreadDeliveryStatus completely unchanged.
      //
      // HT-69 (spec §4's `conversation.reply_sent`, spec §9 decision 3:
      // fired at 'sent' — truth, not intent): this is THE delivery-status
      // transition this ticket owns (this method is shared by `sendReply`'s
      // keyed-retry claim path AND `runDeliveryWorker`'s sweep,
      // `src/mail/send.ts`'s `attemptDeliveryOfClaimedThread` — the ONE
      // place either caller marks a claimed row `sent`/`failed`; the
      // no-idempotency-key `setThreadDeliveryStatus` path above is legacy
      // and unreachable from the real API, which requires `Idempotency-Key`
      // on every reply — see this ticket's report for the full reasoning).
      // Wrapped in a transaction so the status write and the outbox event
      // commit or roll back together (spec §4: "an event never fires for a
      // change that rolled back") — only on the 'sent' branch; 'failed'
      // fires nothing (not in spec §4's vocabulary).
      //
      // Soft-delete carve-out (review fix, HT-69): mail delivery is NOT
      // conversation-status-scoped — a thread claimed/leased before its
      // conversation was soft-deleted can still legitimately be delivered
      // and marked 'sent' here (charter invariant #1: never lose or corrupt
      // customer mail; the send already happened by the time this write
      // runs). But spec §4 is absolute: "No event of any type fires for a
      // soft-deleted conversation after its deletion" — the SAME
      // indistinguishable-from-nonexistent rule `listAwaitingDrafts`
      // already enforces for drafts via its `c.status <> 'deleted'` join.
      // The correlated `conversation_status` column below is read in the
      // SAME statement as the delivery-status write (no separate query, no
      // TOCTOU against a concurrent delete), and gates the event append —
      // never the delivery-status write itself, which always proceeds.
      await db.transaction(async (tx) => {
        const updated = await tx.query<ThreadRow & { conversation_status: string }>(
          `UPDATE threads SET delivery_status = $1, claimed_until = NULL
           WHERE id = $2 AND direction = 'outbound'
           RETURNING ${THREAD_COLUMNS},
             (SELECT status FROM conversations WHERE id = threads.conversation_id) AS conversation_status`,
          [status, threadId],
        )
        if (updated.length === 0) {
          throw new Error(
            `releaseThreadLease: no outbound thread with id ${threadId} (wrong id, an inbound thread, or the row was deleted)`,
          )
        }
        if (status === 'sent' && updated[0].conversation_status !== 'deleted') {
          const thread = toStoredThread(updated[0])
          await appendOutboxEventInTx(tx, {
            type: 'conversation.reply_sent',
            conversationId: thread.conversationId,
            data: { threadId: thread.id, authorKind: thread.authorKind },
          })
        }
      })
    },

    async listDeliverableThreads(options) {
      // draft_status IS DISTINCT FROM 'awaiting_review' — same
      // belt-on-top-of-the-CHECK guard as claimThreadForDelivery above
      // (HT-68; spec §2's closing paragraph).
      const rows = await db.query<ThreadRow>(
        `SELECT ${THREAD_COLUMNS} FROM threads
         WHERE direction = 'outbound'
           AND send_envelope IS NOT NULL
           AND (
             delivery_status = 'failed'
             OR (
               delivery_status = 'pending'
               AND created_at < now() - ($1::double precision * interval '1 millisecond')
             )
           )
           AND (claimed_until IS NULL OR claimed_until < now())
           AND draft_status IS DISTINCT FROM 'awaiting_review'
         ORDER BY created_at
         LIMIT $2`,
        [options.staleAfterMs, options.batchSize],
      )
      return rows.map(toStoredThread)
    },

    async listConversations(options) {
      // Built up as parameterized fragments — never string-interpolated
      // values, only structure (which fragment appears) is decided in JS.
      // See src/db/client.ts's module doc: parameterization is not optional.
      const conditions: string[] = []
      const params: SqlValue[] = []

      if (options.folder === 'open') {
        // The open FOLDER is two statuses (spec §3a's folder semantics):
        // active is the working state, and pending still counts as open
        // work. Both values are literals here, not caller data — the only
        // caller-influenced choice is WHICH fragment appears.
        conditions.push("c.status IN ('active', 'pending')")
      } else if (options.folder !== undefined) {
        params.push(options.folder)
        conditions.push(`c.status = $${params.length}`)
      } else {
        // No explicit filter: every status EXCEPT deleted. A `'deleted'`
        // conversation is never returned by any call to this method,
        // filtered or not (spec §3a) — this is the "not filtered" branch of
        // that rule, not an oversight.
        conditions.push("c.status <> 'deleted'")
      }

      if (options.cursor !== undefined) {
        // Postgres row-value comparison: `(a, b) < (x, y)` compares `a` to
        // `x` first and only consults `b`/`y` on a tie — exactly the
        // "updated_at DESC, id DESC" ordering this method commits to, in
        // one expression rather than a hand-rolled `a < x OR (a = x AND b <
        // y)`. Verified against PGlite's bundled Postgres 18, which
        // supports row-value comparison natively (a long-standing core
        // Postgres feature, not a version-specific behavior).
        params.push(options.cursor.updatedAt, options.cursor.id)
        conditions.push(`(c.updated_at, c.id) < ($${params.length - 1}, $${params.length})`)
      }

      params.push(options.limit)
      const limitParam = params.length

      const rows = await db.query<ConversationSummaryRow>(
        `SELECT c.id, c.number, c.subject, c.customer_email, c.status, c.tags, c.assignee_agent_id, c.created_at, c.updated_at, ${THREAD_COUNT_SUBQUERY}, ${LATEST_BODY_TEXT_SUBQUERY}
         FROM conversations c
         WHERE ${conditions.join(' AND ')}
         ORDER BY c.updated_at DESC, c.id DESC
         LIMIT $${limitParam}`,
        params,
      )

      return rows.map(toConversationSummary)
    },

    async setConversationStatus(conversationId, status) {
      // HT-69 (spec §4's `conversation.status_changed`, "status transition
      // among the four API states"): the `from`/`to` payload needs the
      // PRIOR status, which a plain UPDATE...RETURNING never exposes (only
      // the post-update row). `SELECT ... FOR UPDATE` first — mirroring
      // appendThreadInTx's own lock-then-act shape above — locks the row so
      // no concurrent write can change `status` between this read and the
      // UPDATE below, then the UPDATE and (when the status actually
      // changed) the outbox event commit together in the SAME transaction
      // (spec §4's transactional-outbox rule). `deleted` is excluded by
      // TYPE (`ConversationStatus` has no `'deleted'` member) — this method
      // can never be called with it, so "only the four API states fire
      // this event" holds by construction, not by a runtime check.
      return db.transaction(async (tx) => {
        const priorRows = await tx.query<{ status: string }>(
          'SELECT status FROM conversations WHERE id = $1 FOR UPDATE',
          [conversationId],
        )
        const prior = priorRows[0]
        if (prior === undefined || prior.status === 'deleted') return null

        const rows = await tx.query<ConversationSummaryRow>(
          `UPDATE conversations
           SET status = $1, updated_at = now()
           WHERE id = $2 AND status <> 'deleted'
           ${summaryReturningSql('$2')}`,
          [status, conversationId],
        )
        const row = rows[0]
        if (row === undefined) return null

        // "Transition" (spec §4) — a PATCH that re-asserts the SAME status
        // touches nothing new, so it fires no event (mirrors updated_at
        // still bumping either way — a no-op transition is idempotent
        // storage-wise but not event-worthy).
        if (prior.status !== status) {
          await appendOutboxEventInTx(tx, {
            type: 'conversation.status_changed',
            conversationId,
            data: { from: prior.status, to: status },
          })
        }
        return toConversationSummary(row)
      })
    },

    async setConversationTags(conversationId, tags) {
      // Persisted verbatim (the HTTP layer normalizes first — see the
      // interface doc); jsonb columns take caller-serialized JSON text, the
      // same convention as send_envelope. No updated_at bump: metadata, not
      // activity (spec §4e).
      //
      // HT-69 (spec §4's `conversation.tags_changed`, "fired when: tag set
      // replaced"): unconditional on every successful replace — unlike
      // status_changed's "transition" wording, this event names the ACTION
      // (a PUT that replaces the set), not a before/after diff, so it fires
      // even when the replacement happens to equal the prior set. Wrapped
      // in a transaction so the write and the event commit together (spec
      // §4's transactional-outbox rule).
      return db.transaction(async (tx) => {
        const rows = await tx.query<ConversationSummaryRow>(
          `UPDATE conversations
           SET tags = $1::jsonb
           WHERE id = $2 AND status <> 'deleted'
           ${summaryReturningSql('$2')}`,
          [JSON.stringify(tags), conversationId],
        )
        const row = rows[0]
        if (row === undefined) return null
        await appendOutboxEventInTx(tx, {
          type: 'conversation.tags_changed',
          conversationId,
          data: { tags },
        })
        return toConversationSummary(row)
      })
    },

    async setConversationAssignee(conversationId, assigneeAgentId) {
      // No updated_at bump: claiming is metadata, not activity (spec §4f).
      //
      // HT-69 (spec §4's `conversation.assignee_changed`, "assignee
      // set/cleared"): unconditional on every successful write, same
      // "names the action, not a before/after diff" reasoning as
      // setConversationTags above. Wrapped in a transaction so the write
      // and the event commit together (spec §4's transactional-outbox
      // rule); the FK-violation catch stays around the WHOLE transaction
      // call (not just the UPDATE) since a rolled-back transaction due to
      // the FK throw must not leave a dangling outbox row either — though
      // in practice the throw happens before appendOutboxEventInTx is ever
      // reached, since the UPDATE itself is what violates the FK.
      try {
        return await db.transaction(async (tx) => {
          const rows = await tx.query<ConversationSummaryRow>(
            `UPDATE conversations
             SET assignee_agent_id = $1
             WHERE id = $2 AND status <> 'deleted'
             ${summaryReturningSql('$2')}`,
            [assigneeAgentId, conversationId],
          )
          const row = rows[0]
          if (row === undefined) return null
          await appendOutboxEventInTx(tx, {
            type: 'conversation.assignee_changed',
            conversationId,
            data: { assigneeAgentId },
          })
          return toConversationSummary(row)
        })
      } catch (err) {
        // The Agent was deleted between the caller's existence check and this
        // UPDATE — the FK is the authoritative guard for that race (interface
        // doc above), and its violation is a caller-facing outcome, not a 500.
        if (isAssigneeFkViolation(err)) return 'invalid_agent'
        throw err
      }
    },

    async recordThreadView(threadId) {
      await db.query(
        `UPDATE threads SET customer_viewed_at = now()
         WHERE id = $1 AND direction = 'outbound' AND customer_viewed_at IS NULL`,
        [threadId],
      )
    },

    async appendDraft(conversationId, draft) {
      return db.transaction(async (tx) => {
        const result = await appendThreadInTx(tx, conversationId, {
          direction: 'outbound',
          messageId: null,
          fromAddress: draft.fromAddress ?? '',
          bodyText: draft.bodyText,
          bodyHtml: draft.bodyHtml ?? null,
          authorKind: 'assistant',
          authorAssistantId: draft.assistantId,
          draftStatus: 'awaiting_review',
          idempotencyKey: `draft:${draft.idempotencyKey}`,
        })
        // HT-70 (spec §4): fire draft.created ONLY for a genuinely NEW row
        // (result.created) — an idempotency-key replay must never re-fire an
        // event for the same logical draft, and a refused append
        // (not-found/deleted) has nothing to announce (spec: "no event... for
        // a soft-deleted conversation, including stranded drafts"). Written
        // in the SAME transaction as the insert (spec §4's transactional
        // outbox rule).
        if (result.ok && result.created) {
          await appendOutboxEventInTx(tx, {
            type: 'draft.created',
            conversationId,
            data: { threadId: result.threadId, assistantId: draft.assistantId },
          })
        }
        return result
      })
    },

    async listAwaitingDrafts(options) {
      const conditions = [
        "t.direction = 'outbound'",
        "t.draft_status = 'awaiting_review'",
        "c.status <> 'deleted'",
      ]
      const params: SqlValue[] = []
      if (options.cursor !== undefined) {
        params.push(options.cursor.createdAt, options.cursor.id)
        conditions.push(`(t.created_at, t.id) < ($${params.length - 1}, $${params.length})`)
      }
      params.push(options.limit)

      const rows = await db.query<ThreadRow>(
        `SELECT ${THREAD_COLUMNS_T} FROM threads t
         JOIN conversations c ON c.id = t.conversation_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY t.created_at DESC, t.id DESC
         LIMIT $${params.length}`,
        params,
      )
      return rows.map(toStoredThread)
    },

    async resolveDraft(input) {
      return db.transaction(async (tx) => {
        if (input.action === 'discard') {
          const rows = await tx.query<ThreadRow>(
            `UPDATE threads
             SET draft_status = 'discarded', approved_by_agent_id = $2, draft_resolved_at = now()
             WHERE id = $1 AND direction = 'outbound' AND draft_status = 'awaiting_review'
             RETURNING ${THREAD_COLUMNS}`,
            [input.threadId, input.resolvedByAgentId],
          )
          const row = rows[0]
          if (row === undefined) return null
          // HT-70 (spec §4): draft.resolved, in the SAME transaction as the
          // write. No event for a row this UPDATE didn't touch (see above).
          await appendOutboxEventInTx(tx, {
            type: 'draft.resolved',
            conversationId: row.conversation_id,
            data: { threadId: row.id, resolution: 'discarded', edited: false },
          })
          return toStoredThread(row)
        }

        // approve (spec §6 step 4): writes the caller-derived envelope
        // snapshot + message id, flips draft_status → 'approved' and
        // delivery_status → 'pending' in the SAME statement (so the row is
        // NEVER observably in a state where draft_status is 'approved' but
        // delivery_status is still NULL, or vice versa), and records the
        // approve-with-edits audit fields. `input.edited` (HT-70) is the
        // ONLY signal for draft_edited — see ResolveDraftInput's doc comment
        // for why it is no longer inferred from `edit`'s presence.
        const rows = await tx.query<ThreadRow>(
          `UPDATE threads
           SET message_id = $2,
               send_envelope = $3::jsonb,
               in_reply_to = $8,
               draft_status = 'approved',
               delivery_status = 'pending',
               approved_by_agent_id = $4,
               draft_resolved_at = now(),
               draft_edited = $5,
               body_text = COALESCE($6, body_text),
               body_html = COALESCE($7, body_html)
           WHERE id = $1 AND direction = 'outbound' AND draft_status = 'awaiting_review'
           RETURNING ${THREAD_COLUMNS}`,
          [
            input.threadId,
            input.messageId,
            JSON.stringify(input.sendEnvelope),
            input.resolvedByAgentId,
            input.edited,
            input.edit?.bodyText ?? null,
            input.edit?.bodyHtml ?? null,
            input.inReplyTo,
          ],
        )
        const row = rows[0]
        if (row === undefined) return null
        await appendOutboxEventInTx(tx, {
          type: 'draft.resolved',
          conversationId: row.conversation_id,
          data: { threadId: row.id, resolution: 'approved', edited: input.edited },
        })
        return toStoredThread(row)
      })
    },

    /**
     * HT-70: see the interface doc comment. A plain join-then-select, not a
     * transaction — this is a read.
     */
    async getConversationByThreadId(threadId, options) {
      const includeDeleted = options?.includeDeleted ?? true
      const conversationRows = await db.query<ConversationRow>(
        includeDeleted
          ? `SELECT c.id, c.number, c.subject, c.customer_email, c.status, c.tags, c.assignee_agent_id, c.created_at, c.updated_at
             FROM conversations c JOIN threads t ON t.conversation_id = c.id
             WHERE t.id = $1`
          : `SELECT c.id, c.number, c.subject, c.customer_email, c.status, c.tags, c.assignee_agent_id, c.created_at, c.updated_at
             FROM conversations c JOIN threads t ON t.conversation_id = c.id
             WHERE t.id = $1 AND c.status <> 'deleted'`,
        [threadId],
      )
      const conversationRow = conversationRows[0]
      if (conversationRow === undefined) {
        return null
      }

      const threadRows = await db.query<ThreadRow>(
        `SELECT ${THREAD_COLUMNS} FROM threads WHERE conversation_id = $1 ORDER BY created_at, id`,
        [conversationRow.id],
      )

      return {
        ...toStoredConversation(conversationRow),
        threads: threadRows.map(toStoredThread),
      }
    },

    async deleteConversation(conversationId) {
      // No updated_at bump: a deleted conversation is never surfaced again,
      // so its sort key is meaningless — and leaving it untouched keeps the
      // row an exact record of its last LIVE activity (charter invariant #1:
      // storage keeps the mail; only visibility changes).
      const rows = await db.query<{ id: string }>(
        `UPDATE conversations SET status = 'deleted' WHERE id = $1 AND status <> 'deleted' RETURNING id`,
        [conversationId],
      )
      return rows.length === 1
    },
  }
}

/**
 * Shared insert used by both `createConversation`'s first thread and
 * `appendThread`.
 *
 * When `thread.id` is supplied (the outbound-send path, specs/mail/sending.md
 * §2), the `id` column is set explicitly to that caller-generated UUID. When
 * omitted (the inbound path), the `id` column is left out of the INSERT
 * entirely so the schema's `gen_random_uuid()` default fires — passing an
 * explicit `id` in every case would either require the caller to always
 * generate one (defeating the point of a DB default) or special-case a
 * `null`/`undefined` id column value, which is not what "no id supplied"
 * means here.
 *
 * ## The idempotency-key get-or-insert (HT-16)
 *
 * The INSERT always carries `ON CONFLICT (conversation_id, idempotency_key)
 * WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING <columns>` — this is
 * harmless and never triggers when `thread.idempotencyKey` is omitted (a
 * `NULL` key can never collide with the partial unique index; see migration
 * 003's doc comment), which is exactly why the no-key path needs no separate
 * code path here to stay byte-identical to pre-HT-16 behavior. When a key IS
 * given and the insert is skipped because that `(conversation_id,
 * idempotency_key)` pair already exists, the `RETURNING` clause comes back
 * empty and this function falls back to a `SELECT` of that pre-existing row.
 * The caller (`appendThread`) is what wraps this in the transaction holding
 * the conversation row's `FOR UPDATE` lock, which is what makes the
 * conflict-then-select sequence race-free — see that method's doc comment.
 */
async function insertThread(
  tx: Queryable,
  conversationId: string,
  thread: NewThread,
): Promise<{ threadId: string; created: boolean; row: ThreadRow }> {
  // Derive author_kind from direction when the caller doesn't supply one
  // explicitly (HT-68; spec §2) — same "sensible default, explicit value
  // overrides it" shape as deliveryStatus below. inbound → customer,
  // outbound/note → agent; only the draft path passes 'assistant' itself.
  const authorKind: ThreadAuthorKind =
    thread.authorKind ?? (thread.direction === 'inbound' ? 'customer' : 'agent')
  const authorAgentId = thread.authorAgentId ?? null
  const authorAssistantId = thread.authorAssistantId ?? null
  const draftStatus = thread.draftStatus ?? null

  // Derive delivery_status from direction so the row always satisfies the
  // schema's direction↔status CHECK (migration 002): an outbound thread
  // defaults to 'pending' (its outbox starting state) unless the caller set a
  // status; an inbound thread is forced to NULL regardless of any status
  // passed, since delivery status is meaningless for received mail.
  //
  // HT-68 draft-aware carve-out (spec §2): a fresh draft insert
  // (draftStatus === 'awaiting_review', the only draft_status value ever
  // INSERTed rather than reached via resolveDraft's UPDATE) must NOT be
  // coerced to 'pending' — that would silently arm an unapproved draft for
  // the delivery worker, exactly the illegal state migration 021's CHECK
  // forbids. 'discarded' is included in the same guard for symmetry (the
  // schema forbids a non-null delivery_status alongside it too), even
  // though nothing in this codebase inserts a fresh 'discarded' row today.
  const isUnresolvedDraftInsert = draftStatus === 'awaiting_review' || draftStatus === 'discarded'
  const deliveryStatus =
    thread.direction === 'outbound'
      ? isUnresolvedDraftInsert
        ? null
        : (thread.deliveryStatus ?? 'pending')
      : null
  const idempotencyKey = thread.idempotencyKey ?? null
  // jsonb columns take a caller-serialized string, per src/db/client.ts's
  // module doc — `SqlValue` deliberately has no "plain object" member, so
  // this is the one place a `SendEnvelope` is turned into JSON text.
  const sendEnvelopeJson =
    thread.sendEnvelope !== undefined ? JSON.stringify(thread.sendEnvelope) : null

  const rows =
    thread.id !== undefined
      ? await tx.query<ThreadRow>(
          `INSERT INTO threads (id, conversation_id, direction, message_id, in_reply_to, from_address, body_text, body_html, delivery_status, idempotency_key, send_envelope, author_kind, author_agent_id, author_assistant_id, draft_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
           ON CONFLICT (conversation_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
           RETURNING ${THREAD_COLUMNS}`,
          [
            thread.id,
            conversationId,
            thread.direction,
            thread.messageId,
            thread.inReplyTo ?? null,
            thread.fromAddress,
            thread.bodyText ?? null,
            thread.bodyHtml ?? null,
            deliveryStatus,
            idempotencyKey,
            sendEnvelopeJson,
            authorKind,
            authorAgentId,
            authorAssistantId,
            draftStatus,
          ],
        )
      : await tx.query<ThreadRow>(
          `INSERT INTO threads (conversation_id, direction, message_id, in_reply_to, from_address, body_text, body_html, delivery_status, idempotency_key, send_envelope, author_kind, author_agent_id, author_assistant_id, draft_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           ON CONFLICT (conversation_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
           RETURNING ${THREAD_COLUMNS}`,
          [
            conversationId,
            thread.direction,
            thread.messageId,
            thread.inReplyTo ?? null,
            thread.fromAddress,
            thread.bodyText ?? null,
            thread.bodyHtml ?? null,
            deliveryStatus,
            idempotencyKey,
            sendEnvelopeJson,
            authorKind,
            authorAgentId,
            authorAssistantId,
            draftStatus,
          ],
        )

  if (rows.length === 1) {
    return { threadId: rows[0].id, created: true, row: rows[0] }
  }

  // Conflict: DO NOTHING skipped the insert, which is only possible when
  // idempotencyKey is non-null (see the doc comment above) — fetch the row
  // that already holds this (conversationId, idempotencyKey) pair.
  const existing = await tx.query<ThreadRow>(
    `SELECT ${THREAD_COLUMNS} FROM threads WHERE conversation_id = $1 AND idempotency_key = $2`,
    [conversationId, idempotencyKey],
  )
  const existingRow = existing[0]
  if (existingRow === undefined) {
    // Structurally unreachable: ON CONFLICT only fires against a row that
    // satisfies this exact WHERE, inside the same transaction. Thrown rather
    // than silently returning a made-up result if it ever did happen.
    throw new Error(
      `insertThread: ON CONFLICT DO NOTHING skipped the insert but no existing row was found for conversation ${conversationId}, idempotency key ${idempotencyKey}`,
    )
  }
  return { threadId: existingRow.id, created: false, row: existingRow }
}

/**
 * Coerce a `timestamptz` column value into a `Date`. PGlite (verified
 * against the installed 0.5.4) already parses `timestamptz` results into
 * genuine `Date` instances, so `value instanceof Date` is the common case
 * in practice — but this stays defensive against a future `Db`
 * implementation (e.g. a Supabase/`pg` connection configured with a
 * different type-parser setup) that hands back an ISO-8601 string instead,
 * since `Db`/`Queryable` promise no more than "SQL in, rows out" about
 * value types.
 */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

function toStoredConversation(row: ConversationRow): StoredConversation {
  return {
    id: row.id,
    number: row.number,
    subject: row.subject,
    customerEmail: row.customer_email,
    status: row.status as StoredConversation['status'],
    // Cast, not parsed — same reasoning as send_envelope in toStoredThread:
    // this codebase is the only writer (always a JSON string array), and the
    // jsonb arrives already decoded.
    tags: row.tags as string[],
    assigneeAgentId: row.assignee_agent_id,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  }
}

/**
 * Map a {@link ConversationSummaryRow} to the wire-adjacent
 * {@link ConversationSummary} shape. The `status` cast is safe on the same
 * grounds as {@link toStoredConversation}'s: `listConversations`'s own WHERE
 * clause (see above) never lets a `'deleted'` row reach this mapper, so the
 * narrower {@link ConversationStatus} union always holds in practice even
 * though the column itself is untyped `text` at the SQL level.
 */
function toConversationSummary(row: ConversationSummaryRow): ConversationSummary {
  return {
    id: row.id,
    number: row.number,
    subject: row.subject,
    customerEmail: row.customer_email,
    status: row.status as ConversationSummary['status'],
    threadCount: row.thread_count,
    preview: derivePreview(row.latest_body_text),
    tags: row.tags as string[],
    assigneeAgentId: row.assignee_agent_id,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  }
}

function toStoredThread(row: ThreadRow): StoredThread {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    direction: row.direction as StoredThread['direction'],
    messageId: row.message_id,
    inReplyTo: row.in_reply_to,
    fromAddress: row.from_address,
    bodyText: row.body_text,
    bodyHtml: row.body_html,
    deliveryStatus: row.delivery_status as StoredThread['deliveryStatus'],
    idempotencyKey: row.idempotency_key,
    // Cast, not parsed: this codebase is the only writer of send_envelope
    // (insertThread, always via JSON.stringify of a SendEnvelope), and the
    // jsonb column already arrives decoded (see ThreadRow's doc comment).
    sendEnvelope: row.send_envelope as SendEnvelope | null,
    claimedUntil: row.claimed_until === null ? null : toDate(row.claimed_until),
    customerViewedAt: row.customer_viewed_at === null ? null : toDate(row.customer_viewed_at),
    createdAt: toDate(row.created_at),
    authorKind: row.author_kind as ThreadAuthorKind,
    authorAgentId: row.author_agent_id,
    authorAssistantId: row.author_assistant_id,
    draftStatus: row.draft_status as DraftStatus | null,
    approvedByAgentId: row.approved_by_agent_id,
    draftResolvedAt: row.draft_resolved_at === null ? null : toDate(row.draft_resolved_at),
    draftEdited: row.draft_edited,
  }
}
