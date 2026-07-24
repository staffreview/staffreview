# Staff Loop

You are the **orchestrator**. You don't review or resolve code yourself — you
run a loop that delegates each phase to fresh sub-agents so their (large)
contexts stay isolated from yours, and you decide when to stop.

One **round** is: a multi-agent **review** (you fan out find + verify sub-agents
and post the survivors) → if any comments are open, a **resolve** sub-agent fixes
them. A round is complete only after both phases finish (or after review when
there is nothing to resolve). Resolving edits the working tree, so the next
round's review sees the updated code and can catch regressions or issues the
first pass missed. The loop ends when a review posts **no new open comments**
(the diff has converged) or after completing the **configured round cap**
(default 5), whichever comes first.

You run the review **inline as the orchestrator** — you do **not** spawn a
`/staff-review` sub-agent. `/staff-review` is itself an orchestrator that spawns
find/verify sub-agents; nesting it inside one of your sub-agents would require a
sub-agent to spawn its own sub-agents (usually impossible). Instead you spawn the
shared **`/staff-review-find`** and **`/staff-review-verify`** sub-agents
directly — the same units `/staff-review` uses.

## Why the loop is shaped this way

- The review is **stateless** — left alone it re-derives findings from scratch
  every pass and would re-raise issues a prior resolve already settled, looping
  forever. The `/staff-review-find` skill guards against this: each find agent
  reads the existing threads and skips anything already resolved. So a re-review
  won't re-raise settled issues.
- The open-comment check happens **after the review**, never after resolve
  (resolve always closes everything, so checking there would exit after one
  round). "No new open comments after a review" is the real convergence signal.

## Step 1 — Set up and validate the diff

The CLI is optional: never stop to ask for it. Resolve the slug from a user
argument, then `staff active --json` if available, otherwise `main..WT`. With
the CLI, run `staff diff <slug> --json`; without it, workers use Git.

**Precondition — the head must be the working tree.** Resolve edits the working
tree; review must see those edits next round. Check `head.kind` in CLI output or
that the slug ends in `..WT` without it:

- `head.kind === "working-tree"` → good, proceed.
- Otherwise (a fixed `ref`/commit head, e.g. `main..HEAD`) → resolve's edits will
  never enter the diff and the loop is pointless. Stop and tell the user to point
  the diff at the working tree, e.g. `/staff-loop main..WT`.

Capture the `slug` — pass it to every sub-agent so they operate on the same diff.

Read the settings below when available; otherwise use `R=5`, `A=2`.

```bash
staff settings get loopMaxRounds   # round cap; default 5  → call this R
staff settings get reviewAgents    # review fan-out width; default 2 → call this A
```

(If the user passed a bare integer argument alongside the slug, use it as **A**
for this run instead of the setting — tailoring fan-out to the diff's size.)

## Step 2 — Run the loop (up to R rounds)

Track a round counter. Without the CLI, also track settled
`file`/`line`/`title`/`body` fingerprints in memory. For `round` = 1..R:

### a. Review the diff yourself (pipelined find → verify → post)

Run the same multi-agent review `/staff-review` performs, **inline** — do **not**
spawn a `/staff-review` sub-agent. Use **A** as the fan-out width, and **pipeline
it the same way**: each find agent's output flows straight into its own verify,
and each verified survivor batch is reaped into an in-memory list. Wait only for
all verify chains to drain before the final dedup/post pass, so posting is not
order-dependent.

1. **Find (background).** Partition the 10 review areas (and the
   `.staffreview/docs/` files) across **A** find agents and spawn them in the
   **background** (`run_in_background`) so each reports back independently — each
   with:
   > Read `.agents/skills/staff-review-find/SKILL.md` and follow it exactly.
   > mode=`diff`; slug=`<slug>`; review areas=`<this agent's area numbers>`; docs
   > lessons=`<this agent's filenames, or "none">`. Return the findings JSON —
   > nothing else.

   See `/staff-review` Step 3 for the area/docs partitioning scheme.
2. **Verify (as each find agent returns).** The moment a find agent reports back,
   **stop its background task** (`TaskStop` with the id you launched it with) to
   free its slot — you have its findings now — then spawn one verify agent
   (background) seeded with *only that agent's* findings (if it returned `[]`,
   stop it and skip the verify):
   > Read `.agents/skills/staff-review-verify/SKILL.md` and follow it exactly.
   > mode=`diff`; slug=`<slug>`; candidate findings=`<this find agent's JSON>`.
   > Return the verdicts JSON — nothing else.

   Keep only the **confirmed** findings; when a verdict carries a
   `correctedAnchor`, replace that finding's `file`/`line`/`endLine`/`side` with
   it wholesale.
