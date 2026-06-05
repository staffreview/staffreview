import { expect, test } from "@playwright/test";
import { resetDiffsJson } from "./helpers.ts";

test.beforeEach(async () => {
  await resetDiffsJson();
});

// Regression: a binary blob (pixel.png is added on the feature branch) must
// render a "Binary file not shown" placeholder, never a garbage text diff.
test("a binary file shows a placeholder, not a text diff", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();

  const card = page.getByTestId("file-card-pixel.png");
  await expect(card).toBeVisible();

  // The binary placeholder is shown...
  await expect(card.getByTestId("binary-panel-pixel.png")).toBeVisible();
  await expect(card).toContainText("Binary file not shown");

  // ...and react-diff-viewer never renders a table of (decoded) bytes for it.
  await expect(card.locator("table")).toHaveCount(0);
});
