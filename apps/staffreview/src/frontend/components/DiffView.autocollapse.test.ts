import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Comment, FileDiff, Resolution } from "../../types.ts";
import {
  COLLAPSE_OVERRIDES_V1_KEY,
  collapseOverridesKey,
  computeActiveCommentedPaths,
  computeAutoCollapsed,
  computeCommentLineIds,
  fileLineCount,
  MAX_AUTO_EXPANDED_COMMENTED_FILES,
  MAX_AUTO_EXPANDED_FILES,
  MAX_AUTO_EXPANDED_LINES,
  MAX_COLLAPSE_OVERRIDE_SLUGS,
  PER_FILE_COLLAPSE_LINES,
  pruneCollapseOverrides,
  setCollapseOverride,
} from "./DiffView.tsx";

// Build a text FileDiff whose larger side has `lines` lines.
function file(path: string, lines = 1, extra: Partial<FileDiff> = {}): FileDiff {
  return {
    path,
    status: "modified",
    oldContent: "",
    newContent: Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n"),
    ...extra,
  };
}

const NONE = new Set<string>();

test("a file larger than PER_FILE_COLLAPSE_LINES collapses", () => {
  const big = file("big.ts", PER_FILE_COLLAPSE_LINES + 1);
  const collapsed = computeAutoCollapsed([big], NONE);
  expect(collapsed.has("big.ts")).toBe(true);
});

test("a file at exactly PER_FILE_COLLAPSE_LINES stays expanded", () => {
  const ok = file("ok.ts", PER_FILE_COLLAPSE_LINES);
  const collapsed = computeAutoCollapsed([ok], NONE);
  expect(collapsed.has("ok.ts")).toBe(false);
});

test("an active commented file under the comment cap stays expanded, even when oversized", () => {
  const big = file("huge.ts", PER_FILE_COLLAPSE_LINES + 500);
  const collapsed = computeAutoCollapsed([big], new Set(["huge.ts"]));
  expect(collapsed.has("huge.ts")).toBe(false);
});

test("active commented files beyond the comment cap fall back to normal collapse rules", () => {
  const files = Array.from({ length: MAX_AUTO_EXPANDED_COMMENTED_FILES + 1 }, (_, i) =>
    file(`huge-${i}.ts`, PER_FILE_COLLAPSE_LINES + 500),
  );
  const active = new Set(files.map((f) => f.path));
  const collapsed = computeAutoCollapsed(files, active);
  expect(collapsed.has(`huge-${MAX_AUTO_EXPANDED_COMMENTED_FILES - 1}.ts`)).toBe(false);
  expect(collapsed.has(`huge-${MAX_AUTO_EXPANDED_COMMENTED_FILES}.ts`)).toBe(true);
});

test("files past the per-diff file budget collapse", () => {
  // One tiny file over the file budget; all within the line budget.
  const files = Array.from({ length: MAX_AUTO_EXPANDED_FILES + 1 }, (_, i) => file(`f${i}.ts`, 1));
  const collapsed = computeAutoCollapsed(files, NONE);
  // First MAX_AUTO_EXPANDED_FILES expand; the overflow file collapses.
  expect(collapsed.has(`f${MAX_AUTO_EXPANDED_FILES}.ts`)).toBe(true);
  expect(collapsed.has("f0.ts")).toBe(false);
});

test("files past the per-diff line budget collapse", () => {
  // Files each at the per-file limit (so the per-file rule never fires), but
  // enough of them that their combined lines blow MAX_AUTO_EXPANDED_LINES
  // before the file-count budget is reached.
  const per = PER_FILE_COLLAPSE_LINES; // stays expanded per-file
  const n = Math.ceil(MAX_AUTO_EXPANDED_LINES / per) + 1;
  expect(n).toBeLessThanOrEqual(MAX_AUTO_EXPANDED_FILES); // line budget hits first
  const files = Array.from({ length: n }, (_, i) => file(`f${i}.ts`, per));
  const collapsed = computeAutoCollapsed(files, NONE);
  expect(collapsed.has("f0.ts")).toBe(false); // early files fit
  expect(collapsed.has(`f${n - 1}.ts`)).toBe(true); // last one is over the line budget
});

test("active commented files under the cap are budget-exempt and don't collapse cheaper files", () => {
  // A huge commented file that, if charged, would blow the line budget and
  // collapse the tiny uncommented file after it. It must not.
  const huge = file("huge.ts", MAX_AUTO_EXPANDED_LINES + 5000);
  const tiny = file("tiny.ts", 1);
  const collapsed = computeAutoCollapsed([huge, tiny], new Set(["huge.ts"]));
  expect(collapsed.has("huge.ts")).toBe(false); // commented → shown
  expect(collapsed.has("tiny.ts")).toBe(false); // not penalized by huge.ts
});

