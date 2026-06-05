import { rm } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { resetDiffsJson } from "./helpers.ts";
import { STAFF_CONFIG_DIR } from "./setup.ts";

test.beforeEach(async () => {
  await resetDiffsJson();
  // Reset the per-test isolated global settings so each test starts at
  // the default diff font size.
  await rm(STAFF_CONFIG_DIR, { recursive: true, force: true });
});

async function openGear(page: import("@playwright/test").Page) {
  await page.getByTestId("settings-menu-button").click();
}

async function diffFontSizePx(page: import("@playwright/test").Page): Promise<number> {
  return await page.evaluate(() => {
    const td = document.querySelector(".staff-diff td");
    if (!td) return -1;
    return parseFloat(getComputedStyle(td).fontSize);
  });
}

test("+ and − in the gear menu change the diff font size only", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();
  await expect(page.locator(".staff-diff td").first()).toBeVisible();

  // Sanity: surrounding UI font is independent of the diff font.
  const headerFontBefore = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.querySelector("header")!).fontSize),
  );

  const before = await diffFontSizePx(page);
  expect(before).toBeGreaterThan(0);

  await openGear(page);
  await expect(page.getByTestId("diff-font-size")).toHaveText(`${before}px`);
  await page.getByTestId("diff-font-increase").click();
  await page.getByTestId("diff-font-increase").click();

  const after = await diffFontSizePx(page);
  expect(after).toBe(before + 2);
  await expect(page.getByTestId("diff-font-size")).toHaveText(`${after}px`);

  const headerFontAfter = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.querySelector("header")!).fontSize),
  );
  expect(headerFontAfter).toBe(headerFontBefore);

  // Going down by 3 should put us at before - 1.
  await page.getByTestId("diff-font-decrease").click();
  await page.getByTestId("diff-font-decrease").click();
  await page.getByTestId("diff-font-decrease").click();
  const settled = await diffFontSizePx(page);
  expect(settled).toBe(before - 1);
});

test("font size persists across reload via the global settings file", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();
  await expect(page.locator(".staff-diff td").first()).toBeVisible();

  const initial = await diffFontSizePx(page);

  await openGear(page);
  const post = page.waitForResponse(
    (r) => r.url().includes("/api/settings") && r.request().method() === "POST",
  );
  await page.getByTestId("diff-font-increase").click();
  await post;

  await page.reload();
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();
  // Wait until the diff table is actually attached before measuring.
  await expect(page.locator(".staff-diff td").first()).toBeVisible();

  const afterReload = await diffFontSizePx(page);
  expect(afterReload).toBe(initial + 1);
});
