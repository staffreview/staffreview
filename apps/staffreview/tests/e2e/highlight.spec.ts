import { rm } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { resetDiffsJson } from "./helpers.ts";
import { STAFF_CONFIG_DIR } from "./setup.ts";

test.beforeEach(async () => {
  await resetDiffsJson();
  await rm(STAFF_CONFIG_DIR, { recursive: true, force: true });
});

async function openFeatureDiff(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();
}

async function renderedBackgroundRgb(locator: import("@playwright/test").Locator) {
  return locator.evaluate((el) => {
    const color = getComputedStyle(el).backgroundColor;
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("missing canvas context");
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [red, green, blue] = ctx.getImageData(0, 0, 1, 1).data;
    return { blue, color, green, red };
  });
}

test("Shiki syntax-highlights TypeScript files in the diff", async ({ page }) => {
  await openFeatureDiff(page);
  const mathCard = page.getByTestId("file-card-math.ts");

  // Syntax highlighting is independent from the structured diff toggle: the
  // `export` keyword should be wrapped in a colored Shiki token by default.
  const exportToken = mathCard.locator("span[style*='color']", { hasText: "export" }).first();
  await expect(exportToken).toBeVisible({ timeout: 10_000 });

  // The string literal "a must be a number" should likewise carry a color.
  const stringToken = mathCard
    .locator("span[style*='color']", { hasText: "a must be a number" })
    .first();
  await expect(stringToken).toBeVisible();
});

test("structured highlighting is on by default and can be disabled from the gear menu", async ({
  page,
}) => {
  await openFeatureDiff(page);
  const bigCard = page.getByTestId("file-card-big.ts");

  // Default on: the same-line `const v20 = 20` -> `const v20 = 200` change
  // should render intra-line highlighted blocks.
  await expect(bigCard.getByText(/const v20/).first()).toBeVisible({ timeout: 10_000 });
  const wordBlocks = bigCard.locator('[class*="word-added"], [class*="word-removed"]');
  await expect(wordBlocks.first()).toBeVisible({ timeout: 10_000 });

  await page.getByTestId("settings-menu-button").click();
  const structureToggle = page.getByTestId("structured-highlighting-toggle");
  await expect(structureToggle).toHaveAttribute("aria-checked", "true");
  const postSettings = page.waitForResponse(
    (r) => r.url().includes("/api/settings") && r.request().method() === "POST",
  );
  await structureToggle.click();
  await postSettings;
  await expect(structureToggle).toHaveAttribute("aria-checked", "false");

  await expect(wordBlocks).toHaveCount(0);
});

test("structured highlighting preference persists across reload", async ({ page }) => {
  await openFeatureDiff(page);
  const wordBlocks = page
    .getByTestId("file-card-big.ts")
    .locator('[class*="word-added"], [class*="word-removed"]');

  await expect(wordBlocks.first()).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("settings-menu-button").click();
  const postSettings = page.waitForResponse(
    (r) => r.url().includes("/api/settings") && r.request().method() === "POST",
  );
  await page.getByTestId("structured-highlighting-toggle").click();
  await postSettings;
  await page.keyboard.press("Escape");
  await expect(wordBlocks).toHaveCount(0);

  await page.reload();
  await openFeatureDiff(page);
  await expect(
    page.getByTestId("file-card-big.ts").locator('[class*="word-added"], [class*="word-removed"]'),
  ).toHaveCount(0);
  await page.getByTestId("settings-menu-button").click();
  await expect(page.getByTestId("structured-highlighting-toggle")).toHaveAttribute(
    "aria-checked",
    "false",
  );
});

test("structured highlighting ignores rewrites but keeps spaces inside changed phrases", async ({
  page,
}) => {
  await openFeatureDiff(page);
  const card = page.getByTestId("file-card-structural.ts");
  await expect(card).toBeVisible({ timeout: 10_000 });

  const unrelatedRemovedCell = card.locator('td[class*="diff-removed"]', {
    hasText: "await settings.writeSettings(",
  });
  await expect(unrelatedRemovedCell).toBeVisible();
  await expect(
    unrelatedRemovedCell.locator('[class*="word-added"], [class*="word-removed"]'),
  ).toHaveCount(0);

  const relatedAddedRow = card.locator("tr", {
    hasText: 'key !== "wrapLines"',
  });
  await expect(relatedAddedRow).toBeVisible();
  const highlightedText = await relatedAddedRow.evaluate((row) =>
    Array.from(row.querySelectorAll<HTMLElement>('[class*="word-added"]'))
      .map((node) => node.textContent ?? "")
      .join(""),
  );
  expect(highlightedText).toContain('&& key !== "wrapLines"');
});

test("anchored changed-line highlight stays blue with subtle change tint in dark mode", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openFeatureDiff(page);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
    .toBe(true);

  const bigCard = page.getByTestId("file-card-big.ts");
  const changedRow = bigCard.locator("table tbody tr", { hasText: /const v20/ }).first();
  await expect(changedRow).toBeVisible({ timeout: 10_000 });
  await changedRow.locator("td").nth(3).click();
  await expect(changedRow).toHaveAttribute("data-anchored", "true");
  await expect
    .poll(() =>
      changedRow
        .locator("td")
        .nth(0)
        .evaluate((el) => getComputedStyle(el).boxShadow),
    )
    .not.toBe("none");
  await expect
    .poll(() =>
      changedRow
        .locator("td")
        .nth(3)
        .evaluate((el) => getComputedStyle(el).boxShadow),
    )
    .not.toBe("none");

  const removedCell = await renderedBackgroundRgb(changedRow.locator("td").nth(2));
  const addedCell = await renderedBackgroundRgb(changedRow.locator("td").nth(5));

  expect(addedCell.blue, addedCell.color).toBeGreaterThan(addedCell.red + 10);
  expect(addedCell.green, addedCell.color).toBeGreaterThan(addedCell.red + 10);
  expect(removedCell.blue, removedCell.color).toBeGreaterThan(removedCell.green + 10);
  expect(removedCell.red, removedCell.color).toBeGreaterThan(removedCell.green);
});
