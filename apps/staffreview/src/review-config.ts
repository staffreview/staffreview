/**
 * `/staff-review` fan-out width: how many find sub-agents the orchestrator runs
 * in parallel. The default and the [min, max] bounds the UI and CLI both clamp
 * to. Kept in this dependency-free module (no node:* imports) so the server
 * (`settings.ts`) and the browser bundle (`App.tsx`) import the same numbers
 * instead of re-declaring them and drifting apart.
 *
 * The cap is deliberately conservative: the review runs ~2×N agents total (N
 * find agents, each pipelined into its own verify agent), so a too-high value
 * can burn a lot of tokens fast.
 */
export const DEFAULT_REVIEW_AGENTS = 2;
export const MIN_REVIEW_AGENTS = 1;
export const MAX_REVIEW_AGENTS = 20;
