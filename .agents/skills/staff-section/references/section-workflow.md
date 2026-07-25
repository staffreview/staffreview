# Staff Section

You are the **orchestrator** of a staff/principal-level review of the **existing
code** in the current workspace. Unlike `/staff-review`, you are **not** reviewing
a `base..head` diff — there are no "changes." You review **whole files**, a
bounded **section** at a time, and you remember what you've already covered in a
cache so that **each run advances to new ground**: section by section around the
whole codebase, then back to the first section — re-reviewing a section only when
one of its files **changed** since you last looked at it. A section is reviewed as
a **whole unit**: its files work together, so if even one changed you re-review
the entire section, not just the changed file.

You do **not** review the code yourself. You fan the work out across **N find**
sub-agents (each owning a slice of this run's section, following the shared
`/staff-review-find` skill in its **`files` mode**) and **pipeline** each one's
findings into its own **verify** sub-agent (`/staff-review-verify`, also `files`
mode), exactly like `/staff-review` does — then dedup the survivors and post them
as inline comments. Keep your own context lean: pass file lists, the slug, and
short findings between agents — never whole file contents.

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
paths=$(mktemp "${TMPDIR:-/tmp}/staff-section-paths.XXXXXX")
hashes=$(mktemp "${TMPDIR:-/tmp}/staff-section-hashes.XXXXXX")
ignored=$(mktemp "${TMPDIR:-/tmp}/staff-section-ignored.XXXXXX")
trap 'rm -f "$paths" "$hashes" "$ignored"' EXIT
git ls-files -s -- ':!:.staffreview/' |
  awk '$1 == "100644" || $1 == "100755" { sub(/^[0-9]+ [0-9a-f]+ [0-9]+\t/, ""); print }' |
  sort > "$paths"
if test -f .staffignore; then
  git ls-files -ci --exclude-from=.staffignore | sort > "$ignored"
  comm -23 "$paths" "$ignored" > "$paths.filtered"
  mv "$paths.filtered" "$paths"
