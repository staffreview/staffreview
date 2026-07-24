import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

// SHA-256 digest of a string. Used to detect content changes:
// `reviewed-files.ts` signs a file's old/new content so a reviewed mark
// invalidates when the content changes, and
// `DiffView.tsx` keys its no-wrap measurement / fold-reset on it. Kept in one
// place so the two stay byte-for-byte identical — if they drifted, a reviewed
// file's signature and DiffView's reset keys would disagree about whether the
// content changed.
export function contentSignature(value: string): string {
  return bytesToHex(sha256(utf8ToBytes(value)));
}
