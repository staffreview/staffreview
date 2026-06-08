/**
 * Default for whether long diff lines wrap to fit the pane. On by default
 * (GitHub-style); turning it off lets long lines extend past the pane and
 * scroll horizontally instead. Kept dependency-free so the settings module and
 * the browser bundle can share the single source of truth instead of
 * hard-coding the literal on each side.
 */
export const DEFAULT_WRAP_LINES = true;
