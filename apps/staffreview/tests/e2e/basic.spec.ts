import { expect, test } from "@playwright/test";
import { gotoInitialDiff, resetDiffsJson, staff } from "./helpers.ts";

test.beforeEach(async () => {
  await resetDiffsJson();
});

test("loads the UI and renders the header with both target pickers", async ({ page }) => {
  await page.goto("/");

  // The branch name appears in an outline badge alongside the repo path
  // (the standalone "Staff Review" wordmark + S icon were removed).
  await expect(page.locator("header").getByText("main", { exact: true }).first()).toBeVisible();

  // Two target pickers with labels
  await expect(page.getByText("base", { exact: true })).toBeVisible();
  await expect(page.getByText("head", { exact: true })).toBeVisible();

  // Live badge eventually flips to "Live" once WS connects
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
});

test("Tailwind utility classes are loaded (CSS smoke)", async ({ page }) => {
  await page.goto("/");

  // body should have the resolved Tailwind background color, not browser default white
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  // oklch(0.99 0 0) renders to a near-white rgb(252,252,252) or similar — assert it's NOT the user-agent transparent/empty
  expect(bg).not.toBe("");
  expect(bg).not.toBe("rgba(0, 0, 0, 0)");

  // The header should be sticky positioned via Tailwind
  const headerPos = await page
    .locator("header")
    .first()
    .evaluate((el) => getComputedStyle(el).position);
  expect(headerPos).toBe("sticky");
});

test("renders a diff between two branches", async ({ page }) => {
  await page.goto("/");

  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();

  // The file header should appear
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();
});

test("active diff is created on first load and matches CLI", async ({ page }) => {
  await gotoInitialDiff(page);

  const active = JSON.parse(await staff(["active", "--json"]));
  expect(active).not.toBeNull();
  expect(active.slug).toBeTruthy();
  expect(active.base).toBeTruthy();
  expect(active.head).toBeTruthy();
});
