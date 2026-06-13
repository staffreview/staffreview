/**
 * `/staff-section` fan-out width: how many find sub-agents the orchestrator runs
 * in parallel, which also **sizes the section** reviewed each run (more agents →
 * a larger slice of the codebase per pass). The default and the [min, max]
 * bounds the UI and CLI both clamp to. Kept in this dependency-free module (no
 * node:* imports) so the server (`settings.ts`) and the browser bundle
 * (`SettingsMenu.tsx`) import the same numbers instead of re-declaring them and
 * drifting apart.
 *
 * Like `/staff-review`, the section review runs ~2×N agents total (N find
 * agents, each pipelined into its own verify agent), so the cap stays
 * conservative.
 */
export const DEFAULT_SECTION_AGENTS = 2;
export const MIN_SECTION_AGENTS = 1;
export const MAX_SECTION_AGENTS = 20;
