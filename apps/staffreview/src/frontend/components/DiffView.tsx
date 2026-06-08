import { presentableDiff } from "@codemirror/merge";
import { diffLines } from "diff";
import {
  Binary,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileCode2,
  FileMinus2,
  FilePlus2,
  FoldVertical,
  Link2,
  Plus,
  UnfoldVertical,
} from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Comment, FileDiff } from "../../types.ts";
import {
  ensureShikiLanguage,
  ensureShikiTheme,
  getHighlighter,
  langForPath,
  type StaffHighlighter,
  shikiThemeFor,
  tokenizeLine,
} from "../lib/highlight.ts";
import { cn } from "../lib/utils.ts";
import { CommentThread, NewCommentEditor } from "./CommentThread.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";

type ComposingTarget = { line: number; side: "old" | "new"; endLine?: number };
/**
 * Inline composer hosts and existing threads are keyed by `(side, host line)`.
 * The host line is the visual position of the comment — for a range, that's
 * the END line (matching GitHub's convention of putting the composer below the
 * last line of the selection).
 */
function composingKey(t: ComposingTarget) {
  return `${t.side}:${t.endLine ?? t.line}`;
}

function statusIcon(s: FileDiff["status"]) {
  if (s === "added") return <FilePlus2 className="h-4 w-4 text-success" />;
  if (s === "deleted") return <FileMinus2 className="h-4 w-4 text-destructive" />;
  return <FileCode2 className="h-4 w-4 text-muted-foreground" />;
}

function diffLineCount(value: string): number {
  return value === "" ? 0 : value.replace(/\n$/, "").split("\n").length;
}

export function fileChangeStats(file: FileDiff): { additions: number; deletions: number } {
  // Symlink and binary files render as a compact single row, not added/deleted
  // code lines, so a +/- badge would claim line changes that don't correspond
  // to anything rendered. For a symlink, git.ts stores the link-target path
  // string as old/new content, so a repointed symlink would otherwise report
  // +1/-1; binary content is already blanked to "". Short-circuit both to
  // {0,0} (mirroring `fileLineCount`) rather than relying on every call site to
  // re-derive the guard `canToggleFoldedContext` already applies.
  if (file.isSymlink || file.isBinary) return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const change of diffLines(file.oldContent, file.newContent)) {
    if (change.added) additions += diffLineCount(change.value);
    if (change.removed) deletions += diffLineCount(change.value);
  }
  return { additions, deletions };
}

const MIN_STRUCTURAL_LINE_SIMILARITY = 0.35;

function tokens(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
}

