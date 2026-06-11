---
name: staff-docs
description: Orchestrate a multi-agent mine of GitHub PR review comments for high-value, generalizable lessons worth documenting. By default it sweeps recent GitHub PRs; the user can optionally pass PR URL(s) or PR refs to target specific PRs. Fans the reading out across parallel scout sub-agents, ranks the survivors impact-first, surfaces the top candidates as comments you can review and flag, then documents the ones you flag. Use when the user runs /staff-docs or wants to grow `.staffreview/docs/` from GitHub PR review history.
---

# Staff Docs

You are the **orchestrator** of a GitHub PR docs sweep. You do **not** read PRs
yourself — that would take forever. You build a PR work-list, then fan the
reading out across parallel **scout** sub-agents (each owning a slice of PR refs
and following the shared `/staff-docs-scout` skill). Then you centrally dedup,
detect recurring themes, rank, and present the best candidates. After the user
flags the keepers in the UI, you fan out **documenter** sub-agents to write the
docs entries.

Keep your own context lean: hand scouts normalized PR refs and pass short
candidate JSON back — never whole diffs or file contents. The docs
(`.staffreview/docs/`) is what `/staff-review` learns from; this skill grows it
from GitHub PR review history. It **does not** mine local Staff Review diffs.

## Modes

- `/staff-docs` — sweep recent GitHub PRs for the current repo.
- `/staff-docs <N>` — same sweep, with fan-out width **N** (1–20).
- `/staff-docs <PR URL> [<PR URL> ...]` — targeted mode: mine only those PRs.
- `/staff-docs owner/repo#123 [owner/repo#456 ...]` — targeted mode for explicit
  repo/PR refs.
- `/staff-docs <PR#> [<PR#> ...]` — targeted mode for current-repo PR numbers
  when there is more than one numeric arg, or when the single number is >20.
  For PRs numbered 1–20, pass the URL or `owner/repo#<n>` to avoid the fan-out
  ambiguity.
- After candidates are presented, when the user says to proceed (e.g. "go",
  "document them"), run **Step 7** over the flagged threads. Don't re-discover.

If the user provides PR refs, stay targeted. If they provide no PR refs, run the
GitHub PR sweep. Never scan local Staff Review diffs.

Fan-out width comes from `staff settings get docsAgents` (default 5, clamped
1–20), unless the user passed a single bare integer 1–20 as a one-off fan-out
override. In targeted mode, cap the width at the number of PR refs. Drop empty
buckets; never spawn an idle scout.

## What makes a comment a good candidate

A candidate teaches a **generalizable** lesson `/staff-review` could catch later:

1. **Recurring bug** — same *kind* of issue as one raised on another PR.
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

## Step 1 — Resolve mode, PR refs, and fan-out width N

**Mode.** Parse the user's arguments:

- If there are no args, run **sweep mode**.
- If there is exactly one bare integer in `1..20`, run **sweep mode** and use it
  as a one-off fan-out override.
- Otherwise, run **targeted mode** and parse every arg as a PR ref.

**PR refs.** Parse every argument as one of:

- GitHub PR URL: `https://github.com/<owner>/<repo>/pull/<number>` (fragment OK).
- Repo shorthand: `<owner>/<repo>#<number>`.
- Bare PR number: `<number>` (current repo only, targeted mode).

Normalize them into unique refs:

```json
{ "repo": "owner/name", "pr": 482, "prUrl": "https://github.com/owner/name/pull/482" }
```

For bare PR numbers, resolve the current repo with `gh repo view --json
nameWithOwner -q .nameWithOwner`.

If `gh` is unavailable or unauthenticated, stop and tell the user PR mining needs
`gh auth login`. There is no local-diff fallback.

**Width N.** Resolve the scout fan-out from the global setting:

```bash
staff settings get docsAgents   # prints a number; default 5
```

Clamp `N` to **1–20**. If the mode is targeted, cap it at the number of PR refs.

## Step 2 — Preflight (inline, cheap)

```bash
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

command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1 && echo ok || echo "run gh auth login"
CURRENT_REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
```

**Build the docs index.** Read every `.staffreview/docs/*.md` frontmatter
and collect one compact line per entry: its `source:` URL/slug + the lesson title
+ tags. This is the dedup index you pass to **every** scout (it's small — one line
per entry). If the docs is empty, the index is "none".

