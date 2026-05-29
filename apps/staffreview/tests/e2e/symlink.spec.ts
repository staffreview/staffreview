import { test, expect } from "@playwright/test";
import { resetDiffsJson } from "./helpers.ts";

test.beforeEach(async () => {
  await resetDiffsJson();
});

test("a symlink shows a compact target row, not its file content", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();

  // `readme-link` (a symlink → README.md) was added on the feature branch.
  const symlinkCard = page.getByTestId("file-card-readme-link");
  await expect(symlinkCard).toBeVisible();

  // It renders a compact "Symlink → README.md" row…
  const panel = page.getByTestId("symlink-panel-readme-link");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Symlink");
  await expect(panel).toContainText("README.md");
  // …and NOT a diff table with the (followed) file content.
  await expect(symlinkCard.locator("table")).toHaveCount(0);

  // A regular file (math.ts) still renders its diff table, no symlink panel.
  await expect(page.getByTestId("symlink-panel-math.ts")).toHaveCount(0);
  await expect(page.getByTestId("file-card-math.ts").locator("table")).toBeVisible();
});
