# Mail Threading Spec

Status: draft. Governs how inbound email is assigned to a conversation/thread lineage. Sacred invariant #3 (charter §6): threading correctness outranks feature velocity.

## 1. Purpose & principle

Threading authority lives on the outbound side (charter §2). `In-Reply-To` and `References` (RFC 5322 §3.6.4) are written by every mail client on earth, inconsistently — they are not something the engine controls and cannot be trusted as evidence on their own. The one header the engine fully controls is the Message-ID it mints on its own outbound mail. So the engine embeds a signed token in every outbound Message-ID, and threading a reply back in means finding and verifying that token — never interpreting subject text, never blindly trusting whatever a client echoed back. If no token verifies, the message is a new conversation, full stop. This is "boringly faithful" in the charter §2 sense: reproducing the proven shape of a mechanism ("signed reply tokens in outbound Message-IDs... a pattern as old as mailing-list software," charter §2) without reverse-engineering or trusting inbound header content we didn't produce.

## 2. The reply token

Every outbound message (agent reply, auto-response, and any future first-party auto-reply) embeds a signed token in its `Message-ID`. Proposed format:

```
<ht.{conversationId}.{threadId}.{sig}@{mailDomain}>
```

where `sig = HMAC(secret, canonical(conversationId, threadId))`, truncated and hex/base32-encoded. This is Helpthread's own design, not derived from any observed system's internals — we only observed a black-box Message-ID *shape*, never a secret or algorithm.

The properties that ARE the spec, independent of encoding:

- **(a) Unguessable without the secret** — not forgeable by an attacker who has seen valid tokens (cf. §3 rule 3).
- **(b) Verifiable offline** — no DB round-trip to detect tampering; pure computation against the signing secret(s).
- **(c) Carries the conversation+thread identity** — a verified token deterministically identifies its conversation/thread; no lookup table of issued tokens required.
- **(d) Rotation-tolerant** — the signing secret must be rotatable without invalidating outstanding tokens, implying a `keyId` alongside the signature. **OPEN QUESTION:** does `keyId` ship in v1, or wait for the first rotation?

**Contrast with the observed reference format.** The fixtures show a reference helpdesk emitting Message-IDs shaped like `<FS_reply-{threadId}-{token}@{domain}>` — e.g. `<FS_reply-36-8aefc3079fafdbb9@helpdesk.example.test>` (reply-with-reference.json, `agentReplyEmail.messageId`). Notably `{threadId}` there is a *thread* id (36), not the conversation id (15) — conversation is resolved via the thread's parent, not encoded directly. This is cited only as evidence the "signed token in the outbound Message-ID" pattern works in production (charter §2); Helpthread's `sig` derivation, secret, and truncation are unrelated to whatever that system does internally, which was never observed.

## 3. Inbound threading decision — the algorithm

Ordered, testable procedure applied to every inbound message:

