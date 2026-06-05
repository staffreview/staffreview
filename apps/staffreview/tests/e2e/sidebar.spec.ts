import { expect, test } from "@playwright/test";
import { resetDiffsJson } from "./helpers.ts";

test.beforeEach(async () => {
  // Clear any persisted sidebar state so tests start from the default (open).
  await resetDiffsJson();
});

test("sidebar collapses and expands; state persists across reloads", async ({ page }) => {
  await page.goto("/");
  await page.waitForResponse(
    (r) => r.url().includes("/api/diff") && r.request().method() === "POST",
  );

  // Default: sidebar open with content visible.
  const sidebar = page.getByTestId("review-sidebar");
  await expect(sidebar).toHaveAttribute("data-state", "open");
  await expect(sidebar.getByRole("button", { name: /new comment/i })).toBeVisible();

  // Toggle inside the sidebar — clicking collapses it to a thin strip.
  const collapseToggle = page.getByTestId("sidebar-toggle");
  await expect(collapseToggle).toHaveAttribute("aria-pressed", "false");
  await collapseToggle.click();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");

  // The collapsed strip contains the toggle and a quick "New comment" Plus
  // button, but not the wide "New comment" text button from the open sidebar.
  await expect(sidebar.locator("button:has-text('New comment')")).toHaveCount(0);
  const expandToggle = sidebar.getByTestId("sidebar-toggle");
  await expect(expandToggle).toBeVisible();
  await expect(expandToggle).toHaveAttribute("aria-pressed", "true");
  await expect(sidebar.getByTestId("sidebar-new-comment")).toBeVisible();

  // Reload — state should persist via localStorage.
  await page.reload();
  await page.waitForResponse(
    (r) => r.url().includes("/api/diff") && r.request().method() === "POST",
  );
  await expect(page.getByTestId("review-sidebar")).toHaveAttribute("data-state", "collapsed");
  await expect(page.getByTestId("sidebar-toggle")).toHaveAttribute("aria-pressed", "true");

  // Click again to re-open.
  await page.getByTestId("sidebar-toggle").click();
  await expect(page.getByTestId("review-sidebar")).toHaveAttribute("data-state", "open");
  await expect(page.getByTestId("sidebar-toggle")).toHaveAttribute("aria-pressed", "false");
});

test("collapsed-strip Plus button expands the sidebar, opens the composer, and focuses the editor", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForResponse(
    (r) => r.url().includes("/api/diff") && r.request().method() === "POST",
  );

  // Collapse the sidebar first.
  await page.getByTestId("sidebar-toggle").click();
  await expect(page.getByTestId("review-sidebar")).toHaveAttribute("data-state", "collapsed");

  // Click the strip's Plus button.
  await page.getByTestId("sidebar-new-comment").click();

  // Sidebar is now open and the composer is mounted.
  await expect(page.getByTestId("review-sidebar")).toHaveAttribute("data-state", "open");
  const editor = page.getByTestId("comment-editor");
  await expect(editor).toBeVisible();

  // The editor should be focused — type immediately and the text should land there.
  await page.keyboard.type("typed-after-plus-click");
  await expect(editor).toContainText("typed-after-plus-click");
});

test("header live badge keeps right padding and collapsed strip buttons align", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForResponse(
    (r) => r.url().includes("/api/diff") && r.request().method() === "POST",
  );

  // Collapse the sidebar.
  await page.getByTestId("sidebar-toggle").click();
  await expect(page.getByTestId("review-sidebar")).toHaveAttribute("data-state", "collapsed");

  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  const liveBox = await page.getByText("Live", { exact: true }).boundingBox();
  const toggleBox = await page.getByTestId("sidebar-toggle").boundingBox();
  const plusBox = await page.getByTestId("sidebar-new-comment").boundingBox();

  if (!liveBox || !toggleBox || !plusBox) throw new Error("missing bounding box");

  const viewportWidth = await page.evaluate(() => window.innerWidth);
  expect(viewportWidth - (liveBox.x + liveBox.width)).toBeGreaterThanOrEqual(14);

  // The collapsed sidebar controls still share a vertical column.
  expect(Math.abs(toggleBox.x + toggleBox.width - (plusBox.x + plusBox.width))).toBeLessThanOrEqual(
    2,
  );
});

test("the diff and sidebar are independent scroll panes; the page itself doesn't scroll", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();

  // Desktop layout is fixed to the viewport — the page (document) itself does
  // not scroll; each pane owns its own scrollbar instead. This is what keeps
  // the diff's scrollbar between the panes and the sidebar's on the right.
  const pageScrolls = await page.evaluate(
    () => document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
  );
  expect(pageScrolls).toBe(false);

  const overflowY = (testId: string) =>
    page.getByTestId(testId).evaluate((el) => getComputedStyle(el).overflowY);
  expect(await overflowY("diff-scroll")).toMatch(/auto|scroll/);
  expect(await overflowY("review-sidebar")).toMatch(/auto|scroll/);
});

test("Storage card and Review heading are gone from the sidebar", async ({ page }) => {
  await page.goto("/");
  await page.waitForResponse(
    (r) => r.url().includes("/api/diff") && r.request().method() === "POST",
  );
  await expect(page.getByText("Storage", { exact: true })).toHaveCount(0);
  await expect(page.locator("text=.staffreview/diffs/")).toHaveCount(0);
  // The "Review · N threads" heading was replaced by the collapse button.
  await expect(page.getByText(/Review · \d+ thread/)).toHaveCount(0);
});
