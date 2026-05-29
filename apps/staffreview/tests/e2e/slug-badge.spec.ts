import { test, expect } from "@playwright/test";
import { resetDiffsJson } from "./helpers.ts";

test.beforeEach(async () => {
  await resetDiffsJson();
});

test("slug badge pins the default base to the current branch's commit", async ({ page }) => {
  await page.goto("/");
  const slug = page.getByTestId("diff-slug");
  await expect(slug).toBeVisible();
  // Branches are pinned to their current commit, so the slug uses the
  // 40-char SHA rather than the moving branch name.
  await expect(slug).toHaveText(/^[0-9a-f]{40}\.\.WT$/);
});

test("clicking the slug badge copies it to the clipboard", async ({ page, context, browserName }) => {
  // The clipboard API requires the page to have permission.
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  await page.goto("/");
  const slug = page.getByTestId("diff-slug");
  await expect(slug).toBeVisible();
  const slugText = (await page.getByTestId("diff-slug-text").textContent())!.trim();

  await slug.click();

  // The slug text stays put; a green check icon appears next to it.
  await expect(page.getByTestId("diff-slug-text")).toHaveText(slugText);
  await expect(page.getByTestId("diff-slug-copied")).toBeVisible();

  // Verify what actually landed on the clipboard.
  const fromClipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(fromClipboard).toBe(slugText);

  // Check icon goes away after the timeout.
  await expect(page.getByTestId("diff-slug-copied")).toHaveCount(0, { timeout: 3_000 });
});
