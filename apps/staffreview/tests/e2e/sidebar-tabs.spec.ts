import { test, expect } from "@playwright/test";
import { resetDiffsJson } from "./helpers.ts";

test.beforeEach(async () => {
  await resetDiffsJson();
});

test("sidebar has Comments/Files tabs; Files badge counts the diff", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();

  // Tabs render with Comments selected by default.
  const commentsTab = page.getByTestId("sidebar-tab-comments");
  const filesTab = page.getByTestId("sidebar-tab-files");
  await expect(commentsTab).toBeVisible();
  await expect(filesTab).toBeVisible();
  await expect(commentsTab).toHaveAttribute("data-state", "on");

  // The Files badge reports the number of files in the diff — it should
  // match the number of file cards rendered on the page.
  const fileCardCount = await page.locator('[data-testid^="file-card-"]').count();
  expect(fileCardCount).toBeGreaterThan(0);
  await expect(filesTab).toContainText(String(fileCardCount));

  // Switching to Files reveals the file list with one entry per file card.
  await filesTab.click();
  await expect(filesTab).toHaveAttribute("data-state", "on");
  await expect(page.getByTestId("sidebar-files-list")).toBeVisible();
  await expect(page.getByTestId("sidebar-file-math.ts")).toBeVisible();
  await expect(page.locator('[data-testid^="sidebar-file-"]')).toHaveCount(fileCardCount);
});

test("clicking a file in the Files tab scrolls that file's card into view", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();

  // Pad the page so scrolling is observable, then scroll to the bottom.
  await page.evaluate(() => {
    const s = document.createElement("div");
    s.style.height = "2000px";
    document.body.appendChild(s);
    window.scrollTo(0, 1800);
  });
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(0);

  await page.getByTestId("sidebar-tab-files").click();
  await page.getByTestId("sidebar-file-math.ts").click();

  await page.waitForTimeout(700);
  const after = await page.evaluate(() => window.scrollY);
  expect(after).toBeLessThan(before);
});

test("the New comment button is icon-only and switches back to the Comments tab", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();

  // The icon-only button has aria-label "New comment" but no visible text.
  const newCommentBtn = page.getByTestId("sidebar-new-comment-icon");
  await expect(newCommentBtn).toBeVisible();
  await expect(newCommentBtn).toHaveAttribute("aria-label", "New comment");
  await expect(await newCommentBtn.textContent()).toBe("");

  // While on the Files tab, clicking New comment flips back to Comments
  // and opens the composer.
  await page.getByTestId("sidebar-tab-files").click();
  await newCommentBtn.click();
  await expect(page.getByTestId("sidebar-tab-comments")).toHaveAttribute("data-state", "on");
  await expect(page.getByTestId("comment-editor")).toBeVisible();
});
