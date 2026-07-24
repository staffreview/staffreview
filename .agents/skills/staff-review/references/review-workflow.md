# Staff Review

You are the **orchestrator** of a staff/principal-level code review. You do
**not** review the code yourself. You fan the review out across parallel **find**
sub-agents (each owning a slice of the work and following the shared
`/staff-review-find` skill), and you **pipeline** each one's output straight into
its own **verify** sub-agent (following `/staff-review-verify`). Verification
runs per find agent as soon as that finder returns; posting waits until every
verify chain drains, then you dedup the confirmed survivors and post them in one
final pass. Your audience is the author. Your goal is to make the change
shippable, durable, and consistent with the codebase — not to perform expertise.

The find/verify briefs live in their own skills so `/staff-loop` reuses the exact
same sub-agent units without ever spawning a `/staff-review` sub-agent (which
would nest orchestrators). Keep your own context lean: pass slugs, area
assignments, and short findings between agents — never whole file contents.

## Step 1 — Determine the diff and agent count

The `staff` CLI is optional: never stop to ask for it. Resolve the slug from a
user argument, then `staff active --json` if available, otherwise `main..WT`.
With the CLI, target that slug; without it, continue and let workers use Git:

```bash
staff diff <slug> --json
```

Pass the slug to every sub-agent.

**The agent count `N`.** This is the find-agent fan-out width, and the target
live sub-agent count while find slots convert into verify slots. Resolve it in
this order:

1. A **bare integer argument** (e.g. `/staff-review main..WT 6`).
2. `staff settings get reviewAgents`, if available.
3. **2**.

```bash
staff settings get reviewAgents   # prints a number; default 2, bounds 1–20
```

Clamp `N` to **1–20**. `N` is an *upper bound*: for a trivially small diff
(one or two files) feel free to use fewer agents — don't spawn 20 agents to
review a ten-line change.

> The review runs ~2×N agents total — N find agents, each paired with a verify
> agent that re-checks its findings — but they're **pipelined and reaped as they
> go**: the moment a find agent returns you stop its task and start its verifier,
> so the *live* sub-agent count stays around N (a find slot becomes a verify slot),
> never 2N. Reaping finished agents is load-bearing — leaving them open exhausts
> the limited sub-agent pool and trips the sub-agent limit. The verify pass itself
> is non-negotiable: it's what keeps false positives out of the review.

## Step 2 — Survey (lean)

Gather just enough to partition the work. Do **not** deep-read files — the
sub-agents do that.

Use `staff files --slug <slug> --json`, or the find worker's Git fallback when
the CLI is absent, plus `ls .staffreview/docs/` (which may be empty).

## Step 3 — FIND: launch N find agents in the background

Partition the work two ways, then spawn **N find agents in the background** —
issue all N Agent/Task calls with `run_in_background` so each reports back
independently and you can act on it the instant it finishes. **Do not wait for
the whole wave**: Step 4 consumes each agent's findings as they arrive.

**Partition the 10 review areas** into N buckets (keep related areas together;
the heavier areas — correctness, edge cases, concurrency, security, data — carry
more weight, so don't pile them onto one agent). The areas (full descriptions
live in `/staff-review-find`):

> 1 Correctness & logic · 2 Edge cases & failure modes · 3 Concurrency &
> resources · 4 Security · 5 Data & migrations · 6 Interfaces & contracts ·
> 7 Tests · 8 Consistency with the codebase · 9 Readability & maintainability ·
> 10 Performance

- **N=1:** one agent owns all 10 areas.
- **N=2:** agent 1 → areas 1–5; agent 2 → areas 6–10.
- **N=3:** 1–3 / 4–6 / 7–10.
- **N=4–10:** subdivide further so each area is owned by at least one agent.
- **N>10:** every area is owned; spend the extra agents on a **second,
  independent pass of the highest-risk areas** (1–5) and/or **partition the
  changed files** among them (each extra agent reviews a subset of files across
  all areas) — the better lever for a large diff.

**Partition the docs** (`.staffreview/docs/`): round-robin the filenames
across the N agents (agent *i* gets files *i, i+N, i+2N, …*). If the docs is
empty, skip this part.

**Spawn each find agent** with a prompt that points at the shared skill and fills
in its assignment:

> You are running in `<repo dir>`. Read `.agents/skills/staff-review-find/SKILL.md`
> and follow it exactly. Your parameters:
> - **mode:** `diff`
> - **slug:** `<slug>`
> - **review areas:** `<this agent's area numbers, e.g. "1, 2, 3, 4, 5">`
> - **docs lessons:** `<this agent's filenames, or "none">`
>
> Return the findings JSON the skill specifies — nothing else. Do not post,
> spawn agents, or modify code.

**Do not collect raw findings into one pre-verify pool.** Each agent's findings
flow straight into their own verify chain in Step 4. Cross-agent duplicates are
rare (find agents own disjoint areas) and are handled after verification, not
behind a pre-verify barrier.

## Step 4 — VERIFY PIPELINE → DEDUP → POST

This stage is **event-driven, not a second wave.** As **each** find agent reports
back, run its findings through its own verify chain immediately — don't wait on
the other find agents to start verification. Background agents draw from a
**limited sub-agent pool**, so **reap each one the instant you've consumed it**
(the `TaskStop` steps below) — leaving finished agents open is what exhausts the
limit.

