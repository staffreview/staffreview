---
name: staff-section-verify
description: Verify candidate whole-file section findings and return confirm/reject JSON. Used by staff-section sub-agents.
---

# Staff Section Verify

Independently re-check candidate whole-file findings against the current working
tree. Return verdicts only; do not post, spawn agents, modify code, or commit.

## Load

- For the verification method and verdict JSON schema, read
  `references/verify-guide.md`.
- If the user only asks what this worker does, do not load references.

## Required Parameters

- `slug`: the whole-tree diff used only for comment context.
- `candidate findings`: JSON array from one find agent.
