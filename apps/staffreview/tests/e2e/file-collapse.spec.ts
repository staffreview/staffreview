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

test("marking a file reviewed collapses, dims, and marks it in the sidebar", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();

  const mathCard = page.getByTestId("file-card-math.ts");
  const reviewed = page.getByTestId("reviewed-math.ts");
  await expect(mathCard.locator("table tbody tr").first()).toBeVisible();
  await expect(reviewed).toHaveAttribute("aria-checked", "false");

  await reviewed.click();
  await expect(reviewed).toHaveAttribute("aria-checked", "true");
  await expect(mathCard).toHaveAttribute("data-reviewed", "true");
  await expect(page.getByTestId("collapse-math.ts")).toHaveAttribute("aria-expanded", "false");
  await expect(mathCard.locator("table tbody tr")).toHaveCount(0);

  await page.getByTestId("sidebar-tab-files").click();
  const sidebarFile = page.getByTestId("sidebar-file-math.ts");
  await expect(sidebarFile).toHaveAttribute("data-reviewed", "true");
  await expect(sidebarFile).toContainText("math.ts");

  await page.reload();
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByTestId("reviewed-math.ts")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("file-card-math.ts")).toHaveAttribute("data-reviewed", "true");
  await expect(page.getByTestId("collapse-math.ts")).toHaveAttribute("aria-expanded", "false");

  await page.getByTestId("reviewed-math.ts").click();
  await expect(page.getByTestId("reviewed-math.ts")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("file-card-math.ts")).toHaveAttribute("data-reviewed", "false");
  await expect(page.getByTestId("collapse-math.ts")).toHaveAttribute("aria-expanded", "true");
});
