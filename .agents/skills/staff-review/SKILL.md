---
name: staff-review
description: Perform a thorough, multi-agent staff-engineer-level code review of the current diff — fanning the work across parallel find sub-agents, verifying their findings to kill false positives, then leaving inline comments via the `staff` CLI. Use when the user runs /staff-review or asks for a code review of pending changes.
---

# Staff Review

You are the **orchestrator** of a staff/principal-level code review. You do
**not** review the code yourself. You fan the review out across parallel **find**
sub-agents (each owning a slice of the work and following the shared
`/staff-review-find` skill), have a second wave of **verify** sub-agents (each
following `/staff-review-verify`) confirm every finding to weed out false
positives, and then post only the survivors. Your audience is the author. Your
goal is to make the change shippable, durable, and consistent with the codebase
— not to perform expertise.

The find/verify briefs live in their own skills so `/staff-loop` reuses the exact
same sub-agent units without ever spawning a `/staff-review` sub-agent (which
would nest orchestrators). Keep your own context lean: pass slugs, area
assignments, and short findings between agents — never whole file contents.

## Step 1 — Determine the diff and the agent count

**The diff.** If the user passed a diff slug as an argument (a token containing
`..`, e.g. `/staff-review main..WT` or `/staff-review <sha>..WT`), target it
first — this creates it from the slug if needed and makes it active:

```bash
staff diff main..WT --json
```

A slug is `<base>..<head>`, where each side is `WT` (working tree), `STAGED`, or
a git ref (branch, tag, or SHA). Otherwise use the active diff:

```bash
staff active --json
```

If no diff is active and no slug was given, default to the working tree vs the
current branch:

```bash
staff diff --base HEAD --head working-tree --json
```

Note the `slug` — pass it to every sub-agent; every comment references it.

**The agent count `N`.** This is the fan-out width — how many sub-agents run in
parallel *per phase*. Resolve it in this order:

1. A **bare integer argument** to the skill (e.g. `/staff-review main..WT 6`, or
   just `/staff-review 6`) — the user tailoring fan-out to the diff's size.
2. Otherwise the global setting: `staff settings get reviewAgents` (defaults to **2**).

```bash
staff settings get reviewAgents   # prints a number; default 2, bounds 1–20
```

Clamp `N` to **1–20**. `N` is an *upper bound*: for a trivially small diff
(one or two files) feel free to use fewer agents — don't spawn 20 agents to
review a ten-line change.

> The review runs ~2×N agents total (an N-wide find wave, then an up-to-N-wide
> verify wave). That is intentional — verification is what keeps false positives
> out of the review.

## Step 2 — Survey (lean)

Gather just enough to partition the work. Do **not** deep-read files — the
sub-agents do that.

```bash
staff files --slug <slug> --json   # the changed-file list (paths + status)
ls .staffreview/library/           # the team's captured review lessons (may be empty)
```

## Step 3 — FIND: fan the review out across N agents (parallel)

Partition the work two ways, then spawn **N find agents at once** (issue all N
Agent/Task calls in a single batch so they run in parallel).

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

**Partition the library** (`.staffreview/library/`): round-robin the filenames
across the N agents (agent *i* gets files *i, i+N, i+2N, …*). If the library is
empty, skip this part.

**Spawn each find agent** with a prompt that points at the shared skill and fills
in its assignment:

> You are running in `<repo dir>`. Read `.agents/skills/staff-review-find/SKILL.md`
> and follow it exactly. Your parameters:
> - **slug:** `<slug>`
> - **review areas:** `<this agent's area numbers, e.g. "1, 2, 3, 4, 5">`
> - **library lessons:** `<this agent's filenames, or "none">`
>
> Return the findings JSON the skill specifies — nothing else. Do not post,
> spawn agents, or modify code.

**Collect and dedup.** Gather the findings arrays from all N agents into one
list. Merge true duplicates (same file+line describing the *same* issue — keep
the clearer one, prefer the higher severity). Keep distinct issues that happen to
share a line.

## Step 4 — VERIFY: confirm every finding with a second wave (parallel)

No finding reaches the author unverified. Split the deduped findings into up to
**N batches** and spawn **one verify agent per batch, in parallel**. A finding's
verifier is necessarily a *different* agent than its finder (this is a fresh
wave) — the point is independent eyes.

**Spawn each verify agent:**

> You are running in `<repo dir>`. Read `.agents/skills/staff-review-verify/SKILL.md`
> and follow it exactly. Your parameters:
> - **slug:** `<slug>`
> - **candidate findings:** `<the JSON array for this batch>`
>
> Return the verdicts JSON the skill specifies — nothing else. Do not post,
> spawn agents, or modify code.

Keep only **confirmed** findings. When a verdict carries a `correctedAnchor`,
replace that finding's `file`/`line`/`endLine`/`side` with it wholesale (so a
relocated single-line finding loses its old `endLine`, and a relocated range
keeps the corrected one). Discard the rest — note the count you dropped when you
report back.

## Step 5 — Post the survivors

Now — and only now — post each confirmed finding via the `staff` CLI (see
`/staff-comment` for the full form). Pipe the body via stdin so multi-line
Markdown is safe, and always pass `--author` with **your model name** (e.g.
`Opus 4.8`, `GPT-5.5`) and the finding's `--priority`:

```bash
# inline (anchored). Omit --file/--line for a top-level finding. Add --end-line for a range.
printf '%s' "$BODY" | staff comment add \
  --slug <slug> --file <path> --line <n> --side new \
  --author "<your model name>" --priority <P1|P2|P3>
```

`--priority`: **P1** (must fix: bugs, security, data loss, broken contracts),
**P2** (should fix: real but non-blocking), **P3** (minor: nits, naming, optional
cleanups). Be honest with the scale — if everything is P1, nothing is.

**Optional top-level comment.** If a confirmed finding is genuinely
cross-cutting (architecture, a missing migration, an overall coverage gap) with
no single line to attach to, post it top-level (no `--file`/`--line`). Do **not**
post a verdict/"LGTM"/recap that just restates the inline findings — if every
finding has a home inline, post nothing extra.

## Step 6 — Report back

Summarize to the user in chat (don't post a top-level comment for this):

- `N` agents used; the diff slug.
- Findings: raised by the find wave → confirmed by the verify wave → posted
  (and how many false positives the verify wave dropped).
- A one-line severity breakdown of what you posted (e.g. "2 P1, 3 P2, 1 P3").

Then stop. Do not commit or modify code. The user will run `/staff-resolve` next.

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
- **Find before verify, verify before post.** The find wave must finish before
  the verify wave starts; nothing is posted until verification confirms it.
- **Peak parallelism is `N`.** Each wave runs at most `N` agents at once.
- **No worktree isolation.** Sub-agents read the real working tree the diff
  points at; don't isolate them.
- **Don't commit or modify code.** The review ends with comments posted.
