import { test, expect } from "@playwright/test";
import { resetDiffsJson } from "./helpers.ts";

test.beforeEach(async () => {
  await resetDiffsJson();
});

test("Shiki syntax-highlights TypeScript files in the diff", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();

  const mathCard = page.getByTestId("file-card-math.ts");
  // The `export` keyword should be wrapped in a colored span produced by
  // Shiki's per-token output.
  const exportToken = mathCard.locator("span[style*='color']", { hasText: "export" }).first();
  await expect(exportToken).toBeVisible({ timeout: 10_000 });

  // The string literal "a must be a number" should likewise carry a color.
  const stringToken = mathCard
    .locator("span[style*='color']", { hasText: "a must be a number" })
    .first();
  await expect(stringToken).toBeVisible();
});