3. **Collect survivors (as each verify agent returns).** Append each confirmed
   finding to an in-memory survivor list, but do **not** post it yet. Once a
   verify agent's verdicts are consumed, **stop that verify agent's task too**
   (`TaskStop`) — finished agents left open keep holding slots and will trip the
   sub-agent limit. Reaping each agent as you consume it keeps the live count near
   **A**, not 2A.
4. **Dedup and publish after every verify chain drains.** Dedup as
   `/staff-review` describes. With the CLI, post survivors normally. Without it,
   retain them for resolve and remove fingerprints settled in earlier rounds.

In CLI mode the find skill skips threads earlier rounds settled. In CLI-free
mode, resolved code changes remove the issue from the next round's diff.

### b. Check for convergence — **this is the loop's exit**

After the review drains, use open CLI threads or, without the CLI, this round's
survivors:

```bash
staff comment list --open --json   # CLI mode
```

- If the applicable list is `[]` (empty) → **the loop is done.** Do **not**
  launch a resolve sub-agent. Go to Step 3.
- Otherwise, there are issues to fix — continue to (c), even in round R.
  The round cap is not checked immediately after review.

### c. Spawn a resolve subagent

Use the Agent/Task tool, foreground, awaited. In CLI mode use this prompt:

> Read `.agents/skills/staff-resolve/SKILL.md` and follow it to the letter to
> resolve **every** open thread on the active Staff Review diff `<slug>`.
> Identify yourself with `--author "<your model name>"`. Fix / document / skip
> each thread, reply in-thread, and resolve it. Run the repo's quick checks for
> touched code. Do **not** commit. Report back a one-line summary of how many
> threads you fixed / documented / skipped.

Without the CLI, instead pass `slug` plus indexed survivor JSON and tell resolve
not to run `staff`; it returns `[{"index":0,"outcome":"fixed|documented|skipped"}]`.
Settle only reported `documented`/`skipped` fingerprints. A `fixed` finding must
disappear from the next review; missing indexes remain unresolved.

After resolve finishes, continue to (d).

### d. Round cap

Check the round cap only after resolve. If you completed round R, **stop without
starting review R+1.** The final round's fixes were applied but not re-reviewed —
say so in Step 3. Without the CLI, retain omitted resolver indexes for reporting.
Otherwise, loop back to (a) for the next round.

## Step 3 — Report back

Summarize to the user in chat (don't post a top-level comment):

- How many rounds ran; the fan-out width **A** used.
- Per round: comments posted by review, threads resolved (fixed/documented/skipped).
- Why it stopped: **converged** (a review found nothing new) or **hit the round
  cap** (R — final-round fixes were applied but not re-reviewed; recommend a
  manual look or another `/staff-loop`).
- Without the CLI at the round cap, list every retained unresolved survivor in
  full (priority, title, anchor, and body) so no finding is lost.
- That changes are in the working tree, **uncommitted**, for the user to review
  and commit.

## Constraints

- **Sub-agents do the work; you only orchestrate.** Spawn find
  (`/staff-review-find`), verify (`/staff-review-verify`), and resolve
  (`/staff-resolve`) sub-agents — never a `/staff-review` sub-agent (no nested
  orchestrators). Keep your own context lean — pass slugs, area buckets, and
  short findings, not file contents.
- **Review is pipelined; resolve is a barrier.** Within a round the review runs
  find → verify → collect survivors **pipelined per find agent**. Posting waits
  for the final dedup pass after all verify chains drain. The convergence check
  and any resolve happen only **after the whole review has drained** — every find
  chain verified/reaped and final survivors posted — and a round's resolve must
  fully finish before the next round's review, since they share one working tree.
- **The final round still resolves.** If review in round R posts comments, run
  resolve for those comments and wait for it to finish. The cap prevents review
  R+1; it never permits stopping with round R's comments still open.
- **Reap background sub-agents as you consume them.** Stop each find agent
  (`TaskStop`) the instant you read its findings, and each verify agent once
  you've read its verdicts — leaving finished agents open exhausts the limited
  sub-agent pool and trips the sub-agent limit. This keeps the live count near
  **A**, not 2A; if **A** is large, launch finds in batches.
- **No worktree isolation.** The sub-agents must operate on the real working tree
  the diff points at, so don't isolate them in a separate worktree.
- **Don't commit.** Both phases leave edits in the working tree; the human commits.
- **Respect the precondition.** If the head isn't the working tree, don't loop.
