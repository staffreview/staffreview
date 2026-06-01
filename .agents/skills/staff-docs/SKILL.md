---
name: staff-docs
description: Orchestrate a multi-agent mine of past review comments — local Staff Review diffs and GitHub PRs (via `gh`) — for high-value, generalizable lessons worth documenting. Fans the reading out across parallel scout sub-agents, ranks the survivors impact-first, surfaces the top candidates as comments you can review and flag, then documents the ones you flag. Use when the user runs /staff-docs or wants to grow the `.staffreview/docs/` from real history.
---

# Staff Docs

You are the **orchestrator** of a docs sweep. You do **not** read all the
diffs and PRs yourself — that would take forever. You fan the reading out across
parallel **scout** sub-agents (each owning a slice of the local diffs and PRs and
following the shared `/staff-docs-scout` skill), then you centrally dedup,
detect recurring themes, rank, and present the best candidates. After the user
flags the keepers in the UI, you fan out **documenter** sub-agents to write the
docs entries.

Keep your own context lean: hand scouts file lists and PR numbers, and pass short
candidate JSON back — never whole diff or file contents. The docs
(`.staffreview/docs/`) is what `/staff-review` learns from; this skill grows it
from history.

## Modes

- `/staff-docs` — full sweep: local diffs **+** recent GitHub PRs.
- `/staff-docs <N>` — same, with fan-out width **N** (a bare integer).
- `/staff-docs <PR#>` or `<PR URL>` — mine just that one PR (still deduped
  against the docs). One scout, no sweep.
- After candidates are presented, when the user says to proceed (e.g. "go",
  "document them"), run **Step 7** over the flagged threads. Don't re-discover.

(A bare integer is a fan-out width; a larger number or a URL is a single PR.)

## What makes a comment a good candidate

A candidate teaches a **generalizable** lesson `/staff-review` could catch later:

1. **Recurring bug** — same *kind* of issue as one raised on another PR/diff.
   Recurrence is the strongest signal — and detecting it across scouts is **your**
   job (Step 5), since no single scout sees the whole picture.
2. **Serious issue caught by a human reviewer** — real correctness, security,
   data-loss, or contract problem, not tied to one file's quirks. Must be a
   **human** author: the scout **drops bot / automated-reviewer comments
   entirely** (GitHub `user.type: "Bot"`, `…[bot]` login) — they're templated
   noise the base `/staff-review` already catches, so they never reach you.
3. **A fix for a serious issue** — a comment whose linked fix corrected a real,
   generalizable bug.

Rejected by scouts: nits, style, one-file-specific remarks, already-documented or
already-flagged threads. The full brief lives in `/staff-docs-scout`.

## Step 1 — Resolve the fan-out width N and the mode

**Mode.** If the argument is a PR number/URL, it's single-PR mode (skip the
sweep; one scout). A bare integer is the fan-out width.

**Width N** — how many scouts run in parallel. Resolve in order:

1. A **bare integer argument** (`/staff-docs 8`).
2. Otherwise the global setting: `staff settings get docsAgents` (default 5 —
   its own setting, wider than `/staff-review`'s `reviewAgents` because a sweep
   covers far more ground).

```bash
staff settings get docsAgents   # prints a number; default 5
```

Each scout takes **up to 100 PRs**, so the sweep's reach scales with the width:
roughly **N × 100** PRs per run (default 5 → ~500). There's no fixed total cap —
the cache walks further back into history on each later run. Clamp `N` to
**1–20**. A big first sweep benefits from a wider fan-out (raise `docsAgents`
or pass a bigger integer); the cache makes later sweeps cheap. `N` is an upper
bound — don't spawn 6 scouts for three local diffs and no PRs.

## Step 2 — Preflight (inline, cheap)

```bash
test -d .staffreview/diffs || echo "run 'staff install' first"
mkdir -p .staffreview/docs

# Find the running staff server (for clickable links). Refused ports return
# instantly. Match THIS repo by git root so links point at the right server.
ROOT=$(git rev-parse --show-toplevel)
STAFF_PORT=""
for p in $(seq 4300 4399); do
  info=$(curl -fsS -m 1 "http://localhost:$p/api/info" 2>/dev/null) || continue
  [ "$(printf '%s' "$info" | jq -r '.root // empty')" = "$ROOT" ] && { STAFF_PORT=$p; break; }
done

DEFAULT_BRANCH=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')
DEFAULT_BRANCH=${DEFAULT_BRANCH:-main}
```

**Build the docs index.** Read every `.staffreview/docs/*.md` frontmatter
and collect one compact line per entry: its `source:` URL/slug + the lesson title
+ tags. This is the dedup index you pass to **every** scout (it's small — one line
per entry). If the docs is empty, the index is "none".

