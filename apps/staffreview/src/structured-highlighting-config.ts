/**
 * Default for whether intra-line (word-level) diff highlighting is enabled.
 * Kept dependency-free so the settings module and the browser bundle can share
 * the single source of truth instead of hard-coding the literal on each side.
 */
export const DEFAULT_STRUCTURED_HIGHLIGHTING = true;
