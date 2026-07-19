/**
 * The internal health check (HT-44, specs/mail/inbound-ingestion.md §6;
 * runbook Part G) — one point-in-time report over everything the inbound
 * pipeline needs to stay alive, served by the CRON_SECRET-guarded
 * `GET /api/v1/internal/health` (`./app.ts`) and designed so a dumb HTTP
 * monitor becomes the alerter: the endpoint answers **200 when `ok`, 503
 * when any alert is tripped**, so status-code polling (UptimeRobot, Checkly,
 * a curl in cron — anything that can send one header) is a complete
 * alerting stack. There is deliberately no Datadog/OTel dependency here:
 * the platform aggregates logs (CHARTER.md §4), and this endpoint is the
 * one pull-based surface those logs can't provide.
 *
 * ## What it reports, and the alert each section can trip
 *
 * - **Queue** (`PostgresQueue.getStats` + a 24h dead-letter window):
 *   `queue-drain-stalled` when the oldest ready job has waited longer than
 *   {@link QUEUE_OLDEST_READY_ALERT_SECONDS} (the drain cron runs every
 *   minute — a five-minute-old ready job means ~5 missed/failing ticks);
 *   `queue-dead-letter-growth` when any job was dead-lettered in the last
 *   24h (dead-letter rows are retained by design — migration 013 — so the
 *   signal is growth, never the standing count).
 * - **Ingest ledger** (`inbound_deliveries`, 24h outcome counts):
 *   `ingest-dead-letter-growth`, same growth-not-backlog reasoning (a
 *   dead-lettered row's `updated_at` freezes when it parks, so a 24h
 *   `updated_at` window on the current status IS the newly-parked count).
 * - **Forged tokens** (migration 019's `forged_token_count`):
 *   `forged-token-burst` when {@link FORGED_TOKEN_ALERT_THRESHOLD} or more
 *   deliveries stored in the last 24h carried at least one forged token —
 *   threading.md §5's security signal ("a single forgery is unremarkable; a
 *   burst against one conversation or sender is a security signal"),
 *   finally consumable. The threshold is this module's own default, NOT a
 *   number threading.md §5 blesses (that spec deliberately leaves it open);
 *   it is a constant, not config, until dogfood traffic teaches us better.
 * - **Mailboxes** (`mailboxes` LEFT JOIN `gmail_watch_state`):
 *   `mailbox-needs-attention` for `paused`/`needs_reconnect` rows (both
 *   mean inbound mail is NOT flowing until an operator acts — runbook Part
 *   G); `watch-expiring` for an `active` mailbox whose Gmail `watch()`
 *   expiration is missing or nearer than {@link WATCH_EXPIRY_ALERT_HOURS}
 *   (the daily maintenance cron re-arms it ~7 days out, so anything under
 *   72h means renewal has been failing for days — caught while there is
 *   still runway). `disconnected` mailboxes are deliberately silent: that
 *   state is an operator's own explicit action (HT-47).
 * - **Webhooks** (HT-69; specs/modules/substrate-v1.md §5: "surfaced by
 *   `/api/v1/internal/health` (runbook Part G gains a section)"):
 *   `webhook-endpoint-auto-disabled` for every `webhook_endpoints` row
 *   `WebhookEndpointStore.recordDeliveryFailure` flipped past the
 *   consecutive-failure threshold (spec §9 decision 2: 20) — spec's own
 *   rationale for alerting here ("conservative because a disabled endpoint
 *   silently stops a paid module"). `webhook-delivery-dead-letter-growth`
 *   for any `queue_jobs` row on `WEBHOOK_DELIVERY_TOPIC` dead-lettered in
 *   the last 24h — the SAME growth-not-backlog reasoning as `queue-dead-
 *   letter-growth`/`ingest-dead-letter-growth` above (a dead-lettered
 *   delivery's `webhook_endpoints.recordDeliveryFailure` write already
 *   happened by the time it reaches this state — `src/webhooks/
 *   delivery.ts`'s module doc — so this is a SEPARATE signal from the
 *   auto-disable alert: an endpoint can shed individual failed deliveries
 *   for a while before crossing 20 consecutive and auto-disabling).
 *
 * ## What it deliberately does NOT check
 *
 * A "reconcile cursor is stale" alert was considered and dropped:
 * `gmail_watch_state.updated_at` is bumped by BOTH cursor advances and
 * watch-expiration renewals (`src/store/gmail-watch-state.ts`), so it
 * cannot distinguish "reconcile broken" from "renewal alive" — a health
 * signal that can't measure what it claims is worse than none. A stalled
 * reconcile still surfaces here indirectly (`queue-drain-stalled`, since
 * reconcile jobs retry rather than ack) and in the `gmail_reconcile` log
 * events. If dogfood shows a real blind spot, a dedicated cursor-write
 * timestamp column is the honest fix.
 *
 * ## Alert strings are contract-ish
 *
 * Each alert is `<kebab-code>: <human detail>`. The code prefix is stable
 * (runbook Part G documents each one); the detail after the colon is free
 * text for the human reading the monitor's notification, never parsed.
 */

