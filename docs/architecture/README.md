# Helpthread Architecture

This document is the entry point to Helpthread’s current architecture. The
[Founding Charter](../../CHARTER.md) defines the enduring constraints; specifications
define today’s implementation.

## Platform posture

Helpthread is serverless-native and optimized first for Vercel and Supabase. Those
services are the founding deployment target, not the project’s identity.

Platform services sit behind Helpthread-owned interfaces when the boundary is
meaningful:

- queueing;
- scheduling and durable work;
- object storage;
- inbound communication; and
- outbound email.

See [the provider interface guide](../../src/providers/README.md).

## Communication model

The conversation model is channel-agnostic. Email is the founding channel.
Channel-specific behavior stays at the boundary while conversations retain durable
participants, messages, events, ownership, provenance, and history.

The mail engine’s detailed contracts live in:

- [inbound ingestion](../../specs/mail/inbound-ingestion.md);
- [threading](../../specs/mail/threading.md);
- [outbound sending](../../specs/mail/sending.md); and
- [Gmail push transport](../../specs/mail/gmail-push.md).

## API and application model

The operator inbox, automation, AI, and future interfaces are clients of public
contracts. The maintained Agent Inbox contract lives in
[specs/api/agent-inbox-v1.md](../../specs/api/agent-inbox-v1.md).

The exact product surface and delivery state live in [STATUS.md](../../STATUS.md).

## Modules

Extensions use documented public boundaries. Out-of-process composition is preferred
when it provides a sufficient contract; build-time modules remain available for
capabilities that require deeper composition.

The canonical module documents are:

- [module substrate](../../specs/modules/substrate-v1.md);
- [open-core catalog](../../specs/modules/catalog.md);
- [marketplace](../../specs/modules/marketplace-v1.md); and
- [operator guides](../modules/README.md).

The legal boundary between the AGPL core and separately licensed modules is documented
in [legal/README.md](../../legal/README.md).

## Architecture decisions

Material decisions and their history are indexed in
[docs/decisions/README.md](../decisions/README.md). Superseded implementation details
belong there or in specification changelogs rather than in the charter.
