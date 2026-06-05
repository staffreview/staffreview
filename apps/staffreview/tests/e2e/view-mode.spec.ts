import { rm } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { resetDiffsJson } from "./helpers.ts";
import { STAFF_CONFIG_DIR } from "./setup.ts";

test.beforeEach(async () => {
  await resetDiffsJson();
  // Reset the per-test isolated global settings so each test starts from
  // the default (split view).
  await rm(STAFF_CONFIG_DIR, { recursive: true, force: true });
});

async function openGear(page: import("@playwright/test").Page) {
  await page.getByTestId("settings-menu-button").click();
}

test("view-mode tabs (inside gear menu) flip the diff between split and unified", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();

  // The button group lives inside the gear dropdown now, not the header.
  await expect(page.locator('header [role="tablist"][aria-label="Diff view mode"]')).toHaveCount(0);

  await openGear(page);
  // Tabs live inside the menu; clicking them does not close it, so we can
  // flip back and forth and observe both the aria-checked state and the
  // diff table's column count.
  const splitTab = page.getByTestId("view-mode-split");
  const unifiedTab = page.getByTestId("view-mode-unified");

  await expect(splitTab).toHaveAttribute("aria-checked", "true");
  await expect(unifiedTab).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("table tbody tr").first().locator("td")).toHaveCount(6);

  await unifiedTab.click();
  await expect(unifiedTab).toHaveAttribute("aria-checked", "true");
  await expect(splitTab).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("table tbody tr").first().locator("td")).toHaveCount(4);

  await splitTab.click();
  await expect(splitTab).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("table tbody tr").first().locator("td")).toHaveCount(6);
});

test("view-mode preference is persisted to the global settings file and survives reload", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();

  await openGear(page);
  const postSettings = page.waitForResponse(
    (r) => r.url().includes("/api/settings") && r.request().method() === "POST",
  );
  await page.getByTestId("view-mode-unified").click();
  await postSettings;

  // Reload; the setting should come from the server (read from the isolated
  // config dir written by the previous step) and render unified mode.
  await page.reload();
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();
  await expect(page.locator("table tbody tr").first().locator("td")).toHaveCount(4);

  await openGear(page);
  await expect(page.getByTestId("view-mode-unified")).toHaveAttribute("aria-checked", "true");
});
