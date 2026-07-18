# Delegation ladder

**Pick the cheapest tier that is reliable for the task.**

The ladder, principles, and patterns apply on every surface (Code, Chat, Cowork, Design). The Mechanics section applies only where the surface can spawn sub-agents (currently Code and Cowork); elsewhere, apply the principles to whatever decomposition the surface allows.

## The ladder

When **Fable** (or any Mythos-class model) is the lead:

| Tier | Delegate to it |
|---|---|
| Opus | Deep investigation and evidence-gathering, adversarial review of code/docs against sources of truth, design/planning input on complex systems |
| Sonnet | Contained implementation or authoring from a precise spec, structured codebase/doc mapping, API/`gh` inspection tasks |
| Haiku | Mechanical bulk (sweeps, renames, conversions), dry-run/operability checks, simple verification passes |

When **Opus** is the lead, the lead absorbs the top tier and each remaining role moves down one: Opus keeps deep investigation and final judgment itself; Sonnet does implementation, authoring, and exploration; Haiku does mechanical bulk and dry-runs.

**The human tier.** Below Haiku sits the person: sub-minute UI actions (delete a line in a web editor, approve a dialog, trash a page) where any prompt, at any tier, costs more than the click. Don't automate these — hand them back as a named action item. Override only when getting it off the person's plate is itself the point — then do it knowingly, not by default.

## Choosing the lead

Pick the lead by how often the session needs Fable-grade judgment — then never call upward.

- **Repeatedly, or interleaved with execution** → Fable leads. The lead-seat premium is bounded (the lead's long context is mostly cache reads) while lead errors multiply downstream, so the lead seat is the cheapest place in the system to buy quality.
- **Never** (the plan exists, the work is contained) → Opus leads; Fable doesn't appear.
- **Exactly once, at the start or end** → phase split: a Fable-led planning session emits the plan and agent specs as artifacts; a fresh Opus-led execution session runs them; Fable reviews the final artifact.

**No upward delegation.** The lead never consults a higher tier mid-session: the briefing is lossy compression of exactly the context that judgment needs most, and integrating a higher tier's output inverts the review invariant. Downward handoffs between sessions replace upward calls within one. Failure escalation tops out at the lead's own tier — if a task genuinely needs a tier above the lead, the lead was mis-chosen; re-scope the session rather than consulting upward.

## Principles (all surfaces)

- **Review invariant.** Reviewer ≠ author, and reviewer tier ≥ author tier. When the lead authors an artifact itself, the reviewer is a *parallel* agent at the lead's own tier — a Fable lead gets a parallel Fable reviewer, an Opus lead a parallel Opus reviewer — so the review is independent of the author's context.
- **Verification vs. review litmus.** If the checklist can be written in advance, it's verification — Haiku runs it. If the reviewer has to generate the checklist, it's review — it goes up-ladder.
- **Don't-delegate floor.** If writing a self-contained spec costs more than doing the task, the lead does it directly.
- **On failure.** One retry with a corrected spec. On a second failure, escalate one tier or the lead absorbs the task. Never re-run a failing agent on an unchanged spec.

## Mechanics (agent-spawning surfaces)

**Label every sub-agent with its model.** Prefix the agent's `description` (the short text shown in the FleetView row) with the human-readable name of the model it runs as, in square brackets — `[<Model> <version>] <task>`. If the agent inherits the lead's model (no explicit `model`), use the lead's model name. Keep the rest of the description within its normal 3–5 words.

Examples with the current lineup (July 2026 — update names on release; the rule itself is version-agnostic):

- `[Opus 4.8] Explore teaching-claude-plugin repo`
- `[Sonnet 4.6] Explore ET course harness`
- `[Haiku 4.5] Explore TIC course harness`

## Patterns that work

- **Investigate before editing.** Launch an evidence-gathering agent before changing anything based on an assumption — including the user's stated assumption. Surface contradictions with evidence instead of encoding them into the change.
- **Parallelize on disjoint write-sets.** Independent agents go in a single message so they run concurrently; sequence only when one agent's output feeds another's prompt. "Independent" means disjoint write-sets — no shared files, branches, or tickets — not merely unrelated prompts. Anything sharing a write target gets sequenced. (In Code, worktrees give you disjoint write-sets by construction.)
- **Author low, review high.** Content authored by a lower tier gets an adversarial review by a higher tier against the actual sources of truth (code, configs, live systems) — then the lead applies the fixes itself rather than looping another author pass.
- **Prove operability at the target tier.** A doc/runbook/command meant to be executed by a small model gets a read-only dry-run by that same model (e.g. Haiku narrates exactly what it would run); its confusions are the defect list.
- **Write self-contained agent specs.** Exact paths, expected outputs, hard boundaries ("read-only", "do not touch X", "report, don't fix"). A vague prompt wastes the tier's entire run.
