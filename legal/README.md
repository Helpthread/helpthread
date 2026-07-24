# Helpthread Legal and Licensing

This directory holds the legal instruments and policies that implement the
[Founding Charter](../CHARTER.md). It is not legal advice; the marked drafts require
counsel review before their stated gates.

## Core and contributions

The Helpthread core is licensed under AGPL-3.0. Contributions use the Developer
Certificate of Origin: contributors retain copyright, the inbound license matches the
outbound license, and there is no CLA or copyright assignment.

The project deliberately does not sell exceptions to the core license. Its commercial
model is additive software and services around the core.

## Module boundary

Separately licensed modules must integrate through documented public boundaries
available equally to first-party, community, and private extensions.

For modules that form a combined program with the core, the AGPL-3.0 §7 additional
permission is the legal mechanism defining that boundary. Repository separation alone
does not do so. Out-of-process integrations generally do not need the exception.

See:

- [module API exception](module-api-exception.md);
- [commercial module license](module-commercial-license.md); and
- [module catalog](../specs/modules/catalog.md).

## Provenance and trademarks

- [Provenance policy](provenance-policy.md) records the independent-implementation,
  dependency, DCO, and AI-assisted-development rules.
- [Trademark policy](trademark-policy.md) governs the Helpthread name and marks without
  restricting rights granted by the software license.

## Review gates

Before accepting external code contributions:

- counsel-finalize the module API exception.

Before public launch or taking marketplace revenue, as applicable:

- complete trademark and entity approvals;
- finalize the commercial module license and terms of sale.

Current delivery status and outstanding work belong in [STATUS.md](../STATUS.md).
Historical rationale is indexed in
[docs/decisions/README.md](../docs/decisions/README.md).
