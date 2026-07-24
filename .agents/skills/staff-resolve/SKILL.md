---
name: staff-resolve
description: Resolve open Staff Review threads by fixing, documenting, or skipping with justification. Use for /staff-resolve or addressing review feedback.
---

# Staff Resolve

Work through unresolved Staff Review threads on a diff. For each thread, choose
exactly one outcome: fix the code, document the lesson, or skip with a clear
justification.

## Load

- For any resolve run, read `references/resolve-workflow.md`.
- For documentation entry format, read `.agents/skills/staff-document/SKILL.md`
  only when documenting a thread.
- For comment commands, read `.agents/skills/staff-comment/SKILL.md` only when
  posting replies or resolutions.
- If the user only asks what this skill does, do not load references.

## Rules

- The `staff` CLI is optional. Never stop or ask the user to install it. When an
  orchestrator, the user, or the most recent CLI-free review supplies findings,
  fix/document/skip them without CLI replies or resolution metadata.
- Read all open threads before editing so related fixes can be grouped.
- In CLI mode, reply in-thread with the substantive explanation, then resolve
  the thread.
- Honor `documentRequested: true` by writing a docs entry and resolving as
  documented.
- Run relevant checks for touched code.
- Do not delete review comments or commit.
