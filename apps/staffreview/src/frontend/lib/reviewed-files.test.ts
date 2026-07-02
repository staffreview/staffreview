import { beforeEach, expect, test } from "bun:test";
import type { FileDiff } from "../../types.ts";
import {
  fileReviewSignature,
  loadReviewedFileSignatures,
  reviewedFilePaths,
  reviewedFilesKey,
  saveReviewedFileSignatures,
} from "./reviewed-files.ts";

// Mirrors MAX_REVIEWED_FILE_SLUGS in reviewed-files.ts (kept private there).
const MAX_REVIEWED_FILE_SLUGS = 50;
const PREFIX = "staff:file-reviewed:v1:";

function fileDiff(overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    path: "src/a.ts",
    status: "modified",
    oldContent: "old",
    newContent: "new",
    ...overrides,
  };
}

function countStoredSlugs(): number {
  let n = 0;
  for (let i = 0; i < localStorage.length; i++) {
    if (localStorage.key(i)?.startsWith(PREFIX)) n++;
  }
  return n;
}

beforeEach(() => {
  localStorage.clear();
});

// --- loadReviewedFileSignatures: JSON-shape guards -------------------------

test("load returns {} when nothing is stored", () => {
  expect(loadReviewedFileSignatures("main..WT")).toEqual({});
});

test("load returns {} on malformed JSON", () => {
  localStorage.setItem(reviewedFilesKey("main..WT"), "{not json");
  expect(loadReviewedFileSignatures("main..WT")).toEqual({});
});

test("load rejects non-object shapes (array / primitive)", () => {
  localStorage.setItem(reviewedFilesKey("a..b"), JSON.stringify([1, 2, 3]));
  expect(loadReviewedFileSignatures("a..b")).toEqual({});

  localStorage.setItem(reviewedFilesKey("c..d"), JSON.stringify("nope"));
  expect(loadReviewedFileSignatures("c..d")).toEqual({});
});

test("load keeps only string→string entries", () => {
  localStorage.setItem(
    reviewedFilesKey("main..WT"),
    JSON.stringify({ "src/a.ts": "sig-a", "src/b.ts": 42, "src/c.ts": null }),
  );
  expect(loadReviewedFileSignatures("main..WT")).toEqual({ "src/a.ts": "sig-a" });
});

// --- saveReviewedFileSignatures: persistence + empty-map cleanup -----------

test("save round-trips through load", () => {
  const sigs = { "src/a.ts": "sig-a", "src/b.ts": "sig-b" };
  saveReviewedFileSignatures("main..WT", sigs);
  expect(loadReviewedFileSignatures("main..WT")).toEqual(sigs);
});

test("saving an empty map removes the stored key", () => {
  saveReviewedFileSignatures("main..WT", { "src/a.ts": "sig-a" });
  expect(localStorage.getItem(reviewedFilesKey("main..WT"))).not.toBeNull();

  saveReviewedFileSignatures("main..WT", {});
  expect(localStorage.getItem(reviewedFilesKey("main..WT"))).toBeNull();
});

test("saving overwrites the previous value cleanly", () => {
  saveReviewedFileSignatures("main..WT", { "src/a.ts": "sig-a" });
  saveReviewedFileSignatures("main..WT", { "src/b.ts": "sig-b" });
  expect(loadReviewedFileSignatures("main..WT")).toEqual({ "src/b.ts": "sig-b" });
});

// --- saveReviewedFileSignatures: LRU recency -------------------------------

test("re-saving an existing slug refreshes its LRU recency (removeItem-before-setItem)", () => {
  // Locks the load-bearing removeItem-before-setItem in saveReviewedFileSignatures.
  // localStorage enumeration order is insertion order and a bare setItem on an
  // EXISTING key does NOT move it — so without the removeItem, a re-touched slug
  // keeps its original (front) slot and eviction degrades to FIFO-by-first-write.
  const sig = { "src/a.ts": "sig-a" };
  // Fill to exactly the cap. slug-0 is the oldest by insertion order.
  for (let i = 0; i < MAX_REVIEWED_FILE_SLUGS; i++) {
    saveReviewedFileSignatures(`slug-${i}`, sig);
  }
  // Re-touch the oldest slug. The removeItem-before-setItem re-appends it, so it
  // is no longer the front/oldest — slug-1 is.
  saveReviewedFileSignatures("slug-0", sig);
  // One more distinct slug pushes over the cap and evicts the true oldest.
  saveReviewedFileSignatures("fresh", sig);

  expect(countStoredSlugs()).toBe(MAX_REVIEWED_FILE_SLUGS);
  // The refreshed slug survives; the now-oldest untouched slug is evicted.
  expect(localStorage.getItem(reviewedFilesKey("slug-0"))).not.toBeNull();
  expect(localStorage.getItem(reviewedFilesKey("slug-1"))).toBeNull();
  expect(localStorage.getItem(reviewedFilesKey("fresh"))).not.toBeNull();
});

// --- reviewedFilePaths: content-change invalidation ------------------------

test("a path is reviewed only while its stored signature still matches", () => {
  const file = fileDiff({ path: "src/a.ts" });
  const signatures = { "src/a.ts": fileReviewSignature(file) };
  expect(reviewedFilePaths([file], signatures)).toEqual(new Set(["src/a.ts"]));
});

test("a path with no stored signature is not reviewed", () => {
  const file = fileDiff({ path: "src/a.ts" });
  expect(reviewedFilePaths([file], {})).toEqual(new Set());
});

test("changing a file's content invalidates the reviewed mark", () => {
  const file = fileDiff({ path: "src/a.ts", newContent: "v1" });
  const signatures = { "src/a.ts": fileReviewSignature(file) };

  const changed = fileDiff({ path: "src/a.ts", newContent: "v2" });
  expect(reviewedFilePaths([changed], signatures)).toEqual(new Set());
});

// --- fileReviewSignature -------------------------------------------------

test("signature changes when text content changes", () => {
  const a = fileReviewSignature(fileDiff({ newContent: "one" }));
  const b = fileReviewSignature(fileDiff({ newContent: "two" }));
  expect(a).not.toBe(b);
});

test("binary signatures are byte-independent (documented gap)", () => {
  // git.ts clears old/new content to "" for binaries, so distinct binary bytes
  // under the same path produce the same signature. This locks the documented
  // behavior in fileReviewSignature.
  const a = fileReviewSignature(fileDiff({ isBinary: true, oldContent: "", newContent: "" }));
  const b = fileReviewSignature(fileDiff({ isBinary: true, oldContent: "", newContent: "" }));
  expect(a).toBe(b);
});