fi
git hash-object --stdin-paths < "$paths" > "$hashes"
paste "$paths" "$hashes"   # path<TAB>blobsha
```

(If `git hash-object --stdin-paths` aborts on a tracked-but-deleted path, drop
missing paths first — `git ls-files -s` then filter to existing files. Keep only
regular file modes (`100644` / `100755`) before hashing so symlinks and
submodule gitlinks do not produce anchors that diverge from the whole-tree diff.
The `.staffignore` file uses gitignore syntax.)

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
`staff install`). It records the content hash of every file the last time you
reviewed it, plus a rotation cursor:

```json
{
  "version": 1,
  "updatedAt": "<ISO timestamp>",
  "cursor": "<path of the last file you reviewed last run, or \"\" on a fresh start>",
  "reviewed": {
    "src/foo.ts": { "hash": "<blobsha when reviewed>", "at": "<ISO>" }
  }
}
```

Read it with `Read` (treat a missing/empty/corrupt file as a fresh start:
`cursor: ""`, `reviewed: {}`). Call a file **changed** when it is *not* in
`reviewed` **or** its current hash differs from `reviewed[path].hash`. Then pick
this run's section `S`:

1. **Tile `F` into candidate sections — fresh every run, from the files' _current_
   sizes.** Walking `F` in order from the top, group consecutive files into
   sections whose line totals each reach the **section budget** (below), and
   **prefer to cut at natural seams** (directory / module boundaries) so a section
   is a cohesive unit, not an arbitrary byte-count slice. This tiling covers the
   whole codebase end to end. **A section is the unit of review — you review *all*
   of its files together, or none of them.**

   > **A single sub-agent can thoroughly review ~1,500–2,500 lines of source** (a
   > handful of files) in one pass while still reading callers and tests. Size
   > each section at about **N × 2,000 lines**, divided so each of the N agents
   > gets ~2,000. Use the files' real sizes (`wc -l`); pack denser files more
   > loosely so each agent's slice fits **comfortably** in context.

   Because you re-tile from current sizes on **every** run, a section's
   composition adapts as files change: a file that **grew** leaves less room, so
   the files after it spill into the next section; a file that **shrank** leaves
   more, pulling the next file in. A section therefore **always fits the budget** —
   it never overflows an agent's context just because something grew. (Pinning a
   section's membership once and reusing it would do exactly that — a grown file
   would push a fixed section past the budget — which is why the tiling is
   recomputed instead.) If a **single file is itself larger than one agent's
   budget**, give it its own section (one or more agents can split it by line
   range); never pad a section past the budget to keep a file with its neighbors.

2. **Mark each section DUE or up-to-date.** A section is **DUE** if **any** file
   in it is *changed* (or it contains a file never reviewed). It is **up to date**
   only when **every** file in it is unchanged. *This is the whole point:* a
   section's files work together, so a single changed file makes the **entire**
   section due — you re-review its unchanged files too, never just the changed one.

3. **Rotate to the next due section.** Begin **just after the `cursor`**: the
   section containing the first file in `F` whose path sorts after `cursor` (wrap
   to the top of `F` if `cursor` is empty or past the end). Walk the sections in
   order from there, wrapping once all the way around. **`S` is the first DUE
   section you reach** — skip up-to-date sections as you pass them.

4. If you go a full loop and **every** section is up to date, the whole codebase
   has been reviewed and nothing changed since. **Report that and stop** — do not
   spawn agents or post.

`S` is this run's section: **all** of its files, changed or not. Note them and
their current hashes.

Boundaries landing differently from run to run (as sizes shift) is **expected and
safe**: coverage rides on the per-file hashes in the cache and the full
wrap-around walk, not on stable boundaries. Every changed or never-seen file lands
in *some* due section and is reached as the cursor sweeps around, so nothing is
dropped; the only effect of drift is which cohesive neighbors a file is reviewed
alongside.

## Step 4 — FIND: launch N find agents in the background

Partition `S`'s files into **N roughly-equal slices by size** (keep each slice's
line total near the per-agent budget; keep files from the same directory together
where it's natural). Spawn **N find agents in the background** (`run_in_background`)
so each reports independently — do **not** wait for the whole wave; Step 5 consumes
each as it returns. If `S` has fewer files than `N`, use fewer than `N` agents
(roughly one per file) — **unless** `S` is a single file too big for one agent's
budget (the oversized-file case from Step 3): then split *that file* across
several agents by line range, telling each which range it owns.

Spawn each with:

> You are running in `<repo dir>`. Read `.agents/skills/staff-review-find/SKILL.md`
> and follow it exactly. Your parameters:
> - **mode:** `files`
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

   > You are running in `<repo dir>`. Read `.agents/skills/staff-review-verify/SKILL.md`
   > and follow it exactly. Your parameters:
   > - **mode:** `files`
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
   stdin, pass `--author` with **your model name** and the survivor's
   `--priority`. For inline findings, pass `--side new`; for range findings, also
   pass `--end-line <n>`. For top-level findings (`file: null` / `line: null`),
   omit `--file`, `--line`, `--end-line`, and `--side`:

   ```bash
   # inline (anchored). Add --end-line <n> for a range.
   printf '%s' "$BODY" | staff comment add \
     --slug "$SLUG" --file <path> --line <n> --side new \
     --author "<your model name>" --priority <P1|P2|P3>

   # top-level (cross-cutting).
   printf '%s' "$BODY" | staff comment add \
     --slug "$SLUG" --author "<your model name>" --priority <P1|P2|P3>
   ```

   `--priority`: **P1** (must fix), **P2** (should fix), **P3** (minor). Be honest
   with the scale.

Reaping on consume keeps the **live** sub-agent count near `N` (a find slot turns
into a verify slot), never 2N. If `N` is large, launch finds in batches and reap
completed ones before starting more.

## Step 6 — Update the cache

After every survivor is posted, persist progress so the **next** run advances:

1. For **every file in `S`** — the whole section, changed *and* unchanged — set
   `reviewed[path] = { hash: <its current hash from Step 2>, at: <now> }`. Use the
   hash you captured in Step 2 (not a fresh re-hash), so the cache reflects the
   version you actually reviewed.
2. Optionally drop `reviewed` entries whose path is no longer in `F` (deleted
   files) to keep the cache tidy.
3. Set `cursor` to the **last file of `S` in `F`'s order** (so the next run
   resumes at the following section), set `updatedAt` to now, keep `version: 1`,
   and **`Write` the JSON back** to `.staffreview/section-cache.json`.

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
  yourself — spawn `/staff-review-find` and `/staff-review-verify` in `files`
  mode. Keep your context lean: pass file lists, the slug, and short findings —
  not file contents.
- **Whole files, not a diff.** The slug exists only to anchor comments. Neither
  you nor the sub-agents should fetch the whole-tree diff (`staff files --slug`) —
  it spans the entire repo. Read assigned files directly.
- **Advance every run; skip unchanged *sections*, never individual files.** Honor
  the cache: resume after the `cursor` and review the next **due section** — a
  contiguous group where *at least one* file changed — **in full**, including its
  unchanged files, because the section's files work together. Skip a section only
  when *every* file in it is unchanged. Update the cache so the next run picks up
  at the following section.
- **Verify before post.** Each finding flows find → verify → survivor → dedup →
  post; nothing is posted unverified. Reap each background agent the instant you
  consume it.
- **No worktree isolation.** Sub-agents read the real working tree; don't isolate
  them.
- **Don't commit or modify code.** The review ends with comments posted and the
  cache updated.
