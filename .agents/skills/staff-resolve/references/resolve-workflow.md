# Staff Resolve

Work through the open comment threads on the active Staff Review diff. For each one, either fix the code, save the lesson into `.staffreview/docs/`, or skip it with a justification — then record what you did via `/staff-comment`.

## Step 1 — Read the comments or supplied findings

The `staff` CLI is optional. Never stop or ask the user to install it. When an
orchestrator or user supplies finding JSON directly, or the current conversation
contains the final survivor list from the most recent CLI-free `/staff-review`,
treat each finding as an open review thread: read all of them before editing,
then use its title/body/file/line as the review context. Skip CLI replies and
resolution metadata in this mode, but still choose exactly one
fix/document/skip outcome per finding. Use the supplied review slug and the find
guide's Git mapping to capture any original hunk needed for documentation before
editing.

Otherwise, read persisted comments with the CLI. If the user passed a diff slug
as an argument (e.g. `/staff-resolve main..WT`), target it first so the commands
below operate on that diff:

```bash
staff diff main..WT --json   # only when a slug was given; sets it active
```

Then read the threads:

```bash
staff active --json
staff comment list --open --json
```

If neither direct findings nor CLI-backed comments are accessible, report that
there is no review input to resolve. Do not ask the user to install `staff`.

This returns every unresolved thread as `{ threadId, file, line, endLine, side, resolution, documentRequested, comments }` (`endLine` is set for range comments). Read all of them before touching code so you can group related fixes and avoid conflicting edits.

`documentRequested: true` means a human clicked **Document** in the UI and wants this thread turned into a docs entry (see option 2 below). Treat it as the reviewer's explicit instruction to document rather than fix.

## Step 2 — For each thread: act, then record when possible

Pass `--author "<your model name>"` (e.g. `Opus 4.8`, `GPT-5.5`) on every
`staff comment` command below so the work is attributed to the model, not
"agent".

In CLI mode handle each thread in three steps, **in this order**:

1. **Act** — pick exactly one of fix / document / skip (see below).
2. **Reply in-thread** with what you did and why. This is the record the
   reviewer reads — keep the explanation here, on the thread, not in a
   separate top-level comment. Reply to the thread's **root comment** (the
   entry in `comments` with no `parentId`):
   ```bash
   staff comment add --reply-to <root comment id> --author "<your model name>" \
     --body "Reordered the loop and added a regression test in foo.test.ts."
   ```
3. **Resolve** with the matching status. The `--body` here is just a short
   status line — the substance is in your reply above:
   ```bash
   staff comment resolve --thread <threadId> --author "<your model name>" --status fixed --body "Fixed."
   ```

In CLI-free direct-findings mode, perform step 1 for every finding but omit steps
2 and 3. Return only JSON with one result per successfully handled finding:
`[{"index": 0, "outcome": "fixed|documented|skipped"}]`. Preserve the supplied
indexes; do not report an index whose action did not complete.

Choosing the action:

1. **Fix it.** Make the code change. Run the tests / typecheck / linter for the
   affected area. In CLI mode, reply describing the change, then resolve
   `--status fixed`.

2. **Document it.** If the thread has `documentRequested: true` (the human clicked **Document**), or the reviewer's note is a teaching point worth saving, write a new file under `.staffreview/docs/`. **You** decide the filename and write the content — the UI only flags the thread. Follow the `/staff-document` schema (frontmatter + Context + Issue + Original/Fix code + Why it matters). The example should contain:
   - The comment body.
   - The diff hunk the comment was made on (in CLI mode, from `staff files
     --json`; in direct mode, from the supplied slug using the find guide's Git
     mapping).
   - The fix you made, if you also changed code.
   - The fix diff (the snippet after your edit).
   In CLI mode, reply noting the saved file, then resolve (this also clears
   `documentRequested`):
   ```bash
   staff comment resolve --thread <threadId> --author "<your model name>" \
     --status documented --body "Saved as <slug>.md" --documented-as <slug>.md
   ```

3. **Skip it.** Only when the comment is actually wrong, out of scope, or
   duplicated by another thread. In CLI mode, reply with the explicit
   justification, then resolve `--status skipped`.

Honour the reviewer's pre-marked intent:
- A thread whose only comment is from `/staff-review` with no resolution and no `documentRequested` → treat as **fix** by default.
- A thread with `documentRequested: true` → **document it** (option 2): pick a filename, write the docs entry, and resolve as `documented`.
- Resolved threads don't appear in `--open` at all, so anything the human already marked `fixed`/`skipped`/`documented` is left untouched automatically.

## Step 3 — Group fixes by file

If multiple threads touch the same file, plan one coherent edit per file rather than N drive-by edits. This keeps the diff readable.

## Step 4 — Verify

After all threads are resolved, run whatever quick checks make sense for the repo (type-check, the affected test files, linter on touched files). If something breaks, fix it and add a new resolution body explaining the follow-up. Don't leave the tree red.

## Step 5 — (Optional) wrap up

The per-thread replies from Step 2 are the record of what you did — **do not**
post a top-level comment that restates or summarizes them.

A top-level comment is optional and only for something genuinely
**cross-cutting** that isn't tied to any one thread (e.g. a follow-up that
emerged while resolving, or a repo-wide note). If there's nothing like that,
post nothing — just report the summary back to the user in chat instead.

## Constraints

- **Do not commit.** Leave changes staged or in the working tree. The human reviews and commits.
- **Do not require the CLI.** Direct findings from an orchestrator are sufficient
  review input; only persisted replies and resolution metadata are unavailable.
- **Do not delete review comments.** Resolution is recorded as metadata; the thread stays.
- **One resolution per thread.** If you change your mind, run `staff comment unresolve --thread <threadId>` then resolve again with the new status.
- **In CLI mode, explain in a reply, not a top-level comment.** Each persisted
  thread gets an in-thread reply describing what you did; the resolution
  `--body` is a short status line (it still can't be empty).
