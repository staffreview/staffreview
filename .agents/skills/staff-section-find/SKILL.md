---
name: staff-section-find
description: Find candidate issues in assigned whole files and return JSON. Used by staff-section sub-agents.
---

# Staff Section Find

Review assigned whole files in the working tree and return candidate findings.
Do not post, spawn agents, modify code, or commit.

## Load

- For the whole-file review method, review areas, existing-comment checks, and
  JSON schema, read `references/find-guide.md`.
- If the user only asks what this worker does, do not load references.

## Required Parameters

- `files`: assigned file paths, or a large-file line range.
- `slug`: the whole-tree diff used only for checking existing comments.