import type { Db } from '../db/client.js'
import type { QueueStats } from '../providers/adapters/postgres-queue/index.js'
import type { InboundDeliveryStatus } from '../store/inbound-deliveries.js'
import { WEBHOOK_DELIVERY_TOPIC } from '../webhooks/delivery.js'

/** Oldest-ready-job age (seconds) past which the every-minute drain is presumed stalled. */
export const QUEUE_OLDEST_READY_ALERT_SECONDS = 300

/** Stored deliveries carrying ≥1 forged token in 24h at which the burst alert trips (module doc — a default, not threading.md §5's still-open threshold). */
export const FORGED_TOKEN_ALERT_THRESHOLD = 5

/** Hours of remaining Gmail `watch()` lifetime under which renewal is presumed failing (daily re-arm grants ~7 days; 72h ≈ four missed days, with runway left). */
export const WATCH_EXPIRY_ALERT_HOURS = 72

/** Dependencies {@link runHealthCheck} needs — the raw `Db` for its aggregate queries, and the queue's stats method (a `PostgresQueue` in production; any conforming fake in tests). */
export interface HealthCheckDeps {
  db: Db
  queue: { getStats(): Promise<QueueStats> }
}

/** One mailbox's health row — see the module doc's Mailboxes section. */
export interface MailboxHealth {
  id: string
  address: string
  status: string
  /** The Gmail `watch()` expiration (ISO), `null` when never armed (or the sidecar row is missing entirely). */
  watchExpiresAt: string | null
}

/** One auto-disabled webhook endpoint — see the module doc's Webhooks section (HT-69). */
export interface WebhookHealth {
  id: string
  url: string
  consecutiveFailures: number
}

/** The report `GET /api/v1/internal/health` serves — see the module doc for each section and the alert it can trip. */
export interface HealthReport {
  /** `alerts.length === 0` — the endpoint's 200-vs-503 pivot. */
  ok: boolean
  /** Every tripped alert, `<kebab-code>: <detail>` (module doc). Empty when healthy. */
  alerts: string[]
  generatedAt: string
  queue: QueueStats & { deadLetteredLast24h: number }
  ingest: {
    /** Ledger rows whose CURRENT status was reached in the last 24h, per status. */
    last24hByStatus: Record<InboundDeliveryStatus, number>
    /** The standing dead-letter backlog (retained by design; inspect, don't page on it). */
    deadLetterTotal: number
  }
  forgedTokens: {
    /** Stored deliveries in the last 24h carrying ≥1 forged token. */
    deliveriesLast24h: number
    /** Total forged tokens across those deliveries. */
    tokensLast24h: number
    alertThreshold: number
  }
  mailboxes: MailboxHealth[]
  /** HT-69 (spec §5's "surfaced by /api/v1/internal/health") — see the module doc's Webhooks section. */
  webhooks: {
    /** Endpoints currently `auto_disabled` — the standing set, not a 24h window (mirrors `ingest.deadLetterTotal`'s "inspect, don't page on the backlog itself" framing; the ALERT is what pages, on `.length > 0`). */
    autoDisabled: WebhookHealth[]
    /** `queue_jobs` rows on `WEBHOOK_DELIVERY_TOPIC` dead-lettered in the last 24h. */
    deliveryFailuresLast24h: number
  }
}

