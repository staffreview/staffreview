# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Staff Review** is a local, staff-engineer-grade code review tool: a single `staff` binary that opens a GitHub-style review of *any* git diff (`base..head`) in the browser and ships agent **skills** that drive a thorough automated review on it. 100% local — a small Bun web server over your local git history. No PR, no cloud.

This is a **Bun monorepo** (`workspaces: ["apps/*"]`):

- **`apps/staffreview`** — the product. The `staff` CLI + `Bun.serve` web UI, published to npm/Homebrew as `@staffreview/staff`. **This is where ~all work happens.**
- **`apps/web`** — a separate Next.js + fumadocs marketing/docs site deployed to Cloudflare Workers via OpenNext. Unrelated to the core app; touch only for docs-site work.

## Commands

Run from `apps/staffreview` unless noted. Lint/format are at the repo root.

```bash
bun install                      # repo root — installs all workspaces

# Dev (from apps/staffreview)
bun run dev                      # bun --hot src/cli.ts → serves the UI with HMR
bun run apps/staffreview/src/cli.ts <args>   # run the CLI from source (works from root)

# Tests
bun test src/                    # unit tests (colocated *.test.ts; happy-dom for React)
bun test src/settings.test.ts    # a single unit-test file
bun test -t "resolves a thread"  # unit tests matching a name
bun run test:e2e                 # Playwright e2e (auto-starts a server on TEST_PORT)
bunx playwright test tests/e2e/comments.spec.ts   # a single e2e spec
bun run test:e2e:install         # one-time: install the Chromium browser

# Lint / format (repo root) — biome. Always use the repo's biome via bun.
bun run check                    # biome check .  (lint + format + import-organize)
bun run check:fix                # biome check --write .
bun run lint                     # bun run lint:fix to autofix

# Build the standalone binary (from apps/staffreview)
bun run build:binary             # → dist/staff for the current platform
bun run build:all                # cross-compile darwin/linux × arm64/x64
```

There is **no CI workflow** in this repo; run `bun run check` and the test suites locally before committing.

## Releases

Follow [docs/release.md](docs/release.md) when cutting a release. The short
version: bump `apps/staffreview/package.json` and `bun.lock`, update the
changelog, commit `chore(release): X.Y.Z`, tag `vX.Y.Z`, push `main` and the tag,
verify the GitHub release workflow, then update `staffreview/homebrew-tap`.

## Core domain model

A **diff is a slug**: `base..head`, where each side is a git ref, `WT` (working tree), or `STAGED` (index) — e.g. `main..WT`, `<sha>..HEAD`, `release..main`. See `src/types.ts` for `DiffTarget` / `Comment` / `Diff`.

- `git.ts` owns slug ⇄ target conversion (`slugForDiff` / `targetsForSlug`) and **ref pinning**: when a diff is created, moving refs (`HEAD`, branch/tag names) are resolved to concrete commit SHAs via `resolveTargets`, keeping the original name as `label`. This is load-bearing — a stored diff must never hold a moving ref, or its slug drifts on the next commit. Every creation path (CLI `diff`, server `POST /api/diff`) pins first.
- Comments are **threaded** (`threadId` + `parentId`), can anchor to a line range (`line`/`endLine`/`side`), carry an agent-only `priority` (P1–P3), and resolve as `fixed | skipped | documented`. The **Document** flow sets `documentRequested` (not a resolution) so the thread stays open for `/staff-resolve` to write up.

## Backend architecture (`apps/staffreview/src/`)

- **`cli.ts`** — hand-rolled arg parser + subcommand dispatch (`serve` (default), `diff`, `files`, `comment add|edit|delete|list|resolve|unresolve`, `active`, `settings`, `install`). Anchors `cwd` to the git root. `staff <slug>` is shorthand for `serve <slug>`.
- **`server.ts`** — `Bun.serve` with `routes` for the JSON API (`/api/diff`, `/api/files`, `/api/comment`, `/api/resolve`, `/api/document`, `/api/settings`, `/api/refs`, `/attachments/:name`) plus a `/api/ws` WebSocket. Mutations `broadcast` an event so open tabs live-refresh. Several `fs.watch` watchers (the diffs dir, `active.json`, the working tree filtered through `git check-ignore`, and `.git/index`) emit `repo:changed`/`diff:changed` so editing a source file or staging refreshes the UI with no manual reload. Binds the port **exclusively** (`reusePort: false`) so a second `staff` walks to the next free port instead of load-balancing.
- **`store.ts`** — persistence. Each diff is a JSON file at `.staffreview/diffs/<slug>.json`; `active.json` points at the current one. Writes are **atomic** (temp-`<uuid>`-file then `rename`); a startup `sweepStaleTmp` reaps temps from crashed writes (never on the hot path — see the long comment there for the race it avoids). All comment/thread CRUD lives here.
- **`git.ts`** — every git interaction via `Bun.spawn`. Builds `FileDiff`s (old/new content per side), detects symlinks (mode 120000 → render a target row) and binary blobs (NUL/U+FFFD heuristic → render a "Binary file" row), and skips `.staffreview/` paths.
- **`settings.ts`** — **global** (per-user) settings at `$XDG_CONFIG_HOME/staffreview/settings.json` (override with `$STAFF_CONFIG_DIR`), *not* per-repo. Values are clamped/coerced on write. Numeric defaults/bounds live in tiny dependency-free modules (`loop-config.ts`, `review-config.ts`, `docs-config.ts`, `open-browser-config.ts`, `boolean-setting.ts`) so the **frontend bundle can import them too**.

