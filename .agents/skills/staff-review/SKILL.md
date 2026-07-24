---
name: staff-review
description: Review a Staff Review diff by delegating find/verify agents and posting confirmed comments. Use for /staff-review or code review of pending changes.
---

# Staff Review

Orchestrate a staff-level review of a diff. Do not review code inline; delegate
candidate discovery to `staff-review-find`, verify each batch with
`staff-review-verify`, then post only confirmed findings through `staff-comment`.

## Load

- For an actual review run, read `references/review-workflow.md`.
- For comment command syntax, read `.agents/skills/staff-comment/SKILL.md` only
  when posting.
- If the user only asks what this skill does, do not load references.

## Rules

- Never require the `staff` CLI; fall back to Git and `main..WT` as the workflow
  describes.
- Pass slugs and short JSON findings between agents, not full file contents.
- Pipeline each find agent into its own verifier and reap background agents as
  soon as their output is consumed.
- Deduplicate confirmed survivors before posting.
- Do not modify code or commit; this skill only posts review comments.
