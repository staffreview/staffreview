import { expect, test } from "@playwright/test";
import { resetDiffsJson, staff } from "./helpers.ts";

test.beforeEach(async () => {
  await resetDiffsJson();
});

// Regression: posting a comment must NOT highlight the line it's anchored to.
// A line highlight is reserved for an explicit selection — clicking/dragging a
// line number or arriving via a URL anchor. (The bug fed comment lines into
// react-diff-viewer's `highlightLines`, tinting every commented line.)
test("a comment does not highlight its line; clicking the line number still does", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();

  // An agent comments on math.ts:2 (new side) — no user interaction.
  await staff([
    "comment",
    "add",
    "--file",
    "math.ts",
    "--line",
    "2",
    "--side",
    "new",
    "--author",
    "cli",
    "--body",
    "no highlight please",
  ]);

  const mathCard = page.getByTestId("file-card-math.ts");
  // The thread renders inline...
  await expect(
    mathCard.locator("[data-thread-id]", { hasText: "no highlight please" }),
  ).toBeVisible();
  // ...but nothing is highlighted: neither react-diff-viewer's own
  // `highlighted-line` class nor our `data-anchored` selection paint.
  await expect(mathCard.locator('[class*="highlighted-line"]')).toHaveCount(0);
  await expect(mathCard.locator('table tbody tr[data-anchored="true"]')).toHaveCount(0);

  // The allowed path still works: clicking the line number anchors (highlights)
  // that row.
  const ifRow = mathCard
    .locator("table tbody tr")
    .filter({ hasText: 'if (typeof a !== "number")' });
  await ifRow.locator("td").nth(3).click();
  await expect(ifRow).toHaveAttribute("data-anchored", "true");
});
