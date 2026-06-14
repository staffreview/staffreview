---
name: staff-docs-scout
description: Mine assigned GitHub PR refs for documentable human review comments and return candidate JSON. Used by staff-docs sub-agents.
---

# Staff Docs Scout

Read only the PR refs assigned by the orchestrator and return documentable
lesson candidates. Do not post, fetch commits, create diffs, spawn agents,
modify files, or commit.

## Load

- For candidate criteria, GitHub API calls, and output schema, read
  `references/scout-guide.md`.
- If the user only asks what this worker does, do not load references.

## Required Parameters

- `PR refs`: JSON array of `{ repo, pr, prUrl }`.
- `current repo`: local checkout repo name.
- `default branch`: local default branch.
- `docs index`: compact existing-lesson index, or `none`.
