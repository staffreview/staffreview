/**
 * `/staff-loop` round cap: the default and the [min, max] bounds the UI and CLI
 * both clamp to. Kept in this dependency-free module (no node:* imports) so the
 * server (`settings.ts`) and the browser bundle (`App.tsx`) import the same
 * numbers instead of re-declaring them and drifting apart.
 */
export const DEFAULT_LOOP_ROUNDS = 5;
export const MIN_LOOP_ROUNDS = 1;
export const MAX_LOOP_ROUNDS = 20;
