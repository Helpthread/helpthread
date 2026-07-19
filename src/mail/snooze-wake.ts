/**
 * The snooze wake pass (HT-77; specs/api/agent-inbox-v1.md's snooze
 * amendment). A snooze is a TIMED `pending` — an Agent statement that a
 * conversation should come back to `active` on its own once `snoozed_until`
 * passes. Nothing pushes that transition; it needs a periodic sweep, the
 * same "Postgres itself has no way to push, so a cron tick drains" shape
 * `src/webhooks/outbox-drain.ts`'s own module doc already states for the
 * event outbox.
 *
 * One pass: list the ids of every `pending` conversation whose
 * `snoozed_until` is due (`ConversationStore.listDueSnoozed`), then flip
 * each to `active` via `ConversationStore.setConversationStatus(id,
 * 'active', { requireStatus: 'pending' })` — the SAME store method (and
 * transactional-outbox event emission, spec §4's `conversation.
 * status_changed`) an ordinary `PATCH .../status` call uses, so this pass
 * needs no event-firing logic of its own (`src/store/conversations.ts`'s
 * `setConversationStatus` doc comment covers the full contract, including
 * why `requireStatus` is what makes this safe against a conversation an
 * Agent moved off `pending` in the gap between the list read and this
 * write).
 *
 * Deliberately ONE id at a time, not a single bulk `UPDATE ... WHERE ...
 * RETURNING *`: reusing `setConversationStatus` per-id is what gets
 * `conversation.status_changed` emission "for free" (the brief's own
 * framing) — a bulk statement would either duplicate that event-emission
 * logic or skip it, and HT-77's whole point is that a timed wake is
 * observationally identical to an Agent's own `PATCH`. The batch size below
 * bounds how much work one cron tick does; a batch this size or larger
 * simply continues on the next tick, the same "no pagination, a skipped row
 * is picked up next sweep" shape `ConversationStore.listDeliverableThreads`'s
 * doc comment uses for the outbound delivery sweep.
 */

import type { ConversationStore } from '../store/conversations.js'

/** Default cap on due conversations woken per {@link runSnoozeWake} call — bounds one invocation's work, mirroring `drainEventOutbox`'s `DEFAULT_BATCH_SIZE`. */
const DEFAULT_BATCH_SIZE = 100

/** Dependencies {@link runSnoozeWake} needs for one pass. */
export interface SnoozeWakeDeps {
  store: ConversationStore
}

/** Tuning knobs for one pass; defaults, so `runSnoozeWake(deps)` alone is a complete, reasonable call. */
export interface SnoozeWakeOptions {
  batchSize?: number
}

/** What one {@link runSnoozeWake} call did, for logging/observability by whatever schedules it. */
export interface SnoozeWakeReport {
  /** Due conversation ids found this pass. */
  due: number
  /** Of those, how many were actually woken — may be LESS than `due` when a concurrent Agent action (e.g. closing the conversation) won the race in the gap between the list read and the guarded write (see the module doc's `requireStatus` note); never more. */
  woken: number
}

/**
 * Run one wake pass: list due snoozed conversations, flip each `pending` →
 * `active` (clearing `snoozed_until`) via `setConversationStatus`'s
 * `requireStatus`-guarded write. See the module doc for the full contract.
 */
export async function runSnoozeWake(
  deps: SnoozeWakeDeps,
  options?: SnoozeWakeOptions,
): Promise<SnoozeWakeReport> {
  const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE
  const dueIds = await deps.store.listDueSnoozed({ limit: batchSize })

  let woken = 0
  for (const id of dueIds) {
    const updated = await deps.store.setConversationStatus(id, 'active', {
      requireStatus: 'pending',
    })
    if (updated !== null) woken++
  }

  return { due: dueIds.length, woken }
}
