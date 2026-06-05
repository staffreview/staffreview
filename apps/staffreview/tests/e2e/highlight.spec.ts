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

test("structured highlighting is off by default and can be enabled from the gear menu", async ({
  page,
}) => {
  await openFeatureDiff(page);
  const bigCard = page.getByTestId("file-card-big.ts");

  // Default off: the same-line `const v20 = 20` -> `const v20 = 200` change
  // should render as a changed row without intra-line highlighted blocks.
  // Anchor to a rendered line first so the count-0 assertion proves the
  // feature is off rather than just passing because the card hasn't mounted.
  await expect(bigCard.getByText(/const v20/).first()).toBeVisible({ timeout: 10_000 });
  const wordBlocks = bigCard.locator('[class*="word-added"], [class*="word-removed"]');
  await expect(wordBlocks).toHaveCount(0);

  await page.getByTestId("settings-menu-button").click();
  await expect(page.getByTestId("structured-highlighting-off")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  const postSettings = page.waitForResponse(
    (r) => r.url().includes("/api/settings") && r.request().method() === "POST",
  );
  await page.getByTestId("structured-highlighting-on").click();
  await postSettings;
  await expect(page.getByTestId("structured-highlighting-on")).toHaveAttribute(
    "aria-checked",
    "true",
  );

  // Enabled: react-diff-viewer's word diff should paint the changed blocks
  // inside the line.
  await expect(wordBlocks.first()).toBeVisible({ timeout: 10_000 });
});

test("structured highlighting preference persists across reload", async ({ page }) => {
  await openFeatureDiff(page);
  const wordBlocks = page
    .getByTestId("file-card-big.ts")
    .locator('[class*="word-added"], [class*="word-removed"]');

  await page.getByTestId("settings-menu-button").click();
  const postSettings = page.waitForResponse(
    (r) => r.url().includes("/api/settings") && r.request().method() === "POST",
  );
  await page.getByTestId("structured-highlighting-on").click();
  await postSettings;
  await page.keyboard.press("Escape");
  await expect(wordBlocks.first()).toBeVisible({ timeout: 10_000 });

  await page.reload();
  await openFeatureDiff(page);
  await expect(
    page
      .getByTestId("file-card-big.ts")
      .locator('[class*="word-added"], [class*="word-removed"]')
      .first(),
  ).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("settings-menu-button").click();
  await expect(page.getByTestId("structured-highlighting-on")).toHaveAttribute(
    "aria-checked",
    "true",
  );
});
