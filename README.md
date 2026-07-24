# Helpthread

**Open-source support infrastructure.**

Helpthread provides the foundation upon which support systems are built: durable
conversations, trustworthy email threading, an operator inbox, public APIs and events,
and an extension model available equally to first-party and community software.

It is serverless-native and optimized first for Vercel and Supabase, while keeping
platform services behind Helpthread-owned interfaces. Organizations deploy Helpthread
into infrastructure they choose and control.

> **Status: pre-release and dogfooded in production.** Helpthread is developed by
> Resonant IQ, Inc. and runs the company's support operation today, but it is not ready for general deployment. See
> [STATUS.md](STATUS.md) for the current product surface and roadmap.

## Start here

- **[Founding Charter](CHARTER.md)** — identity, principles, and project commitments
- **[Architecture](docs/architecture/README.md)** — the map to current technical contracts
- **[Status](STATUS.md)** — what is live, underway, and deferred
- **[Governance](GOVERNANCE.md)** — how project decisions are made today
- **[Legal and licensing](legal/README.md)** — the AGPL core and commercial-module boundary
- **[`specs/`](specs/)** — the maintained behavioral and product contracts
- **[`fixtures/`](fixtures/)** — the mail engine's black-box acceptance suite

## Architecture in one breath

TypeScript on Vercel plus Supabase for Postgres, authentication, storage, and realtime.
Inbound mail arrives through push delivery and bounded reconciliation rather than a
long-running poller. Signed reply tokens minted into outbound messages give Helpthread
verifiable threading authority. See the [architecture overview](docs/architecture/README.md).

## Development

Prerequisites: Node 20+.

```
npm install
```

Scripts:

- `npm run typecheck` — TypeScript, strict, no emit.
- `npm run lint` / `npm run lint:fix` — Biome lint (and autofix).
- `npm run format` — Biome format.
- `npm test` / `npm run test:watch` — Vitest.
- `npm run test:coverage` — Vitest with v8 coverage (text + lcov).

## Contributing

Helpthread is not accepting external code contributions yet. Issues and discussion are
welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[AGPL-3.0](LICENSE) for the core. © Resonant IQ, Inc. Commercial modules add to the
core; they do not subtract from it. See
[legal and licensing](legal/README.md).
