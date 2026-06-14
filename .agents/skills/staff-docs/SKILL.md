---
name: staff-docs
description: Mine GitHub PR review comments for reusable Staff Review lessons. Use for /staff-docs or growing `.staffreview/docs/` from PR history.
---

# Staff Docs

Orchestrate a GitHub PR review-comment mining run. Scouts read PR review
comments, the orchestrator ranks candidates, and documenter agents write selected
lessons into `.staffreview/docs/`.

## Load

- For any sweep, targeted PR run, candidate presentation, cache update, or
  flagged-candidate documentation pass, read `references/workflow.md`.
- If the user only asks what this skill does, do not load references.

## Rules

- Mine GitHub PR review comments only; never mine local Staff Review diffs.
- Keep scouts read-only: no posting, fetching, local diffs, or file edits.
- Deduplicate centrally and rank impact-first before presenting candidates.
- Wait for the user to flag candidates before writing docs entries.
- Do not commit.
