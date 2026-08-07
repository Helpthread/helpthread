# Mail Threading Spec

Status: draft. Governs how inbound email is assigned to a conversation/thread lineage. Under the charter's "Conversation integrity" rule, threading correctness outranks feature velocity.

## 1. Purpose & principle

Threading authority lives on the outbound side under the charter's "Conversation integrity" rule. `In-Reply-To` and `References` (RFC 5322 §3.6.4) are written by every mail client on earth, inconsistently — they are not something the engine controls and cannot be trusted as evidence on their own. The one header the engine fully controls is the Message-ID it mints on its own outbound mail. So the engine embeds a signed token in every outbound Message-ID, and threading a reply back in means finding and verifying that token — never interpreting subject text, never blindly trusting whatever a client echoed back. If no token verifies, the message is a new conversation, full stop. This preserves proven mail behavior without reverse-engineering or trusting inbound header content we did not produce.

## 2. The reply token

Every outbound message (agent reply, auto-response, and any future first-party auto-reply) embeds a signed token in its `Message-ID`. Format (implemented in `src/mail/reply-token.ts`):

```
<ht.{keyId}.{conversationId}.{threadId}.{sig}@{mailDomain}>
```

where `sig = base64url( HMAC-SHA256( secret, "{keyId}.{conversationId}.{threadId}"))` — the full 32-byte HMAC, base64url-encoded, unpadded (not truncated; the extra bytes are trivial inside a Message-ID and full length is the safest choice). The `keyId` names the signing key and is itself part of the signed payload, so a token's key cannot be swapped without invalidating it. `mailDomain` is not signed (it is not part of threading identity). The id fields are constrained at mint time to `[A-Za-z0-9_-]` (the base64url alphabet, excluding the `.` delimiter), so a well-formed local part splits unambiguously into five segments. This is Helpthread's own design, not derived from any observed system's internals — we only observed a black-box Message-ID *shape*, never a secret or algorithm.

The properties that ARE the spec, independent of encoding:

- **(a) Unguessable without the secret** — not forgeable by an attacker who has seen valid tokens (cf. §3 rule 3).
- **(b) Verifiable offline** — no DB round-trip to detect tampering; pure computation against the signing secret(s).
- **(c) Carries the conversation+thread identity** — a verified token deterministically identifies its conversation/thread; no lookup table of issued tokens required.
- **(d) Rotation-tolerant** — the signing secret must be rotatable without invalidating outstanding tokens. **Resolved: `keyId` ships in v1.** A keyring has one `current` key (mints and verifies) and zero or more `retired` keys (verify only); rotating means retiring the old key and promoting a new `current`, which never invalidates tokens already in customers' mailboxes. Dropping a key from the ring entirely stops its tokens from verifying.

**Contrast with the observed reference format.** The fixtures show a reference helpdesk emitting Message-IDs shaped like `<FS_reply-{threadId}-{token}@{domain}>` — e.g. `<FS_reply-36-{token}@helpdesk.example.test>` (reply-with-reference.json, `agentReplyEmail.messageId`; the token value in the committed fixtures is a redacted placeholder — the real capability token is never published). Notably `{threadId}` there is a *thread* id (36), not the conversation id (15) — conversation is resolved via the thread's parent, not encoded directly. This is cited only as evidence the "signed token in the outbound Message-ID" pattern works in production (charter's "Conversation integrity" rule); Helpthread's `sig` derivation, secret, and truncation are unrelated to whatever that system does internally, which was never observed.

## 2a. The token also rides in `References`

