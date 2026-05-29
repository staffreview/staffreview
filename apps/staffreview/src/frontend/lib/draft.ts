/**
 * Tiny localStorage-backed draft store for comment editors. Keeps
 * in-progress comment/reply/edit text so an accidental refresh doesn't
 * lose work. Drafts are namespaced by a caller-provided key and cleared
 * on successful submit.
 */
const PREFIX = "staff:draft:";

export function loadDraft(key: string): string {
  try {
    return localStorage.getItem(PREFIX + key) ?? "";
  } catch {
    return "";
  }
}

export function saveDraft(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(PREFIX + key, value);
    else localStorage.removeItem(PREFIX + key);
  } catch {}
}

export function clearDraft(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {}
}
