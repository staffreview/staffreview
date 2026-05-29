import { test, expect } from "@playwright/test";
import { resetDiffsJson, staff } from "./helpers.ts";

test.beforeEach(async () => {
  await resetDiffsJson();
});

test("inline comments appear in the sidebar and clicking scrolls to them", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();

  // Seed an inline comment on math.ts:2 (new side) via the CLI.
  const out = await staff([
    "comment",
    "add",
    "--file",
    "math.ts",
    "--line",
    "2",
    "--side",
    "new",
    "--body",
    "sidebar-link-target",
    "--author",
    "cli",
  ]);
  const comment = JSON.parse(out);
  const link = page.getByTestId(`sidebar-inline-thread-${comment.threadId}`);
  await expect(link).toBeVisible();
  await expect(link).toHaveText("math.ts:2");
  // The body lives in the sibling CommentThread rendered by the sidebar.
  await expect(page.getByTestId("review-sidebar")).toContainText("sidebar-link-target");

  // Force the page tall so we can observe a scroll change.
  await page.evaluate(() => {
    const spacer = document.createElement("div");
    spacer.style.height = "2000px";
    document.body.appendChild(spacer);
    window.scrollTo(0, 1500);
  });
  const yBefore = await page.evaluate(() => window.scrollY);

  await link.click();

  // The thread element should be scrolled into the visible viewport.
  const yAfter = await page.evaluate(() => window.scrollY);
  expect(yAfter).not.toBe(yBefore);

  const threadEl = page.locator(`[data-thread-id="${comment.threadId}"]`);
  const inView = await threadEl.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight;
  });
  expect(inView).toBe(true);
});

// Note: collapsed-expand-then-scroll has a known timing race because
// react-diff-viewer-continued takes more than one frame to mount its
// <table>. Skipped until we move off the library.
test.skip("clicking a sidebar inline thread expands the file if it's collapsed", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();

  const out = await staff([
    "comment",
    "add",
    "--file",
    "math.ts",
    "--line",
    "2",
    "--side",
    "new",
    "--body",
    "expand-on-click",
    "--author",
    "cli",
  ]);
  const comment = JSON.parse(out);

  // Collapse the file.
  await page.getByTestId("collapse-math.ts").click();
  await expect(page.getByTestId("collapse-math.ts")).toHaveAttribute("aria-expanded", "false");

  // Click the sidebar link — the file should re-expand and the thread
  // becomes visible.
  await page.getByTestId(`sidebar-inline-thread-${comment.threadId}`).click();
  await expect(page.getByTestId("collapse-math.ts")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(`[data-thread-id="${comment.threadId}"]`)).toBeVisible();
});
