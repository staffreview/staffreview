import { test, expect } from "@playwright/test";
import { resetDiffsJson } from "./helpers.ts";
import { rm } from "node:fs/promises";
import { STAFF_CONFIG_DIR } from "./setup.ts";

test.beforeEach(async () => {
  await resetDiffsJson();
  // Reset the isolated global settings so each test starts from the
  // default (files collapsed / showDiffOnly).
  await rm(STAFF_CONFIG_DIR, { recursive: true, force: true });
});

async function openDiff(page: import("@playwright/test").Page) {
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByTestId("file-card-big.ts")).toBeVisible();
}

test("Collapsed (default) folds unchanged context; the expand button reveals it", async ({ page }) => {
  await page.goto("/");
  await openDiff(page);

  const card = page.getByTestId("file-card-big.ts");
  const rows = card.locator("table tbody tr");
  // big.ts is 40 lines with one change in the middle — folded, only the
  // changed hunk + a few context lines show.
  await expect.poll(async () => await rows.count()).toBeLessThan(40);
  const foldedCount = await rows.count();

  // The expand-all button is shown and functional in collapsed mode.
  const expandBtn = card.locator('button[class*="all-expand-button"]');
  await expect(expandBtn).toBeVisible();
  await expandBtn.click();
  await expect.poll(async () => await rows.count()).toBeGreaterThan(foldedCount);
});

test("Expanded shows the whole file and hides the inert expand button", async ({ page }) => {
  await page.goto("/");
  await openDiff(page);

  const card = page.getByTestId("file-card-big.ts");
  // Switch the default to Expanded.
  await page.getByTestId("settings-menu-button").click();
  const postSettings = page.waitForResponse(
    (r) => r.url().includes("/api/settings") && r.request().method() === "POST",
  );
  await page.getByTestId("files-default-expanded").click();
  await postSettings;
  await page.keyboard.press("Escape");

  // All 40 lines now render, and the inert expand button is hidden.
  await expect(card.locator("table tbody tr")).toHaveCount(40);
  await expect(card.locator('button[class*="all-expand-button"]')).toBeHidden();
});

test("the Expanded preference persists across reload", async ({ page }) => {
  await page.goto("/");
  await openDiff(page);

  await page.getByTestId("settings-menu-button").click();
  await page.getByTestId("files-default-expanded").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("file-card-big.ts").locator("table tbody tr")).toHaveCount(40);

  await page.reload();
  await openDiff(page);
  await expect(page.getByTestId("file-card-big.ts").locator("table tbody tr")).toHaveCount(40);
  await page.getByTestId("settings-menu-button").click();
  await expect(page.getByTestId("files-default-expanded")).toHaveAttribute("aria-checked", "true");
});