/** Every ledger status, for zero-filling {@link HealthReport.ingest}'s per-status map (a status with no 24h rows must still appear, as `0`). */
const ALL_DELIVERY_STATUSES: InboundDeliveryStatus[] = [
  'received',
  'stored',
  'suppressed',
  'failed',
  'dead-letter',
]

/**
 * Run every check in the module doc and assemble the report. Read-only —
 * five aggregate queries plus `getStats`, no writes, no external calls —
 * so polling it every minute is harmless. Throws only if a query itself
 * fails (a down database IS a health-check failure; the endpoint's generic
 * 500 — and the monitor alerting on any non-200 — reports it honestly).
 */
export async function runHealthCheck(deps: HealthCheckDeps): Promise<HealthReport> {
  const alerts: string[] = []

  // --- Queue. ---------------------------------------------------------------
  const stats = await deps.queue.getStats()
  const deadLetteredLast24hRows = await deps.db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM queue_jobs
     WHERE dead_lettered_at > now() - interval '24 hours'`,
  )
  const deadLetteredLast24h = deadLetteredLast24hRows[0]?.count ?? 0
  if (
    stats.oldestReadyAgeSeconds !== null &&
    stats.oldestReadyAgeSeconds > QUEUE_OLDEST_READY_ALERT_SECONDS
  ) {
    alerts.push(
      `queue-drain-stalled: oldest ready job has waited ${stats.oldestReadyAgeSeconds}s ` +
        `(threshold ${QUEUE_OLDEST_READY_ALERT_SECONDS}s) — is the every-minute drain cron running?`,
    )
  }
  if (deadLetteredLast24h > 0) {
    alerts.push(
      `queue-dead-letter-growth: ${deadLetteredLast24h} queue job(s) dead-lettered in the last 24h — inspect queue_jobs.last_error`,
    )
  }

  // --- Ingest ledger. -------------------------------------------------------
  const statusRows = await deps.db.query<{ status: InboundDeliveryStatus; count: number }>(
    `SELECT status, count(*)::int AS count FROM inbound_deliveries
     WHERE updated_at > now() - interval '24 hours'
     GROUP BY status`,
  )
  const last24hByStatus = Object.fromEntries(
    ALL_DELIVERY_STATUSES.map((status) => [status, 0]),
  ) as Record<InboundDeliveryStatus, number>
  for (const row of statusRows) {
    last24hByStatus[row.status] = row.count
  }
  const deadLetterTotalRows = await deps.db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM inbound_deliveries WHERE status = 'dead-letter'`,
  )
  const deadLetterTotal = deadLetterTotalRows[0]?.count ?? 0
  if (last24hByStatus['dead-letter'] > 0) {
    alerts.push(
      `ingest-dead-letter-growth: ${last24hByStatus['dead-letter']} inbound delivery(ies) ` +
        'dead-lettered in the last 24h — inspect inbound_deliveries.last_error',
    )
  }

  // --- Forged tokens (migration 019). ---------------------------------------
  const forgedRows = await deps.db.query<{ deliveries: number; tokens: number }>(
    `SELECT count(*)::int AS deliveries, COALESCE(sum(forged_token_count), 0)::int AS tokens
     FROM inbound_deliveries
     WHERE forged_token_count > 0 AND updated_at > now() - interval '24 hours'`,
  )
  const forged = forgedRows[0] ?? { deliveries: 0, tokens: 0 }
  if (forged.deliveries >= FORGED_TOKEN_ALERT_THRESHOLD) {
    alerts.push(
      `forged-token-burst: ${forged.deliveries} stored delivery(ies) carried forged reply tokens ` +
        `in the last 24h (threshold ${FORGED_TOKEN_ALERT_THRESHOLD}) — threading.md §5 security signal; ` +
        'inspect the forged_token_detected log events for senders and targets',
    )
  }

  // --- Mailboxes + watch state. ---------------------------------------------
  const mailboxRows = await deps.db.query<{
    id: string
    address: string
    status: string
    watch_expiration: Date | string | null
    expires_in_seconds: number | null
  }>(
    `SELECT m.id, m.address, m.status, w.watch_expiration,
            EXTRACT(EPOCH FROM (w.watch_expiration - now()))::int AS expires_in_seconds
     FROM mailboxes m
     LEFT JOIN gmail_watch_state w ON w.mailbox_id = m.id
     ORDER BY m.created_at`,
  )
  const mailboxes: MailboxHealth[] = mailboxRows.map((row) => ({
    id: row.id,
    address: row.address,
    status: row.status,
    watchExpiresAt:
      row.watch_expiration === null ? null : toDate(row.watch_expiration).toISOString(),
  }))
  for (const row of mailboxRows) {
    if (row.status === 'paused' || row.status === 'needs_reconnect') {
      alerts.push(
        `mailbox-needs-attention: mailbox ${row.address} is '${row.status}' — inbound mail is not ` +
          'flowing until an operator acts (runbook Part G)',
      )
    }
    if (row.status === 'active') {
      if (row.expires_in_seconds === null) {
        alerts.push(
          `watch-expiring: mailbox ${row.address} is active but has no Gmail watch() expiration ` +
            'recorded — watch was never armed, or its state row is missing',
        )
      } else if (row.expires_in_seconds < WATCH_EXPIRY_ALERT_HOURS * 3600) {
        alerts.push(
          `watch-expiring: mailbox ${row.address}'s Gmail watch() expires in ` +
            `${Math.max(0, Math.floor(row.expires_in_seconds / 3600))}h ` +
            `(threshold ${WATCH_EXPIRY_ALERT_HOURS}h) — the daily renewal cron is failing`,
        )
      }
    }
  }

  // --- Webhooks (HT-69; module doc's Webhooks section). ----------------------
  const autoDisabledRows = await deps.db.query<{
    id: string
    url: string
    consecutive_failures: number
  }>(
    `SELECT id, url, consecutive_failures FROM webhook_endpoints
     WHERE status = 'auto_disabled'
     ORDER BY updated_at DESC`,
  )
  const autoDisabled: WebhookHealth[] = autoDisabledRows.map((row) => ({
    id: row.id,
    url: row.url,
    consecutiveFailures: row.consecutive_failures,
  }))
  if (autoDisabled.length > 0) {
    alerts.push(
      `webhook-endpoint-auto-disabled: ${autoDisabled.length} webhook endpoint(s) auto-disabled ` +
        `after reaching the consecutive-failure threshold — inspect and re-enable via PATCH ` +
        '/api/v1/webhooks/{id} once fixed (runbook Part G)',
    )
  }
  const deliveryFailuresRows = await deps.db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM queue_jobs
     WHERE topic = $1 AND dead_lettered_at > now() - interval '24 hours'`,
    [WEBHOOK_DELIVERY_TOPIC],
  )
  const deliveryFailuresLast24h = deliveryFailuresRows[0]?.count ?? 0
  if (deliveryFailuresLast24h > 0) {
    alerts.push(
      `webhook-delivery-dead-letter-growth: ${deliveryFailuresLast24h} webhook delivery(ies) ` +
        'dead-lettered in the last 24h — inspect queue_jobs.last_error for topic ' +
        `'${WEBHOOK_DELIVERY_TOPIC}'`,
    )
  }

  return {
    ok: alerts.length === 0,
    alerts,
    generatedAt: new Date().toISOString(),
    queue: { ...stats, deadLetteredLast24h },
    ingest: { last24hByStatus, deadLetterTotal },
    forgedTokens: {
      deliveriesLast24h: forged.deliveries,
      tokensLast24h: forged.tokens,
      alertThreshold: FORGED_TOKEN_ALERT_THRESHOLD,
    },
    mailboxes,
    webhooks: { autoDisabled, deliveryFailuresLast24h },
  }
}

/** Coerce a `timestamptz` value into a `Date` — the same defensive shape `src/store/*.ts`'s `toDate` helpers use (PGlite hands back `Date`s; a future `Db` may hand back strings). */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}
