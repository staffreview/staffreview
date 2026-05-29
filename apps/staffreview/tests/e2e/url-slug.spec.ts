import { test, expect } from "@playwright/test";
import { resetDiffsJson } from "./helpers.ts";

test.beforeEach(async () => {
  await resetDiffsJson();
});

test("active diff slug is reflected in the URL as ?diff=", async ({ page }) => {
  await page.goto("/");
  await page.waitForResponse((r) => r.url().includes("/api/diff") && r.request().method() === "POST");
  // Default base is pinned to the current branch's commit SHA, head is WT.
  await expect.poll(() => new URL(page.url()).searchParams.get("diff")).toMatch(
    /^[0-9a-f]{40}\.\.WT$/,
  );

  // Switching head to a branch should update the URL — head is also SHA-pinned.
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("diff")).toMatch(
    /^[0-9a-f]{40}\.\.[0-9a-f]{40}$/,
  );
});

test("loading the page with ?diff=<slug> opens that diff", async ({ page }) => {
  // First, open the diff in the UI so the JSON file (with the real
  // un-sanitized refs) is persisted under .staffreview/diffs/.
  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();
  const slug = await page.getByTestId("diff-slug").textContent();
  expect(slug).toBeTruthy();

  // Now simulate a recipient opening the share link in a fresh tab.
  // Use a separate context so localStorage doesn't carry over.
  const recipient = await page.context().browser()!.newContext();
  const tab = await recipient.newPage();
  await tab.goto(`http://localhost:4823/?diff=${encodeURIComponent(slug!)}`);
  await expect(tab.getByText("math.ts", { exact: true }).first()).toBeVisible();
  await expect(tab.getByTestId("diff-slug")).toHaveText(slug!);
  await recipient.close();
});
