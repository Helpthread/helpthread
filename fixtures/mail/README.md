# Mail-behavior acceptance fixtures

These fixtures define the **mail behavior Helpthread's engine must exhibit** —
they are the acceptance criteria the mail engine (and its threading logic, per
[`specs/mail/threading.md`](../../specs/mail/threading.md)) is tested against.
Each records an input scenario and the expected conversation/threading outcome.

## What they assert

- `new-conversation` — a fresh inbound email opens a new conversation.
- `reply-with-reference` — a reply carrying a valid signed reply token threads
  into the same conversation.
- `token-authority` — a valid token threads even when the subject is unrelated;
  the token, not the subject, is the threading authority.
- `forged-reply-token` — a tampered token is rejected and opens a new
  conversation; the token is verified, not merely pattern-matched.
- `reply-subject-only` / `same-subject-different-customer` — a matching subject
  with no valid token never threads; subject is never a threading signal.
- `auto-submitted` — auto-submitted mail still creates a conversation.
- `html-body` — an inbound HTML body (including a `<script>` tag) is captured
  verbatim, establishing that the engine — not the reader — must sanitize.

## Provenance

These outcomes were captured by **black-box observation** of a running
reference helpdesk (facts about behavior, recorded via its API), used to
validate the threading spec and surface real-world edge cases. Token values and
personal data are redacted to deterministic placeholders. This is behavioral
ground truth only — Helpthread's implementation is its own (see the charter's
provenance section). The observation tooling itself is not part of this repo;
Helpthread's own end-to-end mail tests will point at a Helpthread instance.