**Load the cache** `.staffreview/docs-cache.json` (already gitignored under
`.staffreview/`). Create it if absent. Schema:

```json
{
  "lastSweepAt": "<iso>",
  "scannedPRs": { "482": { "verdict": "candidate", "at": "<iso>" } },
  "lastPresented": [
    { "slug": "<base>..<head>", "threadId": "<id>", "source": "PR #482", "title": "<lesson>" }
  ]
}
```

`verdict` ∈ `candidate | low-value | no-comments | irrelevant | error`.

**Check `gh`.** PRs are only swept when `gh` is installed and authenticated:

```bash
command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1 && echo ok || echo skip-prs
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)   # only if ok
```

If `gh` is unavailable, sweep local diffs only and tell the user PRs were skipped.

## Step 3 — Build and partition the work-list

**Local diffs.** `ls .staffreview/diffs/*.json` → the full list of diff files.

**PRs (sweep mode, `gh` ok).** The budget is **100 PRs per scout**, so this sweep
wants up to **N × 100** promising PRs. Walk PRs newest-first, skip any already in
`scannedPRs`, and **pre-filter low-value PRs yourself** so scouts never waste a
network round-trip on them. Pull a generous page (filtering drops many) and keep
taking until you have `N × 100` promising un-cached PRs or the list runs out:

```bash
# Pull newest-first with headroom (low-value + already-cached get dropped below).
gh pr list --state all --limit $((N * 150)) \
  --json number,title,labels,state,mergedAt,updatedAt,author,reviewDecision
```

