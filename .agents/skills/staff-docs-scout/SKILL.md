---
name: staff-docs-scout
description: One scout-agent unit of /staff-docs — reads an assigned slice of local Staff Review diffs and/or GitHub PRs, judges each review comment against the documentable-lesson criteria, and RETURNS candidate findings as JSON without posting, fetching commits, or modifying anything. A shared building block the /staff-docs orchestrator spawns per sub-agent; not usually run on its own.
---

# Staff Docs — Scout

You are **one scout agent** in a `/staff-docs` sweep. The orchestrator spawned
you and, in its prompt, gave you a slice of the work:

- **repo dir** — where you're running.
- **local diffs** — filenames in `.staffreview/diffs/` to mine (or "none").
- **PR numbers** — GitHub PRs to mine (or "none"; only present when `gh` works).
- **repo** — `owner/name`, for `gh api` calls.
- **default branch** — for the relevance check.
- **docs index** — a compact list of lessons already documented (each line: a
  `source` URL/slug + a one-line lesson/tags), for dedup (or "none").

You **RETURN candidate JSON — you do NOT post comments, create diffs, run
`git fetch`, spawn agents, or modify/commit anything.** The orchestrator
materializes and presents what you return; your job is to read fast and judge well.

## What makes a comment a candidate

A review comment is a candidate when it teaches a **generalizable** lesson a
future `/staff-review` could catch. Specifically:

1. **Recurring bug** — a bug/issue of the same *kind* as one seen elsewhere.
2. **Serious issue caught by a human reviewer** — a real correctness, security,
   data-loss, or API-contract problem, not tied to one file's quirks (and from a
   **human** — bot comments are excluded entirely; see below).
3. **A fix for a serious issue** — a comment whose referenced/linked fix (a later
   commit or merged PR) corrected a real, generalizable bug.

**Skip bot comments entirely.** Many PR review comments come from bots
(CodeRabbit, SonarCloud, `github-actions`, etc.) — GitHub marks them
`user.type == "Bot"` and their login usually ends in `[bot]`. **Drop every
bot-authored comment before you judge it: it is never a candidate, under any
criterion.** Bot output is templated and the issues it raises are the kind the
base `/staff-review` already catches, so documenting it just adds noise. Only
**human** review comments are eligible.

**Reject** (don't emit): nits and style, one-file-specific incidental details,
approval/"+1" chatter, questions, anything covered by a docs-index lesson, and
any thread already resolved `documented` or already flagged `documentRequested`.

## Step 1 — Mine your assigned local diffs

For each assigned `.staffreview/diffs/<file>`, read the JSON and examine its
`comments[]`. For each comment, judge it against the criteria. Skip a comment when
its thread is resolved (`resolution.status` of `fixed`/`skipped`/`documented`) —
actually only skip `documented` and threads with `documentRequested: true`; a
`fixed`/`skipped` thread can still hold a generalizable lesson — and skip anything
the docs index already covers.

For each keeper, emit a candidate with `source: "local"`, the diff's `slug`, the
root comment's `threadId`, its `file`/`line`/`side`, the comment's `author`, plus
your judgment fields (`lessonTitle`, `rationale`, `criterion`, `severity`,
`theme`, `createdAt`). The comment already lives on a local diff, so the
orchestrator just points the user at it — you don't need a hunk. (Local comments
aren't GitHub bots, but an **AI-agent** author like `Opus 4.8` still isn't a
*human* reviewer — don't mark those criterion 2; they can still be criterion 1.)

## Step 2 — Mine your assigned PRs

For each assigned PR number `<n>` (skip this step entirely if you got "none"):

```bash
gh api --paginate "repos/<repo>/pulls/<n>/comments" \
  --jq '[.[] | {id, path, line, original_line, side, diff_hunk, body,
                in_reply_to_id, created_at, html_url,
                author: .user.login,
                authorIsBot: (.user.type == "Bot" or (.user.login | endswith("[bot]")))}]'
```

`authorIsBot` is the exclusion filter: when it's `true`, **drop the comment** —
it never becomes a candidate (see "Skip bot comments entirely" above).

- **No review comments** → record `scanned["<n>"] = "no-comments"`, move on.
- **Relevance** — drop any comment whose `path` no longer exists in the default
  branch (the lesson can't apply to current code):

  ```bash
  git cat-file -e "origin/<default-branch>:<path>" 2>/dev/null && echo present || echo gone
  ```

  If *every* commented file is `gone`, record `scanned["<n>"] = "irrelevant"`.
- **Drop bot-authored comments** (`authorIsBot == true`) before judging — they
  are never candidates (see "Skip bot comments entirely" above).
- **Judge** the remaining human comments against the criteria; skip docs
  duplicates (match `html_url` against the docs index's sources, or the same lesson).
- For each keeper, capture the PR's base/head SHAs **read-only** so the
  orchestrator can materialize the diff later (you must NOT fetch):

  ```bash
  gh pr view <n> --json baseRefOid,headRefOid \
    -q '[.baseRefOid, .headRefOid] | @tsv'
  ```

  Emit a candidate with `source: "pr"`, `pr`, `prUrl`, `commentUrl` (the
  comment's `html_url`), `file` (`path`), `line` (`line ?? original_line`),
  `side` (RIGHT→`new`, LEFT→`old`), `baseSha`, `headSha`, the relevant slice of
  `diff_hunk`, the comment's `author` (always a human — bots were dropped), and
  your judgment fields.

Record `scanned["<n>"] = "candidate"` for any PR that yielded ≥1 keeper.

## Output — return JSON, do not post

Return **only** this object as your final message (no prose around it):

```json
{
  "candidates": [ /* candidate objects, see below */ ],
  "scanned": { "482": "candidate", "481": "no-comments", "480": "irrelevant" }
}
```

Each candidate:

```json
{
  "source": "pr" | "local",
  "pr": 482 | null,
  "prUrl": "https://github.com/owner/name/pull/482" | null,
  "commentUrl": "https://github.com/owner/name/pull/482#discussion_r123" | null,
  "slug": "<diff slug>" | null,         // local only — the existing diff
  "threadId": "<id>" | null,            // local only — the existing thread
  "file": "path/to/file.ts" | null,
  "line": 42 | null,
  "side": "new" | "old",
  "author": "octocat" | "Opus 4.8",     // PR login (human) or local author; bots are excluded
  "baseSha": "<sha>" | null,            // pr only — for the orchestrator to fetch
  "headSha": "<sha>" | null,            // pr only
  "diffHunk": "<relevant slice>" | null,// pr only
  "criterion": 1 | 2 | 3,              // which rule it hit
  "severity": "P1" | "P2" | "P3",      // P1 serious/recurring · P3 minor
  "lessonTitle": "one-line lesson",
  "rationale": "why it's generalizable / worth documenting",
  "theme": "short-theme-tag",          // for cross-scout recurrence clustering
  "createdAt": "<iso>"                  // the comment's timestamp
}
```

Use a stable, lowercase `theme` slug (e.g. `unclosed-fd`, `missing-await`,
`sql-injection`) — the orchestrator clusters on it to detect recurrence across
scouts, so name the *kind* of bug, not the file. Return an empty `candidates`
array if nothing qualifies. Do not run `staff comment`, `git fetch`, spawn
agents, or modify code.
