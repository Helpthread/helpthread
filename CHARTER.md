# Helpthread — Founding Charter

> **Helpthread is open-source support infrastructure.**
>
> It exists so organizations can own, extend, and operate the systems through which they support their customers.

## First Principles

### 1. The operator owns the system

Organizations should be free to own, operate, and extend the infrastructure through which they support their customers.

Operators decide where Helpthread runs, where its data lives, which providers it uses, which extensions it trusts, and when it changes. They should be able to inspect, extend, and replace parts of the stack without losing the conversations entrusted to it.

Ownership includes control over execution, configuration, integrations, customization, and upgrade timing. Changes to Helpthread must preserve meaningful operator choice.

### 2. Conversations are the source of truth

Support begins with a conversation between an organization and its customer.

Tickets, assignments, statuses, workflows, summaries, and reports organize or interpret that conversation. They do not replace it. Helpthread preserves the original record—its participants, provenance, sequence, and history—so future applications can interpret it without obscuring what occurred.

Communication correctness is therefore a core responsibility.

### 3. Infrastructure outlives applications

Interfaces, workflows, channels, providers, and AI systems will change. The underlying records and contracts should remain dependable.

Helpthread invests first in durable primitives: conversations, participants, identities, messages, events, routing, storage, and public contracts. Interfaces and optional capabilities build upon those primitives through the same platform available to everyone.

## Project Commitments

These commitments turn the first principles into practical product and engineering constraints.

### Operator ownership

Helpthread preserves meaningful operator choice over deployment, data, configuration, credentials, integrations, extensions, and AI providers.

Operators choose the infrastructure providers through which they operate Helpthread. Those providers may offer managed infrastructure, but Helpthread has no project-operated data path: conversation data stays within the infrastructure and services the operator selects.

The operator-owned deployment path must remain real, documented, and functionally credible.

### The core stays open

The Helpthread core is AGPL-3.0 free software. Contributors retain copyright in their work and contribute it under the same license the project gives everyone else.

Capabilities released as part of the free core are not later withdrawn behind a commercial license. Commercial offerings may add modules, updates, support, or other conveniences. They do not subtract from the open core.

Helpthread sustains itself through commercial software and services around the core, not by selling exceptions to the core’s license.

### Conversation integrity

Helpthread preserves the fidelity, provenance, and durable history of conversations.

Every message records who or what authored it, how it arrived, and where it belongs. Threading authority derives from evidence Helpthread can verify. Changes to communication behavior require fixtures, reproducible proof, or an explicit written decision—not intuition alone.

Email is the founding channel, so its mature semantics and accumulated edge cases deserve particular respect. The rule is broader than email: correctness follows the conversation across every channel.

The following are never traded for speed, convenience, or a convincing demonstration:

1. Never lose or corrupt a message.
2. Threading correctness outranks feature velocity.
3. Authorship and provenance remain explicit.
4. Communication semantics do not change silently.

### Public APIs and events

Anything a first-party interface can do must also be possible through a documented public contract.

The operator inbox is a client. Automation is a client. AI is a client. Future interfaces are clients.

Meaningful state changes emit meaningful events. Public contracts expose enough context and provenance for operators and extensions to understand what happened without relying on private implementation details.

### Replaceable providers

External services are dependencies, not identities.

Helpthread owns the interfaces at its platform boundaries. Providers implement those interfaces. A first-class provider may receive an excellent, deeply tested experience without becoming inseparable from the core.

Replacement does not need to be effortless. It must remain architecturally possible.

### Extensibility without privilege

Meaningful ownership includes the ability to extend the system.

First-party, community, and private extensions use the same public mechanisms. If a first-party module needs a new capability, that capability belongs in the public extension model. Commercial code receives no hidden privileges.

Extension points exist because the platform needs them, not as private accommodations for particular modules.

The boundary between the AGPL core and separately licensed modules must be explicit, documented, and equally available to everyone. Repository separation alone does not define that boundary.

### Infrastructure before applications

The core provides durable primitives. Optional applications compose them into particular experiences.

Knowledge bases, AI assistants, analytics, reporting, and specialized workflows may integrate with or build upon Helpthread. They do not become part of the foundation merely because they are valuable.

When a capability can reasonably live outside the foundation, it should. Extensibility is preferred over completeness.

### Interfaces may change; contracts remain stable

No interface may become the only expression of a capability.

Public schemas, APIs, events, and extension contracts evolve deliberately and compatibly. Internal implementations may change freely while their public meaning remains stable.

### Provenance must be defensible

Helpthread is an independent implementation.

