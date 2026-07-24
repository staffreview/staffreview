---
name: staff-loop
description: Iteratively review and resolve a working-tree Staff Review diff until it converges or reaches the round cap. Use for /staff-loop.
---

# Staff Loop

Run repeated review and resolve rounds on a diff whose head is the working tree.
The loop delegates review discovery/verification and resolution to sub-agents,
then stops when a fresh review finds no open comments or the configured round cap
is reached.

## Load

- For an actual loop run, read `references/loop-workflow.md`.
- For the review phase details, read `.agents/skills/staff-review/references/review-workflow.md`
  when needed.
- If the user only asks what this skill does, do not load references.

## Rules

- The `staff` CLI is optional. Never stop or ask the user to install it; without
  it, use Git for the diff and pass confirmed findings directly to resolve.
- Resolve the diff in this order: user-provided slug, active CLI diff, then
  `main..WT`.
- Do not spawn `staff-review` as a sub-agent; spawn `staff-review-find` and
  `staff-review-verify` directly.
- Resolve edits must happen in the real working tree; do not isolate them in a
  separate worktree.
- Check convergence after review, not immediately after resolve.
- Reap background agents as soon as their output is consumed.
- Do not commit.
