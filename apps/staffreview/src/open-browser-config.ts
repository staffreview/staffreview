/**
 * Default for whether `staff serve` opens the browser automatically. Kept
 * dependency-free so the CLI/settings module and browser bundle can share it.
 */
export const DEFAULT_OPEN_BROWSER = true;

/**
 * Decide whether `staff serve` should auto-open the browser, given the two CLI
 * flags and the persisted `openBrowser` setting. Pure so its precedence truth
 * table can be unit-tested without spawning a real browser.
 *
 * Precedence:
 * - `--no-open` always wins (it overrides `--open` and the setting).
 * - else `--open` forces it on (overriding a `false` setting).
 * - else fall back to the persisted setting.
 *
 * Both flags are expected pre-coerced to booleans by the caller (the CLI runs
 * `flags` through `booleanFlag` first).
 */
export function shouldOpenBrowser(opts: {
  noOpen: boolean;
  open: boolean;
  setting: boolean;
}): boolean {
  if (opts.noOpen) return false;
  return opts.open || opts.setting;
}
