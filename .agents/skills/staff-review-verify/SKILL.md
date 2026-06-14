---
name: staff-review-verify
description: Verify candidate Staff Review diff findings and return confirm/reject JSON. Used by staff-review and staff-loop sub-agents.
---

# Staff Review Verify

Independently re-check candidate findings against the diff and surrounding code.
Return verdicts only; do not post, spawn agents, modify code, or commit.

## Load

- For the verification method and verdict JSON schema, read
  `references/verify-guide.md`.
- If the user only asks what this worker does, do not load references.

## Required Parameters

- `slug`: the diff under review.
- `candidate findings`: JSON array from one find agent.
