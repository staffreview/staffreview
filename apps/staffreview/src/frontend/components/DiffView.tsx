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
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import ReactDiffViewer, { DiffMethod } from "react-diff-viewer-continued";
import { createPortal } from "react-dom";
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

type DiffViewerHandle = {
  state?: {
    expandedBlocks?: number[];
    computedDiffResult?: Record<string, { blocks?: { index: number }[] }>;
  };
  setState?: (state: { expandedBlocks: number[] }, callback?: () => void) => void;
};

/**
 * The block list react-diff-viewer-continued computed for the *currently
 * rendered* inputs. The library keys `computedDiffResult` by `getMemoisedKey()`
 * — a `JSON.stringify` of the diff-shaping props — and never evicts entries, so
 * picking `Object.values(...).at(-1)` (the most-recently-*inserted* entry) is
 * only correct while content keeps changing forward: if the inputs revert to a
 * value already cached (a working-tree edit undone over the WS, content cycling
 * back), the active key is a cache *hit*, no new entry is appended, and `.at(-1)`
 * returns a stale, unrelated block set. Reconstruct the library's key from the
 * same props we pass to `<ReactDiffViewer>` and look the entry up directly. Fall
 * back to `.at(-1)` only if the keyed lookup misses (e.g. before the first
 * compute lands, or a future library/prop drift), preserving prior behavior.
 *
 * `key` MUST mirror `getMemoisedKey` field-for-field, including the prop order
 * and the library's `defaultProps` for any prop we don't pass (`linesOffset: 0`).
 */
function diffViewerBlocksKey(props: {
  oldValue: string;
  newValue: string;
  disableWordDiff: boolean;
  compareMethod: string;
  alwaysShowLines: string[];
  extraLinesSurroundingDiff: number;
}): string {
  return JSON.stringify({
    oldValue: props.oldValue,
    newValue: props.newValue,
    disableWordDiff: props.disableWordDiff,
    compareMethod: props.compareMethod,
    linesOffset: 0,
    alwaysShowLines: props.alwaysShowLines,
    extraLinesSurroundingDiff: props.extraLinesSurroundingDiff,
  });
}

function diffViewerBlocks(viewer: DiffViewerHandle | null, key?: string): { index: number }[] {
  const cache = viewer?.state?.computedDiffResult;
  if (!cache) return [];
  const keyed = key !== undefined ? cache[key] : undefined;
  if (keyed) return keyed.blocks ?? [];
  return Object.values(cache).at(-1)?.blocks ?? [];
}

function alignCodeFoldButtons(container: HTMLElement, wrapLines: boolean) {
  const table = container.querySelector("table");
  if (!table) return;
  // Wrapping: the table fills the pane, so its center *is* the pane center — the
  // natural reference. No-wrap: the table is content-wide (and may be scrolled
  // horizontally), so centering on it would push the "N unchanged lines" pill
  // off-screen; center on the visible pane (`container`'s client box) instead.
  // No-wrap positions the pill absolutely inside its fold cell so centering it
  // does not expand the file's horizontal scroll range.
  let center: number;
  if (wrapLines) {
    const tableRect = table.getBoundingClientRect();
    center = tableRect.left + tableRect.width / 2;
  } else {
    const containerRect = container.getBoundingClientRect();
    center = containerRect.left + container.clientWidth / 2;
  }
  for (const button of container.querySelectorAll<HTMLButtonElement>(
    'button[class*="code-fold-expand-button"]',
  )) {
    button.style.setProperty("--staff-code-fold-shift", "0px");
    button.style.removeProperty("--staff-code-fold-left");
    const buttonRect = button.getBoundingClientRect();
    if (!wrapLines) {
      const containerRect = container.getBoundingClientRect();
      const offsetParent = button.offsetParent as HTMLElement | null;
      const parentRect = offsetParent?.getBoundingClientRect() ?? containerRect;
      const left =
        containerRect.left + container.clientWidth / 2 - parentRect.left - buttonRect.width / 2;
      button.style.setProperty("--staff-code-fold-left", `${left}px`);
      continue;
    }
    const buttonCenter = buttonRect.left + buttonRect.width / 2;
    button.style.setProperty("--staff-code-fold-shift", `${center - buttonCenter}px`);
  }
}

/**
 * Unified no-wrap uses a content-wide table so added/removed cell backgrounds
 * extend behind the entire long line. Horizontal scroll should appear only when
 * the table is genuinely wider than the visible pane. A no-op for split (the
 * table always grows and scrolls there) and wrap (lines never overflow).
 */
