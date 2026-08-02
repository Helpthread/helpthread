# Helpthread Decision Log

This directory preserves material decisions that explain how the current architecture,
licensing model, and product boundary came to be.

The [Founding Charter](../../CHARTER.md) contains enduring principles. Decisions and
specification changelogs contain dated implementation and product choices.

## 2026-07-10 — DCO contributions and the module boundary

**Decided:** 2026-07-10

Contributors retain copyright and contribute under the Developer Certificate of Origin.
Helpthread does not require a CLA or copyright assignment.

Where separately licensed modules form a combined program with the AGPL core, an
AGPL-3.0 §7 additional permission defines the legal boundary. It is symmetric for
first-party, community, private, and fork-based modules using the documented public API.
Counsel must finalize it before the first external contribution is accepted.

Helpthread therefore gives up unilateral relicensing and core dual-licensing. Commercial
sustainability comes from additive modules and services rather than license exceptions.

See [legal/README.md](../../legal/README.md).

## 2026-07-19 — Knowledge base reclassified as a paid module

**Decided:** 2026-07-19

The knowledge base is a first-party paid module. The core may expose public knowledge
interfaces and integration hooks; authoring, publishing, presentation, search
experiences, and management remain module capabilities.

This was not a retroactive paywall because no knowledge-base capability had shipped in
the free core. The charter's floor still governs: nothing already free in the core is
paywalled later.

## 2026-07-19 — Marketplace moved to public launch

**Decided:** 2026-07-19

The original roadmap deferred the marketplace. Once the module substrate and first
commercial module became real during dogfooding, the remaining work was commerce and
distribution plumbing rather than speculation.

The official marketplace therefore became a public-launch capability, proven first
through Resonant IQ's own installation path. It remains additive: the AGPL core holds no
marketplace credentials, licensing does not control runtime execution, and commercial
modules receive no private core capabilities.

The public contract module authors build against is the
[module substrate](../../specs/modules/substrate-v1.md); commercial distribution
mechanics are maintained by Resonant IQ outside this repository.

## 2026-07-23 — Managed-hosting proposal rejected

A managed-hosting design introduced on 2026-07-19 was based on a mistaken interpretation
of the project direction. Helpthread and its commercial modules are operator-deployed.
Resonant IQ does not host module runtimes or process operator conversation data.

The proposal was removed because it violated the charter's operator-ownership principle.
It is not part of Helpthread's product or architecture.

The original charter and its complete amendment record are preserved at
[docs/history/CHARTER-v1.md](../history/CHARTER-v1.md).

## 2026-07-28 — The Supabase Data API is closed; Postgres is reached directly

**Decided:** 2026-07-28

**Context.** A Supabase advisor alert reported one publicly accessible table. Checking the
project found the problem was broader: all 19 tables in `public` had Row-Level Security
disabled *and* full `SELECT/INSERT/UPDATE/DELETE/TRUNCATE` granted to the `anon` and
`authenticated` roles. Supabase exposes `public` through PostgREST, and the anon key is
public by design, so this was unauthenticated read and write against production —
including INSERT into `agents`, `agent_auth_identities`, `agent_mailbox_access`, and
`webauthn_credentials`, which is enough to self-provision an authenticated Agent.
`mailbox_oauth_tokens` was partially cushioned: its token columns hold AES-256-GCM
ciphertext keyed outside the database, so a dump yields ciphertext, not usable Gmail
credentials. Inspection of the data found no evidence of tampering — this checked state,
not access logs, so it is not proof of non-access.

**Decision.** The PostgREST Data API is not part of Helpthread's architecture. The
application reaches Postgres directly over the pooler (`DATABASE_URL`) and uses Supabase
Storage with the `service_role` key; no anon-key client exists anywhere in the codebase.
Migration 027 therefore enables RLS on every table and revokes the `anon`/`authenticated`
grants, including via `ALTER DEFAULT PRIVILEGES` so future tables created by the migrating
role do not arrive pre-granted. Neither half hardcodes `public`, because `PostgresDb`
supports a `schema` option; the revokes derive the schema from `'conversations'::regclass`
— deliberately *not* `current_schema()`, which resolves to search_path's first entry rather
than to the schema actually holding the tables, and so can diverge from the unqualified
`ALTER TABLE`s. (An earlier revision of this change used `current_schema()` and was caught
in review; the divergence fails silently, leaving the grants in place while the migration
reports success.) The same lockdown was applied directly to the production project ahead of
the migration landing, to close live exposure rather than wait on review.

Be precise about the limits of the `ALTER DEFAULT PRIVILEGES` layer, which is easy to
overrate: it *deletes a default-ACL entry* rather than installing a standing deny, and
without `FOR ROLE` it binds only to the role that ran the migration. It does not survive
Supabase re-running its stock bootstrap, and it does not touch defaults defined for other
roles such as `supabase_admin`. The durable protection is the standing rule below.

**Alternatives considered.** Enabling RLS alone was rejected: the grants would remain, so
a single future permissive policy would reopen everything. Revoking grants alone was
rejected for the mirror-image reason — anything that re-grants, including Supabase
re-running its stock bootstrap, restores them, and as noted above the default-privileges
layer does not prevent that. Writing real per-tenant RLS policies was rejected as solving a problem Helpthread
does not have: policies exist to make anon access safe, and there is no anon access to
make safe. Deny-by-default with no policies is the honest expression of that.

**Consequences.** The Supabase security advisor now reports `rls_enabled_no_policy` at
INFO level for every table. That is the intended end state, not an outstanding item.
Tables are owned by `postgres`, which bypasses RLS unless `FORCE ROW LEVEL SECURITY` is
set — deliberately not set — so the application is unaffected. A standing rule follows:
any migration adding a table must also enable RLS on it.

**This promotes an implicit deployment detail into an invariant: `DATABASE_URL` must
connect as the role that owns the tables.** It does today — the runbook has the operator
use the Supabase pooler string (role `postgres`) for both the app and `scripts/migrate.ts`,
so connecting role and owning role coincide by construction. But pointing `DATABASE_URL` at
a dedicated least-privilege role — a supported Supabase pattern — now breaks the engine, and
the two halves break differently: reads go quiet (RLS with no policies returns zero rows
instead of raising, so the symptom is an empty inbox rather than a database error) while
every write hard-errors with `new row violates row-level security policy`. The loud signal
arrives first, via inbound ingest. No test can catch the misconfiguration, because PGlite
also runs as the owner. Separately,
`splitStatements` in `src/db/migrate.ts` had to learn about dollar quoting, since
migration 027's role guard is a `DO $$ ... $$` block whose body contains semicolons.

**Supersedes.** Nothing.

Future material decisions should record:

1. date and scope;
2. context;
3. decision;
4. alternatives considered;
5. consequences; and
6. superseded decisions, if any.