Mark `low-value` (write the verdict straight to the cache, don't hand to a scout):
dependency bumps (`dependabot`/`renovate` authors; titles like `bump`,
`update … to …`), formatting/lint-only, version/release chores, pure-typo docs.
Keep the rest as the **promising PR list**, newest first, and cap it at `N × 100`.
Whatever you don't reach this run stays un-cached, so the next sweep picks it up.

**Single-PR mode.** The work-list is just that one PR (and no local diffs).

**Partition.** Build one combined work-list — the local diff files **interleaved
with** the promising PR numbers (so no scout gets stuck with only slow PR
fetches) — and round-robin it across the `N` scouts (item *i* → scout *i mod N*).
Each scout ends up with ≤100 PRs. Drop empty buckets; never spawn an idle scout.

## Step 4 — FAN OUT: spawn N scouts in parallel

Issue **all N Agent/Task calls in a single batch** so they run concurrently. Give
each scout its slice and the shared context:

> You are running in `<repo dir>`. Read `.agents/skills/staff-docs-scout/SKILL.md`
> and follow it exactly. Your parameters:
> - **local diffs:** `<this scout's diff filenames, or "none">`
> - **PR numbers:** `<this scout's PR numbers (≤100), or "none">`
> - **repo:** `<owner/name>`
> - **default branch:** `<branch>`
> - **docs index:** `<the compact dedup lines, or "none">`
>
> Return the `{ candidates, scanned }` JSON the skill specifies — nothing else.
> Do not post, create diffs, run git fetch, spawn agents, or modify code.

**Collect** every scout's `candidates` into one list and merge every `scanned`
map (plus the `low-value` PRs you pre-marked) into the cache's `scannedPRs`, each
with the current timestamp. Set `lastSweepAt`.

## Step 5 — Merge: dedup, detect recurrence, rank (you, centrally)

1. **Dedup** against the docs index and against each other — two candidates
   teaching the same lesson collapse to one (keep the clearer / more recent).
2. **Detect recurrence (criterion 1).** Group candidates by `theme` across *all*
   scouts. A theme seen on **multiple** sources is higher impact — **boost** its
   severity (e.g. two P2s on the same theme become a P1-class "recurring" finding).
   This cross-scout view is the whole reason recurrence is judged here, not in a
   scout.
3. **Rank impact-first.** Sort by severity descending (recurring + serious first),
   breaking ties by recency (newest `createdAt` first). Take the **top 10** to
   present — set the rest aside (they stay un-flagged for a future run).

## Step 6 — Materialize & present (you; git ops serialized here)

Make each of the top 10 reviewable in the UI as a comment the user can
**Document**, then present the list. Use **your own model name** as `--author`
(e.g. `Opus 4.8`) and the candidate's `--priority`. Materialization touches git
and the `staff` CLI, so do it **here, sequentially** — never in a scout.

**Local candidate** — the comment already exists on its diff. Nothing to post;
record its `slug` + `threadId`. Link: `?diff=<slug>`.

**PR candidate** — fetch the PR's commits, build the diff, anchor the point:

```bash
git fetch -q origin "pull/<pr>/head"           # FETCH_HEAD = PR head
HEAD_SHA=$(git rev-parse FETCH_HEAD)            # (or use the scout's headSha)
git cat-file -e "<baseSha>" 2>/dev/null || git fetch -q origin "<baseSha>"

SLUG="<baseSha>..${HEAD_SHA}"
staff diff "$SLUG" --no-set-active --json       # create the diff; don't disturb the active one

printf '%s' "<one-line lesson>. Generalizable: <why>. From PR #<pr>: <prUrl>

\`\`\`diff
<the relevant slice of diffHunk>
\`\`\`

Reviewer's point, restated: <rationale>." | staff comment add \
  --slug "$SLUG" --file "<file>" --line <line> --side <new|old> \
  --author "Opus 4.8" --priority <Pn>
```

Capture the printed comment's `threadId`. **Fallback if `git fetch` fails**
(deleted fork, dropped commit, offline): don't lose the candidate — reuse one
shared diff `staff diff "${DEFAULT_BRANCH}..WT" --no-set-active` and add a
**top-level** comment (no `--file`/`--line`) whose body carries the lesson, the
`diffHunk` in a fenced ```diff block, the rationale, and the PR link.

**Record** every presented item (`slug`, `threadId`, `source`, `title`) into the
cache's `lastPresented` so Step 7 knows where to look.

**Present** the list to the user, highest-impact first, numbered. For each:
the one-line lesson; which criterion it hit (recurring / human-caught / fix) and
its recurrence count if >1; severity; source (`PR #<n>` or local slug) and the
**author** (e.g. `octocat`); and the link —
`http://localhost:<STAFF_PORT>/?diff=<slug>` if a server is running, else the
command `staff <slug>` (append `--port <n>` for a fixed port).

Then **stop** with a clear instruction, e.g.:

> Scanned with N scouts; added 10 candidates. Open each link, click **Document**
> on the ones worth keeping, then tell me to proceed and I'll write the entries.

Do **not** document or resolve anything yet.

## Step 7 — Document the flagged candidates (fan out documenters)

Triggered when the user says to proceed. Across the `slug`s in `lastPresented`,
collect the threads the user flagged:

```bash
staff comment list --slug "<slug>" --json | jq '[.[] | select(.documentRequested == true)]'
```

Split the flagged threads into up to **N** batches and spawn **one documenter
agent per batch, in parallel** (batch all calls in one message). Each writing a
docs entry is independent, so this parallelizes cleanly:

> You are running in `<repo dir>`. Use `.agents/skills/staff-document/SKILL.md` as
> the entry **format**. For each thread below, write a `.staffreview/docs/<slug>.md`
> entry and then resolve it. Threads (slug · threadId · source · lesson · PR URL
> or local):
> `<this batch's threads, with their context>`
>
> For each: read the thread with `staff comment list --slug <slug> --json`, pick a
> slug that names the **lesson** (e.g. `close-fd-on-error-path.md`), write the
> entry (frontmatter `source:` = the PR URL, or the diff slug for a local one;
> sections: Context / The issue / Original code / Fix / Why it matters; one
> screenful; no author names), then run:
> ```bash
> staff comment resolve --slug "<slug>" --thread <threadId> \
>   --status documented --documented-as <lesson-slug>.md \
>   --author "<your model name>" --body "Documented as <lesson-slug>.md."
> ```
> Return a one-line list of the files you wrote — nothing else.

When the documenters return, mark each corresponding PR `documented` in the cache,
then summarize: the new docs files, and any candidates the user did **not**
flag (left as open comments for a future run).

## The docs cache

`.staffreview/docs-cache.json` lives under the already-gitignored `.staffreview/`
tree — never commit it. It's purely an optimization: deleting it just makes the
next sweep re-scan PRs. To re-scan everything, delete it (or do so if the user
asks to "re-scan from scratch").

## Constraints

- **You orchestrate; scouts do the reading.** Never mine diffs/PRs inline — spawn
  `/staff-docs-scout` agents. Keep your context lean: pass file lists, PR
  numbers, and short candidate JSON, not file or diff contents.
- **Recurrence, dedup, and ranking are central.** Only you see all scouts'
  output, so cluster and rank in Step 5 — scouts can't.
- **Serialize git/CLI mutations.** All `git fetch`, `staff diff`, and
  `staff comment` calls happen in the orchestrator (Steps 6–7) or documenter
  agents — never in a scout (avoids parallel-fetch races; scouts stay read-only).
- **Phases are sequential.** Scouts finish before you rank; you present before the
  user flags; flagging before documenters run.
- **Don't document in Step 1–6; wait for the user to flag.**
- **No worktree isolation.** Scouts and documenters read the real repo.
- **Don't disturb the active diff** — create docs diffs with `--no-set-active`.
- **Don't commit**, and don't include author names in docs entries.