function applyUnifiedXScroll(container: HTMLElement, splitView: boolean, wrapLines: boolean) {
  if (splitView || wrapLines) {
    container.classList.remove("staff-diff-xscroll");
    return;
  }
  const table = container.querySelector("table");
  const tableLeft = table?.getBoundingClientRect().left ?? 0;
  const overflowing = table
    ? Array.from(container.querySelectorAll<HTMLElement>('[class*="content-text"]')).some(
        (line) => {
          const textRect = renderedTextRect(line);
          return textRect.right - tableLeft > container.clientWidth + 1;
        },
      )
    : false;
  container.classList.toggle("staff-diff-xscroll", overflowing);
}

function renderedTextRect(element: HTMLElement): DOMRect {
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  const rect = range.getBoundingClientRect();
  range.detach();
  return rect;
}

function applyNoWrapTableMinWidth(container: HTMLElement, wrapLines: boolean) {
  if (wrapLines) {
    container.style.removeProperty("--staff-nowrap-table-min-width");
    return;
  }
  const table = container.querySelector("table");
  if (!table) return;
  container.style.removeProperty("--staff-nowrap-table-min-width");
  const tableLeft = table.getBoundingClientRect().left;
  let contentWidth = container.clientWidth;
  for (const line of container.querySelectorAll<HTMLElement>('[class*="content-text"]')) {
    const textRect = renderedTextRect(line);
    contentWidth = Math.max(contentWidth, textRect.right - tableLeft);
  }
  container.style.setProperty("--staff-nowrap-table-min-width", `${Math.ceil(contentWidth)}px`);
}

function applyUnifiedNoWrapContentMinWidth(
  container: HTMLElement,
  splitView: boolean,
  wrapLines: boolean,
) {
  if (splitView || wrapLines) {
    container.style.removeProperty("--staff-unified-content-min-width");
    return;
  }
  const row = container.querySelector<HTMLTableRowElement>(
    'tbody > tr:not([data-composer-host="true"]):not([class*="code-fold"])',
  );
  if (!row) return;
  const cells = Array.from(row.querySelectorAll<HTMLTableCellElement>(":scope > td")).filter(
    (cell) => getComputedStyle(cell).display !== "none",
  );
  const contentCell = [...cells].reverse().find((cell) => cell.className.includes("content"));
  if (!contentCell) return;
  const fixedWidth = cells
    .filter((cell) => cell !== contentCell)
    .reduce((sum, cell) => sum + cell.getBoundingClientRect().width, 0);
  const minWidth = Math.max(0, container.clientWidth - fixedWidth);
  container.style.setProperty("--staff-unified-content-min-width", `${minWidth}px`);
}

function clearUnifiedGutterNormalization(container: HTMLElement) {
  for (const col of container.querySelectorAll<HTMLTableColElement>(
    "col[data-staff-unified-hidden-col]",
  )) {
    col.removeAttribute("data-staff-unified-hidden-col");
    col.style.removeProperty("display");
    col.style.removeProperty("width");
  }
  for (const col of container.querySelectorAll<HTMLTableColElement>(
    "col[data-staff-unified-content-col]",
  )) {
    col.removeAttribute("data-staff-unified-content-col");
    col.style.removeProperty("width");
  }
  for (const cell of container.querySelectorAll<HTMLTableCellElement>(
    "td[data-staff-unified-gutter]",
  )) {
    const pre = cell.querySelector("pre");
    if (pre) pre.textContent = cell.dataset.oldLine ?? "";
    cell.removeAttribute("data-line");
    cell.removeAttribute("data-new-line");
    cell.removeAttribute("data-old-line");
    cell.removeAttribute("data-side");
    cell.removeAttribute("data-staff-unified-gutter");
    cell.removeAttribute("data-staff-gutter-label");
    cell.removeAttribute("title");
  }
  for (const cell of container.querySelectorAll<HTMLTableCellElement>(
    "td[data-staff-unified-hidden-gutter]",
  )) {
    cell.removeAttribute("aria-hidden");
    cell.removeAttribute("data-staff-unified-hidden-gutter");
    cell.style.removeProperty("display");
    cell.style.removeProperty("width");
    cell.style.removeProperty("padding");
    cell.style.removeProperty("border");
  }
}

function lineNumberText(cell: HTMLTableCellElement): string {
  const text = cell.querySelector("pre")?.textContent?.trim() ?? cell.textContent?.trim() ?? "";
  return /^\d+$/.test(text) ? text : "";
}

