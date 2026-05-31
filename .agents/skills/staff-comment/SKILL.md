---
name: staff-comment
description: Leave or resolve review comments on the active Staff Review diff via the `staff` CLI. Use whenever you need to post inline/top-level comments, replies, or mark a thread as fixed/skipped/documented.
---

# Staff Comment

This skill is a thin wrapper around the `staff` CLI. The CLI writes to `.staffreview/diffs/<slug>.json`; the running web UI picks changes up over a WebSocket and re-renders.

## Find the active diff

```bash
staff active --json
```

Returns `{ "slug": "...", "base": {...}, "head": {...} }`. Every command below operates on the active diff by default; pass `--slug <slug>` to override.

To target (and if necessary create) a specific diff by slug — e.g. when the
user invoked a skill as `/staff-review main..WT` — run `staff diff <slug>` first;
it loads or creates that diff and makes it active:

```bash
staff diff main..WT --json   # <base>..<head>; base/head are WT, STAGED, or a git ref
```

## Identify yourself

Always pass `--author` with **your model name** so the UI shows which model
wrote the comment — e.g. `--author "Opus 4.8"`, `--author "Sonnet 4.6"`,
`--author "GPT-5.5"`. Use the human-readable model name, not "agent" or your
provider. Every `staff comment add` / `staff comment resolve` below should
include it.

## Add a comment

**Inline** (anchored to a file and line):

```bash
staff comment add \
  --file path/to/file.ts \
  --line 42 \
  --side new \                       # "new" (default) or "old"
  --author "Opus 4.8" \              # your model name
  --priority P1 \                    # AI-reviewer severity (see below)
  --body "Off-by-one: the loop misses the last element."
```

**Priority** (`--priority P1|P2|P3`) — an *agent-only* severity so a human can
triage your findings; **P1 is the most serious/urgent**, P3 the least. Set it on
every finding you post. A rough scale:

- **P1** — must fix: correctness/security bugs, data loss, crashes, broken APIs.
- **P2** — should fix: real issues that aren't blocking (missing edge case, weak
  test, risky pattern).
- **P3** — minor: nits, naming, small simplifications, optional suggestions.

Leave it off for purely informational top-level comments. Humans don't set it.

**Inline range** (anchored to a span of lines) — add `--end-line`:

```bash
staff comment add \
  --file path/to/file.ts \
  --line 42 --end-line 48 \          # comment covers lines 42–48 on the side
  --side new \
  --author "Opus 4.8" \
  --body "This whole block can be replaced with a single map()."
```

**Top-level** (no `--file`/`--line`):

```bash
staff comment add --author "Opus 4.8" --body "Overall looks good once tests pass."
```

**Reply** to an existing thread:

```bash
staff comment add --reply-to <commentId> --author "Opus 4.8" --body "Good catch — see also lines 80-86."
```

The CLI prints the new comment's JSON to stdout — including its `id` and
`threadId`. **Capture the `id`**: it's the handle you need to revise or delete
the comment later (see below), and `--reply-to <id>` threads a follow-up onto it.

## Edit or delete a comment you posted

If you posted something you want to revise or take back, use the `id` from the
`comment add` output.

**Revise** the body (the anchor, author, and thread stay the same):

```bash
staff comment edit --id <commentId> --body "Corrected: it's an off-by-one only when the list is empty."
```

`edit` prints the updated comment's JSON. The body can also be piped via stdin.

**Delete** the comment outright:

```bash
staff comment delete --id <commentId>
```

Deleting a comment also removes any replies anchored to it. The command errors
if no comment matches the `id`, so a typo won't silently no-op. Both `edit` and
`delete` operate on the active diff by default; pass `--slug <slug>` to override.

Only edit or delete comments **you** posted — don't rewrite a human's review.

## Resolve a thread

```bash
staff comment resolve --thread <threadId> --status fixed   --body "Reordered the loop and added a test."
staff comment resolve --thread <threadId> --status skipped --body "Intentional — see ADR-0007."
staff comment resolve --thread <threadId> --status documented --body "Saved as error-handling.md" --documented-as error-handling.md
```

- `fixed` — you made the change. The body should describe the change.
- `skipped` — the comment doesn't apply. The body must explain why.
- `documented` — you (the agent) wrote a library entry under `.staffreview/library/`. The body should describe what you saved; `--documented-as` is the filename you chose. This is a terminal resolution — only use it *after* the file exists.

A human can pre-flag a thread for documentation by clicking **Document** in the UI; this sets `documentRequested: true` on the thread (visible in `staff comment list --json`) but leaves it **open**. It is a request, not a resolution — `/staff-resolve` writes the entry and then resolves it as `documented`.

## List comments / threads

```bash
staff comment list --json         # all threads on the active diff
staff comment list --open --json  # only unresolved threads
```

Each entry contains `threadId`, `file`, `line`, `endLine` (for range comments), `side`, `resolution`, `documentRequested`, and the full `comments` array.

## When called from /staff-review

For each finding from your review:

1. Run `staff active --json` once at the start.
2. Run `staff comment add` per finding with `--author "<your model name>"` (e.g. `Opus 4.8`) so the UI shows which model wrote it.
3. Do **not** resolve comments yourself during review — leave that to the human or `/staff-resolve`.

## When called from /staff-resolve

For each unresolved thread:

1. Make the code change (or determine that none is needed).
2. Run `staff comment resolve --thread <threadId> --status <fixed|skipped|documented> --body "..."`.

Always include a substantive `--body`. Empty resolutions are rejected.