test("NOISE_FILE paths collapse", () => {
  const noisy = ["bun.lock", "foo.min.js", "__snapshots__/x.snap"].map((p) => file(p, 1));
  const collapsed = computeAutoCollapsed(noisy, NONE);
  expect(collapsed.has("bun.lock")).toBe(true);
  expect(collapsed.has("foo.min.js")).toBe(true);
  expect(collapsed.has("__snapshots__/x.snap")).toBe(true);
});

test("a commented noise file is still shown", () => {
  const noisy = file("bun.lock", 1);
  const collapsed = computeAutoCollapsed([noisy], new Set(["bun.lock"]));
  expect(collapsed.has("bun.lock")).toBe(false);
});

test("binary and symlink files stay expanded (compact rows)", () => {
  const bin = file("image.png", 0, { isBinary: true });
  const link = file("link", 0, { isSymlink: true, symlinkTarget: "target" });
  // Even alongside an exhausted budget, binary/symlink are never collapsed.
  const fillers = Array.from({ length: MAX_AUTO_EXPANDED_FILES }, (_, i) => file(`g${i}.ts`, 1));
  const collapsed = computeAutoCollapsed([...fillers, bin, link], NONE);
  expect(collapsed.has("image.png")).toBe(false);
  expect(collapsed.has("link")).toBe(false);
});

test("precomputed lineCounts produce the same decision as recomputing", () => {
  const files = [
    file("a.ts", PER_FILE_COLLAPSE_LINES + 1),
    file("b.ts", 10),
    file("c.png", 0, { isBinary: true }),
  ];
  const counts = new Map(files.map((f) => [f.path, fileLineCount(f)]));
  const withCounts = computeAutoCollapsed(files, NONE, counts);
  const without = computeAutoCollapsed(files, NONE);
  expect([...withCounts].sort()).toEqual([...without].sort());
});

// ── computeCommentLineIds / computeActiveCommentedPaths ─────────────────────

const RESOLVED: Resolution = {
  status: "fixed",
  body: "Fixed.",
  at: "2026-01-01T00:00:00.000Z",
};

let commentSeq = 0;
// A root (no parentId) comment. Only the fields the helpers read matter.
function root(extra: Partial<Comment> = {}): Comment {
  commentSeq++;
  return {
    id: `c${commentSeq}`,
    threadId: `t${commentSeq}`,
    file: "a.ts",
    line: 10,
    side: "new",
    body: "x",
    author: "tester",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}
// A reply (has parentId) on a thread.
function reply(threadId: string, extra: Partial<Comment> = {}): Comment {
  commentSeq++;
  return {
    id: `r${commentSeq}`,
    threadId,
    parentId: "c1",
    file: "a.ts",
    body: "reply",
    author: "tester",
    createdAt: "2026-01-02T00:00:00.000Z",
    ...extra,
  };
}

test("computeCommentLineIds maps new-side to R and old-side to L", () => {
  const ids = computeCommentLineIds([
    [root({ side: "new", line: 12 })],
    [root({ side: "old", line: 30 })],
  ]);
  expect(ids).toContain("R-12");
  expect(ids).toContain("L-30");
});

test("computeCommentLineIds defaults a missing side to R (new)", () => {
  const ids = computeCommentLineIds([[root({ side: undefined, line: 7 })]]);
  expect(ids).toEqual(["R-7"]);
});

test("computeCommentLineIds emits two ids for a range comment (start and end)", () => {
  const ids = computeCommentLineIds([[root({ side: "new", line: 5, endLine: 9 })]]);
  expect(ids).toEqual(["R-5", "R-9"]);
});

test("computeCommentLineIds emits one id when endLine equals line", () => {
  const ids = computeCommentLineIds([[root({ side: "new", line: 5, endLine: 5 })]]);
  expect(ids).toEqual(["R-5"]);
});

test("computeCommentLineIds INCLUDES resolved roots so their anchor stays inline", () => {
  const ids = computeCommentLineIds([[root({ line: 21, resolution: RESOLVED })]]);
  expect(ids).toEqual(["R-21"]);
});

test("computeCommentLineIds dedupes ids shared across threads", () => {
  const ids = computeCommentLineIds([
    [root({ side: "new", line: 8 })],
    [root({ side: "new", line: 8 })],
  ]);
  expect(ids).toEqual(["R-8"]);
});

test("computeCommentLineIds ignores threads whose root has no line (file-level)", () => {
  const ids = computeCommentLineIds([[root({ line: undefined })]]);
  expect(ids).toEqual([]);
});

test("computeCommentLineIds finds the root even when replies sort first", () => {
  const thread: Comment[] = [reply("t1", { line: undefined }), root({ threadId: "t1", line: 14 })];
  expect(computeCommentLineIds([thread])).toEqual(["R-14"]);
});

test("computeActiveCommentedPaths keeps files with an unresolved root", () => {
  const paths = computeActiveCommentedPaths([root({ file: "open.ts" })]);
  expect(paths.has("open.ts")).toBe(true);
});

test("computeActiveCommentedPaths EXCLUDES files whose only root is resolved", () => {
  const paths = computeActiveCommentedPaths([root({ file: "resolved.ts", resolution: RESOLVED })]);
  expect(paths.has("resolved.ts")).toBe(false);
});

test("computeActiveCommentedPaths ignores replies (only roots count)", () => {
  const paths = computeActiveCommentedPaths([reply("t1", { file: "reply-only.ts" })]);
  expect(paths.has("reply-only.ts")).toBe(false);
});

// ── pruneCollapseOverrides ──────────────────────────────────────────────────
//
// A minimal localStorage-shaped stub. A Map preserves insertion order, which is
// exactly the enumeration order pruneCollapseOverrides treats as recency: the
// oldest-inserted keys sort first and are the eviction candidates. `setItem` on
// an existing key updates in place WITHOUT reordering — matching the Web Storage
// spec — so the test never relies on a bare setItem re-appending.
function makeLocalStorageStub() {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key(i: number): string | null {
      return Array.from(map.keys())[i] ?? null;
    },
    getItem(k: string): string | null {
      return map.has(k) ? (map.get(k) as string) : null;
    },
    setItem(k: string, v: string): void {
      map.set(k, v); // in-place update on existing key; no reorder
    },
    removeItem(k: string): void {
      map.delete(k);
    },
    _keys: () => Array.from(map.keys()),
  };
}

