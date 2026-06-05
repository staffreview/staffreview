/**
 * Parse a CLI-supplied boolean setting value (e.g. `staff settings set
 * openBrowser <value>`). Accepts the common truthy/falsy spellings and throws a
 * usage error on anything else so garbage is rejected rather than silently
 * persisted. Kept dependency-free so it can be unit-tested without importing
 * the CLI entrypoint (which runs `main()` at module scope).
 */
export function parseBooleanSetting(value: string | undefined, key: string): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }
  throw new Error(`usage: staff settings set ${key} <true|false>`);
}
