# Spam classification

**Status: PARTIALLY BUILT.** §3.1 and §4 are implemented and tested (the provider
verdict, Gmail's half of it, and the status decision at ingest). §3.2 (header-derived
signals), §5 (the reclassification loop) and §6 (operator controls) are specified but
**not built**. Every blocking decision is now made — §5.3 (corrections stay inside
Helpthread, never written back to the operator's mailbox) and §6 (classification starts
enabled and can be disabled) were answered by the maintainer on 2026-08-02 and are
recorded in §7's ledger. What remains unbuilt is implementation work,
not open questions.

Companion to [inbound-ingestion.md](./inbound-ingestion.md), whose three invariants this
spec is subordinate to, and [threading.md](./threading.md), whose reply-token decision
always outranks anything here. Status vocabulary is
[agent-inbox-v1.md](../api/agent-inbox-v1.md) §3a.

## 1. The problem this closes

Before this spec, `spam` was a status an Agent set by hand and nothing else — as
agent-inbox-v1.md §3a put it: "nothing classifies spam automatically in v1."

That was a deliberate v1 deferral, but it left a defect underneath it. The two intake
paths behaved differently, and neither behaviour was chosen:

- **IMAP** opens `INBOX` only (`src/providers/adapters/imap/client.ts`). Whatever the
  mail server filed as Junk was never fetched. Spam filtering by side effect.
- **Gmail** calls `history.list` with no `labelId` filter
  (`src/providers/adapters/gmail/history.ts`) — correctly, because filtering there would
  race the label application and drop real mail. But the only label check downstream was
  the self-echo filter. **A message Google had already put in `SPAM` became an ordinary
  `active` conversation in the inbox.** Google's verdict was computed, delivered to us,
  and thrown away.

An operator who connects a Gmail mailbox reasonably expects Gmail's spam filtering to
still apply. It did not.

## 2. What this is not

Helpthread does not build a spam classifier. Scoring message content is a large,
adversarial, permanently-maintained problem, and every mailbox we intake from is already
behind one. This spec is about **not discarding verdicts that already exist**, plus a small,
conservative set of header-derived signals for transports that supply no verdict.

Three constraints bound everything below:

1. **Nothing is ever dropped.** inbound-ingestion.md §1's third invariant is not
   negotiable. A spam decision changes one column on one row; the message is parsed,
   stored, threaded and attachment-linked identically either way. A false positive is
   always visible in the Spam folder and always recoverable.
2. **Our own reply token always wins.** If `decideThreading` matched a valid token, the
   message belongs to that conversation and the conversation's status is not this spec's
   business (§4.2).
3. **An Agent's judgment is never silently overruled.** Automatic classification decides
   where a *brand-new* conversation is filed. It never re-files a conversation a human
   already placed.

## 3. Signals

### 3.1 The provider verdict (BUILT)

`RawInboundMessage.providerSpamVerdict` (`src/providers/inbound-email.ts`) carries the
transport's own conclusion across the provider boundary. Three states:

| Value | Meaning |
|---|---|
| `'spam'` | The provider affirmatively classified the message as junk. |
| `'clean'` | The provider classified it and did not call it junk. |
| `'unknown'` | No verdict available — the provider does not classify, or omitted it on this delivery. |

Omitted entirely by a transport with no concept of a verdict; ingest reads an absent
field exactly as `'unknown'`.

`'clean'` and `'unknown'` produce the same outcome today (§4.1) but are kept distinct on
the wire: "we asked and it said no" is evidence, "we have no idea" is not, and §3.2's
header signals will need to tell them apart — header scoring should defer to an explicit
`'clean'` and should not defer to silence.

**Each transport must earn `'clean'`; no transport inherits it.** The table above defines
`'clean'` as an *affirmative* judgment, and "the provider sent us something and none of it
said spam" is not, on its own, that judgment. The two collapse only where the transport
classifies **every** message it delivers, so that the absence of a junk marker is itself
the verdict. That happens to hold for Gmail (below), which is why its implementation reads
a bare absence of `SPAM` as `'clean'` — but it holds *because of a property of Gmail*, not
because absence generally means clean. A transport that classifies only some of its mail,
or that marks junk only above a confidence threshold, must report `'unknown'` for the
unmarked remainder. Getting this wrong is invisible today, because §4.1 files `'clean'` and
`'unknown'` identically; it becomes load-bearing the moment §3.2's header scoring ships and
starts standing down in the presence of an explicit `'clean'`.

**Per transport:**

