import { rm } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { resetDiffsJson } from "./helpers.ts";
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

test("Collapsed (default) folds unchanged context; the expand button reveals it", async ({
  page,
}) => {
  await page.goto("/");
  await openDiff(page);

  const card = page.getByTestId("file-card-big.ts");
  const rows = card.locator("table tbody tr");
  await expect(card.getByRole("banner")).toHaveCount(0);
  await expect(card.getByTestId("file-change-stats-big.ts")).toHaveText("+1-1");
  // readme-link is a symlink: fileChangeStats short-circuits symlinks to {0,0},
  // so the +/- stats badge is deliberately never rendered for it.
  await expect(page.getByTestId("file-change-stats-readme-link")).toHaveCount(0);
  // big.ts is 40 lines with one change in the middle — folded, only the
  // changed hunk + a few context lines show.
  await expect.poll(async () => await rows.count()).toBeLessThan(40);
  const foldedCount = await rows.count();
  const foldRowButton = card.locator('button[class*="code-fold-expand-button"]').first();
  await expect(foldRowButton).toContainText(/\d+ unchanged lines/);
  const foldButtonBox = await foldRowButton.boundingBox();
  const tableBox = await card.locator("table").boundingBox();
  if (!foldButtonBox || !tableBox) throw new Error("missing fold row bounding box");
  expect(
    Math.abs(foldButtonBox.x + foldButtonBox.width / 2 - (tableBox.x + tableBox.width / 2)),
  ).toBeLessThanOrEqual(3);

  // The header expand-all button is shown and functional in collapsed mode.
  const expandBtn = card.getByTestId("fold-context-big.ts");
  await expect(expandBtn).toBeVisible();
  await expandBtn.click();
  await expect.poll(async () => await rows.count()).toBeGreaterThan(foldedCount);
});

test("Expanded shows the whole file and hides the inert expand button", async ({ page }) => {
  await page.goto("/");
  await openDiff(page);

  const card = page.getByTestId("file-card-big.ts");
  // Turn off default file collapsing.
  await page.getByTestId("settings-menu-button").click();
  const postSettings = page.waitForResponse(
    (r) => r.url().includes("/api/settings") && r.request().method() === "POST",
  );
  await page.getByTestId("files-collapse-toggle").click();
  await postSettings;
  await page.keyboard.press("Escape");

  // All 40 lines now render, and the inert expand button is hidden.
  await expect(card.locator("table tbody tr")).toHaveCount(40);
  await expect(card.getByTestId("fold-context-big.ts")).toBeHidden();
});

test("the Expanded preference persists across reload", async ({ page }) => {
  await page.goto("/");
  await openDiff(page);

  await page.getByTestId("settings-menu-button").click();
  await page.getByTestId("files-collapse-toggle").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("file-card-big.ts").locator("table tbody tr")).toHaveCount(40);

  await page.reload();
  await openDiff(page);
  await expect(page.getByTestId("file-card-big.ts").locator("table tbody tr")).toHaveCount(40);
  await page.getByTestId("settings-menu-button").click();
  await expect(page.getByTestId("files-collapse-toggle")).toHaveAttribute("aria-checked", "false");
});
