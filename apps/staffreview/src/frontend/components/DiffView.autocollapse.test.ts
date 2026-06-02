import { expect, test } from "bun:test";
import type { FileDiff } from "../../types.ts";
import {
	computeAutoCollapsed,
	fileLineCount,
	MAX_AUTO_EXPANDED_FILES,
	MAX_AUTO_EXPANDED_LINES,
	PER_FILE_COLLAPSE_LINES,
} from "./DiffView.tsx";

// Build a text FileDiff whose larger side has `lines` lines.
function file(
	path: string,
	lines = 1,
	extra: Partial<FileDiff> = {},
): FileDiff {
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

test("a commented file never collapses, even when oversized", () => {
	const big = file("huge.ts", PER_FILE_COLLAPSE_LINES + 500);
	const collapsed = computeAutoCollapsed([big], new Set(["huge.ts"]));
	expect(collapsed.has("huge.ts")).toBe(false);
});

test("files past the per-diff file budget collapse", () => {
	// One tiny file over the file budget; all within the line budget.
	const files = Array.from({ length: MAX_AUTO_EXPANDED_FILES + 1 }, (_, i) =>
		file(`f${i}.ts`, 1),
	);
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

test("commented files are budget-exempt and don't collapse cheaper files", () => {
	// A huge commented file that, if charged, would blow the line budget and
	// collapse the tiny uncommented file after it. It must not.
	const huge = file("huge.ts", MAX_AUTO_EXPANDED_LINES + 5000);
	const tiny = file("tiny.ts", 1);
	const collapsed = computeAutoCollapsed([huge, tiny], new Set(["huge.ts"]));
	expect(collapsed.has("huge.ts")).toBe(false); // commented → shown
	expect(collapsed.has("tiny.ts")).toBe(false); // not penalized by huge.ts
});

test("NOISE_FILE paths collapse", () => {
	const noisy = ["bun.lock", "foo.min.js", "__snapshots__/x.snap"].map((p) =>
		file(p, 1),
	);
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
	const fillers = Array.from({ length: MAX_AUTO_EXPANDED_FILES }, (_, i) =>
		file(`g${i}.ts`, 1),
	);
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