function normalizeUnifiedGutters(container: HTMLElement, wrapLines: boolean) {
  const table = container.querySelector("table");
  if (!table) return;
  const cols = Array.from(table.querySelectorAll<HTMLTableColElement>(":scope > colgroup > col"));
  if (cols.length >= 4) {
    cols[1].dataset.staffUnifiedHiddenCol = "true";
    cols[1].style.setProperty("display", "none", "important");
    cols[1].style.setProperty("width", "0px", "important");
    cols[3].dataset.staffUnifiedContentCol = "true";
    if (wrapLines) {
      // Pin the content column to 100% in wrap mode so short changed-line tints
      // fill the visible pane. In no-wrap the table itself grows to the longest
      // line (`width: max-content` in CSS), so forcing this column to 100% would
      // make text spill past its tinted cell instead of expanding the cell.
      cols[3].style.setProperty("width", "100%", "important");
    } else {
      cols[3].style.removeProperty("width");
    }
  }

  const rows = table.querySelectorAll<HTMLTableRowElement>(
    'tbody > tr:not([data-composer-host="true"]):not([class*="code-fold"])',
  );
  for (const row of rows) {
    const cells = Array.from(row.querySelectorAll<HTMLTableCellElement>(":scope > td"));
    if (cells.length !== 4) continue;
    const [oldCell, newCell, markerCell] = cells;
    if (!markerCell?.className.includes("marker")) continue;

    // Re-derive both line numbers from the *fresh* DOM every pass — never
    // `||`-short-circuit to the persisted dataset, or a content refresh that
    // rewrites the line-number `<pre>`s without remounting the viewer (a WS
    // `repo:changed` outside a commented region, so `commentLineKey` is stable)
    // would leave the cached numbers — and thus comment/hash anchoring — stale.
    // `newCell`'s `<pre>` is only hidden, never overwritten, so it always holds
    // the live new-line number. `oldCell`'s `<pre>`, however, gets clobbered
    // with `label` below; once that happens the raw old-line is gone from the
    // DOM, so we read it from the dataset — but only while the `<pre>` still
    // shows the label we last wrote. When the library rewrites that `<pre>`
    // with a fresh raw old-line, `staffGutterLabel` no longer matches and we
    // pick the live number back up.
    const oldPreText = oldCell.querySelector("pre")?.textContent ?? "";
    const oldCellShowsOurLabel =
      oldCell.dataset.staffGutterLabel !== undefined &&
      oldPreText === oldCell.dataset.staffGutterLabel;
    const oldLine = oldCellShowsOurLabel
      ? (oldCell.dataset.oldLine ?? "")
      : lineNumberText(oldCell);
    const newLine = lineNumberText(newCell);
    const primarySide = newLine ? "new" : "old";
    const primaryLine = primarySide === "new" ? newLine : oldLine;
    const label = newLine ? newLine : oldLine ? "-" : "";

    oldCell.dataset.staffUnifiedGutter = "true";
    oldCell.dataset.side = primarySide;
    if (primaryLine) oldCell.dataset.line = primaryLine;
    else oldCell.removeAttribute("data-line");
    if (oldLine) oldCell.dataset.oldLine = oldLine;
    else oldCell.removeAttribute("data-old-line");
    if (newLine) oldCell.dataset.newLine = newLine;
    else oldCell.removeAttribute("data-new-line");
    if (oldLine && !newLine) oldCell.title = `Deleted old line ${oldLine}`;
    else oldCell.removeAttribute("title");

    const pre = oldCell.querySelector("pre");
    if (pre && pre.textContent !== label) pre.textContent = label;
    // Remember the label we wrote so the next pass can tell "our overwritten
    // gutter" apart from a `<pre>` the library has since rewritten with a fresh
    // raw old-line number.
    oldCell.dataset.staffGutterLabel = label;

    newCell.dataset.staffUnifiedHiddenGutter = "true";
    newCell.setAttribute("aria-hidden", "true");
    newCell.style.setProperty("display", "none", "important");
    newCell.style.setProperty("width", "0px", "important");
    newCell.style.setProperty("padding", "0", "important");
    newCell.style.setProperty("border", "0", "important");
  }
}

const WORD_DIFF_SELECTOR =
  'ins[class*="word-added"], del[class*="word-removed"], [data-staff-whitespace-word-diff="true"], [data-staff-low-signal-word-diff="true"]';
const WORD_CHANGE_CLASS = /word-(?:added|removed)/;
const TEXT_NODE = 3;
const SHOW_TEXT = 4;
const WHITESPACE_ONLY = /^[\s\u00a0]*$/u;
const WHITESPACE_CHAR = /^[\s\u00a0]$/u;
const MIN_LOW_SIGNAL_WORD_DIFF_CHARS = 24;
const MAX_STRUCTURAL_WORD_DIFF_RATIO = 0.45;

