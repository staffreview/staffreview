---
name: staff-section
description: Review a rotating section of the current workspace's code — whole files, not a diff. Each run reviews a fresh slice sized to the sub-agent count (default 2), records what it covered in a cache, and on the next run moves on to the next slice — working all the way around the codebase, then back to the start, skipping any file that hasn't changed since it was last reviewed. Use when the user runs /staff-section or wants the existing codebase reviewed section by section over time.
---

# Staff Section

You are the **orchestrator** of a staff/principal-level review of the **existing
code** in the current workspace. Unlike `/staff-review`, you are **not** reviewing
a `base..head` diff — there are no "changes." You review **whole files**, a
bounded **section** at a time, and you remember what you've already covered in a
cache so that **each run advances to new ground**: section by section around the
whole codebase, then back to the first section — re-reviewing a file only if it
**changed** since you last looked at it.

You do **not** review the code yourself. You fan the work out across **N find**
sub-agents (each owning a slice of this run's section, following
`/staff-section-find`) and **pipeline** each one's findings into its own **verify**
sub-agent (following `/staff-section-verify`), exactly like `/staff-review` does —
then dedup the survivors and post them as inline comments. Keep your own context
lean: pass file lists, the slug, and short findings between agents — never whole
file contents.

## Where the comments live: one stable whole-tree diff

Comments in this tool anchor to a diff. A section review has no diff, so you host
the findings on a **single, stable "whole-tree" diff** whose base is the empty
git tree — every file then appears as fully-present content, so a comment can
anchor to **any line of any file**. Create (or reuse) it once and pass its slug
to every sub-agent and every `staff comment` call:

```bash
EMPTY_TREE=$(git hash-object -t tree /dev/null)   # the repo's empty-tree object
staff diff "${EMPTY_TREE}..WT" --json             # creates it if needed; sets it active
```

Note the printed `slug` (it looks like `<40-hex>..WT`). All section-review
comments across all runs accumulate on this one diff, so `/staff-resolve` and the
web UI see them in one place. **Sub-agents must NOT run `staff files --slug` on
this diff** — it would dump the entire repository; they read their assigned files
directly with `Read`/`Grep`.

## Step 1 — Resolve the sub-agent count `N`

`N` is both the find-agent fan-out width and the **lever that sizes the section**
(more agents → a bigger section per run). Resolve it in this order:

1. A **bare integer argument** to the skill (e.g. `/staff-section 4`).
2. Otherwise the global setting: `staff settings get sectionAgents` (default **2**).

```bash
staff settings get sectionAgents   # prints a number; default 2, bounds 1–20
```

Clamp `N` to **1–20**.

## Step 2 — Enumerate the reviewable files (with content hashes)

The "codebase" is the tracked, human-authored source. List the tracked files and
capture each one's **working-tree content hash** (used in Step 3 to tell whether a
file changed since its last review):

```bash
git ls-files -- ':!:.staffreview/' > /tmp/staff-section-paths.txt
git hash-object --stdin-paths < /tmp/staff-section-paths.txt > /tmp/staff-section-hashes.txt
paste /tmp/staff-section-paths.txt /tmp/staff-section-hashes.txt   # path<TAB>blobsha
```

(If `git hash-object --stdin-paths` aborts on a tracked-but-deleted path, drop
missing paths first — `git ls-files` then filter to existing files.)

From that list, **exclude what isn't worth a human-grade read**, keeping a stable
order (sort by path):

- binaries and assets (images, fonts, `*.min.*`, compiled output);
- lockfiles (`bun.lock`, `package-lock.json`, …) and generated artifacts
  (e.g. `src/generated/`, snapshots) — `git.ts`-style build outputs;
- vendored / third-party code you don't own.

Call the result `F` — the ordered list of reviewable files, each with its current
hash. This is the full loop you rotate through.

## Step 3 — Pick this run's section from the cache

The cache is **`.staffreview/section-cache.json`** (per-machine; gitignored by
`staff install`). It records what you've reviewed and where you stopped:

```json
{
  "version": 1,
  "updatedAt": "<ISO timestamp>",
  "cursor": "<path you stopped after last run, or \"\" on a fresh start>",
  "reviewed": {
    "src/foo.ts": { "hash": "<blobsha when reviewed>", "at": "<ISO>" }
  }
}
```

Read it with `Read` (treat a missing/empty/corrupt file as a fresh start:
`cursor: ""`, `reviewed: {}`). Then compute this run's section `S`:

1. **Prune** `reviewed` entries whose path is no longer in `F` (deleted files).
2. **Due check.** A file in `F` is **due** if it is *not* in `reviewed`, **or**
   its current hash differs from `reviewed[path].hash` (it changed since you last
   reviewed it). Everything else is **up to date** and gets skipped.
3. **Rotation order.** Starting at the file **immediately after `cursor`** in `F`
   (wrapping past the end back to the top; start at the top if `cursor` is empty
   or no longer in `F`), walk `F` in order.
4. **Fill the section to budget.** As you walk, collect **due** files (skip
   up-to-date ones) into `S` until the **section budget** is reached or you've
   walked the entire loop once. The budget scales with `N`:

   > **A single sub-agent can thoroughly review ~1,500–2,500 lines of source**
   > (a handful of files) in one pass while still reading callers and tests. Aim
   > for a section of about **N × 2,000 lines**, divided so each agent gets
   > ~2,000. Use the files' real sizes (`wc -l`) — pack fewer, denser files or
   > more small ones so each agent's slice fits **comfortably** in context.

   Stop adding files once `S` is at budget. Always include at least one due file
   if any exist.
