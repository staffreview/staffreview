import { expect, test } from "@playwright/test";
import { resetDiffsJson } from "./helpers.ts";

test.beforeEach(async () => {
  await resetDiffsJson();
});

test("base picker typeahead filters refs and ranks an exact name match first", async ({ page }) => {
  await page.goto("/");
  await page.waitForResponse(
    (r) => r.url().includes("/api/diff") && r.request().method() === "POST",
  );

  await page.getByTestId("target-picker-base-button").click();
  const search = page.getByPlaceholder(/Search refs/);
  await expect(search).toBeVisible();

  // Sanity: before filtering, both branches are listed.
  await expect(page.getByRole("option", { name: /feature\/improve-math/ })).toBeVisible();

  // Type "main" — the list should actually filter: feature/improve-math
  // (no "main" subsequence) drops out, and the `main` branch remains.
  await search.fill("main");
  await expect(page.getByRole("option", { name: /feature\/improve-math/ })).toHaveCount(0);

  const options = page.getByRole("option");
  await expect(options.first()).toBeVisible();
  // The exact-name `main` branch is the top result.
  await expect(options.first()).toContainText("main");
});

test("branch list is capped when idle, expandable via View more, fully searchable", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForResponse(
    (r) => r.url().includes("/api/diff") && r.request().method() === "POST",
  );

  await page.getByTestId("target-picker-base-button").click();

  // The fixture has 7 branches (> the cap of 5). Idle, the list is capped
  // and a "View more" button appears; at least one legacy branch is hidden.
  const viewMore = page.getByTestId("view-more-branches");
  await expect(viewMore).toBeVisible();
  await expect(page.getByRole("option", { name: /legacy\/branch-5/ })).toHaveCount(0);
  // The selected main branch and the newest branch are shown.
  await expect(page.getByRole("option", { name: /\bmain\b/ }).first()).toBeVisible();
  await expect(page.getByRole("option", { name: /feature\/improve-math/ })).toBeVisible();

  // Clicking "View more" reveals the rest (next batch of 10).
  await viewMore.click();
  await expect(page.getByRole("option", { name: /legacy\/branch-5/ })).toBeVisible();
  await expect(page.getByTestId("view-more-branches")).toHaveCount(0);
});

test("tag list is capped, expandable, and keeps the selected hidden tag visible", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForResponse(
    (r) => r.url().includes("/api/diff") && r.request().method() === "POST",
  );

  await page.getByTestId("target-picker-base-button").click();

  await expect(page.getByRole("option", { name: /tag\/release-/ })).toHaveCount(5);
  await expect(page.getByRole("option", { name: /tag\/release-old/ })).toHaveCount(0);
  const viewMore = page.getByTestId("view-more-tags");
  await expect(viewMore).toBeVisible();

  await viewMore.click();
  await expect(page.getByRole("option", { name: /tag\/release-/ })).toHaveCount(7);
  await expect(page.getByTestId("view-more-tags")).toHaveCount(0);

  const diffReload = page.waitForResponse(
    (r) => r.url().includes("/api/diff") && r.request().method() === "POST",
  );
  await page.getByRole("option", { name: /tag\/release-old/ }).click();
  await diffReload;

  await page.getByTestId("target-picker-base-button").click();
  await expect(page.getByRole("option", { name: /tag\/release-old/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /tag\/release-/ })).toHaveCount(6);
  await expect(page.getByTestId("view-more-tags")).toHaveText("View 1 more");
});

test("search results are not capped", async ({ page }) => {
  await page.goto("/");
  await page.waitForResponse(
    (r) => r.url().includes("/api/diff") && r.request().method() === "POST",
  );

  await page.getByTestId("target-picker-base-button").click();
  // Typing a query that matches all legacy branches shows them all with no
  // "View more" cap.
  await page.getByPlaceholder(/Search refs/).fill("legacy/branch");
  await expect(page.getByRole("option", { name: /legacy\/branch-5/ })).toBeVisible();
  await expect(page.getByTestId("view-more-branches")).toHaveCount(0);
});