function removeWordChangeClasses(node: HTMLElement) {
  const changeClasses = Array.from(node.classList).filter((className) =>
    WORD_CHANGE_CLASS.test(className),
  );
  if (changeClasses.length === 0) return;
  node.dataset.staffWordDiffChangeClasses = changeClasses.join(" ");
  for (const className of changeClasses) node.classList.remove(className);
}

function restoreWordChangeClasses(node: HTMLElement) {
  const originalClasses = node.dataset.staffWordDiffChangeClasses;
  if (originalClasses) node.classList.add(...originalClasses.split(" "));
  delete node.dataset.staffWordDiffChangeClasses;
}

function activeWordDiffKind(node: HTMLElement): "added" | "removed" | null {
  if (Array.from(node.classList).some((className) => className.includes("word-added"))) {
    return "added";
  }
  if (Array.from(node.classList).some((className) => className.includes("word-removed"))) {
    return "removed";
  }
  return null;
}

function significantLength(value: string): number {
  return value.replace(/\s+/g, "").length;
}

function textNodes(root: Node): Text[] {
  const doc = root.ownerDocument ?? document;
  const walker = doc.createTreeWalker(root, SHOW_TEXT);
  const nodes: Text[] = [];
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    if (current.nodeType === TEXT_NODE) nodes.push(current as Text);
  }
  return nodes;
}

function trimLeadingWhitespace(root: Node): string {
  let trimmed = "";
  for (const node of textNodes(root)) {
    const originalLength = node.data.length;
    let i = 0;
    while (i < node.data.length && WHITESPACE_CHAR.test(node.data[i])) i++;
    if (i === 0) break;
    trimmed += node.data.slice(0, i);
    node.data = node.data.slice(i);
    if (i < originalLength) break;
  }
  return trimmed;
}

function trimTrailingWhitespace(root: Node): string {
  let trimmed = "";
  const nodes = textNodes(root);
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index];
    let i = node.data.length;
    while (i > 0 && WHITESPACE_CHAR.test(node.data[i - 1])) i--;
    if (i === node.data.length) break;
    trimmed = node.data.slice(i) + trimmed;
    node.data = node.data.slice(0, i);
    if (i > 0) break;
  }
  return trimmed;
}

function mergeAdjacentWordDiffWhitespace(container: ParentNode): number {
  let changed = 0;
  for (const node of Array.from(container.querySelectorAll<HTMLElement>(WORD_DIFF_SELECTOR))) {
    let kind = activeWordDiffKind(node);
    if (!kind) continue;

    while (true) {
      const whitespaceNodes: Text[] = [];
      let next = node.nextSibling;
      while (next?.nodeType === TEXT_NODE && WHITESPACE_ONLY.test(next.textContent ?? "")) {
        whitespaceNodes.push(next as Text);
        next = next.nextSibling;
      }
      if (!(next instanceof HTMLElement) || activeWordDiffKind(next) !== kind) break;

      for (const whitespace of whitespaceNodes) {
        node.appendChild(node.ownerDocument.createTextNode(whitespace.data));
        whitespace.remove();
      }
      while (next.firstChild) node.appendChild(next.firstChild);
      next.remove();
      changed++;
      kind = activeWordDiffKind(node);
      if (!kind) break;
    }
  }
  return changed;
}

function suppressLowSignalWordDiffRows(container: ParentNode): number {
  let changed = 0;
  for (const row of container.querySelectorAll<HTMLElement>("tr")) {
    const changedNodes = Array.from(row.querySelectorAll<HTMLElement>(WORD_DIFF_SELECTOR)).filter(
      (node) => activeWordDiffKind(node),
    );
    if (changedNodes.length === 0) continue;

    const contentCells = Array.from(row.querySelectorAll<HTMLElement>('td[class*="content"]'));
    const lineText = (contentCells.length > 0 ? contentCells : [row])
      .map((cell) => cell.textContent ?? "")
      .join("");
    const lineLength = significantLength(lineText);
    if (lineLength === 0) continue;

    const changedLength = changedNodes.reduce(
      (sum, node) => sum + significantLength(node.textContent ?? ""),
      0,
    );
    if (
      changedLength < MIN_LOW_SIGNAL_WORD_DIFF_CHARS ||
      changedLength / lineLength <= MAX_STRUCTURAL_WORD_DIFF_RATIO
    ) {
      continue;
    }

    for (const node of changedNodes) {
      removeWordChangeClasses(node);
      node.dataset.staffLowSignalWordDiff = "true";
      changed++;
    }
  }
  return changed;
}

