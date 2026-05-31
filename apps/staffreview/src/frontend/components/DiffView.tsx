import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactDiffViewer, { DiffMethod } from "react-diff-viewer-continued";
import type { Highlighter } from "shiki";
import {
  Binary,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileCode2,
  FileMinus2,
  FilePlus2,
  Link2,
  Plus,
} from "lucide-react";
import type { Comment, FileDiff } from "../../types.ts";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { CommentThread, NewCommentEditor } from "./CommentThread.tsx";
import { cn } from "../lib/utils.ts";
import { getHighlighter, langForPath, shikiThemeFor, tokenizeLine } from "../lib/highlight.ts";

function statusIcon(s: FileDiff["status"]) {
  if (s === "added") return <FilePlus2 className="h-4 w-4 text-success" />;
  if (s === "deleted") return <FileMinus2 className="h-4 w-4 text-destructive" />;
  return <FileCode2 className="h-4 w-4 text-muted-foreground" />;
}

/**
 * Build the inline-style block we hand to react-diff-viewer-continued.
 * The library reads `variables.light` or `variables.dark` based on its
 * `useDarkTheme` prop, so we pre-compute one block for the active mode.
 * The diff-tint percentages are bumped on dark backgrounds where the
 * lower opacities would otherwise vanish into the page.
 */
function makeDiffStyles(mode: "light" | "dark") {
  const isDark = mode === "dark";
  const block = {
    diffViewerBackground: "var(--color-card)",
    diffViewerColor: "var(--color-card-foreground)",
    addedBackground: isDark
      ? "color-mix(in oklch, var(--color-success) 28%, transparent)"
      : "color-mix(in oklch, var(--color-success) 14%, transparent)",
    addedColor: "var(--color-foreground)",
    removedBackground: isDark
      ? "color-mix(in oklch, var(--color-destructive) 30%, transparent)"
      : "color-mix(in oklch, var(--color-destructive) 12%, transparent)",
    removedColor: "var(--color-foreground)",
    wordAddedBackground: isDark
      ? "color-mix(in oklch, var(--color-success) 55%, transparent)"
      : "color-mix(in oklch, var(--color-success) 36%, transparent)",
    wordRemovedBackground: isDark
      ? "color-mix(in oklch, var(--color-destructive) 55%, transparent)"
      : "color-mix(in oklch, var(--color-destructive) 30%, transparent)",
    addedGutterBackground: isDark
      ? "color-mix(in oklch, var(--color-success) 40%, transparent)"
      : "color-mix(in oklch, var(--color-success) 22%, transparent)",
    removedGutterBackground: isDark
      ? "color-mix(in oklch, var(--color-destructive) 40%, transparent)"
      : "color-mix(in oklch, var(--color-destructive) 22%, transparent)",
    gutterBackground: "var(--color-muted)",
    gutterBackgroundDark: "var(--color-muted)",
    highlightBackground: "color-mix(in oklch, var(--color-warning) 25%, transparent)",
    highlightGutterBackground: "color-mix(in oklch, var(--color-warning) 35%, transparent)",
    codeFoldGutterBackground: "var(--color-muted)",
    codeFoldBackground: "var(--color-muted)",
    emptyLineBackground: "var(--color-background)",
    gutterColor: "var(--color-muted-foreground)",
    addedGutterColor: "var(--color-foreground)",
    removedGutterColor: "var(--color-foreground)",
    codeFoldContentColor: "var(--color-muted-foreground)",
    diffViewerTitleBackground: "var(--color-muted)",
    diffViewerTitleColor: "var(--color-foreground)",
    diffViewerTitleBorderColor: "var(--color-border)",
  };
  return {
    variables: isDark ? { dark: block } : { light: block },
    line: { padding: "2px 4px" },
    contentText: { fontFamily: "var(--font-mono)" },
  } as const;
}

// Per-file collapse *overrides*: a map of path → collapsed?. Only files
// the user has explicitly toggled appear here; everything else follows
// the global "files expanded by default" setting. (Previously this was a
// flat Set of collapsed paths, which couldn't represent "explicitly
// expanded" when the default is collapsed.)
const COLLAPSE_OVERRIDES_KEY = "staff:file-collapse-overrides";

