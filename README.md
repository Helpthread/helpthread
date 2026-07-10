# Helpthread

Open-source, serverless helpdesk — shared inbox, threaded email conversations, knowledge base — for teams who live on Vercel and Supabase. Aimed at the ease of use Help Scout set the bar for, fully owned by the operator. FreeScout proved the self-hosted market is real; Helpthread is built for it on modern rails.

> **Status: early and pre-release.** This repository is being built in the open from its first day. Today it holds the project's constitution ([CHARTER.md](CHARTER.md)), behavioral specifications, a test-fixture harness, and the platform interfaces — **not yet a runnable product.** It is dogfooded first, as [Resonant IQ](https://resonantiq.app)'s own support system, before it's anything anyone else should deploy. Watch or star to follow along; expect things to move and change.

## What's here now

- **[CHARTER.md](CHARTER.md)** — the founding document: vision, principles, licensing, architecture, roadmap. Read this first.
- **`specs/`** — behavioral specifications (the conversation API contract, mail threading) that the engine will be built and tested against.
- **`fixtures/`** — a black-box test harness and recorded fixtures that form the mail engine's acceptance suite.
- **`src/providers/`** — the platform-provider interfaces (queue, scheduler, storage, inbound email) the engine depends on, keeping it Vercel-first but not Vercel-only.

## Architecture in one breath

TypeScript on Vercel (Fluid Compute, Workflows, Queues, Cron — no daemons, no polling) plus Supabase (Postgres, Auth, Storage, Realtime). Inbound mail arrives by push webhook, not IMAP polling. Threading authority lives on the outbound side: signed reply tokens in the Message-IDs the engine emits. See the charter for the reasoning.

## Contributing

Not accepting external contributions yet — see [CONTRIBUTING.md](CONTRIBUTING.md). Issues and discussion are welcome.

## License

[AGPL-3.0](LICENSE) for the core. © Resonant IQ, Inc. Commercially-licensed first-party modules will come later via a marketplace; the core stays free software, forever. See the charter's licensing section.