5. If `S` is **empty**, nothing is due: the whole codebase has been reviewed and
   nothing changed since. **Report that and stop** — do not spawn agents or post.

`S` is this run's section. Note its files and their hashes.

## Step 4 — FIND: launch N find agents in the background

Partition `S`'s files into **N roughly-equal slices by size** (keep each slice's
line total near the per-agent budget; keep files from the same directory together
where it's natural). Spawn **N find agents in the background** (`run_in_background`)
so each reports independently — do **not** wait for the whole wave; Step 5 consumes
each as it returns. If `S` has fewer files than `N`, spawn one agent per file and
use fewer than `N` agents.

Spawn each with:

> You are running in `<repo dir>`. Read `.agents/skills/staff-section-find/SKILL.md`
> and follow it exactly. Your parameters:
> - **slug:** `<slug>`  (for checking existing comments only — do NOT run `staff files` on it)
> - **files:** `<this agent's file paths, newline- or comma-separated>`
>
> Review those whole files across all the review areas the skill lists and return
> the findings JSON it specifies — nothing else. Do not post, spawn agents, or
> modify code.

## Step 5 — VERIFY pipeline → dedup → post

Identical in shape to `/staff-review` Step 4 — **event-driven, reaping as you go**:

1. **Verify.** The instant a find agent reports back, **stop its background task**
   (`TaskStop` with the id you launched it with) — you have its findings, so it
   must not keep holding a slot — then spawn one verify agent (background) seeded
   with *only that agent's* findings. A finder that returned `[]` is reaped and
   skipped.

   > You are running in `<repo dir>`. Read `.agents/skills/staff-section-verify/SKILL.md`
   > and follow it exactly. Your parameters:
   > - **slug:** `<slug>`
   > - **candidate findings:** `<this find agent's JSON array>`
   >
   > Return the verdicts JSON the skill specifies — nothing else. Do not post,
   > spawn agents, or modify code.

2. **Collect survivors.** Keep only **confirmed** findings; when a verdict carries
   a `correctedAnchor`, replace that finding's `file`/`line`/`endLine`/`side` with
   it wholesale. Append survivors to an in-memory list and **stop the verify
   agent's task** once consumed. Track how many false positives you dropped.

3. **Dedup and post after every verify chain drains.** Dedup true duplicates
   (same `file`+`line`, same issue — keep the clearest/highest-severity one), then
   post each survivor via the `staff` CLI (see `/staff-comment`). Pipe the body via
   stdin, pass `--author` with **your model name**, the survivor's `--priority`,
   and **`--side new`**:

   ```bash
   printf '%s' "$BODY" | staff comment add \
     --slug "$SLUG" --file <path> --line <n> --side new \
     --author "<your model name>" --priority <P1|P2|P3>
   ```

   `--priority`: **P1** (must fix), **P2** (should fix), **P3** (minor). Be honest
   with the scale.

Reaping on consume keeps the **live** sub-agent count near `N` (a find slot turns
into a verify slot), never 2N. If `N` is large, launch finds in batches and reap
completed ones before starting more.

## Step 6 — Update the cache

After every survivor is posted, persist progress so the **next** run advances:

1. For each file in `S`, set `reviewed[path] = { hash: <the hash from Step 2>, at: <now> }`.
2. Set `cursor` to the **last file of `S` in `F`'s order** (so the next run
   resumes right after it).
3. Set `updatedAt` to now, keep `version: 1`, and **`Write` the JSON back** to
   `.staffreview/section-cache.json`.

Mark each file with the hash you captured in Step 2 (not a fresh re-hash), so the
cache reflects the version you actually reviewed.

## Step 7 — Report back

Summarize to the user in chat (don't post a top-level comment):

- `N` sub-agents used; the section reviewed (file count + the paths, or a
  directory summary if long).
- Findings: raised → confirmed → posted (and how many false positives verification
  dropped, plus any duplicates merged). A one-line severity breakdown (e.g.
  "1 P1, 2 P2").
- **Coverage:** how many of `F`'s files are now up to date vs. still pending, so
  the user knows how far around the codebase they are (e.g. "42 / 130 files
  reviewed; run `/staff-section` again to continue").

Then stop. Do not commit or modify code. The user runs `/staff-resolve` to act on
the comments.

## Conventions for comment bodies

- Markdown; code suggestions in fenced blocks. Reference locations as `path:42`.
- One issue per comment; keep each under ~10 lines unless it carries code.

## Constraints

- **You orchestrate; sub-agents do the work.** Never review or verify inline
  yourself — spawn `/staff-section-find` and `/staff-section-verify`. Keep your
  context lean: pass file lists, the slug, and short findings — not file contents.
- **Whole files, not a diff.** The slug exists only to anchor comments. Neither
  you nor the sub-agents should fetch the whole-tree diff (`staff files --slug`) —
  it spans the entire repo. Read assigned files directly.
- **Advance every run; skip the unchanged.** Honor the cache: resume after the
  `cursor`, review only **due** (new or changed) files, and update the cache so
  the next run picks up where you left off. Re-review a file only when its hash
  changed.
- **Verify before post.** Each finding flows find → verify → survivor → dedup →
  post; nothing is posted unverified. Reap each background agent the instant you
  consume it.
- **No worktree isolation.** Sub-agents read the real working tree; don't isolate
  them.
- **Don't commit or modify code.** The review ends with comments posted and the
  cache updated.
