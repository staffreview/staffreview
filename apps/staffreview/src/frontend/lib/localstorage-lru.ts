// Shared, bounded-growth LRU helpers over a *family* of localStorage keys that
// share a common prefix (e.g. one entry per diff slug). localStorage has a ~5MB
// origin cap and these entry families are never fully cleared, so a long-lived
// install would otherwise grow without bound — and a quota-exceeded write is
// silently swallowed, dropping *all* persisted state. Callers cap the number of
// retained per-prefix entries, evicting the least-recently-*written*. Recency
// is persisted explicitly because Web Storage does not define key enumeration
// order.
//
// This is the delicate, spec-dependent core that used to be duplicated between
// `reviewed-files.ts` and `DiffView.tsx`'s collapse-override helpers; it now
// lives (and is tested) once. Both `pruneLru` and `writeLruEntry` are
// best-effort: they swallow storage errors so a failing write never throws into
// a render path.

const RECENCY_KEY_PREFIX = "staff:lru-recency:";

function recencyKey(prefix: string): string {
  return `${RECENCY_KEY_PREFIX}${encodeURIComponent(prefix)}`;
}

function readRecencies(prefix: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(recencyKey(prefix));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number",
      ),
    );
  } catch {
    return {};
  }
}

// Remove a family entry together with its recency metadata.
export function removeLruEntry(prefix: string, key: string): void {
  try {
    localStorage.removeItem(key);
    const recencies = readRecencies(prefix);
    delete recencies[key];
    localStorage.setItem(recencyKey(prefix), JSON.stringify(recencies));
  } catch {}
}

// Keep only the most-recently-written keys under `prefix`, down to `cap`, never
// evicting `keepKey` (the key written this pass). No-op at or under the cap.
export function pruneLru(prefix: string, cap: number, keepKey: string): void {
  try {
    const recencies = readRecencies(prefix);
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    if (keys.length <= cap) return;
    // Missing metadata belongs to legacy entries and is treated as oldest.
    const evictable = keys
      .filter((key) => key !== keepKey)
      .sort((a, b) => (recencies[a] ?? 0) - (recencies[b] ?? 0));
    const toEvict = evictable.slice(0, keys.length - cap);
    for (const key of toEvict) {
      localStorage.removeItem(key);
      delete recencies[key];
    }
    localStorage.setItem(recencyKey(prefix), JSON.stringify(recencies));
  } catch {}
}

// Write `value` at `key`, refresh its explicit LRU recency, then prune the
// `prefix` family down to `cap`.
export function writeLruEntry(prefix: string, cap: number, key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
    const recencies = readRecencies(prefix);
    recencies[key] = Math.max(0, ...Object.values(recencies)) + 1;
    localStorage.setItem(recencyKey(prefix), JSON.stringify(recencies));
    pruneLru(prefix, cap, key);
  } catch {}
}
