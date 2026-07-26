import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { resetDiffsJson, staff, waitForInitialDiff } from "./helpers.ts";
import { SCRATCH_DIR } from "./setup.ts";

test.beforeEach(async () => {
  await resetDiffsJson();
});

test("editing the working tree refreshes the diff in the open UI", async ({ page }) => {
  const initialDiff = waitForInitialDiff(page);
  await page.goto("/");
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await initialDiff;

  const fname = "live-wt-marker.txt";
  const fpath = join(SCRATCH_DIR, fname);
  try {
    // A new working-tree file: the server's repo watcher broadcasts
    // repo:changed and the UI re-fetches files → a card appears.
    await writeFile(fpath, "hello from a working-tree edit\n");
    await expect(page.getByTestId(`file-card-${fname}`)).toBeVisible({ timeout: 8_000 });
  } finally {
    await rm(fpath, { force: true });
  }
  // Deleting it triggers another refresh → the card goes away.
  await expect(page.getByTestId(`file-card-${fname}`)).toHaveCount(0, { timeout: 8_000 });
});

test("a static commit↔commit diff ignores working-tree edits", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  // Make head a pinned commit (feature/improve-math) so the diff is
  // commit↔commit — neither side is the working tree.
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();

  const fname = "static-wt-marker.txt";
  const fpath = join(SCRATCH_DIR, fname);
  try {
    await writeFile(fpath, "should not appear in a static diff\n");
    // Give the watch/broadcast time; the new file must NOT show up because
    // a static diff can't change from a working-tree edit.
    await page.waitForTimeout(1500);
    await expect(page.getByTestId(`file-card-${fname}`)).toHaveCount(0);
  } finally {
    await rm(fpath, { force: true });
  }
});

test("CLI-added comment shows up in the open UI via WebSocket", async ({ page }) => {
  const initialDiff = waitForInitialDiff(page);
  await page.goto("/");
  // wait for initial diff load + WS hello
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await initialDiff;

  // Out-of-process CLI add — server's fs.watch should broadcast diff:changed
  await staff(["comment", "add", "--body", "live-update-marker", "--author", "cli"]);

  await expect(page.getByText("live-update-marker")).toBeVisible({ timeout: 5_000 });
});

test("CLI can create a line-range comment (--line + --end-line)", async ({ page }) => {
  const initialDiff = waitForInitialDiff(page);
  await page.goto("/");
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await initialDiff;

  const out = await staff([
    "comment",
    "add",
    "--file",
    "math.ts",
    "--line",
    "1",
    "--end-line",
    "3",
    "--side",
    "new",
    "--body",
    "range from cli",
    "--author",
    "cli",
  ]);
  const comment = JSON.parse(out);
  expect(comment.line).toBe(1);
  expect(comment.endLine).toBe(3);

  // The sidebar inline-thread label reflects the line span.
  const label = page.getByTestId(`sidebar-inline-thread-${comment.threadId}`);
  await expect(label).toBeVisible({ timeout: 5_000 });
  await expect(label).toContainText("math.ts:1-3");
});

test("CLI resolution updates the UI", async ({ page }) => {
  const initialDiff = waitForInitialDiff(page);
  await page.goto("/");
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await initialDiff;

  const out = await staff(["comment", "add", "--body", "resolve-me", "--author", "cli"]);
  const comment = JSON.parse(out);

  await expect(page.getByText("resolve-me")).toBeVisible({ timeout: 5_000 });

  await staff([
    "comment",
    "resolve",
    "--thread",
    comment.threadId,
    "--status",
    "fixed",
    "--body",
    "Fixed in commit abc1234",
  ]);

  // Fixed/Skipped threads collapse — the resolution body is not shown in
  // the UI anymore, just the badge. Wait for the collapsed-fixed strip.
  await expect(page.getByTestId("thread-collapsed-fixed")).toBeVisible({ timeout: 5_000 });
});