## The skills system

The automated review is driven by nine Markdown skills. **Canonical source lives in `.agents/skills/<name>/SKILL.md`**; `apps/staffreview/skills/*.md` are symlinks to those, and `cli.ts` imports them as text (`import … with { type: "text" }`) so they're baked into the binary. `staff install` writes them out to a consuming repo's `.agents/skills/` and symlinks them into `.claude/skills/` (Claude Code picks them up as slash commands), then creates `.staffreview/` and gitignores the per-machine bits.

**To change skill behavior, edit `.agents/skills/<name>/SKILL.md`** (the `skills/*.md` symlinks and the `SKILLS` map in `cli.ts` follow automatically). Orchestrators (`staff-review`, `staff-loop`, `staff-docs`) fan out to building-block skills (`staff-review-find`, `staff-review-verify`, `staff-docs-scout`); `staff-comment` is the thin CLI wrapper they all post through.

## `.staffreview/` layout

- `diffs/`, `attachments/`, `active.json` — per-machine session data, **gitignored** by `staff install`.
- `docs/` — the team's captured review lessons; **committed** so every future review cross-checks against them.

## Frontend (`src/frontend/`)

React 19, bundled by **Bun's own bundler** (no vite/webpack) with `bun-plugin-tailwind` (Tailwind v4) — config in `bunfig.toml`. Entry: `index.html` → `frontend.tsx` → `App.tsx`.

- `App.tsx` holds top-level state (targets, diff, files, settings/theme) and opens the WebSocket; mutations elsewhere broadcast events that trigger a diff refetch via `lib/api.ts`.
- `DiffView.tsx` is the first-party diff table renderer: `buildDiffRows` creates split/unified rows, inline comment hosts render as ordinary table rows, folded context is built by `buildVisibleDiffItems`, and no-wrap mode uses CSS variables to keep gutters fixed while code scrolls horizontally. It also runs the **auto-collapse** heuristic for large diffs and keeps commented lines visible when context is folded.
- `lib/highlight.ts` — **Shiki** syntax highlighting (lazy theme/lang loading) behind a bounded **LRU token cache** keyed by `theme::lang::line`.
- `MarkdownEditor.tsx` is a TipTap editor with image-paste upload to `/api/attachment`.

## Build & dev/binary split

`scripts/build.ts` is a **two-phase** build: (1) `Bun.build` the frontend (`index.html`, code-split, minified) to a temp dir, then base64-encode every emitted asset into `src/generated/frontend-assets.ts`; (2) `Bun.build --compile` `cli.ts` into a standalone binary that embeds those assets. **`src/generated/frontend-assets.ts` is a build artifact** — it's reset to an empty placeholder after each build and is excluded from biome; never edit it by hand.

`process.env.STAFF_BUILD` switches `server.ts`: unset/dev → serve via HTML imports with HMR; `"binary"` → serve the embedded `frontendAssets`. Keep both paths working when touching how assets are served.

## UI components

This project uses **shadcn/ui** for all UI primitives. Always install or update
components via the official CLI — never write them by hand from scratch.

```sh
# Inside apps/staffreview, where components.json lives
bunx --bun shadcn@latest add <component> [<component>…]
```

- The CLI writes to `src/frontend/components/ui/` using the aliases in
  `apps/staffreview/components.json`.
- Auto-detect fails (Bun.serve + HTML imports), but `components.json` is already
  configured — just run `add`, not `init`.
- Project-specific variants (`success`, `warning`, `muted` on `Button`/`Badge`)
  are appended to the CLI-generated files. Preserve them when re-running the CLI
  (`--overwrite` is safe, then re-add the custom variants).
- Need a primitive that isn't installed? Add it via the CLI rather than
  hand-rolling a div/button — hand-rolled components miss the canonical focus
  rings, keyboard handling, and Radix a11y.

## Bun-first conventions

Default to Bun over Node tooling and prefer Bun's built-in APIs (the codebase already does):

- `bun <file>` / `bun test` / `bun build` / `bun install` / `bunx`, not the node/npm/jest/webpack equivalents. Bun auto-loads `.env` — no `dotenv`.
- `Bun.serve()` (not express), `Bun.file` (over `node:fs` read/write), `Bun.spawn`/`Bun.$` (over execa), `Bun.Glob`, `crypto.randomUUID()`, built-in `WebSocket`.
- Bun docs are vendored at `node_modules/bun-types/docs/**.mdx` if you need API details.
