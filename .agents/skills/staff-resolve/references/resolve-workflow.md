# Staff Resolve

Work through the open comment threads on the active Staff Review diff. For each one, either fix the code, save the lesson into `.staffreview/docs/`, or skip it with a justification — then record what you did via `/staff-comment`.

## Step 1 — Read the comments or supplied findings

The CLI is optional. Supplied findings (including a prior CLI-free review's
survivors) are threads: use their body/anchor, skip comment commands, and return
indexed `fixed|documented|skipped` outcomes. Otherwise use the CLI below; if
neither source exists, report no review input without asking for installation.

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

For direct findings, perform step 1 only and return
`[{"index":0,"outcome":"fixed|documented|skipped"}]`; omit failed indexes.

Choosing the action:

1. **Fix it.** Make the code change. Run the tests / typecheck / linter for the
   affected area. In CLI mode, reply and resolve `--status fixed`.

2. **Document it.** If the thread has `documentRequested: true` (the human clicked **Document**), or the reviewer's note is a teaching point worth saving, write a new file under `.staffreview/docs/`. **You** decide the filename and write the content — the UI only flags the thread. Follow the `/staff-document` schema (frontmatter + Context + Issue + Original/Fix code + Why it matters). The example should contain:
   - The comment body.
   - The diff hunk the comment was made on (use `staff files --json` or Git).
   - The fix you made, if you also changed code.
   - The fix diff (the snippet after your edit).
   In CLI mode, reply noting the saved file, then resolve:
   ```bash
   staff comment resolve --thread <threadId> --author "<your model name>" \
     --status documented --body "Saved as <slug>.md" --documented-as <slug>.md
   ```

3. **Skip it.** Only when the comment is wrong, out of scope, or duplicated. In
   CLI mode, reply with the justification and resolve `--status skipped`.

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
- **Do not delete review comments.** Resolution is recorded as metadata; the thread stays.
- **One resolution per thread.** If you change your mind, run `staff comment unresolve --thread <threadId>` then resolve again with the new status.
- **In CLI mode, explain in a reply, not a top-level comment.**
