// Shared, bounded-growth LRU helpers over a *family* of localStorage keys that
// share a common prefix (e.g. one entry per diff slug). localStorage has a ~5MB
// origin cap and these entry families are never fully cleared, so a long-lived
// install would otherwise grow without bound — and a quota-exceeded write is
// silently swallowed, dropping *all* persisted state. Callers cap the number of
// retained per-prefix entries, evicting the least-recently-*written*.
//
// Recency is localStorage's key enumeration order, which is insertion order per
// the Web Storage spec: `setItem` on an *existing* key updates the value in
// place and does NOT move the key. `writeLruEntry` therefore `removeItem`s
// before `setItem` so a re-touched key is genuinely re-appended, making
// enumeration order a true most-recently-written ordering — which `pruneLru`
// then relies on to treat the front of the scanned keys as the actual oldest.
//
// This is the delicate, spec-dependent core that used to be duplicated between
// `reviewed-files.ts` and `DiffView.tsx`'s collapse-override helpers; it now
// lives (and is tested) once. Both `pruneLru` and `writeLruEntry` are
// best-effort: they swallow storage errors so a failing write never throws into
// a render path.

// Keep only the most-recently-written keys under `prefix`, down to `cap`, never
// evicting `keepKey` (the key written this pass). No-op at or under the cap.
export function pruneLru(prefix: string, cap: number, keepKey: string): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    if (keys.length <= cap) return;
    // Evict the oldest (front of enumeration order), never the active key.
    const evictable = keys.filter((key) => key !== keepKey);
    const toEvict = evictable.slice(0, keys.length - cap);
    for (const key of toEvict) localStorage.removeItem(key);
  } catch {}
}

// Write `value` at `key`, refreshing its LRU recency (removeItem before setItem
// so an existing key is re-appended to enumeration order), then prune the
// `prefix` family down to `cap`.
export function writeLruEntry(prefix: string, cap: number, key: string, value: string): void {
  try {
    localStorage.removeItem(key);
    localStorage.setItem(key, value);
    pruneLru(prefix, cap, key);
  } catch {}
}
