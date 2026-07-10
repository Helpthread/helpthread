# Provenance records

The charter's clean-room policy (CHARTER.md §3) requires that the wall be **documented, not just described**. This directory is that documentation.

- `sessions.md` — append-only log: one entry per working session. Date, side (spec / implementation / foundation), sources touched, artifacts produced.
- `modules/<module>.md` — one manifest per shipped module: which specs it was built from, which sessions produced it, and the human design/review record (required for copyrightability of AI-assisted work).

Rules of thumb: if a session read FreeScout source or quarantined material, it is a **spec** session and may not write engine code. If in doubt which side a session was on, it was contaminated — log it that way and keep its output out of the shipping tree.
