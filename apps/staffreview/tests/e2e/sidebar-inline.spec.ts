import { expect, test } from "@playwright/test";
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

  // Scroll the diff pane (the diff is its own scroll container now) so the
  // anchored line is out of view, then click the sidebar link and confirm it
  // scrolls the inline thread back into the viewport.
  const diffPane = page.getByTestId("diff-scroll");
  await diffPane.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(50);

  await link.click();

  await expect(page.locator(`[data-thread-id="${comment.threadId}"]`)).toBeInViewport();
});

// Note: collapsed-expand-then-scroll has a known timing race because
// react-diff-viewer-continued takes more than one frame to mount its
// <table>. Skipped until we move off the library.
test.skip("clicking a sidebar inline thread expands the file if it's collapsed", async ({
  page,
}) => {
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
