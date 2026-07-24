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
the free core. The maintained product boundary lives in
[specs/modules/catalog.md](../../specs/modules/catalog.md).

## 2026-07-19 — Marketplace moved to public launch

**Decided:** 2026-07-19

The original roadmap deferred the marketplace. Once the module substrate and first
commercial module became real during dogfooding, the remaining work was commerce and
distribution plumbing rather than speculation.

The official marketplace therefore became a public-launch capability, proven first
through Resonant IQ's own installation path. It remains additive: the AGPL core holds no
marketplace credentials, licensing does not control runtime execution, and commercial
modules receive no private core capabilities.

See [specs/modules/marketplace-v1.md](../../specs/modules/marketplace-v1.md).

## 2026-07-23 — Managed-hosting proposal rejected

A managed-hosting design introduced on 2026-07-19 was based on a mistaken interpretation
of the project direction. Helpthread and its commercial modules are operator-deployed.
Resonant IQ does not host module runtimes or process operator conversation data.

The proposal was removed because it violated the charter's operator-ownership principle.
It is not part of Helpthread's product or architecture.

The original charter and its complete amendment record are preserved at
[docs/history/CHARTER-v1.md](../history/CHARTER-v1.md).

Future material decisions should record:

1. date and scope;
2. context;
3. decision;
4. alternatives considered;
5. consequences; and
6. superseded decisions, if any.
