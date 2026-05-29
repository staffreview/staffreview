import { test, expect } from "@playwright/test";
import { resetDiffsJson } from "./helpers.ts";

test.beforeEach(async () => {
  await resetDiffsJson();
});

test("clicking the copy-path button copies the file path to the clipboard", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();

  await page.getByTestId("copy-path-math.ts").click();

  const fromClipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(fromClipboard).toBe("math.ts");
});

test("Comment on file button is gone from the file header", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();

  const mathCard = page.getByTestId("file-card-math.ts");
  await expect(mathCard.getByRole("button", { name: /comment on file/i })).toHaveCount(0);

  // The status badge should sit on the right side of the header.
  const badge = mathCard.locator("div").first().getByText(/Modified|Added|Deleted/i).first();
  await expect(badge).toBeVisible();
});