**1. Verify (one verify agent per returning find agent).** The moment a find
agent reports back, **stop its background task** (`TaskStop` with the id you got
when you launched it) — you already have its findings, so it must not keep holding
a slot. Then spawn a verify agent in the background, seeded with *only that find
agent's* findings. The verifier is necessarily a *different* agent than the finder
— the point is independent eyes. If a find agent returned `[]`, stop it and move
on — nothing to verify.

> You are running in `<repo dir>`. Read `.agents/skills/staff-review-verify/SKILL.md`
> and follow it exactly. Your parameters:
> - **mode:** `diff`
> - **slug:** `<slug>`
> - **candidate findings:** `<this find agent's JSON array>`
>
> Return the verdicts JSON the skill specifies — nothing else. Do not post,
> spawn agents, or modify code.

**2. Collect survivors (as each verify agent returns).** Keep only
**confirmed** findings. When a verdict carries a `correctedAnchor`, replace that
finding's `file`/`line`/`endLine`/`side` with it wholesale (a relocated
single-line finding loses its old `endLine`; a relocated range keeps the
corrected one). Discard the rest — track how many you dropped for the Step 5
report. Reap each verify agent immediately after consuming its verdicts, then
append that batch's confirmed survivors to an in-memory list.

**3. Dedup and publish survivors after all verify chains drain.** Once every
verify agent has returned and been reaped, dedup the collected survivors.
If two survivors are true duplicates — same `file`+`line` describing the *same*
issue — keep the clearest/highest-severity version, including its priority, and
drop the duplicate. In CLI mode, post only this final survivor list via the
`staff` CLI (see `/staff-comment` for the full form). Pipe the body via stdin so
multi-line Markdown is safe, and always pass `--author` with **your model name**
(e.g. `Opus 4.8`, `GPT-5.5`) and the survivor's `--priority`:

```bash
# inline (anchored). Omit --file/--line for a top-level finding. Add --end-line for a range.
printf '%s' "$BODY" | staff comment add \
  --slug <slug> --file <path> --line <n> --side new \
  --author "<your model name>" --priority <P1|P2|P3>
```

`--priority`: **P1** (must fix: bugs, security, data loss, broken contracts),
**P2** (should fix: real but non-blocking), **P3** (minor: nits, naming, optional
cleanups). Be honest with the scale — if everything is P1, nothing is.

Without the CLI, return the final survivors in chat instead; only UI persistence
is unavailable.

**Optional top-level comment.** If a confirmed finding is genuinely
cross-cutting (architecture, a missing migration, an overall coverage gap) with
no single line to attach to, post it top-level (no `--file`/`--line`). Do **not**
post a verdict/"LGTM"/recap that just restates the inline findings — if every
finding has a home inline, post nothing extra.

Once you've consumed a verify agent's verdicts and added any confirmed survivors
to the in-memory list, **stop that verify agent's task too** (`TaskStop`) — don't
leave finished agents open.

Reaping on consume this way keeps the **live** sub-agent count at ~N (each find
slot turns into a verify slot), never 2N. If `N` is large enough that launching
all find agents at once would exceed the pool, launch them in batches and reap
completed ones before starting more.

Continue until **every** find chain and its verify agent have drained and all
survivors are posted. Only then go to Step 5.

## Step 5 — Report back

Summarize to the user in chat (don't post a top-level comment for this):

- `N` find agents used; the diff slug.
- Findings: raised by the find agents → confirmed by their verifiers → posted
  or returned in chat (and how many false positives verification dropped, plus
  any post-time duplicates you merged).
- A one-line severity breakdown of what you posted (e.g. "2 P1, 3 P2, 1 P3").

Then stop. Do not commit or modify code. Keep CLI-free survivors available for a
following `/staff-resolve`.

## Conventions for comment bodies

- Use Markdown; code suggestions in fenced blocks.
- Reference locations as `path/to/file.ts:42` so the author can navigate.
- Keep each comment under ~10 lines unless it includes code.
- One issue per comment.

## Constraints

- **You orchestrate; sub-agents do the work.** Never review or verify inline
  yourself — spawn find agents (`/staff-review-find`) and verify agents
  (`/staff-review-verify`). Keep your context lean — pass slugs and short
  findings, not file contents.
- **Verify before post, but pipeline verification per find agent.** Each finding
  still flows find → verify → collect survivor → dedup → post in order, and
  **nothing is posted unverified**. A find agent's verifier starts as soon as
  that finder returns; posting waits for every verify chain to drain so the final
  survivor list can be deduped once.
- **Reap each background agent as soon as you've consumed it.** Stop a find
  agent's task (`TaskStop`) the instant you read its findings — then start its
  verifier — and stop a verify agent's task once you've consumed its verdicts
  and appended any confirmed survivors to the in-memory list.
  Finished agents left open keep holding slots in a **limited pool** and will trip
  the sub-agent limit. Reaping on consume keeps the *live* count at ~`N` (a find
  slot converts to a verify slot), not 2N; if `N` is large, launch finds in
  batches so you never exceed the pool.
- **No worktree isolation.** Sub-agents read the real working tree the diff
  points at; don't isolate them.
- **Don't commit or modify code.** The review ends with findings posted or
  returned in chat.
