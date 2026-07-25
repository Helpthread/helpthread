# Helpthread Legal and Licensing

This directory holds the legal instruments and policies that implement the
[Founding Charter](../CHARTER.md). It is not legal advice.

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

- [module API exception](module-api-exception.md); and
- [commercial module license](module-commercial-license.md).

## Provenance and trademarks

- [Provenance policy](provenance-policy.md) records the independent-implementation,
  dependency, DCO, and AI-assisted-development rules.
- [Trademark policy](trademark-policy.md) governs the Helpthread name and marks without
  restricting rights granted by the software license.

## What is and is not in force

The AGPL-3.0 core license is in force today. The
[module API exception](module-api-exception.md) is not: it takes effect only when
appended to the repository's `LICENSE`, and it must be adopted before the first
external code contribution is merged. The commercial module license applies to paid
modules on adoption, and the terms of sale that it cross-references are not yet
written.

Current delivery status and outstanding work belong in the
[Helpthread OSS Roadmap](https://github.com/orgs/Helpthread/projects/1).
Historical rationale is indexed in
[docs/decisions/README.md](../docs/decisions/README.md).
