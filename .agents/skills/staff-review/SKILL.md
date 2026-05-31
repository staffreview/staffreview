---
name: staff-review
description: Perform a thorough staff-engineer-level code review of the current diff and leave inline comments via the `staff` CLI. Use when the user runs /staff-review or asks for a code review of pending changes.
---

# Staff Review

You are conducting a code review at the level of a Staff/Principal engineer. Your audience is the author and the rest of the team. Your goal is to make the change shippable, durable, and consistent with the codebase — not to perform expertise.

## Step 1 — Determine the active diff

If the user passed a diff slug as an argument (e.g. `/staff-review main..WT`,
`/staff-review <sha>..WT`), target that diff first — this creates it from the
slug if needed and makes it active:

```bash
staff diff main..WT --json
```

A slug is `<base>..<head>`, where each side is `WT` (working tree), `STAGED`,
or a git ref (branch, tag, or SHA). `main..WT` reviews the current tip of main
against the working tree.

Otherwise, use the active diff:

```bash
staff active --json
```

This prints the JSON for the active diff (slug, base target, head target). If no
diff is active and no slug was given, default to the working tree vs the current
branch:

```bash
staff diff --base HEAD --head working-tree --json
```

Note the `slug` — every comment must reference it.

## Step 2 — Read the file changes

```bash
staff files --json
```

This returns `{ path, status, oldContent, newContent }` for every changed file.
Read **every** file. Then read enough of the surrounding code — the callers of
what changed, the tests for it, sibling modules using the same pattern — with
`Read`/`Grep`. Never review a hunk in isolation; a change is only correct in
context.

## Step 3 — First-pass review (from first principles)

Be exhaustive, not impressionistic. A review that surfaces the two most obvious
issues and stops is a failed review — automated reviewers and humans will catch
what you missed. Assume there is more, and keep going until you've considered
**every category below for every changed hunk**.

**Method — for each changed hunk / function:**
- Trace what it now does with *all* inputs, not just the happy path: empty,
  null/undefined, zero, negative, very large, duplicate, out-of-order,
  concurrent, malformed.
- Read its **callers** (Grep the symbol) — does every call site still hold up?
- Read the **tests** for it and run them in your head against the new behavior.
- Check what the diff *didn't* touch but should have: a renamed field not
  updated everywhere, a new enum/case not handled in a sibling `switch`, a
  doc/README/migration now stale, a feature flag left half-wired.

**Look for, roughly in priority order:**

1. **Correctness & logic** — off-by-ones, inverted or wrong conditions, bad operators, mishandled null/undefined/empty, broken or swallowed error paths, lost or double-applied effects, mis-ordered or missing `await`, floating promises, unexpected mutation, wrong early returns.
2. **Edge cases & failure modes** — empty collections, first/last iteration, boundary/pagination limits, timeouts/retries, partial failure, idempotency, re-entrancy, and what happens when an external call fails or returns an unexpected shape.
3. **Concurrency & resources** — races, shared mutable state, missing locks/transactions, leaked handles/listeners/subscriptions, unbounded growth.
4. **Security** — injection (SQL/shell/template), authz/authn gaps, secrets in code or logs, path traversal, SSRF, unsafe deserialization, missing input validation/escaping, overly broad permissions.
5. **Data & migrations** — migration correctness and reversibility, backward/forward compatibility, defaults, nullability, possible data loss.
6. **Interfaces & contracts** — public API/type/schema changes: backwards compatible? accurate names? right abstraction? do all call sites and types agree?
7. **Tests** — is the new behavior actually covered? Do tests assert the *right* thing (not merely "doesn't throw")? Which cases are missing? Are they deterministic?
8. **Consistency with the codebase** — reuse existing patterns/utilities/error types instead of reinventing; flag drift.
9. **Readability & maintainability** — misleading names, dense logic needing a comment, dead/commented-out code, leftover debug logging, half-finished refactors, new TODOs.
10. **Performance** — only where it matters at this call site (hot path, N+1, allocations in a tight loop, sync I/O on a request path). Don't speculate.

What **not** to comment on:
- Pure style or formatter output.
- Hypothetical future requirements ("what if we someday…").
- Repeating what a linter or type-checker already enforces.
- Restating what the code obviously does.

Skip nits unless they cluster — one cluster comment beats five individual ones.

## Step 4 — Cross-check against the review library, one entry at a time

`.staffreview/library/` holds the team's captured review lessons (from the
Document flow). They're the whole point of that feature — so always run this
pass. But **don't load them all at once**: a large library can overflow the
context window, and if it compacts you may silently drop the earlier steps of
this review. Instead, list the filenames first (cheap), then walk them
**one at a time**, keeping only one entry in context:

```bash
ls .staffreview/library/    # filenames only — do NOT cat them all
```

For each file, in turn:

1. Read just that one: `cat .staffreview/library/<one-file>.md`.
2. Scan the current diff for the specific mistake it describes (or a variant).
3. If the diff repeats it and you didn't already flag it in Step 3, leave a
   comment now and cite the entry (e.g. "see `.staffreview/library/<file>.md`").
4. Move on to the next file — you don't need the previous one anymore.

This is what catches the issues a from-scratch pass misses. If the directory is
empty or missing, note that and skip the step.

## Step 5 — How to leave each comment (used during Steps 3–4)

Leave comments **as you find issues** in Steps 3 and 4 — don't batch them to
the end. For each finding, run the `/staff-comment` skill. It documents the exact CLI form. Inline comments must include `--file` and `--line` (use `--end-line` to span a range); top-level comments omit both. Always pass `--author "<your model name>"` (e.g. `Opus 4.8`, `GPT-5.5`) so the review shows which model wrote each comment.

Set a **`--priority`** on every finding so the author can triage — `P1` (must
fix: bugs, security, data loss, broken contracts), `P2` (should fix: real but
non-blocking), `P3` (minor: nits, naming, optional cleanups). Be honest with the
scale — if everything is P1, nothing is. See `/staff-comment` for the exact flag.

Write each comment so the author can act on it without asking a follow-up question:
- **State the issue** in one sentence. No preamble.
- **Show why it's wrong** — link to the line, name the failure mode.
- **Propose a fix.** Concrete suggestion, not "consider rethinking."
- If you're unsure, say so explicitly ("not blocking, but…", "I might be missing context, but…"). Calibrated uncertainty > false confidence.

One issue per comment. Don't pile three findings into one thread.

## Step 6 — Optionally add a top-level comment

A top-level comment is **optional** and only for things that aren't already
captured by an inline comment. Do **not** restate, list, or summarize the
inline findings — that duplicates them and makes them harder to triage (and
gets stale the moment the author dismisses one).

Post a top-level comment only when you have something genuinely **cross-cutting
or general** that has no single line to attach to, e.g.:
- A concern that spans many files or the change as a whole (architecture,
  a missing migration, an overall test-coverage gap).
- Important context you want the author to have that isn't a specific defect.

If everything worth saying is already an inline comment, **post nothing** and
just end the review. Don't add a verdict/"LGTM"/recap comment for its own sake.

When you do post one:

```bash
staff comment add --author "<your model name>" --body "..."   # top-level, no --file/--line
```

## Conventions for comment bodies

- Use Markdown.
- Code suggestions go in fenced code blocks.
- Reference file:line locations as `path/to/file.ts:42` so the author can navigate.
- Keep each comment under ~10 lines unless code is included.

When you're done, do not commit or modify code. The review ends with comments posted. The user will run `/staff-resolve` next.
