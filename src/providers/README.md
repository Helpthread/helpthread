# `src/providers` — platform provider interfaces

This directory is the seam CHARTER.md §4 promises: **"the engine's core never
calls a platform directly: queueing, scheduled and durable work, blob
storage, and inbound email all sit behind thin provider interfaces the
project owns, with today's implementations (Vercel Queues, Vercel Cron and
Workflows, Supabase Storage, Gmail push) as adapters"** rather than
assumptions baked into engine code.

## The rule

**Engine core imports only from `src/providers`** — the interfaces and types
defined in this directory — never a platform SDK (`@vercel/*`,
`@supabase/*`, `googleapis`, etc.) directly. If an engine module needs to
enqueue work, schedule an action, store a blob, or read an inbound email, it
takes a dependency on the relevant interface (`QueueProvider`,
`SchedulerProvider`, `BlobStore`, `InboundEmailProvider`) — never on the
package that implements it.

Concrete implementations — **adapters** — live in `src/providers/adapters/<name>/`
(e.g. `src/providers/adapters/vercel-queues/`). This task defines the
contracts only; no adapters are built here.

An adapter is **selected at the composition root** — the small amount of
top-level wiring code (API route handlers, cron entry points, app
bootstrap) that constructs concrete provider instances from env/config and
hands them to engine modules. Engine modules never `import` an adapter
themselves; they only ever see the interface type. This keeps the
dependency arrow pointing one way: adapters depend on the interfaces the
engine defines, not the other way around.

## Vercel-first, not Vercel-only

Per CHARTER.md §4, the first-class deployment target is Vercel + Supabase,
and the first adapters built against these interfaces will target Vercel
Queues, Vercel Cron/Workflows, Supabase Storage, and Gmail push. But because
engine code only ever depends on the interfaces in this directory, a future
plain-Node-plus-Postgres deployment (or any other platform) stays reachable
by writing new adapters — not by rewriting the engine. Inbound email forces
this discipline regardless, since Gmail can't be the only supported mailbox
forever; this directory applies the same discipline to the other three
seams the charter names.

## Testing payoff

Because engine code depends on these interfaces rather than concrete SDKs,
the engine's test suite runs against **in-memory fakes** of `QueueProvider`,
`SchedulerProvider`, `BlobStore`, and `InboundEmailProvider` — no cloud
account, network call, or platform emulator required to exercise queueing,
scheduling, storage, or inbound-mail logic. Adapters get their own
integration tests against the real platform; engine logic does not need
those to run.
