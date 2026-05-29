import { test, expect } from "@playwright/test";
import { resetDiffsJson } from "./helpers.ts";

test.beforeEach(async () => {
  // Clear any persisted sidebar state so tests start from the default (open).
  await resetDiffsJson();
});

test("sidebar collapses and expands; state persists across reloads", async ({ page }) => {
  await page.goto("/");
  await page.waitForResponse((r) => r.url().includes("/api/diff") && r.request().method() === "POST");

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
  await page.waitForResponse((r) => r.url().includes("/api/diff") && r.request().method() === "POST");
  await expect(page.getByTestId("review-sidebar")).toHaveAttribute("data-state", "collapsed");
  await expect(page.getByTestId("sidebar-toggle")).toHaveAttribute("aria-pressed", "true");

  // Click again to re-open.
  await page.getByTestId("sidebar-toggle").click();
  await expect(page.getByTestId("review-sidebar")).toHaveAttribute("data-state", "open");
  await expect(page.getByTestId("sidebar-toggle")).toHaveAttribute("aria-pressed", "false");
});

test("collapsed-strip Plus button expands the sidebar, opens the composer, and focuses the editor", async ({ page }) => {
  await page.goto("/");
  await page.waitForResponse((r) => r.url().includes("/api/diff") && r.request().method() === "POST");

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

test("collapsed strip buttons share an X column with the header's gear button", async ({ page }) => {
  await page.goto("/");
  await page.waitForResponse((r) => r.url().includes("/api/diff") && r.request().method() === "POST");

  // Collapse the sidebar.
  await page.getByTestId("sidebar-toggle").click();
  await expect(page.getByTestId("review-sidebar")).toHaveAttribute("data-state", "collapsed");

  const gearBox = await page.getByTestId("settings-menu-button").boundingBox();
  const toggleBox = await page.getByTestId("sidebar-toggle").boundingBox();
  const plusBox = await page.getByTestId("sidebar-new-comment").boundingBox();

  if (!gearBox || !toggleBox || !plusBox) throw new Error("missing bounding box");

  // All three live in the same vertical column — their right edges should
  // line up within a 2px tolerance for sub-pixel rendering.
  expect(Math.abs(gearBox.x + gearBox.width - (toggleBox.x + toggleBox.width))).toBeLessThanOrEqual(2);
  expect(Math.abs(gearBox.x + gearBox.width - (plusBox.x + plusBox.width))).toBeLessThanOrEqual(2);
});

test("sidebar does not visibly shift when the page scrolls", async ({ page }) => {
  await page.goto("/");
  // Pick a comparison with enough diff to make the page scrollable.
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();

  // Force the page to be tall enough to scroll, then capture top before/after.
  await page.evaluate(() => {
    const spacer = document.createElement("div");
    spacer.style.height = "2000px";
    document.body.appendChild(spacer);
  });

  const sidebar = page.getByTestId("review-sidebar");
  const before = await sidebar.boundingBox();
  if (!before) throw new Error("no bounding box");

  await page.evaluate(() => window.scrollTo(0, 300));
  await page.waitForTimeout(50);
  const after = await sidebar.boundingBox();
  if (!after) throw new Error("no bounding box");

  // The sticky sidebar's top should be at the same viewport-relative y as
  // before scrolling — no jump.
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
});

test("Storage card and Review heading are gone from the sidebar", async ({ page }) => {
  await page.goto("/");
  await page.waitForResponse((r) => r.url().includes("/api/diff") && r.request().method() === "POST");
  await expect(page.getByText("Storage", { exact: true })).toHaveCount(0);
  await expect(page.locator("text=.staffreview/diffs/")).toHaveCount(0);
  // The "Review · N threads" heading was replaced by the collapse button.
  await expect(page.getByText(/Review · \d+ thread/)).toHaveCount(0);
});
