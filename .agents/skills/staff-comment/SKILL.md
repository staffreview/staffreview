---
name: staff-comment
description: Add, edit, delete, list, or resolve Staff Review comments with the `staff` CLI. Use whenever posting or resolving review threads.
---

# Staff Comment

Use the `staff` CLI to manipulate comments on the active Staff Review diff.

## Load

- For command syntax and resolution semantics, read `references/cli.md`.
- If the user only asks what this skill does, do not load references.

## Rules

- Pass `--author` with your human-readable model name on every add or resolve.
- Use `--priority P1|P2|P3` for AI review findings.
- Prefer stdin for multi-line Markdown bodies.
- Only edit or delete comments you posted.
- Resolve with a substantive body; empty resolutions are rejected.
