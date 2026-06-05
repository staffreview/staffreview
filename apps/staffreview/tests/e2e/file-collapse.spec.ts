import { expect, test } from "@playwright/test";
import { resetDiffsJson } from "./helpers.ts";

test.beforeEach(async () => {
  await resetDiffsJson();
});

test("clicking the chevron collapses the file and persists across reload", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();

  const mathCard = page.getByTestId("file-card-math.ts");
  await expect(mathCard.locator("table tbody tr").first()).toBeVisible();

  // Default: expanded, diff table visible.
  const chevron = page.getByTestId("collapse-math.ts");
  await expect(chevron).toHaveAttribute("aria-expanded", "true");

  // Collapse.
  await chevron.click();
  await expect(chevron).toHaveAttribute("aria-expanded", "false");
  await expect(mathCard.locator("table tbody tr")).toHaveCount(0);
  // The header (file path) is still visible.
  await expect(mathCard.getByText("math.ts", { exact: true })).toBeVisible();

  // Reload — collapsed state should be remembered.
  await page.reload();
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();
  const chevron2 = page.getByTestId("collapse-math.ts");
  await expect(chevron2).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("file-card-math.ts").locator("table tbody tr")).toHaveCount(0);

  // Expand again.
  await chevron2.click();
  await expect(chevron2).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByTestId("file-card-math.ts").locator("table tbody tr").first(),
  ).toBeVisible();
});
