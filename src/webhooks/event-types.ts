/**
 * The closed event-type vocabulary (HT-69; specs/modules/substrate-v1.md
 * §4's vocabulary table). Additions are spec amendments, not a runtime
 * config surface — this list is the one place both the admin API's `events`
 * filter validation (`src/api/webhooks.ts`) and any future emission call
 * site can check a type string against the spec'd set.
 *
 * `event_outbox.type` and `webhook_endpoints.events` are both untyped
 * `text`/`jsonb` at the storage layer (`src/store/event-outbox.ts`,
 * `src/store/webhook-endpoints.ts` — "this store does not validate against
 * that list; the caller is the only writer of event types"), so this module
 * is that caller-side validation, not a schema constraint.
 *
 * `draft.created`/`draft.resolved` are listed here even though HT-69 does
 * not emit them (wave 3 owns `appendDraft`/`resolveDraft`, spec §6) — an
 * admin registering a webhook today may legally subscribe to them ahead of
 * time (spec §1's additive-forward rule: the substrate's surface is
 * complete even where an individual emission call site lands in a later
 * wave), and no schema change is needed when wave 3 starts firing them.
 */

/** `test.ping` is a synthetic type — never persisted to `event_outbox`, fired only by `POST /api/v1/webhooks/{id}/test` (spec §5) directly through the delivery queue. Kept OUT of {@link EVENT_TYPES}/{@link isEventType}: it is not a subscribable filter value (a `test.ping` delivery always targets the one endpoint being tested, regardless of its `events` filter — see `src/api/webhooks.ts`'s `handleTestWebhook`), so it must never appear in a stored endpoint's `events` array. */
export const TEST_PING_EVENT_TYPE = 'test.ping'

/** Every real domain event type spec §4's vocabulary table lists, in table order. */
export const EVENT_TYPES = [
  'conversation.created',
  'conversation.message_received',
  'conversation.reply_sent',
  'conversation.status_changed',
  'conversation.tags_changed',
  'conversation.assignee_changed',
  'draft.created',
  'draft.resolved',
] as const

export type EventType = (typeof EVENT_TYPES)[number]

/** Is `value` one of {@link EVENT_TYPES}? The narrowing guard `src/api/webhooks.ts` uses to validate a `POST`/`PATCH` body's `events` array. Deliberately excludes {@link TEST_PING_EVENT_TYPE} — see its own doc comment. */
export function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value)
}
