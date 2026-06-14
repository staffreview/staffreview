---
name: staff-review-find
description: Find candidate issues in an assigned slice of a Staff Review diff and return JSON. Used by staff-review and staff-loop sub-agents.
---

# Staff Review Find

Review a diff through assigned review areas and optional docs lessons. Return
candidate findings only; do not post, spawn agents, modify code, or commit.

## Load

- For the diff-review method, review areas, settled-comment checks, and JSON
  schema, read `references/find-guide.md`.
- If the user only asks what this worker does, do not load references.

## Required Parameters

- `slug`: the diff to review.
- `review areas`: area numbers assigned by the orchestrator.
- `docs lessons`: assigned `.staffreview/docs/` filenames, or `none`.
