---
name: staff-section
description: Review rotating sections of existing source files and post confirmed Staff Review comments. Use for /staff-section or whole-codebase review over time.
---

# Staff Section

Orchestrate a section-by-section review of existing code, not a diff. Pick the
next due group of whole files, delegate discovery to `staff-review-find` (in its
`files` mode), verify with `staff-review-verify`, then post confirmed comments on
the stable whole-tree diff.

## Load

- For an actual section review, read `references/section-workflow.md`.
- For comment command syntax, read `.agents/skills/staff-comment/SKILL.md` only
  when posting.
- If the user only asks what this skill does, do not load references.

## Rules

- The `staff` CLI is optional. Never stop or ask the user to install it; without
  it, review files normally and return confirmed findings in chat.
- Review whole files in the selected section; skip unchanged sections, not
  individual changed files.
- Never run `staff files --slug` on the whole-tree section diff.
- Pipeline find to verify, reap background agents promptly, and publish only
  verified survivors.
- Update `.staffreview/section-cache.json` only after publishing is complete.
- Do not modify source code or commit.