**Load the docs cache** `.staffreview/docs-cache.json` (already gitignored under
`.staffreview/`). Create it if absent. Sweep mode uses `scannedPRs` to avoid
reviewing the same PR forever; targeted mode ignores `scannedPRs` because the
user named those PRs explicitly.

```json
{
  "lastRunAt": "<iso>",
  "scannedPRs": {
    "owner/name#482": { "verdict": "candidate", "at": "<iso>" },
    "owner/name#481": { "verdict": "low-value", "at": "<iso>" }
  },
  "lastPresented": [
    {
      "slug": "<base>..<head>",
      "threadId": "<id>",
      "source": "PR #482",
      "title": "<lesson>",
      "prUrl": "https://github.com/owner/name/pull/482"
    }
  ]
}
```

In targeted mode, do **not** skip a PR because it appeared in `scannedPRs`. In
sweep mode, skip PRs already in `scannedPRs`.

When loading an existing cache, migrate the older schema before matching
`scannedPRs`: if `lastSweepAt` exists and `lastRunAt` is absent, copy it to
`lastRunAt` and drop `lastSweepAt`; if any `scannedPRs` key is a bare PR number,
rewrite it to `${CURRENT_REPO}#<number>` (unless that namespaced key already
exists) and delete the bare key. Old bare keys could only have come from the
current repo.

## Step 3 — Build and partition the PR work-list

**Targeted mode.** The work-list is exactly the normalized PR refs the user
passed. Do not broaden the scope.

**Sweep mode.** Walk current-repo PRs newest-first, skip PRs already in
`scannedPRs`, and pre-filter obvious low-value PRs yourself so scouts do not
waste a slot. Take up to **N × 100** promising un-cached PRs:

```bash
gh pr list --state all --limit $((N * 150)) \
  --json number,title,author,createdAt,updatedAt,mergedAt,closedAt,additions,deletions,changedFiles,comments,reviewDecision,url \
  --jq '.[]'
```

Drop PRs that are clearly bot-only, pure dependency bumps, formatting-only churn,
tiny typo/docs changes with no review discussion, or already covered by the docs
index. Record dropped PRs in `scannedPRs` as `"low-value"` so the next sweep
moves on. Keep the rest as normalized PR refs for the current repo, newest first,
and cap them at `N × 100`.

Round-robin the final PR work-list across `N` scouts (item *i* → scout *i mod
N*). Drop empty buckets. Do not add local diff files.

## Step 4 — FAN OUT: spawn N scouts in parallel

Issue **all N Agent/Task calls in a single batch** so they run concurrently. Give
each scout its slice and the shared context:

> You are running in `<repo dir>`. Read `.agents/skills/staff-docs-scout/SKILL.md`
> and follow it exactly. Your parameters:
> - **PR refs:** `<JSON array of {repo, pr, prUrl}>`
> - **current repo:** `<owner/name>`
> - **default branch:** `<branch>`
> - **docs index:** `<the compact dedup lines, or "none">`
>
> Return the `{ candidates, scanned }` JSON the skill specifies — nothing else.
> Do not post, create diffs, run git fetch, spawn agents, or modify code.

**Collect** every scout's `candidates` into one list and merge every `scanned`
map. Set `lastRunAt` in the cache. In sweep mode, also merge the scout `scanned`
map (plus the low-value PRs you pre-filtered) into `scannedPRs`, each with
`{ verdict, at }`. In targeted mode, leave `scannedPRs` unchanged.

## Step 5 — Merge: dedup, detect recurrence, rank (you, centrally)

1. **Dedup** against the docs index and against each other — two candidates
   teaching the same lesson collapse to one (keep the clearer / more recent).
2. **Detect recurrence (criterion 1).** Group candidates by `theme` across *all*
   scouts. A theme seen on **multiple** PRs is higher impact — **boost**
   its severity (e.g. two P2s on the same theme become a P1-class "recurring"
   finding). This cross-scout view is the whole reason recurrence is judged here,
   not in a scout.
3. **Rank impact-first.** Sort by severity descending (recurring + serious first),
   breaking ties by recency (newest `createdAt` first). Take the **top 10** to
   present — set the rest aside (they stay un-flagged for a future run).

