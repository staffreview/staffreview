# Staff Loop

You are the **orchestrator**. You don't review or resolve code yourself — you
run a loop that delegates each phase to fresh sub-agents so their (large)
contexts stay isolated from yours, and you decide when to stop.

One **round** is: a multi-agent **review** (you fan out find + verify sub-agents
and post the survivors) → if any comments are open, a **resolve** sub-agent fixes
them. Resolving edits the working tree, so the next round's review sees the
updated code and can catch regressions or issues the first pass missed. The loop
ends when a review posts **no new open comments** (the diff has converged) or
after the **configured round cap** (default 5), whichever comes first.

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

Capture the `slug` — pass it to every sub-agent so they operate on the same diff.

Then read the two settings that shape the loop (both changeable in the web UI's
gear menu):

```bash
staff settings get loopMaxRounds   # round cap; default 5  → call this R
staff settings get reviewAgents    # review fan-out width; default 2 → call this A
```

(If the user passed a bare integer argument alongside the slug, use it as **A**
for this run instead of the setting — tailoring fan-out to the diff's size.)

## Step 2 — Run the loop (up to R rounds)

Track a round counter yourself. For `round` = 1..R:

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
4. **Dedup and post after every verify chain drains.** When all verify agents
   have returned and been reaped, dedup the collected survivor list before
   posting. If two survivors are true duplicates — same `file`+`line` describing
   the *same* issue — keep the clearest/highest-severity version, including its
   priority, and drop the duplicate. Post only this final survivor list with the
   `staff` CLI, body via stdin, `--author "<your model name>"` and each finding's
   `--priority` (as `/staff-review` Step 4 describes).

The find skill already skips threads earlier rounds settled, so a re-review won't
re-raise resolved issues.

### b. Check for convergence — **this is the loop's exit**

After the round's review pipeline has **fully drained** — every find chain
verified and its survivors posted:

```bash
staff comment list --open --json
```

- If it's `[]` (empty) → **the loop is done.** Do **not** launch a resolve
  sub-agent. Go to Step 3.
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

If you complete round R's resolve and have not yet converged, **stop without a
further review.** The last round's fixes were applied but not re-verified — say
so in Step 3.

## Step 3 — Report back

Summarize to the user in chat (don't post a top-level comment):

- How many rounds ran; the fan-out width **A** used.
- Per round: comments posted by review, threads resolved (fixed/documented/skipped).
- Why it stopped: **converged** (a review found nothing new) or **hit the round
  cap** (R — and therefore may not be fully settled; recommend a manual look or
  another `/staff-loop`).
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
- **Reap background sub-agents as you consume them.** Stop each find agent
  (`TaskStop`) the instant you read its findings, and each verify agent once
  you've read its verdicts — leaving finished agents open exhausts the limited
  sub-agent pool and trips the sub-agent limit. This keeps the live count near
  **A**, not 2A; if **A** is large, launch finds in batches.
- **No worktree isolation.** The sub-agents must operate on the real working tree
  the diff points at, so don't isolate them in a separate worktree.
- **Don't commit.** Both phases leave edits in the working tree; the human commits.
- **Respect the precondition.** If the head isn't the working tree, don't loop.