- **Gmail** (built, `spamVerdictOf` in `src/mail/gmail-reconcile.ts`): the system `SPAM`
  label ⇒ `'spam'`; any other non-empty label set ⇒ `'clean'`; an empty/absent `labelIds`
  ⇒ `'unknown'`, because the history client documents that Gmail does not guarantee the
  field is populated. This runs **after** the self-echo filter, so our own outbound reply
  that Gmail happened to file as junk is skipped entirely rather than filed as a spam
  conversation.

  Reading a bare absence of `SPAM` as `'clean'` is licensed by the rule above and by one
  specific fact: **Gmail classifies every message it accepts**, so a delivered message
  carrying labels but not `SPAM` has been assessed and cleared. This is the whole
  justification — it is not a default, and the next transport does not get it for free
  (§7, D6).

  **This is best-effort, not complete, and the boundary is worth stating precisely.**
  `history.list` is a delta stream, not a snapshot. The history client requests
  `labelAdded` alongside `messageAdded` and set-unions the label deltas
  (`src/providers/adapters/gmail/history.ts`), so a message that arrives labeled `INBOX`
  and is classified `SPAM` moments later — **within the same reconcile window** — is
  correctly seen as spam. What is *not* covered: a `SPAM` label applied **after** the
  window's `history.list` snapshot. That message has already been ingested as `active`,
  and the next reconcile deliberately ignores a `labelsAdded` record for an id it did not
  itself newly add (otherwise any re-labeling of any old message would manufacture an
  ingest). So it stays `active`.

  This is not a regression — before this spec, *every* spam message stayed `active` — but
  it means the feature must not be described as "Gmail's spam filtering now applies."
  It applies to mail Gmail had classified by the time we read the history window, which
  is the common case and not all cases. Closing the remainder is §5's reclassification
  problem, not something the intake path can solve.
- **IMAP** (built by omission): the client opens `INBOX`, so a server-side Junk move
  means the message is never fetched. The field is not supplied ⇒ `'unknown'`. This is
  the correct verdict: we genuinely do not know, because we never saw the message at all.
  Recorded here so the asymmetry with Gmail is documented rather than accidental.
- **A future forwarding-address transport**: whatever the receiving service reports. A
  transport that reports nothing supplies nothing.

### 3.2 Header-derived signals (NOT BUILT)

For a `'unknown'` verdict on a message we did receive, a small conservative set of
RFC-defined headers, evaluated at ingest after `parseInboundEmail`:

| Signal | Source | Weight |
|---|---|---|
| DMARC `fail` | `Authentication-Results` (RFC 7601), our own receiving hop only | Strong |
| SPF `fail` + DKIM `fail`, both | `Authentication-Results` | Strong |
| `Precedence: bulk` / `list` | RFC 2076 | Weak |
| `List-Unsubscribe` present **and** no prior conversation with this sender | RFC 8058 | Weak |
| `Auto-Submitted:` other than `no` | RFC 3834 | Weak — see below |

Two rules make this safe:

- **Only the receiving hop's `Authentication-Results` is trusted.** The header is
  sender-forgeable; every hop before ours is attacker-controlled. A message with no
  parseable `Authentication-Results` from our own hop contributes nothing, never a
  failure.
- **One strong signal, or two weak ones, classifies as spam.** A single weak signal never
  does. Legitimate mail is routinely `Precedence: bulk` (every receipt, every
  notification), and a customer who genuinely writes from a mailing list address is not
  junk.

`Auto-Submitted` deserves a carve-out rather than a weight: an auto-reply is not spam,
it is a bounce or an out-of-office. Suppressing those is
inbound-ingestion.md §5's loop-guard problem, not this spec's, and the two must not be
conflated. Listed here only to record that it was considered and routed elsewhere.

## 4. The decision (BUILT)

### 4.1 New conversations

At ingest, a brand-new conversation is created with `status = 'spam'` when the verdict is
`'spam'`, and `status = 'active'` otherwise (`'clean'`, `'unknown'`, absent). This is the
whole effect. `NewConversation.status` (`src/store/conversations.ts`) is narrowed to
exactly those two values: a conversation is never born `closed`, `pending`, or `deleted`.

Both creation sites apply it — a genuine `new` threading decision, and the
deleted/not-found fallback where a valid token named a conversation that is gone. The
fallback case is flagged as an open decision (§7, D2).

`conversation.created` and `conversation.message_received` fire for a spam conversation
exactly as for any other. A consumer that wants to ignore junk reads the status; events
are not silently withheld, because a webhook consumer that never learns a message
arrived cannot audit what we filed.

### 4.2 Replies to existing conversations

**The verdict has no effect on an existing conversation, ever.** A message that threads
onto one by valid reply token contributes its thread and nothing else; the verdict is not
read. Two reasons, either sufficient: our token is the stronger signal (we minted it, and
it proves we wrote to this address first), and the target's current status may be an
Agent's own deliberate placement.

That is a statement about **this spec's** input only, and it must not be read as "the
status cannot change." It can, by a rule that predates this spec and is untouched by it:
agent-inbox-v1.md §4a's reopen, which moves a `closed` or `spam` conversation to `active`
on any genuinely-new inbound thread (`appendThreadInTx`, `src/store/conversations.ts`).

Spelled out, because the composition is the part that is easy to get wrong:

| Target's status | Verdict on the arriving reply | Resulting status | Decided by |
|---|---|---|---|
| `active` | `'spam'` | `active` — unchanged | This spec: verdict not read on append |
| `active` | `'clean'` / `'unknown'` | `active` — unchanged | This spec: verdict not read on append |
| `spam` | `'spam'` | **`active` — reopened** | §4a's reopen rule, not this spec |
| `spam` | `'clean'` / `'unknown'` | **`active` — reopened** | §4a's reopen rule, not this spec |

