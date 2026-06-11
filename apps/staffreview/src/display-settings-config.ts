/**
 * Defaults for the persisted display settings: side-by-side vs unified view,
 * and whether file diffs start expanded (off = the collapsed "show diff only"
 * style). Mirrored by `BOOLEAN_SETTING_DEFAULTS` in settings.ts and
 * `DEFAULT_SETTINGS` in SettingsMenu.tsx. Kept dependency-free so the settings
 * module and the browser bundle can share the single source of truth instead
 * of hard-coding the literals on each side.
 */
export const DEFAULT_SPLIT_VIEW = true;
export const DEFAULT_FILES_EXPANDED_BY_DEFAULT = false;