## Step 6 — Materialize & present (you; git ops serialized here)

Make each of the top 10 reviewable in the UI as a comment the user can
**Document**, then present the list. Use **your own model name** as `--author`
(e.g. `Opus 4.8`) and the candidate's `--priority`. Materialization touches git
and the `staff` CLI, so do it **here, sequentially** — never in a scout.

**PR candidate** — fetch the PR's commits, build the diff, anchor the point:

```bash
GIT_URL="https://github.com/<repo>.git"
git fetch -q "$GIT_URL" "pull/<pr>/head"        # FETCH_HEAD = PR head
HEAD_SHA=$(git rev-parse FETCH_HEAD)             # (or use the scout's headSha)
git cat-file -e "<baseSha>^{commit}" 2>/dev/null || git fetch -q "$GIT_URL" "<baseSha>"

SLUG="<baseSha>..${HEAD_SHA}"
staff diff "$SLUG" --no-set-active --json        # create the diff; don't disturb the active one

printf '%s' "<one-line lesson>. Generalizable: <why>. From PR #<pr>: <prUrl>

\`\`\`diff
<the relevant slice of diffHunk>
\`\`\`

Reviewer's point, restated: <rationale>." | staff comment add \
  --slug "$SLUG" --file "<file>" --line <line> --side <new|old> \
  --author "Opus 4.8" --priority <Pn>
```

Capture the printed comment's `threadId`. **Fallback if `git fetch` fails** or
the PR is from a different repo than the current local repo: don't lose the
candidate — reuse one shared diff `staff diff "${DEFAULT_BRANCH}..WT"
--no-set-active` and add a **top-level** comment (no `--file`/`--line`) whose body
carries the lesson, the `diffHunk` in a fenced ```diff block, the rationale, and
the PR link.

**Record** every presented item (`slug`, `threadId`, `source`, `title`, `prUrl`)
into the cache's `lastPresented` so Step 7 knows where to look.

**Present** the list to the user, highest-impact first, numbered. For each:
the one-line lesson; which criterion it hit (recurring / human-caught / fix) and
its recurrence count if >1; severity; source (`PR #<n>`) and the **author** (e.g.
`octocat`); and the link — `http://localhost:<STAFF_PORT>/?diff=<slug>` if a
server is running, else the command `staff <slug>` (append `--port <n>` for a
fixed port).

Then **stop** with a clear instruction, e.g.:

> Scanned 80 PRs with 5 scouts; added 10 candidates. Open each link,
> click **Document** on the ones worth keeping, then tell me to proceed and I'll
> write the entries.

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
> entry and then resolve it. Threads (slug · threadId · source · lesson · PR URL):
> `<this batch's threads, with their context>`
>
> For each: read the thread with `staff comment list --slug <slug> --json`, pick a
> slug that names the **lesson** (e.g. `close-fd-on-error-path.md`), write the
> entry (frontmatter `source:` = the PR URL; sections: Context / The issue /
> Original code / Fix / Why it matters; one screenful; no author names), then run:
> ```bash
> staff comment resolve --slug "<slug>" --thread <threadId> \
>   --status documented --documented-as <lesson-slug>.md \
>   --author "<your model name>" --body "Documented as <lesson-slug>.md."
> ```
> Return a one-line list of the files you wrote — nothing else.

When the documenters return, summarize the new docs files and any candidates the
user did **not** flag (left as open comments for a future run).

## The docs cache

`.staffreview/docs-cache.json` lives under the already-gitignored `.staffreview/`
tree — never commit it. `scannedPRs` is only for sweep mode, so repeated sweeps
make progress instead of re-reading the same PRs. `lastPresented` is the handoff
cache for Step 7. Deleting the file is safe; it only means the next sweep starts
fresh and Step 7 cannot know which presented threads belong to a previous run.

## Constraints

- **You orchestrate; scouts do the reading.** Never mine PRs inline — spawn
  `/staff-docs-scout` agents. Keep your context lean: pass PR refs and short
  candidate JSON, not file or diff contents.
- **No local diff mining.** `/staff-docs` mines GitHub PR review comments only.
- **Targeted mode stays targeted.** If the user passed PR URL(s) or refs, do not
  call `gh pr list` or walk repository PR history.
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
