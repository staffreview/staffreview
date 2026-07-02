/// <reference lib="dom" />

import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FileDiff } from "../../types.ts";
import { DiffFile, setCollapseOverride } from "./DiffView.tsx";

// Guards the prop-driven reviewed→false re-expansion effect (the prevReviewedRef
// sync effect in DiffFile). When a reviewed file's working-tree content changes,
// its signature stops matching, `reviewedFilePaths` drops it, and `reviewed`
// flips false via the PROP (not handleReviewedChange, which the user-driven
// uncheck path uses). Without the effect — or its collapse-override guard — the
// card would stay collapsed, hiding changes that now need re-review. Neither the
// e2e (user-driven uncheck) nor the lib tests cover this path.

const SLUG = "main..WT";

// A binary file so expansion never mounts the async Shiki highlighter
// (shouldRenderTextDiff stays false). The collapse-sync effect under test is
// file-type-agnostic — it keys only on `reviewed`, `file.path`, and the slug —
// so this keeps the render synchronous and the assertions deterministic.
const FILE: FileDiff = {
  path: "assets/logo.png",
  status: "modified",
  oldContent: "",
  newContent: "",
  isBinary: true,
};

let container: HTMLElement | null = null;
let root: Root | null = null;

function render(reviewed: boolean, autoCollapsed = false) {
  act(() => {
    root?.render(
      <DiffFile
        file={FILE}
        slug={SLUG}
        comments={[]}
        splitView
        syntaxTheme="github-dark"
        structuredHighlighting={false}
        wrapLines={false}
        expandedByDefault={false}
        autoCollapsed={autoCollapsed}
        reviewed={reviewed}
      />,
    );
  });
}

function mount(reviewed: boolean, autoCollapsed = false) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  render(reviewed, autoCollapsed);
}

// The collapse toggle exposes `aria-expanded={!collapsed}`, so this reads the
// card's real collapse state without reaching into component internals.
function isExpanded(): boolean {
  const btn = container?.querySelector(`[data-testid="collapse-${FILE.path}"]`);
  return btn?.getAttribute("aria-expanded") === "true";
}

// Click the header chevron — the real toggleCollapsed path, which persists a
// collapse *override* (path → collapsed?) for the current state.
function clickCollapseToggle(): void {
  const btn = container?.querySelector(
    `[data-testid="collapse-${FILE.path}"]`,
  ) as HTMLElement | null;
  act(() => btn?.click());
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

test("prop-driven reviewed→false re-expands the card when no collapse override exists", () => {
  mount(true);
  expect(isExpanded()).toBe(false); // reviewed → collapsed

  render(false); // signature drifted: reviewed flips false via the prop
  expect(isExpanded()).toBe(true); // the sync effect re-expands for re-review
});

test("prop-driven reviewed→false leaves the card collapsed when a `true` override exists", () => {
  // The user explicitly COLLAPSED this file (the chevron writes a `true` override).
  setCollapseOverride(SLUG, FILE.path, true);

  mount(true);
  expect(isExpanded()).toBe(false); // reviewed → collapsed

  render(false); // reviewed flips false via the prop
  expect(isExpanded()).toBe(false); // `true` (collapsed) override wins: stays collapsed
});

// Regression for the force-expand effect ignoring `reviewed`: marking a file
// reviewed collapses it WITHOUT writing an override (only unchecking writes
// one), so a reviewed card has nothing guarding it in the force-expand effect.
// `computeAutoCollapsed` couples files via a shared per-diff budget, so freeing
// budget elsewhere can flip a reviewed file's `autoCollapsed` true→false and,
// pre-fix, the force-expand effect would spuriously re-open the reviewed card.
// The `reviewed` short-circuit keeps the reviewed⇒collapsed invariant.
test("reviewed card stays collapsed when freed budget flips autoCollapsed false", () => {
  mount(true, true); // reviewed + auto-collapsed, no override
  expect(isExpanded()).toBe(false);

  render(true, false); // budget freed elsewhere: autoCollapsed flips true→false
  expect(isExpanded()).toBe(false); // reviewed short-circuit keeps it collapsed
});

// Regression for the value-vs-presence guard bug: a `false` (expanded) override
// must NOT block re-expansion. Drives the full reported sequence end-to-end via
// the real chevron path (which persists the override) and prop-driven reviewed
// transitions (the working-tree edit / signature-drift path), rather than
// seeding the override directly.
test("prop-driven reviewed→false re-expands when a `false` (expanded) override exists", () => {
  mount(false); // unreviewed, expanded, no override yet
  expect(isExpanded()).toBe(true);

  // Expand "via the chevron": collapse then expand, leaving a persisted `false`
  // (expanded) override — what a user expanding an auto-collapsed file leaves.
  clickCollapseToggle(); // → collapsed, override `true`
  expect(isExpanded()).toBe(false);
  clickCollapseToggle(); // → expanded, override `false`
  expect(isExpanded()).toBe(true);

  render(true); // check Reviewed: parent flips the prop → force-collapse (override kept)
  expect(isExpanded()).toBe(false);

  render(false); // edit the file: signature drifts, reviewed flips false via the prop
  // The old presence check (`file.path in overrides`) left this collapsed; honoring
  // the value (`!== true`) re-expands so the drifted changes are visible for re-review.
  expect(isExpanded()).toBe(true);
});
