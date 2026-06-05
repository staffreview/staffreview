import { expect, test } from "@playwright/test";

test("the tab title shows the project being reviewed", async ({ page }) => {
  await page.goto("/");
  // The scratch repo's directory basename is "repo" (tests/e2e/.tmp/repo).
  await expect(page).toHaveTitle("Staff Review: repo");
});