type LocalStorageStub = ReturnType<typeof makeLocalStorageStub>;
let stub: LocalStorageStub;
const realLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;

// Use defineProperty rather than plain assignment: under the happy-dom test env
// (preloaded for React component tests) `localStorage` is a readonly accessor,
// so `globalThis.localStorage = …` throws. defineProperty works in both the
// bare-global and DOM environments.
function setLocalStorage(value: unknown) {
  Object.defineProperty(globalThis, "localStorage", {
    value,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  stub = makeLocalStorageStub();
  setLocalStorage(stub);
});

afterEach(() => {
  setLocalStorage(realLocalStorage);
});

// Deterministic slug name for index `i`. Deriving from the index (rather than
// indexing a returned array) keeps the type `string`, not `string | undefined`,
// under `noUncheckedIndexedAccess`.
const slugName = (i: number) => `slug-${i}`;
const slugKey = (i: number) => collapseOverridesKey(slugName(i));

// Seed `n` slug entries in insertion order: slug-0 (oldest) … slug-(n-1).
function seedSlugs(n: number): void {
  for (let i = 0; i < n; i++) stub.setItem(slugKey(i), "{}");
}

const present = (i: number) => expect(stub.getItem(slugKey(i))).not.toBeNull();
const evicted = (i: number) => expect(stub.getItem(slugKey(i))).toBeNull();

test("pruneCollapseOverrides evicts nothing at exactly the cap", () => {
  const n = MAX_COLLAPSE_OVERRIDE_SLUGS;
  seedSlugs(n);
  pruneCollapseOverrides(slugName(n - 1));
  expect(stub.length).toBe(MAX_COLLAPSE_OVERRIDE_SLUGS);
  for (let i = 0; i < n; i++) present(i);
});

test("pruneCollapseOverrides removes the orphaned v1 key", () => {
  stub.setItem(COLLAPSE_OVERRIDES_V1_KEY, "{}");
  seedSlugs(3);
  pruneCollapseOverrides(slugName(2));
  expect(stub.getItem(COLLAPSE_OVERRIDES_V1_KEY)).toBeNull();
});

test("pruneCollapseOverrides evicts exactly the count of oldest keys above the cap", () => {
  const over = 5;
  const n = MAX_COLLAPSE_OVERRIDE_SLUGS + over;
  seedSlugs(n);
  // Keep the newest slug; the `over` oldest (front of enumeration) should go.
  pruneCollapseOverrides(slugName(n - 1));
  expect(stub.length).toBe(MAX_COLLAPSE_OVERRIDE_SLUGS);
  // The first `over` slugs are the oldest and must be evicted.
  for (let i = 0; i < over; i++) evicted(i);
  // Everything from index `over` onward survives.
  for (let i = over; i < n; i++) present(i);
});

test("pruneCollapseOverrides protects `keep` even when it sorts first (oldest)", () => {
  const over = 3;
  const n = MAX_COLLAPSE_OVERRIDE_SLUGS + over;
  seedSlugs(n);
  // `keep` is the very oldest entry — it would be the first evicted without
  // the keepKey guard.
  pruneCollapseOverrides(slugName(0));
  expect(stub.length).toBe(MAX_COLLAPSE_OVERRIDE_SLUGS);
  present(0); // kept survives despite sorting first
  // Protecting the oldest means eviction starts at the next-oldest and takes
  // `over` of them (indices 1..over).
  for (let i = 1; i <= over; i++) evicted(i);
  present(over + 1);
});

test("pruneCollapseOverrides ignores foreign localStorage keys", () => {
  stub.setItem("unrelated:thing", "x");
  seedSlugs(2);
  pruneCollapseOverrides(slugName(1));
  // Foreign key is neither counted toward the cap nor evicted.
  expect(stub.getItem("unrelated:thing")).not.toBeNull();
});

// Re-touching an existing slug must re-append it to enumeration order so it
// escapes eviction — the whole reason `setCollapseOverride` does
// `removeItem(key)` before `setItem(key, …)` (DiffView.tsx:199). The other prune
// tests seed via a bare `setItem`, which updates in place WITHOUT reordering, so
// they'd stay green even if that `removeItem` were deleted (silently reverting to
// FIFO-by-first-write eviction). This test mirrors that remove-then-set ordering
// to lock the recency behavior in.
test("pruneCollapseOverrides keeps a re-appended (re-touched) slug and evicts the now-oldest", () => {
  const over = 1;
  const n = MAX_COLLAPSE_OVERRIDE_SLUGS + over;
  seedSlugs(n);
  // Re-touch the oldest slug exactly the way `setCollapseOverride` does:
  // removeItem then setItem, which moves it to the BACK of enumeration order.
  stub.removeItem(slugKey(0));
  stub.setItem(slugKey(0), "{}");
  // Now slug-1 is the oldest. Prune with a different `keep` so neither slug-0
  // nor slug-1 is protected by the keepKey guard — survival must come purely
  // from re-append recency.
  pruneCollapseOverrides(slugName(n - 1));
  expect(stub.length).toBe(MAX_COLLAPSE_OVERRIDE_SLUGS);
  present(0); // re-touched → re-appended → newest → survives
  evicted(1); // now the oldest → evicted
  for (let i = 2; i < n; i++) present(i);
});

// Bind the recency behavior to the real code path: `setCollapseOverride` must
// `removeItem` before `setItem` so writing to an EXISTING slug re-appends it to
// enumeration order. Deleting the `removeItem(key)` line at DiffView.tsx:199
// leaves the bare in-place `setItem` (no reorder), so this test fails — exactly
// the regression the prune tests can't catch.
test("setCollapseOverride re-appends an existing slug to the back of enumeration order", () => {
  // Seed two slugs; slug-0 is the oldest (front of enumeration).
  stub.setItem(slugKey(0), "{}");
  stub.setItem(slugKey(1), "{}");
  expect(stub._keys()).toEqual([slugKey(0), slugKey(1)]);
  // Touch the OLDER slug. With the remove-then-set ordering it must move to the
  // back; a bare in-place setItem would leave it at the front.
  setCollapseOverride(slugName(0), "some/file.ts", true);
  expect(stub._keys()).toEqual([slugKey(1), slugKey(0)]);
});

// And the end-to-end consequence: a re-touched-but-old slug survives an
// over-cap prune driven entirely by setCollapseOverride's own write+prune.
test("setCollapseOverride keeps a re-touched slug alive across its own prune", () => {
  const n = MAX_COLLAPSE_OVERRIDE_SLUGS; // at the cap
  seedSlugs(n); // slug-0 oldest … slug-(n-1) newest
  // Re-touch the oldest slug, then add one brand-new slug to push over the cap.
  // setCollapseOverride runs pruneCollapseOverrides internally on each call.
  setCollapseOverride(slugName(0), "x.ts", true); // slug-0 → re-appended (newest)
  setCollapseOverride(slugName(n), "y.ts", true); // new slug → over cap → prune
  expect(stub.length).toBe(MAX_COLLAPSE_OVERRIDE_SLUGS);
  present(0); // re-touched → survives despite being seeded first
  evicted(1); // now the genuine oldest → evicted
});
