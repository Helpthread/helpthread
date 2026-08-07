# Helpthread Project History

Helpthread began when Resonant IQ replaced its own FreeScout installation with support
software designed for the Vercel and Supabase stack it already operated.

Help Scout established the experience bar: support should feel effortless for both the
customer and the operator. FreeScout demonstrated real demand for a self-hosted
alternative and provided an inspectable behavioral reference, but its daemon-based PHP
architecture and runtime extension model did not fit Resonant IQ's stack.

Helpthread's founding implementation therefore combined:

- Help Scout as a usability reference;
- FreeScout as evidence of demand and a black-box behavioral reference;
- operator choice over deployment, data, providers, and extensions; and
- serverless, push-based infrastructure with no long-running mailbox pollers.

Helpthread is an independent implementation. Reference products inform experience and
observable behavior, never copied code.

The project was dogfooded first as Resonant IQ's production support system. That origin
remains important, but it does not define Helpthread's permanent market or architecture.

## Archived founding document

[CHARTER-v1.md](CHARTER-v1.md) is the complete original charter, written on 2026-07-09
before the first code commit. It includes the original mission, architecture, roadmap,
licensing rationale, sacred invariants, governance, and amendments through 2026-07-19.

It was superseded by the current [Founding Charter](../../CHARTER.md) on 2026-07-23.
The archive remains historical evidence, not current authority.

The archived July 19 managed-hosting amendment was rejected on 2026-07-23. It resulted
from a mistaken interpretation of the project direction and conflicts with operator
ownership. Helpthread and its modules are operator-deployed; Resonant IQ does not host
their runtimes or process operator conversation data.
