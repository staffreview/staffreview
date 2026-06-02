import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffPath, diffsDir, ensureDirs, loadDiff, saveDiff } from "./store.ts";
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

test("a successful save leaves no *.tmp files in the diffs dir", async () => {
	const d = makeDiff();
	await saveDiff(d, tmp);
	const entries = await readdir(diffsDir(tmp));
	expect(entries).toContain(`${d.slug}.json`);
	expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
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
