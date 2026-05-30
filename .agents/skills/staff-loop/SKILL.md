---
name: staff-loop
description: Iteratively review and resolve the active Staff Review diff. Runs /staff-review then /staff-resolve in subagents, round after round, until a fresh review surfaces no new comments or a configurable round cap (the loopMaxRounds setting, default 5) is hit. Use when the user runs /staff-loop or wants the diff reviewed and fixed end-to-end with minimal supervision.
---

# Staff Loop

You are the **orchestrator**. You don't review or resolve code yourself — you
run a loop that delegates each phase to a fresh subagent so their (large)
contexts stay isolated from yours, and you decide when to stop.

One **round** is: a review subagent posts comments → if any are open, a resolve
subagent fixes them. Resolving edits the working tree, so the next round's
review sees the updated code and can catch regressions or issues the first pass
missed. The loop ends when a review posts **no new open comments** (the diff has
converged) or after the **configured round cap** (a global setting, default 5),
whichever comes first.

## Why the loop is shaped this way

- `/staff-review` is **stateless** — left alone it re-derives findings from
  scratch every pass and would re-raise issues a prior resolve already skipped,
  looping forever. So each review subagent here is told to **read the existing
  threads first** and not re-raise anything already settled.
- The open-comment check happens **after the review**, never after resolve
  (resolve always closes everything, so checking there would exit after one
  round). "No new open comments after a review" is the real convergence signal.

## Step 1 — Set up and validate the diff

If the user passed a slug (e.g. `/staff-loop main..WT`), make it active first;
otherwise read the active diff:

```bash
staff diff main..WT --json   # only if a slug was given; sets it active
staff active --json          # otherwise — capture the slug
```

**Precondition — the head must be the working tree.** Resolve edits the working
tree; review must see those edits next round. Check `head.kind` in the JSON:

- `head.kind === "working-tree"` → good, proceed.
- Otherwise (a fixed `ref`/commit head, e.g. `main..HEAD`) → resolve's edits will
  never enter the diff and the loop is pointless. Stop and tell the user to point
  the diff at the working tree, e.g. `/staff-loop main..WT`.

Capture the `slug` — pass it to every subagent so they operate on the same diff.

Then read the round cap (a user setting, changeable in the web UI's gear menu):

```bash
staff settings get loopMaxRounds   # prints the cap as a number; defaults to 5
```

Call this value **N**.

## Step 2 — Run the loop (up to N rounds)

Track a round counter yourself. For `round` = 1..N:

### a. Spawn a review subagent

Use the Agent/Task tool (do **not** review inline). Run it in the foreground and
await it. Give it this prompt (substitute the real slug):

> Read `.agents/skills/staff-review/SKILL.md` and follow it to the letter to
> review the active Staff Review diff `<slug>`. Identify yourself with
> `--author "<your model name>"` on every `staff comment` command.
>
> **Before reviewing, gain context from prior rounds:** run
> `staff comment list --json` and read the existing threads. Treat every thread
> already resolved as `fixed`, `skipped`, or `documented` as **settled** — do
> **not** re-raise it or a trivial variant of it. Only post comments for
> genuinely new issues, or ones still open and unaddressed. Do not commit or
> modify code. Report back a one-line count of comments you posted.

### b. Check for convergence — **this is the loop's exit**

After the review subagent returns:

```bash
staff comment list --open --json
```

- If it's `[]` (empty) → **the loop is done.** Do **not** launch a resolve
  subagent. Go to Step 3.
- Otherwise, there are open threads to fix — continue to (c).

### c. Spawn a resolve subagent

Use the Agent/Task tool, foreground, awaited. Prompt (substitute the slug):

> Read `.agents/skills/staff-resolve/SKILL.md` and follow it to the letter to
> resolve **every** open thread on the active Staff Review diff `<slug>`.
> Identify yourself with `--author "<your model name>"`. Fix / document / skip
> each thread, reply in-thread, and resolve it. Run the repo's quick checks for
> touched code. Do **not** commit. Report back a one-line summary of how many
> threads you fixed / documented / skipped.

Then loop back to (a) for the next round.

### d. Round cap

If you complete round N's resolve and have not yet converged, **stop without a
further review.** The last round's fixes were applied but not re-verified — say
so in Step 3.

## Step 3 — Report back

Summarize to the user in chat (don't post a top-level comment):

- How many rounds ran.
- Per round: comments posted by review, threads resolved (fixed/documented/skipped).
- Why it stopped: **converged** (a review found nothing new) or **hit the round
  cap** (N — and therefore may not be fully settled; recommend a manual look or
  another `/staff-loop`).
- That changes are in the working tree, **uncommitted**, for the user to review
  and commit.

## Constraints

- **Subagents do the work; you only orchestrate.** Keep your own context lean —
  pass slugs and counts, not file contents.
- **Foreground, sequential.** Each round's review must finish before its resolve,
  and a round's resolve before the next review. Never run them in parallel — they
  share one working tree.
- **No worktree isolation.** The subagents must operate on the real working tree
  the diff points at, so don't isolate them in a separate worktree.
- **Don't commit.** Both phases leave edits in the working tree; the human commits.
- **Respect the precondition.** If the head isn't the working tree, don't loop.