Code entering the shipping tree must have a clear and compatible origin. Behavior may be learned from public standards, public documentation, permissively licensed references, and black-box observation—not by copying code under an incompatible license.

Defensible provenance protects users, contributors, the open-source license, and the commercial ecosystem.

### Operational simplicity

Organizations adopt Helpthread to support their customers, not to operate support software.

The system should be understandable when inspected and unobtrusive when working. Added operational complexity must provide a clear benefit in reliability, capability, or operator choice.

## Non-Goals

Helpthread is not:

- a CRM
- a customer success platform
- a marketing or sales platform
- a business or customer intelligence platform
- a team chat application
- an all-in-one business suite

These systems may integrate with or build upon Helpthread. They are not Helpthread.

This boundary describes the product, not the conversations it may carry. Helpthread may support sales, onboarding, success, internal service, or other conversations without becoming the system that manages those business functions.

Helpthread is also not defined by:

- a particular industry or business model
- the word “customer” as the only name for a person being served
- a single communication channel
- a single deployment provider
- a single user interface
- a single AI provider or model

Support is Helpthread’s purpose and category. Its architecture must not confuse its first market, channel, or implementation with the permanent boundary of the system.

## Architecture

Architecture records today’s consequences of the charter. It may change as long as the first principles and project commitments remain intact.

### Founding deployment posture

Helpthread is serverless-native and optimized first for Vercel and Supabase because that is where it was created and first operated.

Queueing, scheduled and durable work, object storage, inbound communication, and similar services sit behind Helpthread-owned provider interfaces when those interfaces preserve a meaningful boundary.

Vercel and Supabase are the founding deployment target, not the definition of Helpthread. Every additional supported target becomes an enduring compatibility and testing commitment.

### Conversation model

The conversation model is channel-agnostic. Email is the founding channel, but storage and public contracts do not assume it is the only way a message can arrive.

A conversation is composed of participants, messages, events, ownership, and history. Channel-specific behavior belongs at the boundary.

### Actor model

Authorship and provenance are explicit. Human staff, external participants, automated systems, and AI assistants are never silently conflated.

AI may draft, summarize, route, or act through public contracts. Its work remains attributable, reviewable when policy requires it, and subject to the same operator choice as any other provider.

### Application and module model

Helpthread supports build-time modules and out-of-process integrations through documented public boundaries. Out-of-process composition is preferred when it provides a clean and sufficient contract.

First-party paid modules may exist. They are distributed to and deployed by the operator; Resonant IQ, Inc., the company that develops and stewards Helpthread, does not host their runtime or process their conversation data. The knowledge base is one such application: the core may expose public knowledge interfaces and integration hooks, while authoring, publishing, presentation, and management remain module capabilities.

Commercial licensing may govern access to downloads, updates, or support. It must not turn installed software into a remote-controlled runtime. A lapsed license may end access to future value; it does not disable software already in the operator’s possession.

### Founding product surface

The free core includes the conversation engine, threading, identity, assignment, durable history, an operator inbox, public APIs and events, and the infrastructure needed to operate them.

The exact API surface and product roadmap belong in maintained specifications. They are not frozen by this charter.

## Stewardship and Amendments

The current governance model belongs in the project’s governance documentation. It may evolve without changing this charter.

Resonant IQ, Inc. stewards the Helpthread name, official distribution channels, marketplace, and its own contributions. This stewardship does not grant it private capabilities within the open core or ownership of contributors’ work.

Changes to implementation follow the normal development process. Changes to this charter require:

1. a written proposal identifying the principle or rule affected;
2. the reason the existing charter no longer produces the right decision;
3. the alternatives considered;
4. an explicit decision recorded in the amendment history.

An amendment should clarify or deliberately change the project’s identity—not document a feature or ordinary architectural choice.

The first principles may be amended only when the project deliberately chooses to become something materially different. Project commitments may evolve when experience shows that they no longer protect those principles. Architecture changes through ordinary design work.

## Success

Helpthread succeeds when organizations can build and operate the support systems they need without giving up meaningful choice or control.

> **Technology will change. These principles should not.**

## Amendment History

### 2026-07-23 — Founding Charter v2 adopted

This charter replaced the original founding document after the project clarified its identity as open-source support infrastructure. The original charter and its amendment history remain available at [`docs/history/CHARTER-v1.md`](docs/history/CHARTER-v1.md).

Future entries record the date, scope, decision, and rationale for each adopted amendment. Superseded implementation decisions move to the [decision log](docs/decisions/README.md) rather than accumulate here.