function loadCollapseOverrides(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSE_OVERRIDES_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? (obj as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function setCollapseOverride(path: string, collapsed: boolean) {
  try {
    const map = loadCollapseOverrides();
    map[path] = collapsed;
    localStorage.setItem(COLLAPSE_OVERRIDES_KEY, JSON.stringify(map));
  } catch {}
}

function groupCommentsByThread(comments: Comment[]) {
  const map = new Map<string, Comment[]>();
  for (const c of comments) {
    const list = map.get(c.threadId) ?? [];
    list.push(c);
    map.set(c.threadId, list);
  }
  return Array.from(map.values()).map((cs) => cs.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
}

/**
 * Find the <tr> in the rendered diff table whose line-number cell on the
 * given side matches `line`. Works for split view (6 cells per row, line
 * numbers at indices 0 and 3) and unified view (4 cells, line numbers at
 * 0 and 1).
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
    history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
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
 * react-diff-viewer-continued mounts its <table> across multiple frames
 * after a layout change.
 */
export function scrollToLine(file: string, side: "old" | "new", line: number) {
  window.dispatchEvent(
    new CustomEvent("staff:expand-file", { detail: { path: file } }),
  );
  const start = performance.now();
  const tick = () => {
    const card = document.querySelector(
      `[data-testid="file-card-${file.replace(/"/g, '\\"')}"]`,
    );
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

export function DiffFile({
  file,
  slug,
  comments,
  splitView,
  themeMode,
  syntaxTheme,
  expandedByDefault,
  onChange,
}: {
  file: FileDiff;
  slug: string;
  comments: Comment[];
  splitView: boolean;
  themeMode: "light" | "dark";
  syntaxTheme: string;
  expandedByDefault: boolean;
  onChange?: () => void;
}) {
  type ComposingTarget = { line: number; side: "old" | "new"; endLine?: number };
  /**
   * Inline composer hosts and existing threads are keyed by `(side, host
   * line)`. The host line is the visual position of the comment — for a
   * range, that's the END line (matching GitHub's convention of putting
   * the composer below the last line of the selection).
   */
  const composingKey = (t: ComposingTarget) => `${t.side}:${t.endLine ?? t.line}`;

  const [composingLines, setComposingLines] = useState<ComposingTarget[]>([]);
  const [pathCopied, setPathCopied] = useState(false);
  // Whole-card collapse (the header chevron) — independent of the
  // "expand unchanged context" setting below. Defaults to expanded; a
  // per-file toggle is remembered as an override.
  const [collapsed, setCollapsed] = useState<boolean>(
    () => loadCollapseOverrides()[file.path] ?? false,
  );
  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      setCollapseOverride(file.path, next);
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
          setCollapseOverride(file.path, false);
          return false;
        });
      }
    };
    window.addEventListener("staff:expand-file", handler);
    return () => window.removeEventListener("staff:expand-file", handler);
  }, [file.path]);
  const diffRef = useRef<HTMLDivElement>(null);
  // Host <td> elements (one per open composer), keyed by `${side}:${line}`.
  // Ref-backed so DOM and host map stay in sync inside useLayoutEffect; a
  // version counter triggers re-renders so the portals pick up changes.
  const hostsRef = useRef<Map<string, HTMLElement>>(new Map());
  const [, bumpHostsVersion] = useReducer((n: number) => n + 1, 0);
  const [highlighter, setHighlighter] = useState<Highlighter | null>(null);
  useEffect(() => {
    let cancelled = false;
    getHighlighter().then((h) => {
      if (!cancelled) setHighlighter(h);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const lang = useMemo(() => langForPath(file.path), [file.path]);

  const closeComposer = (target: ComposingTarget) => {
    setComposingLines((prev) =>
      prev.filter((t) => composingKey(t) !== composingKey(target)),
    );
  };

  const renderContent = useMemo(() => {
    if (!highlighter || lang === "text") return undefined;
    return (source: string) => {
      // `source` is the text of a line (or a word-diff chunk). Shiki
      // tokenizes it as a single line; multi-line constructs (block
      // comments / template literals) lose continuity but for line-by-
      // line diff this is the accepted trade-off.
      const tokens = tokenizeLine(highlighter, source, lang, syntaxTheme as any);
      return (
        <span>
          {tokens.map((t, i) => (
            <span key={i} style={t.color ? { color: t.color } : undefined}>{t.content}</span>
          ))}
        </span>
      );
    };
  }, [highlighter, lang, syntaxTheme]);

  const diffStyles = useMemo(() => makeDiffStyles(themeMode), [themeMode]);

  const fileComments = useMemo(
    () => comments.filter((c) => c.file === file.path),
    [comments, file.path],
  );
  const threads = useMemo(() => groupCommentsByThread(fileComments), [fileComments]);
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

  // Sync `hostsRef` with `inlineLines`: ensure exactly one <tr> host exists
  // immediately after each line that has any inline content (threads and/or
  // a composer). Hosts whose key is no longer wanted are removed.
  useLayoutEffect(() => {
    // When the file is collapsed the diff div is unmounted; drop our hosts
    // so the next expand starts from a clean slate.
    if (collapsed) {
      hostsRef.current.clear();
      bumpHostsVersion();
      return;
    }
    const container = diffRef.current;
    if (!container) return;

    // Place a host row after every wanted line and tear down stale ones.
    // `findRowForLine` only sees currently-rendered rows. A host can be missing
    // because the row isn't rendered yet (react-diff-viewer renders, and
    // expands files via `hasLineComments`, across several async frames) OR
    // because a re-render swapped in fresh <tr> nodes and orphaned a host we
    // injected. Treat a disconnected host the same as a missing one and
    // recreate it — otherwise the thread's portal points at a detached <td>
    // and the comment shows only in the sidebar. We retry on a frame budget
    // (below) until everything is placed and connected.
    const placeHosts = (): boolean => {
      const desired = new Set(inlineLines.map(([k]) => k));
      let changed = false;
      let allPlaced = true;

      for (const [key, host] of Array.from(hostsRef.current.entries())) {
        if (desired.has(key)) continue;
        const tr = host.parentElement as HTMLElement | null;
        if (tr) {
          const targetTr = tr.previousElementSibling as HTMLElement | null;
          if (targetTr?.dataset) delete targetTr.dataset.composing;
          tr.remove();
        }
        hostsRef.current.delete(key);
        changed = true;
      }

      for (const [key, target] of inlineLines) {
        let host = hostsRef.current.get(key);
        let targetTr: HTMLElement | null = null;
        const hostLine = target.endLine ?? target.line;
        if (host?.isConnected) {
          targetTr = host.parentElement?.previousElementSibling as HTMLElement | null;
        } else {
          targetTr = findRowForLine(container, { line: hostLine, side: target.side });
          if (!targetTr) {
            allPlaced = false;
            continue;
          }
          const tr = document.createElement("tr");
          tr.dataset.composerHost = "true";
          const td = document.createElement("td");
          td.colSpan = targetTr.children.length;
          td.style.setProperty("padding", "0", "important");
          td.style.background = "var(--color-muted)";
          td.style.borderTop = "1px solid var(--color-border)";
          td.style.borderBottom = "1px solid var(--color-border)";
          tr.appendChild(td);
          targetTr.after(tr);
          host = td;
          hostsRef.current.set(key, td); // replaces any orphaned host for this key
          changed = true;
        }
        // Keep the source-row `composing` attribute in sync with whether a
        // composer is *currently* open on this line — hosts can outlive
        // composers (because of existing threads on the same line).
        if (targetTr) {
          if (composingLines.some((t) => t.line === target.line && t.side === target.side)) {
            targetTr.dataset.composing = target.side;
          } else {
            delete targetTr.dataset.composing;
          }
        }
      }

      if (changed) bumpHostsVersion();
      return allPlaced;
    };

    placeHosts();
    // Nothing to anchor → no need to keep polling.
    if (inlineLines.length === 0) return;

    // Re-run on a frame budget so hosts land once the library finishes its
    // async (re)render — and get re-placed if a later render orphans them
    // (e.g. the expand triggered by hasLineComments swaps the rows out). Once
    // everything is placed and connected, `placeHosts` is a passive no-op, so
    // this doesn't fight the library's own row rendering the way a live
    // MutationObserver did. ~3s matches scrollToLine's polling budget.
    let raf = 0;
    let stable = 0;
    const deadline = performance.now() + 3000;
    const tick = () => {
      raf = 0;
      // Stop once placement has held steady for a few frames (enough to absorb
      // the library's async render / expand) — or the budget runs out. A
      // re-placement (a late detach) resets the counter so it still gets
      // repaired within the window instead of burning the whole 3s every time.
      stable = placeHosts() ? stable + 1 : 0;
      if (stable < 10 && performance.now() < deadline) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [collapsed, inlineLines, composingLines, splitView, file.oldContent, file.newContent]);

  // Track the currently anchored range — driven by the URL hash. Browser
  // navigation fires `hashchange`; our own `setLineHash` helper
  // additionally dispatches `staff:hashchange` because
  // `history.replaceState` is silent. `startLine === endLine` for a
  // single-line anchor. This anchored range is the *only* thing that gets a
  // line highlight (painted via `data-anchored` below, on click/drag or a URL
  // anchor) — a comment on a line must NOT light it up.
  const [anchored, setAnchored] = useState<
    { side: "old" | "new"; startLine: number; endLine: number } | null
  >(null);

  // Does this file have any line-anchored comment thread? If so we render it
  // fully expanded (see `showDiffOnly` below) instead of folding unchanged
  // context. Folding hides the rows a comment is anchored to, and with them
  // the inline thread's host row — leaving the comment visible only in the
  // sidebar, even after the user unfolds by hand. react-diff-viewer's own
  // `alwaysShowLines` would be the surgical fix, but in this version toggling
  // it at runtime corrupts the virtualized render (the file goes blank), so we
  // expand the whole file instead — coarser, but reliable.
  const hasLineComments = useMemo(
    () => threads.some((t) => t.find((c) => !c.parentId)?.line != null),
    [threads],
  );

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
  function getLineNumberCell(
    el: HTMLElement,
  ): { side: "old" | "new"; line: number } | null {
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
    if (!dragRef.current) return;
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
      else if (cells.length >= 4) cell = side === "old" ? cells[0] : cells[1];
      if (!cell) return null;
      const n = Number(cell.textContent?.trim() ?? "");
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    let endLine = lineOnSide(tr);
    if (endLine == null) {
      for (let n: Element | null = tr.nextElementSibling; n; n = n.nextElementSibling) {
        const v = lineOnSide(n);
        if (v != null) { endLine = v; break; }
      }
    }
    if (endLine == null) {
      for (let p: Element | null = tr.previousElementSibling; p; p = p.previousElementSibling) {
        const v = lineOnSide(p);
        if (v != null) { endLine = v; break; }
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
  const [plus, setPlus] = useState<
    | { line: number; side: "old" | "new"; top: number; left: number }
    | null
  >(null);
  const lastHoveredTr = useRef<HTMLElement | null>(null);
  function handleDiffMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    const td = (e.target as HTMLElement).closest("td");
    if (!td) return;
    const tr = td.closest("tr") as HTMLElement | null;
    if (!tr || tr.dataset.composerHost === "true") {
      if (lastHoveredTr.current !== null) {
        lastHoveredTr.current = null;
        setPlus(null);
      }
      return;
    }
    if (tr === lastHoveredTr.current && plus) return;
    lastHoveredTr.current = tr;
    const cells = Array.from(tr.querySelectorAll<HTMLTableCellElement>(":scope > td"));
    const idx = cells.indexOf(td as HTMLTableCellElement);
    if (idx < 0) return;
    const resolved = resolveTargetFromCells(cells, idx);
    if (!resolved) {
      setPlus(null);
      return;
    }
    // Pick the gutter cell for the resolved side so we can anchor the "+".
    let gutterCell: HTMLTableCellElement | undefined;
    if (cells.length >= 6) gutterCell = resolved.side === "old" ? cells[0] : cells[3];
    else if (cells.length >= 4) gutterCell = resolved.side === "old" ? cells[0] : cells[1];
    if (!gutterCell || !diffRef.current) return;
    const containerRect = diffRef.current.getBoundingClientRect();
    const cellRect = gutterCell.getBoundingClientRect();
    // Anchor the "+" vertically to the line-number text, not the cell's
    // center — on a wrapped line the cell grows tall, and centering on
    // it would drop the "+" into the middle of the wrapped content.
    // The <pre> holding the line number is always a single line pinned
    // to the top of the cell.
    const numEl = gutterCell.querySelector("pre") ?? gutterCell;
    const numRect = numEl.getBoundingClientRect();
    setPlus({
      line: resolved.line,
      side: resolved.side,
      top: numRect.top - containerRect.top + numRect.height / 2,
      left: cellRect.right - containerRect.left,
    });
  }
  function handleDiffMouseLeave() {
    lastHoveredTr.current = null;
    setPlus(null);
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

  // Paint each row in the anchored range with `data-anchored`. The diff
  // `<table>` is owned by react-diff-viewer-continued, so we can't pass
  // a prop on a specific <tr> — we mark them in the DOM. The library
  // re-renders its rows on lots of things (Shiki tokens arriving, font
  // size changes, threads updating, etc.), and each re-render swaps in
  // new <tr> nodes without our attribute, so we keep a
  // MutationObserver alive for the whole effect lifetime and re-mark
  // on every childList change. The observer's `childList`/`subtree`
  // config doesn't watch attribute mutations, so our own
  // `dataset.anchored` writes don't re-trigger it.
  useLayoutEffect(() => {
    if (collapsed || !diffRef.current) return;
    const container = diffRef.current;
    const clear = () => {
      container.querySelectorAll('[data-anchored="true"]').forEach((el) => {
        (el as HTMLElement).removeAttribute("data-anchored");
      });
    };
    if (!anchored) {
      clear();
      return;
    }
    const lo = Math.min(anchored.startLine, anchored.endLine);
    const hi = Math.max(anchored.startLine, anchored.endLine);
    // In split view a pure deletion row has no new-side line number
    // (and a pure addition has no old-side line number), so iterating
    // line-by-line through the range and looking each up would skip
    // those rows even when they're spatially inside the selection.
    // Walk the DOM from the start row to the end row instead — that
    // marks every <tr> between them, including any interspersed
    // deletions/additions/context.
    const apply = () => {
      clear();
      const startRow = findRowForLine(container, { line: lo, side: anchored.side });
      const endRow = findRowForLine(container, { line: hi, side: anchored.side });
      if (!startRow) return;
      let row: HTMLElement | null = startRow;
      while (row) {
        row.dataset.anchored = "true";
        if (row === endRow) break;
        row = row.nextElementSibling as HTMLElement | null;
      }
    };
    apply();
    const observer = new MutationObserver(() => apply());
    observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [anchored, collapsed, splitView, file.oldContent, file.newContent]);

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
        <span className="font-mono text-sm">{file.path}</span>
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
          {pathCopied ? (
            <Check className="h-3 w-3 text-success" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
        </Button>
        {file.oldPath && file.oldPath !== file.path && (
          <span className="text-xs text-muted-foreground font-mono">← {file.oldPath}</span>
        )}
        {fileComments.length > 0 && (
          <Badge variant="muted" className="ml-1">
            {threads.length} thread{threads.length === 1 ? "" : "s"}
          </Badge>
        )}
        <div className="flex-1" />
        <Badge variant="outline" className="capitalize">{file.status}</Badge>
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
        <div
          className={cn(
            "staff-diff relative",
            splitView ? "staff-diff-split" : "staff-diff-unified",
            expandedByDefault ? "staff-diff-expanded" : "staff-diff-collapsed",
          )}
          ref={diffRef}
          onMouseDown={handleDiffMouseDown}
          onMouseOver={handleDiffMouseOver}
          onMouseMove={handleDiffMouseMove}
          onMouseLeave={handleDiffMouseLeave}
        >
          <ReactDiffViewer
            oldValue={file.oldContent}
            newValue={file.newContent}
            splitView={splitView}
            compareMethod={DiffMethod.WORDS}
            useDarkTheme={themeMode === "dark"}
            // When files aren't "expanded by default", fold unchanged
            // regions to just the changed hunks (+3 context lines). That
            // makes react-diff-viewer's expand/fold-all button in the
            // summary row functional. Fully-expanded mode shows the whole
            // file (and the button has nothing to do). We also force-expand
            // any file that has line comments so none of them are hidden in a
            // fold (see `hasLineComments`).
            showDiffOnly={!expandedByDefault && !hasLineComments}
            extraLinesSurroundingDiff={3}
            renderContent={renderContent}
            styles={diffStyles as any}
          />
          {plus && (
            <button
              type="button"
              data-staff-plus
              aria-label={`Comment on line ${plus.line}`}
              title="Comment on this line"
              onClick={(e) => {
                e.stopPropagation();
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

      {!collapsed && inlineLines.map(([key, target]) => {
        const host = hostsRef.current.get(key);
        if (!host) return null;
        const lineThread = rootByLine.get(key);
        const rootThread = lineThread?.find((c) => !c.parentId);
        const hasComposer = composingLines.some(
          (t) => composingKey(t) === key,
        );
        return createPortal(
          <div
            key={key}
            data-thread-id={rootThread?.threadId}
            className="space-y-3 p-3"
          >
            {lineThread && (
              <CommentThread
                slug={slug}
                comments={lineThread}
                onChange={onChange}
              />
            )}
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
          </div>,
          host,
        );
      })}

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
  expandedByDefault = true,
  onChange,
}: {
  files: FileDiff[];
  slug: string;
  comments: Comment[];
  splitView: boolean;
  themeMode: "light" | "dark";
  syntaxTheme?: string;
  expandedByDefault?: boolean;
  onChange?: () => void;
}) {
  const resolvedSyntaxTheme = syntaxTheme ?? shikiThemeFor(themeMode);
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
          themeMode={themeMode}
          syntaxTheme={resolvedSyntaxTheme}
          expandedByDefault={expandedByDefault}
          onChange={onChange}
        />
      ))}
    </div>
  );
}
