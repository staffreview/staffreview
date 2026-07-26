import { rm } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { gotoInitialDiff, resetDiffsJson } from "./helpers.ts";
import { STAFF_CONFIG_DIR } from "./setup.ts";

test.beforeEach(async () => {
  await resetDiffsJson();
  await rm(STAFF_CONFIG_DIR, { recursive: true, force: true });
});

test("settings menu aligns to the gear button after Refresh", async ({ page }) => {
  await page.goto("/");

  const gear = page.getByTestId("settings-menu-button");
  const refresh = page.getByTestId("header-refresh");
  await expect(gear).toBeVisible();
  await expect(refresh).toBeVisible();

  const gearBox = await gear.boundingBox();
  const refreshBox = await refresh.boundingBox();
  expect(gearBox).not.toBeNull();
  expect(refreshBox).not.toBeNull();
  expect(gearBox!.x).toBeLessThan(refreshBox!.x);

  await gear.click();
  const menu = page.locator('[data-slot="dropdown-menu-content"]');
  await expect(menu).toBeVisible();

  const openedGearBox = await gear.boundingBox();
  const menuBox = await menu.boundingBox();
  expect(openedGearBox).not.toBeNull();
  expect(menuBox).not.toBeNull();
  expect(
    Math.abs(menuBox!.x + menuBox!.width - (openedGearBox!.x + openedGearBox!.width)),
  ).toBeLessThanOrEqual(1);
});

test("header Refresh re-runs the diff fetch", async ({ page }) => {
  await gotoInitialDiff(page);

  const refresh = page.getByTestId("header-refresh");
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

  // Click the header Refresh button.
  await page.getByTestId("header-refresh").click();

  // The new /api/diff POST returns the comment, which should render.
  await expect(page.getByText("REFRESH-TARGET")).toBeVisible();
});

test("Reset to defaults requires confirmation and restores menu settings", async ({ page }) => {
  await page.request.post("/api/settings", {
    data: {
      splitView: false,
      diffFontSize: 17,
      theme: "dark",
      structuredHighlighting: false,
      wrapLines: false,
      filesExpandedByDefault: true,
      openBrowser: false,
      loopMaxRounds: 6,
      reviewAgents: 3,
      sectionAgents: 4,
      docsAgents: 7,
    },
  });

  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
    .toBe(true);
  await page.getByTestId("settings-menu-button").click();

  await expect(page.getByTestId("view-mode-unified")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("structured-highlighting-toggle")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(page.getByTestId("wrap-lines-toggle")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("files-collapse-toggle")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("diff-font-size")).toHaveText("17px");
  await expect(page.getByTestId("theme-dark")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("open-browser-auto")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("loop-rounds-value")).toHaveText("6 rounds max");
  await expect(page.getByTestId("review-agents-value")).toHaveText("3 agents");
  await expect(page.getByTestId("section-agents-value")).toHaveText("4 agents");
  await expect(page.getByTestId("docs-agents-value")).toHaveText("7 agents");

  const resetButton = page.getByTestId("settings-reset-button");
  await resetButton.scrollIntoViewIfNeeded();
  await resetButton.click();
  await expect(page.getByRole("dialog", { name: "Reset settings?" })).toBeVisible();
  await page.getByTestId("settings-reset-cancel").click();
  await expect(page.getByRole("dialog", { name: "Reset settings?" })).toHaveCount(0);
  await expect(page.getByTestId("view-mode-unified")).toHaveAttribute("aria-checked", "true");

  await resetButton.scrollIntoViewIfNeeded();
  await resetButton.click();
  const postSettings = page.waitForResponse(
    (r) => r.url().includes("/api/settings") && r.request().method() === "POST",
  );
  await page.getByTestId("settings-reset-confirm").click();
  await postSettings;

  await page.getByTestId("settings-menu-button").click();
  await expect(page.getByTestId("view-mode-unified")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("structured-highlighting-toggle")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByTestId("wrap-lines-toggle")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("files-collapse-toggle")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("diff-font-size")).toHaveText("14px");
  await expect(page.getByTestId("theme-system")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("open-browser-auto")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("loop-rounds-value")).toHaveText("5 rounds max");
  await expect(page.getByTestId("review-agents-value")).toHaveText("2 agents");
  await expect(page.getByTestId("section-agents-value")).toHaveText("2 agents");
  await expect(page.getByTestId("docs-agents-value")).toHaveText("5 agents");
});
