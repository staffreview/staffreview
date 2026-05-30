# Staff Review

**A local, staff‑engineer‑grade code review — for your working tree, before anyone else sees it.**

Staff Review opens a GitHub‑style review of *any* diff in your browser and lets **any AI coding agent** leave a thorough, inline review on it — then fix, document, or skip each comment. No PR, no cloud service, no waiting on a teammate. It all runs on your machine, over your local git repo.

<!-- Add a screenshot or GIF of the review UI here — it sells the tool better than words. -->

```bash
staff install            # set up the repo (writes the /staff-* skills)
staff main..WT           # open “main vs. working tree” in your browser
# then, in your agent:  /staff-review main..WT   →   /staff-resolve
```

---

## Why you’ll want it

- **🔍 Review any diff, locally, in seconds.** Compare a branch, a commit, a range, your staged changes, or your uncommitted working tree — `main..WT`, `<sha>..<sha>`, `release..main`, anything. A clean split/unified diff opens in your browser with inline comments, replies, and resolutions. Catch issues *before* you push, with no GitHub PR required.

- **🤖 A thorough automated review from any harness or model.** Staff Review ships editable **skills** that drive a staff‑engineer‑level review: trace every changed hunk through its edge cases, read the callers and tests, and leave concrete, actionable comments. Use Claude Code out of the box, or any agent that can read a `SKILL.md` and run a shell command — and point it at whichever model you like.

- **📚 Capture project‑specific concerns so they’re never missed again.** Flag a comment with **Document**, then run `/staff-resolve` — the agent writes it up as a library entry under `.staffreview/library/`. Every future review cross‑checks the diff against that library, so the gotcha your team keeps re‑learning gets caught automatically. Commit the library and the whole team benefits.

- **🔁 Loop review → resolve for higher‑quality results.** `/staff-loop` runs the review and the fixes in isolated subagents, round after round, until a fresh review finds nothing new (or a cap you set). Each round’s fixes get re‑reviewed, so regressions and missed issues surface on their own.

> Staff Review itself is **100% local** — a small web server reading your local git history. (Your agent still talks to whatever model you choose; pick a local one if you want zero data to leave the machine.)

---

## Install

macOS and Linux are supported. All you need on the machine is **git** — the
released binary is **self‑contained** (it bundles its own runtime), so there’s
nothing else to install to run it.

### Homebrew (prebuilt binary)

```bash
brew install staffreview/tap/staff      # or: brew install ./packaging/staff.rb
staff --version
```

### From source

