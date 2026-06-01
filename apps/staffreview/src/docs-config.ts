/**
 * `/staff-docs` scout fan-out width: how many scout sub-agents the
 * orchestrator runs in parallel to mine local diffs + GitHub PRs. The default
 * and the [min, max] bounds the UI and CLI both clamp to. Kept in this
 * dependency-free module (no node:* imports) so the server (`settings.ts`) and
 * the browser bundle (`App.tsx`) import the same numbers instead of
 * re-declaring them and drifting apart.
 *
 * The default is higher than `/staff-review`'s (2) because a docs sweep
 * covers far more ground — each scout takes up to ~100 PRs — and runs a single
 * read-only wave (no verify wave), so the per-agent cost is lower. Total PRs
 * scanned per sweep scales with the width: ~N × 100.
 */
export const DEFAULT_DOCS_AGENTS = 5;
export const MIN_DOCS_AGENTS = 1;
export const MAX_DOCS_AGENTS = 20;