The third row is the counter-intuitive one and it is deliberate: a message the provider
called junk, replying to a conversation we ourselves filed as junk, still reopens it. The
reply token proves we wrote to that address first, and a customer who answers is a
customer whatever a classifier thought of either message. Both `spam` rows are covered by
tests in `src/mail/ingest.test.ts`.

The practical consequence for an operator: a false positive self-heals the moment the
sender replies, and never needs the Spam folder to be checked for it to do so.

## 5. Reclassification (NOT BUILT)

### 5.1 The Agent's correction is the ground truth

An Agent moving a conversation out of `spam` is the only correction signal that matters.
It is already recorded by `setStatus`.

### 5.2 Sender allow-listing

A sender an Agent has rescued from spam should not be re-classified on their next
message. The intended mechanism is per-mailbox sender state, not a global list.

### 5.3 Feeding corrections back to the provider — DECIDED: no

Gmail's API can remove the `SPAM` label, which would train the operator's own filter.
**Helpthread does not do this** (maintainer decision, 2026-08-02). Corrections stay
inside Helpthread's own database.

This is a boundary, not a deferral: Helpthread reads the operator's mailbox and does not
write classification state back into it. A correction made here changes what Helpthread
believes, never what the operator's mail provider believes. An operator who wants Gmail
retrained does it in Gmail, where they can see it.

Consequence to be honest about: the same sender can keep arriving with a `'spam'` verdict
after being rescued, because Google's opinion is unchanged. §5.2's per-mailbox sender
state is what absorbs that, and it is why allow-listing is not optional once §5 is built.

## 6. Operator controls (NOT BUILT)

**Enabled by default, with an operator switch** (maintainer decision, 2026-08-02).
Automatic classification applies to a newly connected mailbox with no setup, and
an operator who does not want it can turn it off.

Three consequences follow, and none are built yet:

- **The switch is per-mailbox, not global.** Mailboxes are connected independently and an
  operator may trust one provider's filtering and not another's. (INFERRED — the grain was
  not specified in the decision above; per-mailbox is an inference, and it is a
  two-way door.)
- **Off means the verdict is not read at all**, not that it is read and ignored. A message
  arriving at a mailbox with classification off is filed `active` regardless of its label.
- **The Spam folder distinguishes "filed automatically" from "an Agent filed this."**
  Without that, an operator cannot audit what the classifier did, and cannot tell a
  mistake of theirs from a mistake of ours. The storage for this does not exist yet —
  `status` alone does not record who set it.

## 7. Decision ledger

Per the repo's provenance discipline, every normative choice above is marked with its
source. Anything marked **INFERRED** is an inference drawn from existing specs and has not been
approved.

| # | Decision — in plain words | Source |
|---|---|---|
| — | Build the fix plus a spec for real auto-classification, rather than the fix alone | Maintainer decision, 2026-08-02 (chose fix-plus-spec over fix-only) |
| — | Spam is never auto-classified in v1 | Prior accepted spec, agent-inbox-v1.md §3a |
| D0 | Junk mail is stored and filed as `spam`, never dropped at intake | ⚠️ INFERRED — follows from inbound-ingestion.md §1's never-dropped invariant, but applying it to junk specifically is an inference |
| D1 | Automatic spam classification is **on by default**, and an operator can **switch it off** | Maintainer decision, 2026-08-02 |
| D1a | That switch is **per-mailbox** rather than global | ⚠️ INFERRED — the grain was not part of D1's answer. A two-way door |
| D2 | A spam-verdict message whose reply token names a *deleted* conversation is filed as spam | ⚠️ INFERRED — the valid token argues it is a real customer; the deletion argues an Agent already discarded that thread. Uniform rule chosen for simplicity, not because the edge was decided |
| D3 | An Agent's "not spam" correction is **never** written back to the operator's Gmail | Maintainer decision, 2026-08-02 |
| D4 | Header scoring requires one strong or two weak signals; a lone weak signal never classifies | ⚠️ INFERRED — a conservative default, not a measured threshold |
| D5 | `Auto-Submitted` is a loop-guard concern, not a spam signal | ⚠️ INFERRED |
| D6 | Gmail's "labels present, none of them `SPAM`" keeps reporting `'clean'` rather than `'unknown'`; §3.1 states the justification instead of the code changing | Maintainer, 2026-08-02: chose "Keep code, tighten §3.1" over narrowing the code, on the question of whether `'clean'` is honest for a message with no `SPAM` label |

**One-way door:** none, in what is built or specified. The only candidate was writing
classification state back into the operator's own mailbox, and D3 closed that door rather
than walking through it — Helpthread reads the operator's mail and does not write its own
opinions into it. Every remaining INFERRED row above (D0, D1a, D2, D4, D5) is a two-way
door: each changes a default or a threshold, and reversing any of them costs one edit and
no migration.
