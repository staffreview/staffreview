// FNV-1a hash of a string, formatted as `${length}:${hash >>> 0}`. Used to
// cheaply detect content changes: `reviewed-files.ts` signs a file's old/new
// content so a reviewed mark invalidates when the content changes, and
// `DiffView.tsx` keys its no-wrap measurement / fold-reset on it. Kept in one
// place so the two stay byte-for-byte identical — if they drifted, a reviewed
// file's signature and DiffView's reset keys would disagree about whether the
// content changed.
export function contentSignature(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${value.length}:${hash >>> 0}`;
}
