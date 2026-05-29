import { test, expect } from "@playwright/test";
import { resetDiffsJson } from "./helpers.ts";

test.beforeEach(async () => {
  await resetDiffsJson();
});

test("gear menu opens and Refresh re-runs the diff fetch", async ({ page }) => {
  await page.goto("/");
  await page.waitForResponse((r) => r.url().includes("/api/diff") && r.request().method() === "POST");

  // Refresh is hidden inside the menu now, not in the header.
  await expect(page.getByRole("button", { name: /^Refresh$/ })).toHaveCount(0);

  await page.getByTestId("settings-menu-button").click();
  const refresh = page.getByTestId("settings-menu-refresh");
  await expect(refresh).toBeVisible();

  // Clicking Refresh should issue a POST /api/diff
  const post = page.waitForResponse(
    (r) => r.url().includes("/api/diff") && r.request().method() === "POST",
  );
  await refresh.click();
  await post;
});

test("Refresh re-fetches the diff and surfaces new comments", async ({ page }) => {
  // Stub /api/diff responses so the test is independent of WS timing,
  // StrictMode double-mounts, and on-disk state. First response is empty;
  // after Refresh, the same endpoint returns the comment.
  let phase: "before" | "after" = "before";
  const slug = "STUB-SLUG";
  const baseDiff = {
    slug,
    base: { kind: "ref", ref: "HEAD" },
    head: { kind: "working-tree" },
    comments: [] as any[],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  await page.route("**/api/diff*", async (route) => {
    const m = route.request().method();
    if (m !== "GET" && m !== "POST") return route.fallback();
    const comments =
      phase === "after"
        ? [
            {
              id: "stub-1",
              threadId: "stub-1",
              body: "REFRESH-TARGET",
              author: "cli",
              createdAt: "2026-01-01T00:01:00Z",
            },
          ]
        : [];
    const body = { diff: { ...baseDiff, comments } };
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await page.goto("/");
  // Wait for the page to fully settle (covers React StrictMode's double-effect
  // in dev, which can fire a second POST after the first one resolves).
  await page.waitForLoadState("networkidle");
  // The sidebar's "New comment" button is rendered once the diff is loaded.
  await expect(
    page.getByTestId("review-sidebar").getByRole("button", { name: /new comment/i }),
  ).toBeVisible();

  // Initial render: no marker.
  await expect(page.getByText("REFRESH-TARGET")).toHaveCount(0);

  // Out-of-band change: the next /api/diff response will include the comment.
  phase = "after";

  // Without clicking Refresh, the page should not re-fetch.
  await page.waitForTimeout(300);
  await expect(page.getByText("REFRESH-TARGET")).toHaveCount(0);

  // Open the gear menu and click Refresh.
  await page.getByTestId("settings-menu-button").click();
  await page.getByTestId("settings-menu-refresh").click();

  // The new /api/diff POST returns the comment, which should render.
  await expect(page.getByText("REFRESH-TARGET")).toBeVisible();
});