export function normalizeWordDiffWhitespace(container: ParentNode): number {
  let changed = 0;
  for (const node of Array.from(container.querySelectorAll<HTMLElement>(WORD_DIFF_SELECTOR))) {
    restoreWordChangeClasses(node);
    delete node.dataset.staffLowSignalWordDiff;
    delete node.dataset.staffWhitespaceWordDiff;
  }

  for (const node of Array.from(container.querySelectorAll<HTMLElement>(WORD_DIFF_SELECTOR))) {
    if (WHITESPACE_ONLY.test(node.textContent ?? "")) {
      removeWordChangeClasses(node);
      node.dataset.staffWhitespaceWordDiff = "true";
      changed++;
      continue;
    }

    const leading = trimLeadingWhitespace(node);
    const trailing = trimTrailingWhitespace(node);
    if (leading) node.before(node.ownerDocument.createTextNode(leading));
    if (trailing) node.after(node.ownerDocument.createTextNode(trailing));
    if (leading || trailing) changed++;
  }
  changed += mergeAdjacentWordDiffWhitespace(container);
  changed += suppressLowSignalWordDiffRows(container);
  return changed;
}

/**
 * Escape text destined for an HTML body via `dangerouslySetInnerHTML` so file
 * contents can't inject markup. Entities are character-counted by
 * react-diff-viewer-continued's `applyDiffToHighlightedHtml`, which decodes
 * `&lt; &gt; &amp; &quot; &#39; &#x27; &nbsp;` back to single characters when
 * overlaying word-diff ranges — so this set must stay in sync with that decoder.
 *
 * Subtlety (the reason for the `<wbr>` below): the library's `decodeEntities`
 * runs its replacements *sequentially* and decodes `&amp;`→`&` **before**
 * `&quot;`/`&#39;`/`&#x27;`/`&nbsp;`. So a source line that literally contains one
 * of those entity strings (common in HTML/XML — e.g. `&nbsp;`, `&#39;`) escapes
 * to `&amp;nbsp;` / `&amp;#39;`, and the decoder then *re-forms* the entity
 * (`&amp;`→`&`, then `&nbsp;`→space): the decoded length undercounts the raw
 * length by 4–5 chars and the word-diff `<ins>`/`<del>` overlay drifts for the
 * rest of a CHANGED line. `&amp;lt;`/`&amp;gt;` are safe because `&lt;`/`&gt;`
 * are decoded *before* `&amp;`, so the body is already consumed.
 *
 * Fix: after escaping, drop a zero-width `<wbr>` between any `&amp;` and a
 * following re-formable body. `applyDiffToHighlightedHtml` splits HTML into
 * tag/text segments and decodes each text segment independently, so the `<wbr>`
 * tag boundary keeps the decoded `&` and the body in separate segments — they
 * can no longer re-combine, and per-segment decoded length matches raw length.
 * `<wbr>` is a zero-width void element, so the rendered output is unchanged.
 */
// Bodies the library's `decodeEntities` decodes *after* `&amp;` — these are the
// ones that re-form once `&amp;`→`&` exposes a leading `&`.
const REFORMABLE_ENTITY_BODY = /&amp;(?=#39;|#x27;|quot;|nbsp;)/g;

export function escapeHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  return escaped.replace(REFORMABLE_ENTITY_BODY, "&amp;<wbr>");
}

