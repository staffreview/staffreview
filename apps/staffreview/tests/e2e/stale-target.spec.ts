import { test, expect } from "@playwright/test";
import { resetDiffsJson } from "./helpers.ts";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SCRATCH_DIR } from "./setup.ts";

test.beforeEach(async () => {
  await resetDiffsJson();
});

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: SCRATCH_DIR, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")}: ${stderr}`)),
    );
  });
}

test("a banner appears when the branch base is pinned to advances", async ({ page }) => {
  await page.goto("/");
  await page.waitForResponse((r) => r.url().includes("/api/diff") && r.request().method() === "POST");
  // The default base is already pinned to main's current commit.
  await expect(page.getByTestId("stale-target-banner")).toHaveCount(0);

  // Create a new commit on main outside the page's lifecycle.
  await writeFile(join(SCRATCH_DIR, "BANNER.md"), "new file\n");
  await run("git", ["add", "BANNER.md"]);
  await run("git", ["commit", "-qm", "advance main"]);

  // Force a refs refresh by toggling page visibility — the polling interval
  // also covers this but we don't want to wait 15s in a test.
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

  await expect(page.getByTestId("stale-target-banner")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("stale-target-banner")).toContainText("main");

  // Clicking "Update base" should refresh the slug to a new SHA.
  const oldSlug = (await page.getByTestId("diff-slug").textContent())!;
  await page.getByTestId("update-base-to-latest").click();
  await expect(page.getByTestId("stale-target-banner")).toHaveCount(0);
  await expect.poll(async () => (await page.getByTestId("diff-slug").textContent()) !== oldSlug).toBe(true);
});

test("the banner is dismissible with the X button, until a newer commit lands", async ({ page }) => {
  await page.goto("/");
  await page.waitForResponse((r) => r.url().includes("/api/diff") && r.request().method() === "POST");

  // Advance main once → banner appears.
  await writeFile(join(SCRATCH_DIR, "DISMISS1.md"), "one\n");
  await run("git", ["add", "DISMISS1.md"]);
  await run("git", ["commit", "-qm", "advance once"]);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByTestId("stale-target-banner")).toBeVisible({ timeout: 5_000 });

  // Dismiss with X — banner goes away and stays away even after re-poll.
  await page.getByTestId("stale-target-dismiss").click();
  await expect(page.getByTestId("stale-target-banner")).toHaveCount(0);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(300);
  await expect(page.getByTestId("stale-target-banner")).toHaveCount(0);

  // Land a *newer* commit → banner returns (the dismissal was for the
  // previous SHA only).
  await writeFile(join(SCRATCH_DIR, "DISMISS2.md"), "two\n");
  await run("git", ["add", "DISMISS2.md"]);
  await run("git", ["commit", "-qm", "advance again"]);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByTestId("stale-target-banner")).toBeVisible({ timeout: 5_000 });
});
