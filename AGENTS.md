# Repository Guidelines

## Project Structure & Module Organization

This is a Bun workspace with two apps under `apps/`. `apps/staffreview` contains
the `staff` CLI, local review server, React frontend, Playwright e2e tests, and
binary build scripts. Frontend components live in
`apps/staffreview/src/frontend/components`, shared frontend helpers in
`apps/staffreview/src/frontend/lib`, and CLI/server code in
`apps/staffreview/src`. `apps/web` contains the Next/Fumadocs documentation site;
docs content is in `apps/web/content/docs`. Release automation lives in
`.github/workflows/release.yml`.

## Build, Test, and Development Commands

- `bun run check`: run Biome formatting, linting, and import organization checks.
- `bun run check:fix`: apply safe Biome fixes.
- `bun run --cwd apps/staffreview test`: run Bun unit/component tests.
- `bun run --cwd apps/staffreview test:e2e`: run Playwright e2e tests.
- `bun run --cwd apps/staffreview dev -- serve --no-open`: run the Staff Review
  CLI in dev mode and serve the local UI.
- `bun run --cwd apps/staffreview build`: build the bundled CLI.
- `bun run --cwd apps/web dev`: run the documentation site locally.
- `bun run --cwd apps/web types:check`: generate docs metadata and run TypeScript.

Agents in this workspace should prefix shell commands with `rtk`, for example
`rtk bun run check`.

## Coding Style & Naming Conventions

Use TypeScript/TSX, ES modules, 2-space indentation, double quotes, semicolons,
and trailing commas where Biome inserts them. Keep React components in PascalCase
files, helpers in lower-case or kebab-case files, and tests beside the feature or
under `apps/staffreview/tests/e2e`. Prefer existing utilities and UI components
before adding new abstractions.

## Testing Guidelines

Use `bun test` for unit/component tests and Playwright for browser workflows.
Name tests by behavior, not implementation detail. Add focused coverage when
changing diff rendering, target selection, settings persistence, CLI parsing, or
release/build behavior. Run `bun run check` plus the narrowest relevant test
command before committing.

## Commit & Pull Request Guidelines

Recent history uses short imperative subjects, sometimes scoped
(`docs(web): ...`, `chore(release): ...`). Keep commits focused and mention user
visible behavior in the subject when possible. PRs should include a concise
summary, tests run, linked issue or motivation, and screenshots for UI changes.

## Release Notes

Package releases update `apps/staffreview/package.json`, `bun.lock`, and
`apps/web/content/docs/changelog.mdx`, then tag `vX.Y.Z`. The release workflow
builds platform binaries and publishes GitHub release assets. Update
`staffreview/homebrew-tap` after the release assets are available. Follow the
full checklist in [docs/release.md](docs/release.md).