**Resolved with live production evidence on 2026-07-17.** §2 describes the token embedded in the outbound `Message-ID`; that remains true and unchanged. But `Message-ID` is not guaranteed to survive transmission unaltered: Gmail's `users.messages.send` accepted the engine's verbatim-set `Message-ID` on the request and REPLACED it on the wire with a Gmail-generated id (`<CAKWkAL3...@mail.gmail.com>` — confirmed from the raw copy Gmail itself returned on reconcile of the sent message's self-echo). This is not a violation of the `EmailSender` contract (specs/mail/sending.md §4, `src/providers/email-sender.ts`) — the adapter transmitted `Message-ID` verbatim as required; the rewrite happens server-side, downstream of transmission, outside any adapter's control. Its effect on threading is the same either way: the customer's reply carried `In-Reply-To`/its trailing `References` entry pointing at Gmail's substituted id, with our token nowhere on the wire — `decideThreading` correctly found no verified token and (§3 rule 4, invariant #5) started a NEW conversation instead of appending. Tonight's failure is preserved as a fixture reproducing it exactly: `src/mail/ingest.test.ts`'s "the exact live-production failure" test.

**The fix: the outbound reply's own minted `messageId` ALSO rides as the FINAL entry of that reply's own `References` header** (`src/mail/send.ts`, `sendReply`), appended after any ancestor ids — unconditionally, even on a first reply with no ancestors (a one-element `References: [messageId]`). `References`, unlike `Message-ID`, is not rewritten by Gmail. An RFC-5322-compliant reply's own `References` is built as `{original References} + {original Message-ID}` (§3.6.4) — so when the customer replies, their client's `References` becomes `[...ourOutboundReferences, gmailRewrittenId]`, i.e. `[...ancestors, ourMintedToken, gmailRewrittenId]`. The token lands ONE POSITION BEFORE the trailing foreign id — never last, never in `In-Reply-To` (which still correctly names the specific ancestor message being answered, not this reply's own id — left unchanged by this fix).

**Zero threading-decision code changed.** §3's algorithm already scans `References` newest-first (`src/mail/thread.ts`'s `buildCandidates`, reversing wire order before scanning) — exactly what is needed to skip the foreign trailing id and find our token immediately behind it. This section moves *where the token rides on the outbound side*; it does not touch how an inbound decision is made, does not add a heuristic, and does not weaken "no verified token ⇒ new conversation." Verified, not assumed: `src/mail/thread.ts` is unmodified by, and the fixture above passes through the existing scan unchanged.

**Every future outbound reply therefore carries the token TWICE** — once in `Message-ID` (§2, the primary channel, un-rewritten by providers that respect the `EmailSender` contract) and once as the final `References` entry (§2a, the provider-durable backup channel). Either surviving to the customer's reply is sufficient for `decideThreading` to append correctly; both surviving is redundant, not conflicting (the newest-first scan tries `In-Reply-To` first, so an un-rewritten `Message-ID`/`In-Reply-To` pair is still found first when it survives).

**Review-fix amendment: this section's own reply also reflects back into its own mailbox — a SEPARATE guard, not this section's scan, closes it.** Putting the token in `References` unconditionally means the SENT message's own self-echo (Gmail delivers a sent message into the mailbox it was sent from; `src/mail/gmail-reconcile.ts` ingests it like any other inbound message) now ALSO carries a verifiable token in `References` — and `inbound-ingestion.md` §5's `Message-ID`-based loop guard (`isOwnMessageReflection`) cannot catch it, for the exact reason this section exists: Gmail rewrites the self-echo's `Message-ID` too. Left unguarded, that self-echo would `append` into its own conversation as a phantom inbound message. This is NOT fixed by touching `decideThreading` or this section's scan (doing so would also misfire on a customer's legitimate autoresponder reply, which carries our token in `References` the exact same way) — it is fixed one layer earlier, in the delivery ledger itself, before `decideThreading` ever runs: see `inbound-ingestion.md` §5's " amendment" for the full mechanism (`src/mail/send.ts`'s `preSuppressOwnSend`) and its one known residual race.

## 3. Inbound threading decision — the algorithm

Ordered, testable procedure applied to every inbound message:

1. **Extract candidate tokens from `In-Reply-To`, then each `References` entry, most-recent-first.** `In-Reply-To` names the specific message being replied to; `References` accumulates over a conversation's life, so scanning newest-first reaches what the customer is most immediately replying to before older entries. Evidence: reply-with-reference.json's `agentReplyEmail.references` field shows the list growing across replies (`<...@example.test> <FS_reply-31-9cbef04c5307d744@helpdesk.example.test>`) alongside a distinct `In-Reply-To` — proving both headers carry independent candidates and References accumulates over time.
2. **For each candidate matching our Message-ID pattern, verify the signature; the first VALID token wins → append to that conversation/thread lineage.** Evidence: reply-with-reference.json — a reply's `In-Reply-To`/`References` pointed at the helpdesk's prior reply Message-ID and the conversation's thread count grew 3→4 with `appendedToSameConversation: true`.
3. **If a candidate matches our pattern but FAILS signature verification, it is forged/corrupted: do not thread on it.** Treat it as absent and continue scanning remaining candidates; only fall through to rule 4 once all candidates are exhausted. Record a security-relevant event (forged-token observed; see §5). Evidence: forged-reply-token.json — a tampered token (altered from a genuine one captured in the base run) did not append to the real conversation (`appendedToRealConversation: false`; conversation 15's thread count held at 4 before and after); a new conversation (id 20) was created instead. The forged value differed from the genuine one by only a few characters yet was rejected, which shows the reference system checks token *integrity* rather than merely pattern-matching the `FS_reply-…` shape. (Black-box observation can't tell us *how* — HMAC signature, opaque store lookup, or otherwise — and this spec doesn't claim to know; Helpthread's own design, §2, uses an HMAC signature to get the same rejection guarantee.)
4. **If no valid token is found in any header, this is a NEW conversation — regardless of subject.** Subject is NEVER used to thread. Evidence: reply-subject-only.json — a `Re:`-prefixed reply with matching subject and no reference headers produced a *separate* conversation (`outcome: "split"`, new id 17 distinct from original 16). Evidence: same-subject-different-customer.json — a second message with the exact same subject as an existing conversation and no reference headers produced its own conversation (`outcome: "own-conversation"`, id 19, distinct from 14); its correction note shows this held even though the sender turned out to be the *same* customer (Gmail flattens plus-addressed From to the canonical address) — neither subject nor sender identity merged them.
5. **A valid token threads even when the subject is completely unrelated.** The signed token is the sole threading authority; subject carries zero weight once a token verifies. Evidence: token-authority.json — a reply carrying the genuine token from reply-with-reference.json but subject `"Completely unrelated subject [...]"` still appended to conversation 15 (`appendedToRealConversation: true`, thread count 4→5, `newConversation: null`).

## 4. What is deliberately NOT done

- **No subject-based threading**, under any condition, including exact matches and `Re:` prefixes (§3 rule 4; reply-subject-only.json, same-subject-different-customer.json).
- **No fuzzy/heuristic matching of quoted bodies.** Quoted-text detection is a known source of false-positive threading; out of scope entirely, not a fallback when token matching fails.
- **No trusting `References`/`In-Reply-To` values that don't contain one of our verified tokens.** A header that merely *looks* like a threading reference but matches no signed token carries no authority — inert, not a weaker signal.

Rationale: the charter's "Conversation integrity" rule draws the line at *reproducing proven behavior*, not *reverse-engineering or second-guessing inbound headers* clients write inconsistently. Heuristic threading would trade a deterministic, testable rule for a guess.

## 5. Edge cases & open questions

- **Multiple valid tokens across `References` pointing at DIFFERENT conversations.** Not observed. Per rule 1's most-recent-first scan, the first valid token wins by construction. **OPEN QUESTION:** confirm most-recent-wins is intended — plausible since it reflects what the customer is immediately replying to, but needs its own acceptance fixture before it's load-bearing.
- **A valid token to a CLOSED/archived conversation.** **RESOLVED** at the store layer (`src/store/conversations.ts`, `ConversationStore.appendThread`): the thread is inserted and the conversation reopens (`status` back to `'open'`). A reply to a resolved ticket lands back in the same conversation rather than forking a duplicate.
- **A valid token to a deleted conversation.** **RESOLVED** at the store layer: nothing is inserted; `appendThread` returns a `deleted` result and the caller (the mail-ingestion pipeline) is expected to fall back to starting a fresh conversation, so the message is never silently dropped (invariant #1) but also never resurrects a conversation an operator intentionally removed. A missing conversation id (token verifies, but no such conversation row exists at all) is handled the same shape, with a distinct `not-found` result.
- **Forged-token rate-limiting/alerting.** forged-reply-token.json proves detection works; it says nothing about response. A single forgery is unremarkable; a burst against one conversation or sender is a security signal. **OPEN QUESTION:** threshold/alerting mechanism unspecified — security follow-up, not blocking v1 correctness.
- **`keyId` rotation.** See §2(d).
- **Auto-Submitted mail creates conversations.** auto-submitted.json: a message with `Auto-Submitted: auto-replied` was ingested normally, creating conversation 18 — not suppressed. In scope here only insofar as such mail runs through the algorithm above; whether Helpthread should suppress or specially route it (to avoid reply loops when its own auto-response gets auto-answered) is cross-referenced to a future auto-responder spec.
- **HTML `<script>` tag stored verbatim.** html-body.json: an inbound body containing `<script>alert(1)</script>` was stored and returned raw, unsanitized. Threading doesn't own sanitization, but this is a security flag: storage must not assume the reader sanitizes, and a dedicated sanitization spec is needed before HTML bodies render anywhere untrusted.

## 6. Acceptance fixtures

The mail engine implementation must pass an acceptance suite derived from these observed fixtures in `fixtures/mail/observed/`:

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