1. **Extract candidate tokens from `In-Reply-To`, then each `References` entry, most-recent-first.** `In-Reply-To` names the specific message being replied to; `References` accumulates over a conversation's life, so scanning newest-first reaches what the customer is most immediately replying to before older entries. Evidence: reply-with-reference.json's `agentReplyEmail.references` field shows the list growing across replies (`<...@example.test> <FS_reply-31-9cbef04c5307d744@helpdesk.example.test>`) alongside a distinct `In-Reply-To` — proving both headers carry independent candidates and References accumulates over time.
2. **For each candidate matching our Message-ID pattern, verify the signature; the first VALID token wins → append to that conversation/thread lineage.** Evidence: reply-with-reference.json — a reply's `In-Reply-To`/`References` pointed at the helpdesk's prior reply Message-ID and the conversation's thread count grew 3→4 with `appendedToSameConversation: true`.
3. **If a candidate matches our pattern but FAILS signature verification, it is forged/corrupted: do not thread on it.** Treat it as absent and continue scanning remaining candidates; only fall through to rule 4 once all candidates are exhausted. Record a security-relevant event (forged-token observed; see §5). Evidence: forged-reply-token.json — a tampered token (`<FS_reply-36-3cfea8079fafdbb9@...>`, altered from the genuine `<FS_reply-36-8aefc3079fafdbb9@...>`) did not append to the real conversation (`appendedToRealConversation: false`; conversation 15's thread count held at 4 before and after); a new conversation (id 20) was created instead. This also proves the reference system validates the signature rather than pattern-matching the token shape, since the forged value differs by only a few characters yet was rejected.
4. **If no valid token is found in any header, this is a NEW conversation — regardless of subject.** Subject is NEVER used to thread. Evidence: reply-subject-only.json — a `Re:`-prefixed reply with matching subject and no reference headers produced a *separate* conversation (`outcome: "split"`, new id 17 distinct from original 16). Evidence: same-subject-different-customer.json — a second message with the exact same subject as an existing conversation and no reference headers produced its own conversation (`outcome: "own-conversation"`, id 19, distinct from 14); its correction note shows this held even though the sender turned out to be the *same* customer (Gmail flattens plus-addressed From to the canonical address) — neither subject nor sender identity merged them.
5. **A valid token threads even when the subject is completely unrelated.** The signed token is the sole threading authority; subject carries zero weight once a token verifies. Evidence: token-authority.json — a reply carrying the genuine token from reply-with-reference.json but subject `"Completely unrelated subject [...]"` still appended to conversation 15 (`appendedToRealConversation: true`, thread count 4→5, `newConversation: null`).

## 4. What is deliberately NOT done

- **No subject-based threading**, under any condition, including exact matches and `Re:` prefixes (§3 rule 4; reply-subject-only.json, same-subject-different-customer.json).
- **No fuzzy/heuristic matching of quoted bodies.** Quoted-text detection is a known source of false-positive threading; out of scope entirely, not a fallback when token matching fails.
- **No trusting `References`/`In-Reply-To` values that don't contain one of our verified tokens.** A header that merely *looks* like a threading reference but matches no signed token carries no authority — inert, not a weaker signal.

Rationale: charter §2's "boringly faithful on mail semantics" principle draws the line at *reproducing proven behavior*, not *reverse-engineering or second-guessing inbound headers* clients write inconsistently. Heuristic threading is exactly the kind of "improvement" the charter's origin story (well-intentioned mail-handling changes that silently destroyed content) warns against — trading a deterministic, testable rule for a guess.

## 5. Edge cases & open questions

- **Multiple valid tokens across `References` pointing at DIFFERENT conversations.** Not observed. Per rule 1's most-recent-first scan, the first valid token wins by construction. **OPEN QUESTION:** confirm most-recent-wins is intended — plausible since it reflects what the customer is immediately replying to, but needs its own acceptance fixture before it's load-bearing.
- **A valid token to a CLOSED/archived conversation.** Not observed. **OPEN QUESTION:** reopen, or start a new conversation referencing it? Reopen matches the charter's Help Scout-like ease-of-use bar but is undecided.
- **A valid token to a deleted conversation.** Not observed. Token verifies but its target is gone — must not crash or silently drop mail (invariant #1). **OPEN QUESTION:** likely "create a new conversation, log the orphaned-token event," undecided.
- **Forged-token rate-limiting/alerting.** forged-reply-token.json proves detection works; it says nothing about response. A single forgery is unremarkable; a burst against one conversation or sender is a security signal. **OPEN QUESTION:** threshold/alerting mechanism unspecified — security follow-up, not blocking v1 correctness.
- **`keyId` rotation.** See §2(d).
- **Auto-Submitted mail creates conversations.** auto-submitted.json: a message with `Auto-Submitted: auto-replied` was ingested normally, creating conversation 18 — not suppressed. In scope here only insofar as such mail runs through the algorithm above; whether Helpthread should suppress or specially route it (to avoid reply loops when its own auto-response gets auto-answered) is cross-referenced to a future auto-responder spec.
- **HTML `<script>` tag stored verbatim.** html-body.json: an inbound body containing `<script>alert(1)</script>` was stored and returned raw, unsanitized. Threading doesn't own sanitization, but this is a security flag: storage must not assume the reader sanitizes, and a dedicated sanitization spec is needed before HTML bodies render anywhere untrusted.

## 6. Acceptance fixtures

The mail engine implementation (a later ticket) must pass an acceptance suite derived from these observed fixtures, carried forward from the HT-7 branch to `fixtures/mail/observed/` on `main`:

| Rule | Fixture |
|---|---|
| §3 rule 2 — valid token threads into same conversation | `fixtures/mail/observed/reply-with-reference.json` |
| §3 rule 3 — forged token does not thread; new conversation created | `fixtures/mail/observed/forged-reply-token.json` |
| §3 rule 4 — no token, subject-only reply → new conversation | `fixtures/mail/observed/reply-subject-only.json` |
| §3 rule 4 — no token, identical subject (even same sender) → new conversation | `fixtures/mail/observed/same-subject-different-customer.json` |
| §3 rule 5 — valid token wins over unrelated subject | `fixtures/mail/observed/token-authority.json` |
| Baseline — fresh message, no headers → new conversation | `fixtures/mail/observed/new-conversation.json` |
| Cross-ref — Auto-Submitted mail still creates a conversation | `fixtures/mail/observed/auto-submitted.json` |
| Cross-ref — HTML/script body stored verbatim (sanitization spec, not threading) | `fixtures/mail/observed/html-body.json` |

Each row is a minimum bar, not a ceiling: the suite should assert both the observed outcome (conversation, thread-count delta) and the specific rule from §3 that produced it, so a change that reaches the right conversation via the wrong rule (e.g. accidentally matching on subject) still fails.