Building (or running) from source additionally needs [**Bun**](https://bun.sh):

```bash
git clone https://github.com/staffreview/staffreview.git
cd staffreview
bun install
cd apps/staffreview && bun run build:binary   # compiles a standalone ./dist/staff

# put it on your PATH
ln -s "$PWD/dist/staff" ~/.local/bin/staff
staff --version
```

Prefer not to build? Run straight from source: `bun run apps/staffreview/src/cli.ts <args>`.

---

## Quickstart (about 60 seconds)

From inside the git repo you want to review:

```bash
# 1. One‑time setup: writes the five /staff-* skills, creates the
#    .staffreview/ store, and gitignores the per‑machine bits.
staff install

# 2. Open a diff in the browser. WT = working tree, STAGED = index.
staff main..WT
```

Then, in your AI agent (e.g. Claude Code, from the same repo):

```text
/staff-review main..WT      # leaves inline comments — they show up live in the UI
/staff-resolve              # fixes / documents / skips each open comment
```

Watch the comments stream into the browser as the agent posts them. Triage in the UI, reply, resolve threads yourself, or let `/staff-resolve` work through them. That’s the whole loop.

---

## How it works

**Diffs are slugs.** A diff is `base..head`, where each side is a git ref, `WT` (working tree), or `STAGED`:

```bash
staff main..WT              # current main → uncommitted working tree
staff abc1234..HEAD         # a specific commit → HEAD
staff main..STAGED          # main → what you’ve git‑added
staff                       # just open the UI on the active diff
```

**The web UI** is a GitHub‑style review:

- Click a line number to anchor a comment; **drag** or **shift‑click** to select a range.
- Hover a line and click the **+** to comment; **reply** to build a thread.
- **Resolve** a thread as *Fixed* or *Skipped*, or flag it with **Document** so `/staff-resolve` captures it as a reusable lesson.
- The diff and the comment sidebar scroll independently, with light/dark themes, split/unified view, and syntax highlighting in the gear menu.

**The skills** are how agents review. `staff install` writes five of them to `.agents/skills/` (symlinked into `.claude/skills/` so Claude Code picks them up as slash commands):

| Skill | What it does |
| --- | --- |
| `/staff-review` | Reviews the active diff from first principles and leaves inline comments. |
| `/staff-resolve` | Works each open thread: fixes the code, documents it, or skips with a justification. |
| `/staff-comment` | The thin CLI wrapper the others use to post/edit/resolve comments. |
| `/staff-document` | Imports a GitHub PR review comment (by URL) as a `.staffreview/library/` example. |
| `/staff-loop` | Runs `/staff-review` → `/staff-resolve` in subagents, round after round, until it converges. |

They’re just Markdown — open `.agents/skills/staff-review/SKILL.md` and tune it to your team’s standards.

**The library** (`.staffreview/library/`) is your team’s captured review wisdom. `/staff-review` reads it on every pass and re‑flags any recurrence of a documented mistake. The library is meant to be **committed**; the session data (`.staffreview/diffs/`, `attachments/`, `active.json`) is gitignored automatically.

**The loop** (`/staff-loop`) chains review and resolution in subagents until a review surfaces nothing new, capped by the `loopMaxRounds` setting (default **5**, adjustable in the gear menu). It’s the “set it going and come back to a higher‑quality result” button.

---

## Tips for getting the most out of it

- **Review against your working tree.** Use a `…​..WT` diff (e.g. `main..WT`) so that fixes from `/staff-resolve` flow into the next review. This is *required* for `/staff-loop` to converge — point it at the working tree, not a fixed commit range.
- **Make the skills yours.** They’re Markdown in `.agents/skills/`. Add your conventions, your “don’t do X here,” your preferred test framework. A review is only as good as the standard you hand it.
- **Build the library early.** The first time *anyone* — a human or an agent — flags something project‑specific, click **Document** and let `/staff-resolve` write it up. From then on it’s checked on every review. Commit `.staffreview/library/` so the team shares one memory.
- **Label your models.** The skills pass `--author "<model name>"` so the UI shows who said what. Mix models (e.g. one to review, another to resolve) and compare.
- **Keep diffs focused.** Reviews are sharper on smaller changes; a 30‑file diff dilutes attention. Review feature‑by‑feature.
- **`/staff-loop` edits your working tree.** It’s unattended and powerful, but it leaves changes uncommitted on purpose — read the diff before you commit. Lower `loopMaxRounds` to cap cost, raise it for thoroughness.
- **No GitHub required.** This works on any local repo with no remote — review your own work before it ever becomes a PR.

---

## CLI reference

```text
staff [serve] [<slug>]                 Open the web UI (default). <slug> like main..WT.
staff diff [<slug>] [--base] [--head]  Create/load a diff and make it active.
staff files [--json]                   List the file‑level changes for a diff.
staff comment add|edit|delete|list|resolve|unresolve
                                       Post and manage review comments (used by the skills).
staff settings [get <key>]             Read global settings (e.g. loopMaxRounds).
staff install                          Write the skills + initialize the .staffreview/ store.
staff --help                           Full usage.
```

Settings (theme, split/unified, font size, syntax theme, review‑loop cap) live in the gear menu and persist globally.

---

## Requirements

- **git** and macOS or Linux — that’s it to run the prebuilt binary
- [Bun](https://bun.sh) only if you build or run from source
- An AI coding agent for the automated review (Claude Code works out of the box; any harness that can read a `SKILL.md` and run shell commands works too)

## Contributing

Issues and PRs welcome. The app lives in `apps/staffreview` — `bun run dev` runs it from source with hot reload, and `bun run test:e2e` runs the Playwright suite.

## License

[Apache License 2.0](LICENSE) — permissive (use, modify, embed, even commercially) with an explicit patent grant.

**Trademark:** “Staff Review” and its branding are project marks of the maintainers. Forks and redistribution are welcome under the license, but please don’t use the name or logo in a way that implies affiliation or endorsement.
