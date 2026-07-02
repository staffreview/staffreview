import type { FileDiff } from "../../types.ts";
import { contentSignature } from "./content-signature.ts";
import { writeLruEntry } from "./localstorage-lru.ts";

const REVIEWED_FILES_KEY_PREFIX = "staff:file-reviewed:v1";
// Scan prefix for the per-slug entry family (see reviewedFilesKey).
const REVIEWED_FILES_SCAN_PREFIX = `${REVIEWED_FILES_KEY_PREFIX}:`;
const MAX_REVIEWED_FILE_SLUGS = 50;

export function reviewedFilesKey(slug: string): string {
  return `${REVIEWED_FILES_KEY_PREFIX}:${slug}`;
}

export function fileReviewSignature(file: FileDiff): string {
  // NOTE: binary blobs are NOT content-invalidated. `git.ts` clears
  // `oldContent`/`newContent` to "" for binaries, so a binary's signature is
  // byte-independent (it only reflects status/path/kind). Swapping an image's
  // bytes without changing its path leaves the signature unchanged, so a file
  // marked reviewed stays "reviewed". Closing that gap would require a blob
  // identifier (oid) on `FileDiff`; until then binaries rely on path/status
  // changes to invalidate.
  return [
    file.status,
    file.oldPath ?? "",
    file.isSymlink ? "symlink" : file.isBinary ? "binary" : "text",
    file.symlinkTarget ?? "",
    file.oldSymlinkTarget ?? "",
    contentSignature(file.oldContent),
    contentSignature(file.newContent),
  ].join("|");
}

export function loadReviewedFileSignatures(slug: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(reviewedFilesKey(slug));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const signatures: Record<string, string> = {};
    for (const [path, signature] of Object.entries(parsed)) {
      if (typeof path === "string" && typeof signature === "string") {
        signatures[path] = signature;
      }
    }
    return signatures;
  } catch {
    return {};
  }
}

export function saveReviewedFileSignatures(slug: string, signatures: Record<string, string>) {
  const key = reviewedFilesKey(slug);
  if (Object.keys(signatures).length === 0) {
    try {
      localStorage.removeItem(key);
    } catch {}
    return;
  }
  // writeLruEntry removeItem's before setItem so an existing slug is genuinely
  // re-appended to enumeration order (a bare setItem keeps its original slot per
  // the Web Storage spec), then prunes down to the cap.
  writeLruEntry(
    REVIEWED_FILES_SCAN_PREFIX,
    MAX_REVIEWED_FILE_SLUGS,
    key,
    JSON.stringify(signatures),
  );
}

export function reviewedFilePaths(
  files: FileDiff[],
  signatures: Record<string, string>,
): Set<string> {
  const paths = new Set<string>();
  for (const file of files) {
    // Short-circuit on the stored entry first so unreviewed files (the common
    // case) skip the FNV hash over their full old+new content. Otherwise every
    // Reviewed toggle would re-hash the entire diff via the App.tsx memo.
    const stored = signatures[file.path];
    if (stored !== undefined && stored === fileReviewSignature(file)) {
      paths.add(file.path);
    }
  }
  return paths;
}
