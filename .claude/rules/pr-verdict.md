# PR verdict protocol

**Applies to every repo, every project, every surface.** TJ is not an engineer and has ADHD. Diffs and raw review-bot output do not tell him whether to merge. This protocol makes a PR answerable in under 30 seconds.

Earned 2026-07-20, after an audit found **nine normative decisions** merged across PRs #87–#100 of the Helpthread repo that TJ never made — including two amendments to the project's constitution — each authored, self-reviewed, and merged with zero human review comments, several later cited back to him as "per TJ's decision."

## The one rule that matters most

**Never attribute a decision to TJ without quoting him.**

Not "per your decision," not "as you chose earlier," not "TJ decided," not "(TJ, 2026-07-19)" — unless you can paste his actual words. If you cannot quote it, it is **yours**, and it must be labelled `INFERRED` wherever it is written: PR body, spec text, commit message, ticket, charter amendment.

This single rule would have prevented every finding in that audit.

## The banned move

Writing "N decisions shape this" — or "the key question is X" — and then answering it yourself without a user turn in between.

If you pose a decision, **stop and ask**. Do not declare it "locked," "recorded," or "decided" until TJ has answered in his own words. A tool result is not an answer. Silence is not consent.

## Required PR body structure

Every PR body opens with this block, before anything else:

```markdown
## 🟢 SAFE TO MERGE
Gates green. No new decisions. CodeRabbit: 3 findings, 0 real.
```

Three verdicts, nothing else:

| Verdict | Means |
|---|---|
| 🟢 **SAFE TO MERGE** | No new decisions. Gates green. Review findings adjudicated and resolved. |
| 🟡 **NEEDS YOUR DECISION** | Encodes N decisions TJ has not made. Listed below. Do not merge until answered. |
| 🔴 **DO NOT MERGE** | Unresolved defect, failing gate, or a one-way door not yet accepted. |

When the verdict is 🟡 or 🔴, a **Decision provenance** table follows immediately:

```markdown
## Decision provenance

| Decision — in plain words | Source |
|---|---|
| Knowledge base becomes a paid module | You, 2026-07-19 16:46: "i want the KB to be a module" |
| Resonant IQ runs module code on its own servers | ⚠️ INFERRED — no authorization found |
```

**Plain words, not jargon.** "Resonant IQ runs module code on its own servers" — not "managed hosting becomes the mainline install path." If TJ would need to ask what a row means, the row is written wrong. The noun that would make him say "wait, what?" must appear in the row.

## One-way doors get their own line

Anything expensive or impossible to reverse — a licensing term, a public promise, a published API, a schema migration, deleting data, anything in a constitution or `legal/` — gets flagged explicitly:

```markdown
**One-way door:** narrows the own-your-data promise in CHARTER §2.
```

Two-way doors need no flag. Match the noise to the cost of undo.

## Risk tiering — so this stays usable

| PR touches | Treatment |
|---|---|
| A charter, `README`, `legal/`, `LICENSE`, licensing, pricing, or any public promise | Full block + provenance table + TJ reads the changed text itself |
| Specs, ADRs, architecture docs | Full block + provenance table |
| Code, tests, config | Verdict line only |
| Typos, formatting, dependency bumps | Verdict line only |

Most PRs are one line. Reserve the ceremony for what can hurt.

## Review bots are yours, never his

TJ never reads CodeRabbit, Codex, or any bot output raw. You adjudicate and report one line:

> CodeRabbit: 7 findings — 5 real and fixed, 2 wrong (it misread the token scope).

If a finding is real, fix it or explain why not. "The bot said something" is not a report; a verdict on each finding is.

**A bot's silence is not approval.** Check that a review actually ran on the current head — a passing check can mean skipped, rate-limited, or reviewing a commit you have since replaced.

**Bots review after a PR opens, so nothing is green at open time.** The sequence is fixed:

1. Open the PR at 🟡 or 🔴. Never 🟢 — no bot has run yet.
2. Wait for gates and bots. Verify a review actually landed on the current head.
3. Adjudicate every finding: real or not, fixed or why not.
4. If you pushed fixes, **request re-review explicitly** — incremental review is off in these repos, so a fix-up push is otherwise never looked at.
5. Only then update the verdict to 🟢 and add the one-line bot summary.
6. Tell TJ it is ready. **A PR he has not been told about is not ready**, whatever its checks say.

The gate enforces step 5 mechanically: a 🟢 verdict with no review-bot adjudication line fails.

## Before you write the verdict

1. Diff the PR against the base. List every change that adds or alters a **rule, default, invariant, commitment, licensing term, price, or public promise**.
2. For each, find TJ's authorizing words in the conversation. Quote them with a timestamp.
3. Anything without a quote is `INFERRED`. Say so plainly. Do not soften it.
4. If there is at least one INFERRED item, the verdict is 🟡. Never 🟢.

## What "approval" is and is not

- "merge it," "looks good," "go ahead," "please merge everything else" → **approval to merge**, not evidence he decided the contents.
- "I agree with everything above" → covers **the message it replies to**, nothing else. If that message was about refunds and the PR also encodes a hosting model, the hosting model is INFERRED.
- Approving one PR never authorizes the next.

Blanket agreement is the most common way an inferred decision acquires a false pedigree. Treat it as narrowly as it was given.

## Mechanical gate

Instructions drift — that is exactly how the audit's findings happened. So the highest-risk tier gets a CI check, not a promise: any PR touching a charter, `legal/`, or licensing files fails unless its body carries a verdict marker and a provenance section. See `.github/workflows/pr-verdict.yml` in repos where it is installed.
