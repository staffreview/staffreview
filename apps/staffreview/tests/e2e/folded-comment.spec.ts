import { rm } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { resetDiffsJson, staff } from "./helpers.ts";
import { STAFF_CONFIG_DIR } from "./setup.ts";

test.beforeEach(async () => {
  await resetDiffsJson();
  // Start from the default (collapsed / showDiffOnly) so big.ts folds.
  await rm(STAFF_CONFIG_DIR, { recursive: true, force: true });
});

async function openBigDiff(page: import("@playwright/test").Page) {
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  const card = page.getByTestId("file-card-big.ts");
  await expect(card).toBeVisible();
  return card;
}

// Regression: a comment anchored to a line inside a folded region must still
// render INLINE (its host row placed in the diff), not only in the sidebar.
// Fixed by forcing every commented line into react-diff-viewer's
// `alwaysShowLines`, so the line is never folded in the first place.
test("a comment on a folded line renders inline, not just in the sidebar", async ({ page }) => {
  await page.goto("/");
  const card = await openBigDiff(page);

  // big.ts is 40 lines with a single change mid-file (line 21). In collapsed
  // mode the distant context folds away — confirm folding is actually in
  // effect, otherwise the test wouldn't exercise the bug.
  const rows = card.locator("table tbody tr");
  await expect.poll(async () => await rows.count()).toBeLessThan(40);

  // An agent posts a comment on line 3 — far from the only change, so it sits
  // inside a folded block and has no rendered row to host a thread.
  await staff([
    "comment",
    "add",
    "--file",
    "big.ts",
    "--line",
    "3",
    "--side",
    "new",
    "--author",
    "Opus 4.8",
    "--body",
    "Folded-region finding.",
  ]);

  // Reload + reopen so the persisted comment is fetched fresh (independent of
  // the live WS refresh path).
  await page.reload();
  const card2 = await openBigDiff(page);

  // The thread must appear INLINE — inside the big.ts card's diff — not only
  // in the sidebar. The inline host portal carries `data-thread-id`.
  const inlineThread = card2.locator("[data-thread-id]", { hasText: "Folded-region finding." });
  await expect(inlineThread).toBeVisible();

  // And the line it's anchored to (line 3) is now unfolded and present.
  await expect
    .poll(async () => {
      const nums = await card2.locator("table tbody tr td:first-child").allInnerTexts();
      return nums.map((t) => t.trim());
    })
    .toContain("3");
});