function lcsLength(left: string[], right: string[]): number {
  const previous = new Array(right.length + 1).fill(0);
  const current = new Array(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i++) {
    for (let j = 1; j <= right.length; j++) {
      current[j] =
        left[i - 1] === right[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    previous.splice(0, previous.length, ...current);
    current.fill(0);
  }
  return previous[right.length];
}

function lineSimilarity(left: string, right: string): number {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;
  return (2 * lcsLength(leftTokens, rightTokens)) / (leftTokens.length + rightTokens.length);
}

// Per-diff, per-file collapse *overrides*: a map of path → collapsed?. Only
// files the user has explicitly toggled appear here; everything else follows
// the current auto-collapse decision. The diff slug is part of the key so a
// manual expand in one review cannot keep the same path expanded forever.
const COLLAPSE_OVERRIDES_KEY_PREFIX = "staff:file-collapse-overrides:v2";
// The pre-slug global key. Orphaned by the v2 migration; removed once.
export const COLLAPSE_OVERRIDES_V1_KEY = "staff:file-collapse-overrides";
// localStorage has a ~5MB origin cap and we never delete a slug's entry, so a
// long-lived install reviewing many diffs would otherwise grow without bound
// (and a quota-exceeded write is silently swallowed below, dropping *all*
// persisted state). Cap the number of retained per-slug entries, evicting the
// least-recently-touched, so growth is bounded.
export const MAX_COLLAPSE_OVERRIDE_SLUGS = 50;

export function collapseOverridesKey(slug: string): string {
  return `${COLLAPSE_OVERRIDES_KEY_PREFIX}:${slug}`;
}

function loadCollapseOverrides(slug: string): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(collapseOverridesKey(slug));
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? (obj as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

// Bounded-growth guard, run on each write: drop the orphaned v1 key, then keep
// only the most-recently-written slugs. Recency is the localStorage key
// enumeration order, which is insertion order per the Web Storage spec:
// `setItem` on an *existing* key updates the value in place and does NOT move
// the key. `setCollapseOverride` therefore `removeItem`s before `setItem` so the
// slug it touches is genuinely re-appended, making enumeration order a true
// most-recently-written ordering and the front of `keys` the actual oldest.
// We additionally always protect `keep` (the slug written this pass) from
// eviction.
export function pruneCollapseOverrides(keep: string) {
  try {
    localStorage.removeItem(COLLAPSE_OVERRIDES_V1_KEY);
    const keepKey = collapseOverridesKey(keep);
    const prefix = `${COLLAPSE_OVERRIDES_KEY_PREFIX}:`;
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(prefix)) keys.push(k);
    }
    if (keys.length <= MAX_COLLAPSE_OVERRIDE_SLUGS) return;
    // Evict the oldest (front of enumeration order), never the active slug.
    const evictable = keys.filter((k) => k !== keepKey);
    const toEvict = evictable.slice(0, keys.length - MAX_COLLAPSE_OVERRIDE_SLUGS);
    for (const k of toEvict) localStorage.removeItem(k);
  } catch {}
}

export function setCollapseOverride(slug: string, path: string, collapsed: boolean) {
  try {
    const key = collapseOverridesKey(slug);
    const map = loadCollapseOverrides(slug);
    map[path] = collapsed;
    // removeItem before setItem so an existing slug is genuinely re-appended to
    // localStorage's enumeration order (a bare setItem on an existing key keeps
    // its original slot). This makes pruneCollapseOverrides' eviction true
    // most-recently-written, not FIFO-by-first-write.
    localStorage.removeItem(key);
    localStorage.setItem(key, JSON.stringify(map));
    pruneCollapseOverrides(slug);
  } catch {}
}

// ── Auto-collapse heuristics for large diffs ────────────────────────────────
// A collapsed DiffFile unmounts its diff table body, so collapsing heavy /
// low-signal files keeps a 100-file diff from mounting 100 syntax highlighters
// at once. These are *defaults*: an explicit user toggle (override) always
// wins, and active unresolved comments only force-open a bounded number of file
// cards.

// Generated / lock / minified / snapshot files — rarely read line by line.
const NOISE_FILE =
  /(^|\/)(bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|cargo\.lock|composer\.lock|go\.sum|gemfile\.lock|poetry\.lock)$|\.min\.(js|css|mjs|cjs)$|\.map$|(^|\/)__snapshots__\/|\.snap$/i;

// A single file larger than this (lines, larger side) starts collapsed.
export const PER_FILE_COLLAPSE_LINES = 1000;
// Across the whole diff, auto-expand at most this many files…
export const MAX_AUTO_EXPANDED_FILES = 20;
// …and at most this many rendered lines — whichever limit is hit first.
export const MAX_AUTO_EXPANDED_LINES = 6000;
// Active commented files are higher signal than ordinary files, but the
// sidebar is the scalable navigation surface once a review has many findings.
export const MAX_AUTO_EXPANDED_COMMENTED_FILES = 8;

export function fileLineCount(f: FileDiff): number {
  if (f.isBinary || f.isSymlink) return 0; // rendered as a compact row — cheap
  const lines = (s?: string) => (s ? s.split("\n").length : 0);
  return Math.max(lines(f.oldContent), lines(f.newContent));
}

/**
 * Decide which files start collapsed. Walks files in display order: binary /
 * symlink rows and a bounded number of active commented files are shown; noise
 * files and oversized files collapse; and once the per-diff file/line budget is
 * spent everything after it collapses too, so a huge diff stays responsive.
 * Returns the set of paths to collapse by default. Active commented files that
 * stay open still render with unchanged context folded.
 *
 * Force-expanded files (binary/symlink, active commented files under the cap)
 * never consume the ordinary file/line budget — they render regardless, so
 * charging them would only penalize other cheaper files.
 *
 * `lineCounts` is an optional precomputed `path → fileLineCount` map. It lets
 * callers hoist the expensive `.split("\n")` walk into a `files`-only memo so
 * the budget decision can be recomputed cheaply when only active comments
 * change (comments arrive far more often than files do).
 */
export function computeAutoCollapsed(
  files: FileDiff[],
  activeCommentedPaths: Set<string>,
  lineCounts?: Map<string, number>,
): Set<string> {
  const linesFor = (f: FileDiff) => lineCounts?.get(f.path) ?? fileLineCount(f);
  const collapsed = new Set<string>();
  let expandedFiles = 0;
  let expandedLines = 0;
  let expandedCommentedFiles = 0;
  for (const f of files) {
    if (f.isBinary || f.isSymlink) continue; // compact + cheap; leave expanded
    const lines = linesFor(f);
    if (
      activeCommentedPaths.has(f.path) &&
      expandedCommentedFiles < MAX_AUTO_EXPANDED_COMMENTED_FILES
    ) {
      expandedCommentedFiles++;
      continue;
    }
    const overBudget =
      expandedFiles >= MAX_AUTO_EXPANDED_FILES || expandedLines + lines > MAX_AUTO_EXPANDED_LINES;
    if (NOISE_FILE.test(f.path) || lines > PER_FILE_COLLAPSE_LINES || overBudget) {
      collapsed.add(f.path);
    } else {
      expandedFiles++;
      expandedLines += lines;
    }
  }
  return collapsed;
}

function groupCommentsByThread(comments: Comment[]) {
  const map = new Map<string, Comment[]>();
  for (const c of comments) {
    const list = map.get(c.threadId) ?? [];
    list.push(c);
    map.set(c.threadId, list);
  }
  return Array.from(map.values()).map((cs) =>
    cs.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  );
}

export function groupFileCommentsByRootThread(comments: Comment[], filePath: string) {
  return groupCommentsByThread(comments).filter((thread) => {
    const root = thread.find((c) => !c.parentId);
    return root?.file === filePath;
  });
}

/**
 * Files that have at least one *active* (unresolved) line/range comment. These
 * are the higher-signal files `computeAutoCollapsed` will force-open under the
 * commented-file cap. Resolved roots are excluded on purpose — a resolved
 * thread shouldn't keep its whole file card expanded — but they're still kept
 * visible inline by `computeCommentLineIds` (see below).
 */
export function computeActiveCommentedPaths(comments: Comment[]): Set<string> {
  return new Set(
    comments.filter((c) => !c.parentId && !c.resolution && c.file).map((c) => c.file as string),
  );
}

/**
 * The line ids (`R<line>` / `L<line>`) the diff table must keep unfolded so
 * every comment's anchor row stays rendered even while surrounding context is
 * folded. Without this a comment on an unchanged line has no host row and its
 * thread is reachable only from the sidebar (see folded-comment.spec.ts).
 *
 * - Side maps to the diff gutter prefix: `new` → `R`, `old` → `L`.
 * - Range comments emit *two* ids — the start line and the end line — because
 *   the thread is hosted at `endLine` and both endpoints need rendered context.
 * - Resolved roots are intentionally INCLUDED here so a resolved comment on an
 *   unchanged context line still gets an inline host. (They're excluded from
 *   `computeActiveCommentedPaths` so they don't keep the whole file card open.)
 *
 * `threads` is the grouped output of `groupCommentsByThread` (each entry is one
 * thread's comments, root first or findable via `!parentId`).
 */
export function computeCommentLineIds(threads: Comment[][]): string[] {
  return Array.from(
    new Set(
      threads.flatMap((t) => {
        const root = t.find((c) => !c.parentId);
        if (!root?.line) return [];
        const side = root.side === "old" ? "L" : "R";
        const ids = [`${side}-${root.line}`];
        if (root.endLine && root.endLine !== root.line) ids.push(`${side}-${root.endLine}`);
        return ids;
      }),
    ),
  );
}

/**
 * Find the <tr> in the rendered diff table whose line-number cell on the
 * given side matches `line`. Works for split view (6 cells per row, line
 * numbers at indices 0 and 3) and unified view, where the first normalized
 * gutter stores both old/new line numbers as data attributes.
 */
/**
 * Build the URL fragment for a (file, side, line) or line-range target.
 * Single-line emits `R<line>`/`L<line>`; ranges emit `R<start>-R<end>`,
 * matching GitHub's PR-diff anchor format so links are portable.
 */
export function buildLineHash(
  file: string,
  side: "old" | "new",
  startLine: number,
  endLine?: number,
): string {
  const tag = side === "old" ? "L" : "R";
  const lo = Math.min(startLine, endLine ?? startLine);
  const hi = Math.max(startLine, endLine ?? startLine);
  const suffix = lo === hi ? `${tag}${lo}` : `${tag}${lo}-${tag}${hi}`;
  return `#${encodeURIComponent(file)}:${suffix}`;
}

/**
 * Update the URL hash and notify listeners. `replaceState` is silent
 * (doesn't fire `hashchange`), so we emit a custom event the DiffFile
 * listens for to repaint its line highlight.
 */
export function setLineHash(
  file: string,
  side: "old" | "new",
  startLine: number,
  endLine?: number,
) {
  const hash = buildLineHash(file, side, startLine, endLine);
  if (window.location.hash !== hash) {
    history.replaceState(null, "", hash);
  }
  window.dispatchEvent(new CustomEvent("staff:hashchange"));
}

/**
 * Remove the line-anchor hash from the URL. Used when the user clicks
 * the same line number a second time to toggle the highlight off.
 */
export function clearLineHash() {
  if (window.location.hash) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  window.dispatchEvent(new CustomEvent("staff:hashchange"));
}

export function parseLineHash(
  hash: string,
): { file: string; side: "old" | "new"; startLine: number; endLine: number } | null {
  if (!hash) return null;
  const s = hash.startsWith("#") ? hash.slice(1) : hash;
  // Range form first: `<path>:R5-R10` (same side, lo <= hi).
  const range = s.match(/^(.+):([LR])(\d+)-([LR])(\d+)$/);
  if (range && range[2] === range[4]) {
    const a = Number(range[3]);
    const b = Number(range[5]);
    return {
      file: decodeURIComponent(range[1]!),
      side: range[2] === "L" ? "old" : "new",
      startLine: Math.min(a, b),
      endLine: Math.max(a, b),
    };
  }
  // Single-line form: `<path>:R5`.
  const single = s.match(/^(.+):([LR])(\d+)$/);
  if (single) {
    const n = Number(single[3]);
    return {
      file: decodeURIComponent(single[1]!),
      side: single[2] === "L" ? "old" : "new",
      startLine: n,
      endLine: n,
    };
  }
  return null;
}

/**
 * Scroll the diff to a specific file:line (the start of the anchor).
 * Dispatches `staff:expand-file` first so a collapsed file un-collapses
 * before we look for its rows, then polls briefly because
 * the file card may need a frame to expand and render its table after a layout
 * change.
 */
export function scrollToLine(file: string, side: "old" | "new", line: number) {
  window.dispatchEvent(new CustomEvent("staff:expand-file", { detail: { path: file } }));
  const start = performance.now();
  const tick = () => {
    const card = document.querySelector(`[data-testid="file-card-${file.replace(/"/g, '\\"')}"]`);
    if (card) {
      const row = findRowForLine(card as HTMLElement, { line, side });
      if (row) {
        row.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
    }
    if (performance.now() - start < 2000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function findRowForLine(
  container: HTMLElement,
  target: { line: number; side: "old" | "new" },
): HTMLElement | null {
  const rows = container.querySelectorAll("table tbody tr");
  const wanted = String(target.line);
  for (const row of Array.from(rows)) {
    const cells = row.querySelectorAll<HTMLTableCellElement>(":scope > td");
    const unifiedGutter = row.querySelector<HTMLTableCellElement>("td[data-staff-unified-gutter]");
    const unifiedLine =
      target.side === "old" ? unifiedGutter?.dataset.oldLine : unifiedGutter?.dataset.newLine;
    if (unifiedLine === wanted) return row as HTMLElement;
    let cell: HTMLTableCellElement | undefined;
    if (cells.length >= 6) {
      cell = target.side === "old" ? cells[0] : cells[3];
    } else if (cells.length >= 4) {
      cell = target.side === "old" ? cells[0] : cells[1];
    } else {
      continue;
    }
    if (cell?.textContent?.trim() === wanted) return row as HTMLElement;
  }
  return null;
}

type InlineRange = { from: number; to: number };
type DiffRowKind = "context" | "changed" | "added" | "removed";
type DiffRow = {
  key: string;
  kind: DiffRowKind;
  oldLine?: number;
  newLine?: number;
  oldText?: string;
  newText?: string;
  oldRanges: InlineRange[];
  newRanges: InlineRange[];
};
type DiffItem = { type: "row"; row: DiffRow } | { type: "fold"; key: string; count: number };

function splitDiffLines(value: string): string[] {
  if (value === "") return [];
  return value.replace(/\n$/, "").split("\n");
}

function mergeInlineRanges(ranges: InlineRange[], text: string): InlineRange[] {
  const sorted = ranges
    .filter((range) => range.to > range.from)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: InlineRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    const whitespaceGap = last ? text.slice(last.to, range.from) : "";
    if (last && (range.from <= last.to || /^\s+$/u.test(whitespaceGap))) {
      last.to = Math.max(last.to, range.to);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function inlineRangesForPair(
  oldText: string,
  newText: string,
): {
  oldRanges: InlineRange[];
  newRanges: InlineRange[];
} {
  if (oldText === newText) return { newRanges: [], oldRanges: [] };
  const sameExceptWhitespace = oldText.replace(/\s+/g, "") === newText.replace(/\s+/g, "");
  if (!sameExceptWhitespace && lineSimilarity(oldText, newText) < MIN_STRUCTURAL_LINE_SIMILARITY) {
    return { newRanges: [], oldRanges: [] };
  }
  const changes = presentableDiff(oldText, newText, { scanLimit: 500, timeout: 20 });
  return {
    oldRanges: mergeInlineRanges(
      changes
        .filter((change) => change.toA > change.fromA)
        .map((change) => ({ from: change.fromA, to: change.toA })),
      oldText,
    ),
    newRanges: mergeInlineRanges(
      changes
        .filter((change) => change.toB > change.fromB)
        .map((change) => ({ from: change.fromB, to: change.toB })),
      newText,
    ),
  };
}

function buildDiffRows(file: FileDiff, structuredHighlighting: boolean): DiffRow[] {
  const rows: DiffRow[] = [];
  const changes = diffLines(file.oldContent, file.newContent);
  let oldLine = 1;
  let newLine = 1;
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i]!;
    if (change.removed && changes[i + 1]?.added) {
      const removedLines = splitDiffLines(change.value);
      const addedLines = splitDiffLines(changes[i + 1]!.value);
      const pairCount = Math.max(removedLines.length, addedLines.length);
      for (let j = 0; j < pairCount; j++) {
        const oldText = removedLines[j];
        const newText = addedLines[j];
        const rowOldLine = oldText === undefined ? undefined : oldLine++;
        const rowNewLine = newText === undefined ? undefined : newLine++;
        const inline =
          structuredHighlighting && oldText !== undefined && newText !== undefined
            ? inlineRangesForPair(oldText, newText)
            : { newRanges: [], oldRanges: [] };
        rows.push({
          key: `${rowOldLine ?? "-"}:${rowNewLine ?? "-"}:${rows.length}`,
          kind:
            oldText !== undefined && newText !== undefined
              ? oldText === newText
                ? "context"
                : "changed"
              : oldText !== undefined
                ? "removed"
                : "added",
          oldLine: rowOldLine,
          newLine: rowNewLine,
          oldText,
          newText,
          oldRanges: inline.oldRanges,
          newRanges: inline.newRanges,
        });
      }
      i++;
      continue;
    }

    const lines = splitDiffLines(change.value);
    for (const text of lines) {
      const rowOldLine = change.added ? undefined : oldLine++;
      const rowNewLine = change.removed ? undefined : newLine++;
      rows.push({
        key: `${rowOldLine ?? "-"}:${rowNewLine ?? "-"}:${rows.length}`,
        kind: change.added ? "added" : change.removed ? "removed" : "context",
        oldLine: rowOldLine,
        newLine: rowNewLine,
        oldText: change.added ? undefined : text,
        newText: change.removed ? undefined : text,
        oldRanges: [],
        newRanges: [],
      });
    }
  }
  return rows;
}

function buildVisibleDiffItems(
  rows: DiffRow[],
  expanded: boolean,
  forceVisible: Set<string>,
): DiffItem[] {
  if (expanded) return rows.map((row) => ({ row, type: "row" }));
  const visible = new Set<number>();
  const revealMargin = 3;
  const revealAround = (index: number) => {
    for (
      let i = Math.max(0, index - revealMargin);
      i <= Math.min(rows.length - 1, index + revealMargin);
      i++
    ) {
      visible.add(i);
    }
  };

  rows.forEach((row, index) => {
    if (row.kind !== "context") revealAround(index);
    if (row.oldLine && forceVisible.has(`old:${row.oldLine}`)) revealAround(index);
    if (row.newLine && forceVisible.has(`new:${row.newLine}`)) revealAround(index);
  });

  const items: DiffItem[] = [];
  for (let i = 0; i < rows.length; ) {
    if (visible.has(i)) {
      items.push({ row: rows[i]!, type: "row" });
      i++;
      continue;
    }
    const start = i;
    while (i < rows.length && !visible.has(i)) i++;
    items.push({ count: i - start, key: `fold:${start}:${i}`, type: "fold" });
  }
  return items;
}

export function DiffFile({
  file,
  slug,
  comments,
  splitView,
  syntaxTheme,
  structuredHighlighting,
  wrapLines,
  expandedByDefault,
  autoCollapsed,
  onChange,
}: {
  file: FileDiff;
  slug: string;
  comments: Comment[];
  splitView: boolean;
  syntaxTheme: string;
  structuredHighlighting: boolean;
  wrapLines: boolean;
  expandedByDefault: boolean;
  autoCollapsed: boolean;
  onChange?: () => void;
}) {
  const [composingLines, setComposingLines] = useState<ComposingTarget[]>([]);
  const [pathCopied, setPathCopied] = useState(false);
  // Whole-card collapse (the header chevron) — independent of the
  // "expand unchanged context" setting below. Defaults to expanded; a
  // per-file toggle is remembered as an override.
  const [collapsed, setCollapsed] = useState<boolean>(
    () => loadCollapseOverrides(slug)[file.path] ?? autoCollapsed,
  );
  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      setCollapseOverride(slug, file.path, next);
      return next;
    });
  };

  // Listen for "expand-file" events fired by the sidebar when the user
  // clicks an inline thread — make sure the file is open so the thread is
  // scrollable into view.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ path?: string }>).detail;
      if (detail?.path === file.path) {
        setCollapsed((prev) => {
          if (!prev) return prev;
          setCollapseOverride(slug, file.path, false);
          return false;
        });
      }
    };
    window.addEventListener("staff:expand-file", handler);
    return () => window.removeEventListener("staff:expand-file", handler);
  }, [file.path, slug]);

  // `collapsed` is seeded once at mount, but `autoCollapsed` is reactive: a
  // newly-arrived unresolved comment can push a file into the higher-signal set
  // and should force the card OPEN. This effect is force-EXPAND-only — it never
  // auto-collapses. Auto-collapsing here would yank a card shut out from under a
  // user mid-review: e.g. resolving a file's last unresolved comment inline
  // drops it from `activeCommentedPaths`, flipping `autoCollapsed` to true; or
  // freeing per-diff budget in file A pushes file B over the cap. Re-collapsing
  // is left to explicit user action (the chevron), which writes an override.
  useEffect(() => {
    if (autoCollapsed) return; // never auto-collapse, only force-expand
    if (file.path in loadCollapseOverrides(slug)) return; // explicit user choice wins
    setCollapsed((prev) => (prev ? false : prev));
  }, [autoCollapsed, file.path, slug]);

  const diffRef = useRef<HTMLDivElement>(null);
  const [highlighter, setHighlighter] = useState<StaffHighlighter | null>(null);
  const lang = useMemo(() => langForPath(file.path), [file.path]);
  useEffect(() => {
    let cancelled = false;
    setHighlighter(null);
    (async () => {
      const h = await getHighlighter();
      await ensureShikiTheme(syntaxTheme);
      if (lang !== "text") await ensureShikiLanguage(lang);
      if (!cancelled) setHighlighter(h);
    })().catch(() => {
      if (!cancelled) setHighlighter(null);
    });
    return () => {
      cancelled = true;
    };
  }, [lang, syntaxTheme]);

  const closeComposer = (target: ComposingTarget) => {
    setComposingLines((prev) => prev.filter((t) => composingKey(t) !== composingKey(target)));
  };

  const [contextExpanded, setContextExpanded] = useState(false);
  const changeStats = useMemo(() => fileChangeStats(file), [file]);
  const hasChangeStats = changeStats.additions > 0 || changeStats.deletions > 0;
  const canToggleFoldedContext = !expandedByDefault && !file.isSymlink && !file.isBinary;

  const threads = useMemo(
    () => groupFileCommentsByRootThread(comments, file.path),
    [comments, file.path],
  );
  const rootByLine = new Map<string, Comment[]>();
  for (const thread of threads) {
    const root = thread.find((c) => !c.parentId);
    if (!root || !root.line) continue;
    // Range threads render their host at endLine (matching GitHub).
    const hostLine = root.endLine ?? root.line;
    const key = `${root.side ?? "new"}:${hostLine}`;
    rootByLine.set(key, thread);
  }
  const orphanThreads = threads.filter((t) => {
    const r = t.find((c) => !c.parentId);
    return !r?.line;
  });

  // Keep line-comment anchors visible even while unchanged context is folded
  // (resolved roots included — see computeCommentLineIds). For range comments,
  // reveal the start and end lines so the hosted thread and its range endpoints
  // stay visible without expanding the whole file.
  const allContextExpanded = expandedByDefault || contextExpanded;

  function toggleFoldedContext() {
    setContextExpanded((prev) => !prev);
  }

  // Lines that need an inline host: union of lines with an open composer and
  // lines that have at least one threaded comment anchored to them. We only
  // depend on threads+composingLines (not on inner thread state) so the
  // host map is stable across resolution edits to existing threads.
  const inlineLines = useMemo(() => {
    const map = new Map<string, ComposingTarget>();
    for (const t of threads) {
      const root = t.find((c) => !c.parentId);
      if (!root?.line) continue;
      const side = (root.side ?? "new") as "old" | "new";
      const target: ComposingTarget = {
        line: root.line,
        side,
        endLine: root.endLine,
      };
      map.set(composingKey(target), target);
    }
    for (const target of composingLines) {
      map.set(composingKey(target), target);
    }
    return Array.from(map.entries());
  }, [threads, composingLines]);

  // Track the currently anchored range — driven by the URL hash. Browser
  // navigation fires `hashchange`; our own `setLineHash` helper
  // additionally dispatches `staff:hashchange` because
  // `history.replaceState` is silent. `startLine === endLine` for a
  // single-line anchor. This anchored range is the *only* thing that gets a
  // line highlight (painted via `data-anchored` below, on click/drag or a URL
  // anchor) — a comment on a line must NOT light it up.
  const [anchored, setAnchored] = useState<{
    side: "old" | "new";
    startLine: number;
    endLine: number;
  } | null>(null);

  /**
   * Resolve a click anywhere in a diff row to a (line, side) pair, sharing
   * the same fallback logic for inserted/deleted lines that the hover
   * resolver uses.
   */
  function resolveTargetFromCells(
    cells: HTMLTableCellElement[],
    clickedIdx: number,
  ): ComposingTarget | null {
    let preferred: "old" | "new";
    let oldCell: HTMLTableCellElement | undefined;
    let newCell: HTMLTableCellElement | undefined;
    if (cells.length >= 6) {
      preferred = clickedIdx <= 2 ? "old" : "new";
      oldCell = cells[0];
      newCell = cells[3];
    } else if (cells[0]?.dataset.staffUnifiedGutter === "true") {
      const gutter = cells[0];
      const primarySide = gutter.dataset.side === "old" ? "old" : "new";
      const primaryLine = Number(gutter.dataset.line ?? "");
      if (Number.isFinite(primaryLine) && primaryLine > 0) {
        return { line: primaryLine, side: primarySide };
      }
      const newNum = Number(gutter.dataset.newLine ?? "");
      if (Number.isFinite(newNum) && newNum > 0) return { line: newNum, side: "new" };
      const oldNum = Number(gutter.dataset.oldLine ?? "");
      if (Number.isFinite(oldNum) && oldNum > 0) return { line: oldNum, side: "old" };
      return null;
    } else if (cells.length >= 4) {
      preferred = clickedIdx === 0 ? "old" : "new";
      oldCell = cells[0];
      newCell = cells[1];
    } else {
      return null;
    }
    const oldNum = Number(oldCell?.textContent?.trim() ?? "");
    const newNum = Number(newCell?.textContent?.trim() ?? "");
    if (preferred === "new" && Number.isFinite(newNum) && newNum > 0) {
      return { line: newNum, side: "new" };
    }
    if (preferred === "old" && Number.isFinite(oldNum) && oldNum > 0) {
      return { line: oldNum, side: "old" };
    }
    if (Number.isFinite(newNum) && newNum > 0) return { line: newNum, side: "new" };
    if (Number.isFinite(oldNum) && oldNum > 0) return { line: oldNum, side: "old" };
    return null;
  }

  /**
   * If the given element is inside a line-number gutter cell (and not a
   * composer host row), return its side + line number. Used by the
   * mousedown/mouseover selection path to recognize anchor clicks.
   */
  function getLineNumberCell(el: HTMLElement): { side: "old" | "new"; line: number } | null {
    const td = el.closest("td") as HTMLTableCellElement | null;
    if (!td) return null;
    const tr = td.closest("tr") as HTMLElement | null;
    if (!tr || tr.dataset.composerHost === "true") return null;
    const cells = Array.from(tr.querySelectorAll<HTMLTableCellElement>(":scope > td"));
    const idx = cells.indexOf(td);
    let side: "old" | "new" | null = null;
    if (cells.length >= 6) {
      if (idx === 0) side = "old";
      else if (idx === 3) side = "new";
    } else if (td.dataset.staffUnifiedGutter === "true") {
      const unifiedSide = td.dataset.side === "old" ? "old" : "new";
      const unifiedLine = Number(td.dataset.line ?? "");
      if (Number.isFinite(unifiedLine) && unifiedLine > 0) {
        return { side: unifiedSide, line: unifiedLine };
      }
    } else if (cells.length >= 4) {
      if (idx === 0) side = "old";
      else if (idx === 1) side = "new";
    }
    if (!side) return null;
    const n = Number(td.textContent?.trim() ?? "");
    if (!Number.isFinite(n) || n <= 0) return null;
    return { side, line: n };
  }

  /**
   * Range-selection drag state: while the mouse is held down after a
   * line-number click, mouseover events extend the anchored range from
   * `startLine` to the line under the cursor (same side only). Cleared by
   * a window-level mouseup so drags survive leaving the diff container.
   */
  const dragRef = useRef<{ side: "old" | "new"; startLine: number } | null>(null);

  function handleDiffMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    if (target.closest("[data-staff-plus]")) return;
    const ln = getLineNumberCell(target);
    if (!ln) return;
    // Suppress text selection during a range drag.
    e.preventDefault();
    if (e.shiftKey && anchored && anchored.side === ln.side) {
      // Extend from the existing anchor's start to the clicked line.
      setLineHash(file.path, ln.side, anchored.startLine, ln.line);
      dragRef.current = { side: ln.side, startLine: anchored.startLine };
      return;
    }
    // Toggle off: clicking the same single-line anchor a second time
    // clears it, matching GitHub's behavior.
    if (
      anchored &&
      anchored.side === ln.side &&
      anchored.startLine === ln.line &&
      anchored.endLine === ln.line
    ) {
      clearLineHash();
      dragRef.current = null;
      return;
    }
    setLineHash(file.path, ln.side, ln.line);
    dragRef.current = { side: ln.side, startLine: ln.line };
  }

  function handleDiffMouseOver(e: React.MouseEvent<HTMLDivElement>) {
    if (!dragRef.current) {
      updatePlusFromTarget(e.target as HTMLElement);
      return;
    }
    // While dragging, extend the range based on whichever row the
    // cursor is over, not just gutter cells. The row's gutter on the
    // dragged side might be empty (e.g. a pure deletion when dragging
    // the new side) — in that case we walk forward through siblings
    // to the next row that does have a number on the dragged side,
    // then backward as a fallback. Forward-then-backward keeps the
    // selection extending past empty rows instead of contracting.
    const td = (e.target as HTMLElement).closest("td");
    if (!td) return;
    const tr = td.closest("tr") as HTMLElement | null;
    if (!tr || tr.dataset.composerHost === "true") return;
    const side = dragRef.current.side;
    const lineOnSide = (row: Element): number | null => {
      const cells = Array.from(row.querySelectorAll<HTMLTableCellElement>(":scope > td"));
      let cell: HTMLTableCellElement | undefined;
      if (cells.length >= 6) cell = side === "old" ? cells[0] : cells[3];
      else if (cells[0]?.dataset.staffUnifiedGutter === "true") {
        const raw = side === "old" ? cells[0].dataset.oldLine : cells[0].dataset.newLine;
        const n = Number(raw ?? "");
        return Number.isFinite(n) && n > 0 ? n : null;
      } else if (cells.length >= 4) cell = side === "old" ? cells[0] : cells[1];
      if (!cell) return null;
      const n = Number(cell.textContent?.trim() ?? "");
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    let endLine = lineOnSide(tr);
    if (endLine == null) {
      for (let n: Element | null = tr.nextElementSibling; n; n = n.nextElementSibling) {
        const v = lineOnSide(n);
        if (v != null) {
          endLine = v;
          break;
        }
      }
    }
    if (endLine == null) {
      for (let p: Element | null = tr.previousElementSibling; p; p = p.previousElementSibling) {
        const v = lineOnSide(p);
        if (v != null) {
          endLine = v;
          break;
        }
      }
    }
    if (endLine == null) return;
    setLineHash(file.path, side, dragRef.current.startLine, endLine);
  }

  useEffect(() => {
    const end = () => {
      dragRef.current = null;
    };
    window.addEventListener("mouseup", end);
    return () => window.removeEventListener("mouseup", end);
  }, []);

  // Hover-tracked "+" button — a real React element so clicks can open the
  // composer (the CSS pseudo we used before swallowed clicks).
  const [plus, setPlus] = useState<{
    line: number;
    side: "old" | "new";
    top: number;
    left: number;
  } | null>(null);
  const lastHoveredTr = useRef<HTMLElement | null>(null);
  const plusKeyRef = useRef<string | null>(null);
  // Pre-geometry anchor signature of the last accepted move: the resolved
  // gutter cell (node identity) + side + line. `onMouseMove` is on the diff
  // container and fires per pixel, so we use this to bail *before* any forced
  // `getBoundingClientRect` reads while the cursor stays anchored to the same
  // line — restoring the hot-path early-out the `handleDiffMouseMove`→
  // `updatePlusFromTarget` refactor dropped. We key on the gutter cell rather
  // than the `<tr>` so moving between the two gutters of a split row (which
  // resolves to a different side/line) still re-anchors.
  const lastPlusAnchor = useRef<{
    cell: HTMLTableCellElement;
    side: "old" | "new";
    line: number;
  } | null>(null);
  function clearPlus() {
    plusKeyRef.current = null;
    lastPlusAnchor.current = null;
    setPlus(null);
  }
  function updatePlusFromTarget(target: HTMLElement) {
    const td = target.closest("td");
    if (!td) return;
    const tr = td.closest("tr") as HTMLElement | null;
    if (!tr) {
      lastHoveredTr.current = null;
      clearPlus();
      return;
    }
    if (tr.dataset.composerHost === "true") {
      lastHoveredTr.current = null;
      // Moving onto an inline composer/thread host has no "+" of its own, so
      // clear the one left on the previously-hovered data row (mirrors the
      // `!tr` branch above) instead of leaving it stuck.
      clearPlus();
      return;
    }
    lastHoveredTr.current = tr;
    const cells = Array.from(tr.querySelectorAll<HTMLTableCellElement>(":scope > td"));
    const idx = cells.indexOf(td as HTMLTableCellElement);
    if (idx < 0) return;
    const resolved = resolveTargetFromCells(cells, idx);
    if (!resolved) {
      clearPlus();
      return;
    }
    // Pick the gutter cell for the resolved side so we can anchor the "+".
    let gutterCell: HTMLTableCellElement | undefined;
    let markerCell: HTMLTableCellElement | undefined;
    if (cells.length >= 6) {
      gutterCell = resolved.side === "old" ? cells[0] : cells[3];
      markerCell = resolved.side === "old" ? cells[1] : cells[4];
    } else if (cells[0]?.dataset.staffUnifiedGutter === "true") {
      gutterCell = cells[0];
      markerCell = cells[1];
    } else if (cells.length >= 4) {
      gutterCell = resolved.side === "old" ? cells[0] : cells[1];
      markerCell = cells[2];
    }
    if (!gutterCell || !diffRef.current) return;
    // Hot-path early-out: the cursor is still over the same resolved anchor as
    // the last accepted move and a "+" is already shown, so its geometry can't
    // have changed within this continuous mousemove. Bail before the forced
    // layout reads below. (Layout shifts from scroll/resize re-run the gutter
    // normalization, and the next move re-anchors — same staleness window the
    // original `tr === lastHoveredTr.current && plus` guard had.)
    const prevAnchor = lastPlusAnchor.current;
    if (
      plus &&
      prevAnchor &&
      prevAnchor.cell === gutterCell &&
      prevAnchor.side === resolved.side &&
      prevAnchor.line === resolved.line
    ) {
      return;
    }
    lastPlusAnchor.current = { cell: gutterCell, side: resolved.side, line: resolved.line };
    const containerRect = diffRef.current.getBoundingClientRect();
    const cellRect = gutterCell.getBoundingClientRect();
    const markerRect = markerCell?.getBoundingClientRect();
    // Anchor the "+" vertically to the line-number text, not the cell's
    // center — on a wrapped line the cell grows tall, and centering on
    // it would drop the "+" into the middle of the wrapped content.
    // The <pre> holding the line number is always a single line pinned
    // to the top of the cell.
    const numEl = gutterCell.querySelector("pre") ?? gutterCell;
    const numRect = numEl.getBoundingClientRect();
    const nextPlus = {
      line: resolved.line,
      side: resolved.side,
      top: numRect.top - containerRect.top + numRect.height / 2,
      left: markerRect
        ? markerRect.left -
          containerRect.left +
          markerRect.width / 2 -
          4 +
          diffRef.current.scrollLeft
        : cellRect.right - containerRect.left + diffRef.current.scrollLeft,
    };
    const nextKey = `${nextPlus.side}:${nextPlus.line}:${Math.round(nextPlus.top)}:${Math.round(nextPlus.left)}`;
    if (plusKeyRef.current === nextKey) return;
    plusKeyRef.current = nextKey;
    setPlus(nextPlus);
  }
  function handleDiffMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    updatePlusFromTarget(e.target as HTMLElement);
  }
  function handleDiffMouseLeave() {
    lastHoveredTr.current = null;
    clearPlus();
  }
  function openComposerAt(t: ComposingTarget) {
    setComposingLines((prev) =>
      prev.some((x) => composingKey(x) === composingKey(t)) ? prev : [...prev, t],
    );
  }

  useEffect(() => {
    const apply = () => {
      const parsed = parseLineHash(window.location.hash);
      setAnchored(
        parsed && parsed.file === file.path
          ? { side: parsed.side, startLine: parsed.startLine, endLine: parsed.endLine }
          : null,
      );
    };
    apply();
    window.addEventListener("hashchange", apply);
    window.addEventListener("staff:hashchange", apply);
    return () => {
      window.removeEventListener("hashchange", apply);
      window.removeEventListener("staff:hashchange", apply);
    };
  }, [file.path]);

  // Honor the URL fragment on initial mount or true browser-driven
  // hashchange — scroll to the start of the anchored range so share
  // links land in the right place. Skip when `staff:hashchange` fires
  // (it's a click on our own line numbers; the user is already looking
  // at it).
  // biome-ignore lint/correctness/useExhaustiveDependencies: File content changes remount/redraw the third-party diff table and should re-apply the current hash anchor.
  useEffect(() => {
    if (collapsed) return;
    const apply = () => {
      const parsed = parseLineHash(window.location.hash);
      if (parsed && parsed.file === file.path) {
        scrollToLine(parsed.file, parsed.side, parsed.startLine);
      }
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, [collapsed, file.path, file.oldContent, file.newContent]);

  const diffRows = useMemo(
    () => buildDiffRows(file, structuredHighlighting),
    [file, structuredHighlighting],
  );
  const inlineTargetMap = useMemo(() => new Map(inlineLines), [inlineLines]);
  const forceVisibleLines = useMemo(
    () =>
      new Set(inlineLines.map(([, target]) => `${target.side}:${target.endLine ?? target.line}`)),
    [inlineLines],
  );
  const diffItems = useMemo(
    () => buildVisibleDiffItems(diffRows, allContextExpanded, forceVisibleLines),
    [diffRows, allContextExpanded, forceVisibleLines],
  );
  const [xScrollable, setXScrollable] = useState(false);
  const scrollResetKeyRef = useRef("");

  useLayoutEffect(() => {
    const scrollResetKey = [
      file.path,
      file.status,
      file.oldContent.length,
      file.newContent.length,
      splitView ? "split" : "unified",
      wrapLines ? "wrap" : "nowrap",
      collapsed ? "collapsed" : "open",
    ].join("\0");
    if (scrollResetKeyRef.current === scrollResetKey) return;
    scrollResetKeyRef.current = scrollResetKey;
    const container = diffRef.current;
    if (!container) return;
    container.scrollLeft = 0;
    container.style.setProperty("--staff-code-fold-left", `${container.clientWidth / 2}px`);
    plusKeyRef.current = null;
    lastPlusAnchor.current = null;
    setPlus(null);
  });

  useLayoutEffect(() => {
    const container = diffRef.current;
    if (!container || collapsed || wrapLines || file.isSymlink || file.isBinary) {
      container?.style.removeProperty("--staff-code-fold-left");
      setXScrollable(false);
      return;
    }

    let frame = 0;
    const measure = () => {
      frame = 0;
      container.style.setProperty(
        "--staff-code-fold-left",
        `${container.scrollLeft + container.clientWidth / 2}px`,
      );
      const next = container.scrollWidth - container.clientWidth > 1;
      setXScrollable((prev) => (prev === next ? prev : next));
    };
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(measure);
    };

    schedule();
    container.addEventListener("scroll", schedule, { passive: true });
    if (typeof ResizeObserver === "undefined") {
      return () => {
        container.removeEventListener("scroll", schedule);
        if (frame) window.cancelAnimationFrame(frame);
      };
    }
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    const table = container.querySelector("table");
    if (table) observer.observe(table);
    return () => {
      container.removeEventListener("scroll", schedule);
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [collapsed, file.isBinary, file.isSymlink, wrapLines]);

  function rowAnchored(row: DiffRow): boolean {
    if (!anchored) return false;
    const lo = Math.min(anchored.startLine, anchored.endLine);
    const hi = Math.max(anchored.startLine, anchored.endLine);
    const line = anchored.side === "old" ? row.oldLine : row.newLine;
    return line !== undefined && line >= lo && line <= hi;
  }

  function renderLineText(text: string, ranges: InlineRange[], change?: "added" | "removed") {
    const tokens =
      highlighter && lang !== "text"
        ? tokenizeLine(highlighter, text, lang, syntaxTheme)
        : [{ content: text }];
    const pieces: ReactNode[] = [];
    let offset = 0;
    let pieceIndex = 0;
    const activeRanges = mergeInlineRanges(ranges, text);

    for (const token of tokens) {
      let tokenOffset = 0;
      while (tokenOffset < token.content.length) {
        const absolute = offset + tokenOffset;
        const range = activeRanges.find(
          (candidate) => candidate.from <= absolute && absolute < candidate.to,
        );
        const nextRange = activeRanges.find((candidate) => candidate.from > absolute);
        const end = range
          ? Math.min(token.content.length, range.to - offset)
          : Math.min(
              token.content.length,
              nextRange ? nextRange.from - offset : token.content.length,
            );
        const textPart = token.content.slice(tokenOffset, end);
        const style = token.color ? { color: token.color } : undefined;
        const key = `${pieceIndex++}:${absolute}`;
        pieces.push(
          range && change ? (
            <span key={key} className={`staff-word-${change}`} style={style}>
              {textPart}
            </span>
          ) : (
            <span key={key} style={style}>
              {textPart}
            </span>
          ),
        );
        tokenOffset = end;
      }
      offset += token.content.length;
    }
    return pieces.length > 0 ? pieces : "\u00a0";
  }

  function inlineHostsForRow(row: DiffRow): [string, ComposingTarget][] {
    const hosts: [string, ComposingTarget][] = [];
    if (row.oldLine) {
      const key = `old:${row.oldLine}`;
      const target = inlineTargetMap.get(key);
      if (target) hosts.push([key, target]);
    }
    if (row.newLine) {
      const key = `new:${row.newLine}`;
      const target = inlineTargetMap.get(key);
      if (target) hosts.push([key, target]);
    }
    return hosts;
  }

  function renderInlineHost(key: string, target: ComposingTarget, colSpan: number) {
    const lineThread = rootByLine.get(key);
    const rootThread = lineThread?.find((c) => !c.parentId);
    const hasComposer = composingLines.some((t) => composingKey(t) === key);
    if (!lineThread && !hasComposer) return null;
    return (
      <tr key={`host:${key}`} data-composer-host="true">
        <td colSpan={colSpan}>
          <div data-thread-id={rootThread?.threadId} className="space-y-3 p-3">
            {lineThread && <CommentThread slug={slug} comments={lineThread} onChange={onChange} />}
            {hasComposer && (
              <NewCommentEditor
                slug={slug}
                file={file.path}
                line={target.line}
                endLine={target.endLine}
                side={target.side}
                onPosted={() => {
                  closeComposer(target);
                  onChange?.();
                }}
                onCancel={() => closeComposer(target)}
              />
            )}
          </div>
        </td>
      </tr>
    );
  }

  function renderGutterCell(
    side: "old" | "new",
    line: number | undefined,
    status: "added" | "removed" | undefined,
    unified = false,
    label?: string,
    oldLine?: number,
    newLine?: number,
  ) {
    const primaryLine = label ?? (line ? String(line) : "");
    return (
      <td
        className={cn(
          "staff-gutter",
          side === "old" ? "staff-gutter-old" : "staff-gutter-new",
          unified && "staff-gutter-unified",
          status === "added" && "diff-added",
          status === "removed" && "diff-removed",
        )}
        data-side={side}
        data-line={line}
        data-old-line={oldLine}
        data-new-line={newLine}
        data-staff-unified-gutter={unified ? "true" : undefined}
      >
        <pre>{primaryLine}</pre>
      </td>
    );
  }

  function renderMarkerCell(side: "old" | "new") {
    return (
      <td
        className={cn("staff-marker", side === "old" ? "staff-marker-old" : "staff-marker-new")}
      />
    );
  }

  function renderContentCell(
    text: string | undefined,
    ranges: InlineRange[],
    status: "added" | "removed" | undefined,
  ) {
    return (
      <td
        className={cn(
          "staff-content react-diff-content",
          status === "added" && "diff-added",
          status === "removed" && "diff-removed",
          text === undefined && "empty-line",
        )}
      >
        <pre className="staff-content-text react-diff-content-text">
          {text === undefined
            ? "\u00a0"
            : renderLineText(
                text,
                ranges,
                status === "added" ? "added" : status === "removed" ? "removed" : undefined,
              )}
        </pre>
      </td>
    );
  }

  function renderFold(item: Extract<DiffItem, { type: "fold" }>, colSpan: number) {
    return (
      <tr key={item.key} className="react-diff-code-fold code-fold">
        <td colSpan={colSpan}>
          <button
            type="button"
            className="react-diff-code-fold-expand-button code-fold-expand-button"
            onClick={() => setContextExpanded(true)}
            data-testid={`fold-block-${file.path}`}
          >
            <span className="inline-flex items-center gap-1.5">
              <UnfoldVertical className="h-3 w-3" />
              {item.count} unchanged line{item.count === 1 ? "" : "s"}
            </span>
          </button>
        </td>
      </tr>
    );
  }

  function renderColGroup() {
    if (splitView) {
      return (
        <colgroup>
          <col className="staff-col-gutter" />
          <col className="staff-col-marker" />
          <col className="staff-col-content staff-col-content-old" />
          <col className="staff-col-gutter" />
          <col className="staff-col-marker" />
          <col className="staff-col-content staff-col-content-new" />
        </colgroup>
      );
    }
    return (
      <colgroup>
        <col className="staff-col-gutter" />
        <col className="staff-col-marker" />
        <col className="staff-col-content" />
      </colgroup>
    );
  }

  function renderSplitRow(row: DiffRow) {
    const oldStatus = row.kind === "removed" || row.kind === "changed" ? "removed" : undefined;
    const newStatus = row.kind === "added" || row.kind === "changed" ? "added" : undefined;
    const hostRows = inlineHostsForRow(row).map(([key, target]) =>
      renderInlineHost(key, target, 6),
    );
    return [
      <tr
        key={row.key}
        className="react-diff-line"
        data-anchored={rowAnchored(row) ? "true" : undefined}
      >
        {renderGutterCell("old", row.oldLine, oldStatus)}
        {renderMarkerCell("old")}
        {renderContentCell(row.oldText, row.oldRanges, oldStatus)}
        {renderGutterCell("new", row.newLine, newStatus)}
        {renderMarkerCell("new")}
        {renderContentCell(row.newText, row.newRanges, newStatus)}
      </tr>,
      ...hostRows,
    ];
  }

  function renderUnifiedRow(row: DiffRow) {
    const rows: ReactNode[] = [];
    if (row.oldText !== undefined && (row.kind === "removed" || row.kind === "changed")) {
      const oldOnlyRow: DiffRow =
        row.kind === "changed" ? { ...row, newLine: undefined, newText: undefined } : row;
      rows.push(
        <tr
          key={`${row.key}:old`}
          className="react-diff-line"
          data-anchored={rowAnchored(oldOnlyRow) ? "true" : undefined}
        >
          {renderGutterCell("old", row.oldLine, "removed", true, "-", row.oldLine, undefined)}
          {renderMarkerCell("old")}
          {renderContentCell(row.oldText, row.oldRanges, "removed")}
        </tr>,
      );
      for (const [key, target] of inlineHostsForRow(oldOnlyRow)) {
        rows.push(renderInlineHost(key, target, 3));
      }
    }
    if (row.newText !== undefined) {
      const status = row.kind === "added" || row.kind === "changed" ? "added" : undefined;
      const newOnlyRow: DiffRow =
        row.kind === "changed" ? { ...row, oldLine: undefined, oldText: undefined } : row;
      rows.push(
        <tr
          key={`${row.key}:new`}
          className="react-diff-line"
          data-anchored={rowAnchored(newOnlyRow) ? "true" : undefined}
        >
          {renderGutterCell("new", row.newLine, status, true, undefined, undefined, row.newLine)}
          {renderMarkerCell("new")}
          {renderContentCell(row.newText, row.newRanges, status)}
        </tr>,
      );
      for (const [key, target] of inlineHostsForRow(newOnlyRow)) {
        rows.push(renderInlineHost(key, target, 3));
      }
    }
    return rows;
  }

  return (
    <div
      className="rounded-lg border border-border bg-card overflow-hidden"
      data-testid={`file-card-${file.path}`}
    >
      <div
        className={cn(
          "flex items-center gap-2 bg-muted/40 px-3 py-2",
          !collapsed && "border-b border-border",
        )}
      >
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={collapsed ? "Expand file" : "Collapse file"}
          aria-expanded={!collapsed}
          title={collapsed ? "Expand" : "Collapse"}
          onClick={toggleCollapsed}
          data-testid={`collapse-${file.path}`}
        >
          {collapsed ? (
            <ChevronRight className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
        </Button>
        {statusIcon(file.status)}
        <span className="min-w-0 truncate font-mono text-sm" title={file.path}>
          {file.path}
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={pathCopied ? "Path copied" : "Copy file path"}
          title={pathCopied ? "Copied!" : "Copy path"}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(file.path);
              setPathCopied(true);
              window.setTimeout(() => setPathCopied(false), 1200);
            } catch {}
          }}
          data-testid={`copy-path-${file.path}`}
        >
          {pathCopied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
        </Button>
        {canToggleFoldedContext && !collapsed && (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={allContextExpanded ? "Fold unchanged context" : "Expand unchanged context"}
            aria-expanded={allContextExpanded}
            title={allContextExpanded ? "Fold unchanged context" : "Expand unchanged context"}
            onClick={toggleFoldedContext}
            data-testid={`fold-context-${file.path}`}
          >
            {allContextExpanded ? (
              <FoldVertical className="h-3.5 w-3.5" />
            ) : (
              <UnfoldVertical className="h-3.5 w-3.5" />
            )}
          </Button>
        )}
        {file.oldPath && file.oldPath !== file.path && (
          <span className="text-xs text-muted-foreground font-mono">← {file.oldPath}</span>
        )}
        {threads.length > 0 && (
          <Badge variant="muted" className="ml-1">
            {threads.length} thread{threads.length === 1 ? "" : "s"}
          </Badge>
        )}
        <div className="flex-1" />
        <div className="flex shrink-0 items-center gap-2.5">
          {hasChangeStats && (
            <span
              className="flex items-center gap-1 font-mono text-xs"
              title={`${changeStats.additions} additions, ${changeStats.deletions} deletions`}
              data-testid={`file-change-stats-${file.path}`}
            >
              {changeStats.additions > 0 && (
                <span className="text-success">+{changeStats.additions}</span>
              )}
              {changeStats.deletions > 0 && (
                <span className="text-destructive">-{changeStats.deletions}</span>
              )}
            </span>
          )}
          <Badge variant="outline" className="capitalize">
            {file.status}
          </Badge>
        </div>
      </div>

      {/* Symlinks render a compact target row instead of the file content —
       * the content is just the (followed) link target and would be noise.
       * Matches how GitHub shows a symlink in a diff. */}
      {!collapsed && file.isSymlink && (
        <div
          className="flex items-center gap-2 px-3 py-2.5 text-sm font-mono"
          data-testid={`symlink-panel-${file.path}`}
        >
          <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground">Symlink →</span>
          <span className="text-foreground">{file.symlinkTarget || "(unresolved)"}</span>
          {file.oldSymlinkTarget && file.oldSymlinkTarget !== file.symlinkTarget && (
            <span className="text-muted-foreground">
              (was <span className="line-through">{file.oldSymlinkTarget}</span>)
            </span>
          )}
        </div>
      )}

      {/* Binary blobs (images, etc.) can't be rendered as a text diff. */}
      {!collapsed && !file.isSymlink && file.isBinary && (
        <div
          className="flex items-center gap-2 px-3 py-2.5 text-sm"
          data-testid={`binary-panel-${file.path}`}
        >
          <Binary className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground">Binary file not shown</span>
        </div>
      )}

      {!collapsed && !file.isSymlink && !file.isBinary && (
        // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithMouseEvents: Mouse handlers target third-party diff rows for line selection and hover state.
        <div
          className={cn(
            "staff-diff relative",
            splitView ? "staff-diff-split" : "staff-diff-unified",
            expandedByDefault ? "staff-diff-expanded" : "staff-diff-collapsed",
            !wrapLines && "staff-diff-nowrap",
            xScrollable && "staff-diff-xscroll",
          )}
          ref={diffRef}
          onMouseDown={handleDiffMouseDown}
          onMouseOver={handleDiffMouseOver}
          onMouseMove={handleDiffMouseMove}
          onMouseLeave={handleDiffMouseLeave}
        >
          <table>
            {renderColGroup()}
            <tbody>
              {diffItems.flatMap((item) => {
                if (item.type === "fold") return [renderFold(item, splitView ? 6 : 3)];
                return splitView ? renderSplitRow(item.row) : renderUnifiedRow(item.row);
              })}
            </tbody>
          </table>
          {plus && (
            <button
              type="button"
              data-staff-plus
              aria-label={`Comment on line ${plus.line}`}
              title="Comment on this line"
              onClick={(e) => {
                e.stopPropagation();
                lastHoveredTr.current = null;
                clearPlus();
                // If the hovered line falls inside the active anchored
                // range on the same side, attach the comment to the
                // whole range (rendered at endLine). Otherwise it's a
                // single-line comment on the hovered line.
                if (
                  anchored &&
                  anchored.side === plus.side &&
                  anchored.startLine !== anchored.endLine &&
                  plus.line >= anchored.startLine &&
                  plus.line <= anchored.endLine
                ) {
                  openComposerAt({
                    line: anchored.startLine,
                    side: plus.side,
                    endLine: anchored.endLine,
                  });
                } else {
                  openComposerAt({ line: plus.line, side: plus.side });
                }
              }}
              style={{ top: plus.top, left: plus.left }}
              className="absolute z-20 -translate-x-1/2 -translate-y-1/2 w-[22px] h-[22px] flex items-center justify-center rounded-md bg-primary text-primary-foreground shadow-md hover:opacity-90 transition-opacity"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}

      {!collapsed && orphanThreads.length > 0 && (
        <div className="border-t border-border bg-muted/30 p-3 space-y-3">
          {orphanThreads.map((threadComments) => (
            <CommentThread
              key={threadComments[0]!.threadId}
              slug={slug}
              comments={threadComments}
              context="file comment"
              onChange={onChange}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function DiffView({
  files,
  slug,
  comments,
  splitView,
  themeMode,
  syntaxTheme,
  structuredHighlighting = true,
  wrapLines = true,
  expandedByDefault = true,
  onChange,
}: {
  files: FileDiff[];
  slug: string;
  comments: Comment[];
  splitView: boolean;
  themeMode: "light" | "dark";
  syntaxTheme?: string;
  structuredHighlighting?: boolean;
  wrapLines?: boolean;
  expandedByDefault?: boolean;
  onChange?: () => void;
}) {
  const resolvedSyntaxTheme = syntaxTheme ?? shikiThemeFor(themeMode);
  // Decide up front which files start collapsed so a large diff doesn't mount
  // every rendered file table at once (see computeAutoCollapsed).
  //
  // The expensive part — splitting every file's content to count its lines —
  // only depends on `files`, so memoize it there. Comments arrive far more
  // often than files change; re-splitting the whole (large) diff on every
  // comment add/resolve/refresh would be wasted work, since the budget walk
  // itself is just arithmetic.
  const lineCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const f of files) map.set(f.path, fileLineCount(f));
    return map;
  }, [files]);
  const activeCommentedPaths = useMemo(() => computeActiveCommentedPaths(comments), [comments]);
  const autoCollapsed = useMemo(
    () => computeAutoCollapsed(files, activeCommentedPaths, lineCounts),
    [files, activeCommentedPaths, lineCounts],
  );
  if (files.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
        No changes between these targets.
      </div>
    );
  }
  return (
    <div className="space-y-6">
      {files.map((f) => (
        <DiffFile
          key={f.path}
          file={f}
          slug={slug}
          comments={comments}
          splitView={splitView}
          syntaxTheme={resolvedSyntaxTheme}
          structuredHighlighting={structuredHighlighting}
          wrapLines={wrapLines}
          expandedByDefault={expandedByDefault}
          autoCollapsed={autoCollapsed.has(f.path)}
          onChange={onChange}
        />
      ))}
    </div>
  );
}
