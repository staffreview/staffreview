import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activePointerPath,
  diffPath,
  diffsDir,
  ensureDirs,
  getActiveDiffSlug,
  loadDiff,
  saveDiff,
  setActiveDiff,
  staffDir,
  sweepStaleTmp,
} from "./store.ts";
import type { Diff } from "./types.ts";

// Every helper in store.ts takes an explicit `cwd`, so point them at a
// throwaway temp dir per test rather than the real `.staffreview` tree.
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "staffreview-store-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeDiff(): Diff {
  const now = "2026-06-02T00:00:00.000Z";
  return {
    slug: "abc123..WT",
    base: { kind: "commit", ref: "abc123" },
    head: { kind: "working-tree" },
    comments: [
      {
        id: "c1",
        threadId: "c1",
        file: "src/foo.ts",
        line: 10,
        side: "new",
        body: "real comment that must not be lost",
        author: "Opus 4.8",
        createdAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

test("loadDiff returns null for an empty file without throwing", async () => {
  const d = makeDiff();
  await ensureDirs(tmp);
  // A 0-byte file at the diff path is the transient mid-write case — it must
  // be treated as "absent", not raise a JSON parse error.
  await writeFile(diffPath(d.slug, tmp), "");
  expect(await loadDiff(d.slug, tmp)).toBeNull();
});

test("loadDiff returns null for a whitespace-only file without throwing", async () => {
  const d = makeDiff();
  await ensureDirs(tmp);
  await writeFile(diffPath(d.slug, tmp), "  \n\t ");
  expect(await loadDiff(d.slug, tmp)).toBeNull();
});

test("saveDiff then loadDiff round-trips to an equal object", async () => {
  const d = makeDiff();
  await saveDiff(d, tmp);
  const loaded = await loadDiff(d.slug, tmp);
  // saveDiff stamps updatedAt, so compare against the mutated in-memory copy.
  expect(loaded).toEqual(d);
});

test("setActiveDiff atomically writes valid JSON", async () => {
  await setActiveDiff("abc123..WT", tmp);
  await setActiveDiff("def456..WT", tmp);

  expect(JSON.parse(await Bun.file(activePointerPath(tmp)).text())).toEqual({
    slug: "def456..WT",
  });
  expect(await getActiveDiffSlug(tmp)).toBe("def456..WT");
  expect((await readdir(staffDir(tmp))).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
});

test("a successful save leaves no *.tmp files in the diffs dir", async () => {
  const d = makeDiff();
  await saveDiff(d, tmp);
  const entries = await readdir(diffsDir(tmp));
  expect(entries).toContain(`${d.slug}.json`);
  expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
});

test("sweepStaleTmp reaps orphaned *.tmp files left by a crash mid-write", async () => {
  await ensureDirs(tmp);
  // Simulate temp files orphaned by a process killed between Bun.write(tmp)
  // and rename — each crash uses a fresh UUID so they accumulate unbounded.
  await writeFile(join(diffsDir(tmp), "abc123..WT.json.uuid-1.tmp"), "{}");
  await writeFile(join(diffsDir(tmp), "def456..WT.json.uuid-2.tmp"), "{}");
  await writeFile(`${activePointerPath(tmp)}.uuid-3.tmp`, "{}");
  // The one-shot startup sweep (server boot) clears them.
  await sweepStaleTmp(tmp);
  expect((await readdir(diffsDir(tmp))).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  expect((await readdir(staffDir(tmp))).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
});

test("sweepStaleTmp leaves real *.json diffs untouched while reaping *.tmp", async () => {
  const d = makeDiff();
  await saveDiff(d, tmp);
  await writeFile(join(diffsDir(tmp), `${d.slug}.json.orphan.tmp`), "{}");
  await sweepStaleTmp(tmp);
  const entries = await readdir(diffsDir(tmp));
  expect(entries).toContain(`${d.slug}.json`);
  expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
  // The reaper must not corrupt the surviving diff.
  expect(await loadDiff(d.slug, tmp)).toEqual(d);
});

test("saveDiff does NOT reap a concurrent in-flight save's temp file", async () => {
  // Regression for the hot-path reap: ensureDirs (called at the top of every
  // saveDiff) must not glob+unlink *.tmp, or it would delete a concurrent
  // save's just-written temp before that save's own rename, causing ENOENT
  // and silently losing the write. Simulate the in-flight temp and assert a
  // second save leaves it intact.
  const d = makeDiff();
  await ensureDirs(tmp);
  const inflight = join(diffsDir(tmp), "other..WT.json.inflight-uuid.tmp");
  await writeFile(inflight, "{}");
  await saveDiff(d, tmp);
  const entries = await readdir(diffsDir(tmp));
  expect(entries).toContain("other..WT.json.inflight-uuid.tmp");
});

test("loadDiff throws on a non-empty corrupt file (never silently recreates)", async () => {
  const d = makeDiff();
  await ensureDirs(tmp);
  // Genuinely corrupt-but-non-empty content: returning null here would let
  // loadOrCreateDiff overwrite it with an empty diff and destroy comments.
  await writeFile(diffPath(d.slug, tmp), "{ not valid json,,,");
  await expect(loadDiff(d.slug, tmp)).rejects.toThrow(/corrupt diff file/);
});

test("saveDiff rethrows and cleans up the temp file when rename fails", async () => {
  const d = makeDiff();
  await ensureDirs(tmp);
  // Make the destination path a directory so rename() can't replace it with a
  // file — this forces saveDiff's rename to throw and exercises the cleanup
  // path that unlinks the orphan .tmp before rethrowing.
  mkdirSync(diffPath(d.slug, tmp));
  await expect(saveDiff(d, tmp)).rejects.toThrow();
  const entries = await readdir(diffsDir(tmp));
  expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
});
