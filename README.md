# Helpthread

**Open-source support infrastructure.**

Helpthread provides the foundation upon which support systems are built: durable
conversations, trustworthy email threading, an operator inbox, public APIs and events,
and an extension model available equally to first-party and community software.

It is serverless-native and optimized first for Vercel and Supabase, while keeping
platform services behind Helpthread-owned interfaces. Organizations deploy Helpthread
into infrastructure they choose and control.

> **Status: developer preview.** Helpthread is developed by Resonant IQ, Inc. and runs
> the company's own support operation in production today. You can deploy it now if you
> are comfortable running pre-release software: APIs and interfaces may change before
> 1.0, and there is no upgrade-compatibility promise until then. Start at
> [Deploying](specs/deploy/single-project.md). Current work is tracked in the
> [Helpthread OSS Roadmap](https://github.com/orgs/Helpthread/projects/1).
>
> Worth knowing before you deploy: it needs a **Vercel Pro** plan or above (five of the
> six cron schedules run more than once a day, which Hobby does not allow), Gmail is the
> proven inbound path, and IMAP intake is still a draft spec
> ([`specs/mail/mailbox-connection.md`](specs/mail/mailbox-connection.md)) with an open
> question about transport-stable message ids.

## Deploy with Vercel (alpha, developer preview)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FHelpthread%2Fhelpthread&project-name=helpthread&repository-name=helpthread&root-directory=web&env=HELPTHREAD_TOKEN_ENC_KEY%2CHELPTHREAD_API_TOKEN%2CHELPTHREAD_SIGNING_SECRET%2CCRON_SECRET%2CHELPTHREAD_UI_SESSION_SECRET%2CHELPTHREAD_SETUP_SECRET%2CHELPTHREAD_MAIL_DOMAIN%2CHELPTHREAD_SUPPORT_ADDRESS%2CHELPTHREAD_BLOB_BUCKET&envDescription=Secrets%20you%20generate%20yourself%2C%20plus%20your%20mail%20domain%20and%20support%20address%20%E2%80%94%20see%20the%20setup%20guide.&envLink=https%3A%2F%2Fgithub.com%2FHelpthread%2Fhelpthread%2Fblob%2Fmain%2Fspecs%2Fdeploy%2Fdeploy-with-vercel.md&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22supabase%22%2C%22productSlug%22%3A%22supabase%22%7D%5D)

This is an **alpha, developer-preview install path** (issues #151/#153) — a guided one-click
route into a real Helpthread deployment, not a polished onboarding flow. It creates a Vercel
project rooted at `web/`, attaches the Supabase Marketplace integration to provision a
connected Postgres database, and asks you only for the handful of values Vercel and Supabase
can't generate on your behalf. Read
**[Deploy with Vercel](specs/deploy/deploy-with-vercel.md)** before you click — it explains
every prompted variable, how to generate the secrets, the Vercel Pro requirement, and what
happens on first visit. This path has not yet been exercised end to end (no deployment has
been created from this exact button); the manual runbook below remains the proven path.

## Start here

- **[Founding Charter](CHARTER.md)** — identity, principles, and project commitments
- **[Architecture](docs/architecture/README.md)** — the map to current technical contracts
- **[Roadmap](https://github.com/orgs/Helpthread/projects/1)** — public delivery status and planned work
- **[Governance](GOVERNANCE.md)** — how project decisions are made today
- **[Legal and licensing](legal/README.md)** — the AGPL core and commercial-module boundary
- **[Deploying](specs/deploy/single-project.md)** — one Vercel project, one origin
- **[Deploy with Vercel](specs/deploy/deploy-with-vercel.md)** — the alpha one-click install path
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
- `npm run build:engine` — compile the engine to `dist/` (the web app's `prebuild`/`predev` run this).

## Contributing

Helpthread is not accepting external code contributions yet. Issues and discussion are
welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[AGPL-3.0](LICENSE) for the core. © Resonant IQ, Inc. Commercial modules add to the
core; they do not subtract from it. See
[legal and licensing](legal/README.md).