/** Escape a value placed inside a double-quoted HTML attribute. */
export function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
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
      ? "color-mix(in oklch, var(--color-success) 17%, transparent)"
      : "color-mix(in oklch, var(--color-success) 11%, transparent)",
    addedColor: "var(--color-foreground)",
    removedBackground: isDark
      ? "color-mix(in oklch, var(--color-destructive) 18%, transparent)"
      : "color-mix(in oklch, var(--color-destructive) 10%, transparent)",
    removedColor: "var(--color-foreground)",
    wordAddedBackground: isDark
      ? "color-mix(in oklch, var(--color-success) 22%, transparent)"
      : "color-mix(in oklch, var(--color-success) 18%, transparent)",
    wordRemovedBackground: isDark
      ? "color-mix(in oklch, var(--color-destructive) 24%, transparent)"
      : "color-mix(in oklch, var(--color-destructive) 17%, transparent)",
    addedGutterBackground: isDark
      ? "color-mix(in oklch, var(--color-success) 17%, transparent)"
      : "color-mix(in oklch, var(--color-success) 11%, transparent)",
    removedGutterBackground: isDark
      ? "color-mix(in oklch, var(--color-destructive) 18%, transparent)"
      : "color-mix(in oklch, var(--color-destructive) 10%, transparent)",
    gutterBackground: "transparent",
    gutterBackgroundDark: "transparent",
    highlightBackground: "var(--color-anchor-fill)",
    highlightGutterBackground: "var(--color-anchor-fill)",
    codeFoldGutterBackground: "transparent",
    codeFoldBackground: "transparent",
    emptyLineBackground: "var(--color-card)",
    gutterColor: "var(--color-muted-foreground)",
    addedGutterColor: "var(--color-success)",
    removedGutterColor: "var(--color-destructive)",
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
// A collapsed DiffFile unmounts its react-diff-viewer body, so collapsing the
// heavy / low-signal files keeps a 100-file diff from mounting 100 syntax
// highlighters at once. These are *defaults*: an explicit user toggle
// (override) always wins, and active unresolved comments only force-open a
// bounded number of file cards.

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
 * stay open still render with unchanged context folded; see `commentLineIds` /
 * `alwaysShowLines` below.
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
 * The line ids (`R<line>` / `L<line>`) react-diff-viewer must keep unfolded so
 * every comment's anchor row stays rendered even while surrounding context is
 * folded. Without this a comment on an unchanged line has no host row and its
 * thread is reachable only from the sidebar (see folded-comment.spec.ts).
 *
 * - Side maps to the diff gutter prefix: `new` → `R`, `old` → `L`.
 * - Range comments emit *two* ids — the start line and the end line — because
 *   the thread portal is hosted at `endLine` and both endpoints need a rendered
 *   row (react-diff-viewer's `extraLinesSurroundingDiff` fills the gap between).
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
 * react-diff-viewer-continued mounts its <table> across multiple frames
 * after a layout change.
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

export function DiffFile({
  file,
  slug,
  comments,
  splitView,
  themeMode,
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
  themeMode: "light" | "dark";
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
  // Host <td> elements (one per open composer), keyed by `${side}:${line}`.
  // Ref-backed so DOM and host map stay in sync inside useLayoutEffect; a
  // version counter triggers re-renders so the portals pick up changes.
  const hostsRef = useRef<Map<string, HTMLElement>>(new Map());
  const [, bumpHostsVersion] = useReducer((n: number) => n + 1, 0);
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

  const renderContent = useMemo(() => {
    if (!highlighter || lang === "text") return undefined;
    return (source: string) => {
      // `source` is the text of a line (or a word-diff chunk). Tokenizing
      // line-by-line keeps the diff renderer fast and avoids huge highlighter
      // bundles in the browser startup chunk.
      //
      // We emit the tokens as an HTML string via `dangerouslySetInnerHTML`
      // rather than nested React elements. react-diff-viewer-continued's
      // CHANGED-line path (`renderWordDiff`) only keeps the renderer's output
      // if it exposes `props.dangerouslySetInnerHTML.__html` — it then overlays
      // the word-diff `<ins>/<del>` wrappers onto that highlighted HTML
      // (`applyDiffToHighlightedHtml`). Element output is silently discarded,
      // leaving changed lines unhighlighted. The library decodes HTML entities
      // when counting characters against the diff ranges, so we must escape
      // token text (which also prevents file contents from injecting markup).
      const tokens = tokenizeLine(highlighter, source, lang, syntaxTheme);
      const html = tokens
        .map((t) => {
          const text = escapeHtml(t.content);
          return t.color ? `<span style="color:${escapeHtmlAttr(t.color)}">${text}</span>` : text;
        })
        .join("");
      // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki token text and style values are escaped above before being passed to the diff renderer.
      return <span dangerouslySetInnerHTML={{ __html: html }} />;
    };
  }, [highlighter, lang, syntaxTheme]);

  const diffStyles = useMemo(() => makeDiffStyles(themeMode), [themeMode]);
  const diffViewerRef = useRef<DiffViewerHandle | null>(null);
  const [contextFoldState, setContextFoldState] = useState({ key: "", expanded: false });
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
  // reveal the start and end lines; the thread portal is hosted at the end
  // line, and react-diff-viewer's `extraLinesSurroundingDiff` gives both
  // endpoints local context without expanding the whole file.
  const commentLineIds = useMemo(() => computeCommentLineIds(threads), [threads]);
  const commentLineKey = commentLineIds.join("|");
  const viewerResetKey = `${file.oldContent}\0${file.newContent}\0${commentLineKey}\0${expandedByDefault}`;
  // The library's `computedDiffResult` cache key for the props we render below.
  // Used to look up the *current* block set instead of the last-inserted one
  // (see `diffViewerBlocks`), which matters when content reverts to a value the
  // library has already cached. Mirrors the `<ReactDiffViewer>` props verbatim.
  const blocksCacheKey = useMemo(
    () =>
      diffViewerBlocksKey({
        oldValue: file.oldContent,
        newValue: file.newContent,
        disableWordDiff: !structuredHighlighting,
        compareMethod: DiffMethod.WORDS,
        alwaysShowLines: commentLineIds,
        extraLinesSurroundingDiff: 3,
      }),
    [file.oldContent, file.newContent, structuredHighlighting, commentLineIds],
  );
  // Prefer the viewer's live fold state over the cached `contextFoldState` key:
  // `viewerResetKey` folds in `file.oldContent`/`file.newContent`, but the
  // viewer is keyed only on `commentLineKey`, so a working-tree edit arriving
  // over the WebSocket updates the content WITHOUT remounting the viewer (and
  // the library doesn't reset `expandedBlocks` on a content prop change). The
  // cached key would then say "not expanded" while the blocks are still
  // expanded. Deriving from `viewer.state.expandedBlocks` vs the current blocks
  // keeps the button label honest across those refreshes; fall back to the
  // cached flag only before the viewer ref is populated on first render.
  const allContextExpanded = (() => {
    const viewer = diffViewerRef.current;
    const blocks = diffViewerBlocks(viewer, blocksCacheKey);
    if (viewer?.state && blocks.length > 0) {
      const expanded = new Set(viewer.state.expandedBlocks ?? []);
      return blocks.every((block) => expanded.has(block.index));
    }
    return contextFoldState.key === viewerResetKey && contextFoldState.expanded;
  })();

  function toggleFoldedContext() {
    const viewer = diffViewerRef.current;
    const blocks = diffViewerBlocks(viewer, blocksCacheKey);
    if (!viewer?.setState || blocks.length === 0) {
      setContextFoldState({ key: viewerResetKey, expanded: false });
      return;
    }
    const expanded = new Set(viewer.state?.expandedBlocks ?? []);
    const allExpanded = blocks.every((block) => expanded.has(block.index));
    const nextExpandedBlocks = allExpanded ? [] : blocks.map((block) => block.index);
    viewer.setState({ expandedBlocks: nextExpandedBlocks }, () => {
      setContextFoldState({ key: viewerResetKey, expanded: !allExpanded });
    });
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

  // Sync `hostsRef` with `inlineLines`: ensure exactly one <tr> host exists
  // immediately after each line that has any inline content (threads and/or
  // a composer). Hosts whose key is no longer wanted are removed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: The extra diff-rendering props intentionally restart the host repair loop after the third-party diff table redraws.
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
    // unfolds commented lines via `alwaysShowLines`, across several async
    // frames) OR because a re-render swapped in fresh <tr> nodes and orphaned a
    // host we injected. Treat a disconnected host the same as a missing one and
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
    // (e.g. the `key={commentLineKey}` remount, or `alwaysShowLines` unfolding
    // a commented line, swaps the rows out). Once everything is placed and
    // connected, `placeHosts` is a passive no-op, so
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
    // `structuredHighlighting` is in the deps because toggling it flips
    // `disableWordDiff` on <ReactDiffViewer>, whose componentDidUpdate
    // re-renders all diff <tr> rows and detaches our injected comment-host
    // <tr>s. Re-running this effect restarts the repair loop so the inline
    // comment portals get re-anchored instead of pointing at detached <td>s.
  }, [
    collapsed,
    inlineLines,
    composingLines,
    splitView,
    structuredHighlighting,
    file.oldContent,
    file.newContent,
  ]);

  useLayoutEffect(() => {
    if (collapsed) return;
    const container = diffRef.current;
    if (!container) return;
    let raf = 0;
    // The gutter writes below (`pre.textContent`, col/cell styles) are
    // themselves childList/subtree mutations inside the observed container, so a
    // live observer re-fires `apply` on every normalization pass — the
    // `textContent !== label` guard makes it converge rather than loop, but each
    // library re-render / portal insert still costs an extra rAF. Disconnect
    // around the writes so the tool's own mutations don't feed back, then
    // reconnect to catch genuine library re-renders.
    //
    // `alignCodeFoldButtons` does a forced layout read (`getBoundingClientRect`)
    // per fold button; only the *count/identity* of fold buttons and the table
    // affect that alignment, so skip it when neither changed since the last pass
    // (`forceAlign` covers resize and the initial pass, where geometry can move
    // without a DOM mutation). This keeps the reflow off the hot path of every
    // unrelated mutation while still realigning when folds actually appear/move.
    let observer: MutationObserver | null = null;
    let lastFoldSignature = "";
    const foldSignature = () => {
      const table = container.querySelector("table");
      const buttons = container.querySelectorAll('button[class*="code-fold-expand-button"]');
      // Node identity (via a per-pass marker) would be ideal, but a cheap count
      // + table presence is enough: fold buttons only appear/disappear/move when
      // the diff's hidden-block structure changes, which is what realignment
      // tracks.
      return `${table ? "t" : ""}:${buttons.length}`;
    };
    const apply = (forceAlign = false) => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        observer?.disconnect();
        if (splitView) clearUnifiedGutterNormalization(container);
        else normalizeUnifiedGutters(container, wrapLines);
        if (structuredHighlighting) normalizeWordDiffWhitespace(container);
        applyUnifiedNoWrapContentMinWidth(container, splitView, wrapLines);
        applyNoWrapTableMinWidth(container, wrapLines);
        const signature = foldSignature();
        if (forceAlign || signature !== lastFoldSignature) {
          alignCodeFoldButtons(container, wrapLines);
          lastFoldSignature = signature;
        }
        applyUnifiedXScroll(container, splitView, wrapLines);
        observer?.observe(container, { childList: true, subtree: true });
      });
    };
    apply(true);
    observer = new MutationObserver(() => apply());
    observer.observe(container, { childList: true, subtree: true });
    const onResize = () => apply(true);
    window.addEventListener("resize", onResize);
    // In no-wrap, the fold pill is centered on the *visible* pane, so it must be
    // re-centered as the file scrolls horizontally. Re-align directly (the fold
    // structure is unchanged, so `apply`'s signature guard would skip it), rAF-
    // throttled. Wrapping has no horizontal scroll, so this is a no-op there.
    let scrollRaf = 0;
    const onScroll = () => {
      if (wrapLines || scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        alignCodeFoldButtons(container, wrapLines);
      });
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      observer.disconnect();
      window.removeEventListener("resize", onResize);
      container.removeEventListener("scroll", onScroll);
    };
  }, [collapsed, splitView, structuredHighlighting, wrapLines]);

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
      markerCell = cells[2];
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
        ? markerRect.left - containerRect.left + markerRect.width / 2 - 4
        : cellRect.right - containerRect.left,
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: Diff render props and content changes redraw table rows that need the anchored marker re-applied.
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
          )}
          ref={diffRef}
          onMouseDown={handleDiffMouseDown}
          onMouseOver={handleDiffMouseOver}
          onMouseMove={handleDiffMouseMove}
          onMouseLeave={handleDiffMouseLeave}
        >
          {/*
            Keying on `commentLineKey` is required, not cosmetic:
            react-diff-viewer-continued@4.2.2's componentDidUpdate only
            recomputes its fold blocks on oldValue/newValue/compareMethod/
            disableWordDiff/linesOffset changes and IGNORES `alwaysShowLines`.
            Without a key change a newly commented line would never unfold.

            Tradeoff (accepted): a key change unmounts/remounts the viewer,
            which resets its internal `expandedBlocks` ([] on mount). So adding
            or deleting a line comment snaps any folds the user had manually
            expanded shut and re-runs the diff (a brief flash on large files).
            Resolving/unresolving does NOT change `commentLineIds` (resolved
            roots stay in it, see computeCommentLineIds), so it no longer
            remounts. The real fix is patching the library to react to
            `alwaysShowLines` in componentDidUpdate; until then this is an
            intentional remount, not a bug.
          */}
          <ReactDiffViewer
            ref={(instance) => {
              diffViewerRef.current = instance as unknown as DiffViewerHandle | null;
            }}
            key={commentLineKey}
            oldValue={file.oldContent}
            newValue={file.newContent}
            splitView={splitView}
            compareMethod={DiffMethod.WORDS}
            disableWordDiff={!structuredHighlighting}
            useDarkTheme={themeMode === "dark"}
            // When files aren't "expanded by default", fold unchanged
            // regions to just the changed hunks (+3 context lines). Commented
            // lines are added to `alwaysShowLines`, so comments reveal local
            // context without forcing the entire file to mount.
            showDiffOnly={!expandedByDefault}
            alwaysShowLines={commentLineIds}
            extraLinesSurroundingDiff={3}
            codeFoldMessageRenderer={(totalFoldedLines) => (
              <span className="inline-flex items-center gap-1.5">
                <UnfoldVertical className="h-3 w-3" />
                {totalFoldedLines} unchanged line{totalFoldedLines === 1 ? "" : "s"}
              </span>
            )}
            hideSummary
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

      {!collapsed &&
        inlineLines.map(([key, target]) => {
          const host = hostsRef.current.get(key);
          if (!host) return null;
          const lineThread = rootByLine.get(key);
          const rootThread = lineThread?.find((c) => !c.parentId);
          const hasComposer = composingLines.some((t) => composingKey(t) === key);
          return createPortal(
            <div key={key} data-thread-id={rootThread?.threadId} className="space-y-3 p-3">
              {lineThread && (
                <CommentThread slug={slug} comments={lineThread} onChange={onChange} />
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
  // every react-diff-viewer at once (see computeAutoCollapsed).
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
          themeMode={themeMode}
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
