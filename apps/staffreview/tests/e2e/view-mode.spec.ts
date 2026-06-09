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

test("Unified layout switch flips the diff between split and unified", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();

  // The view-mode control lives inside the gear dropdown, not the header.
  await expect(page.locator('header [role="tablist"][aria-label="Diff view mode"]')).toHaveCount(0);

  await openGear(page);
  const unifiedToggle = page.getByTestId("view-mode-unified");

  await expect(unifiedToggle).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("table tbody tr").first().locator("td")).toHaveCount(6);

  await unifiedToggle.click();
  await expect(unifiedToggle).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("table tbody tr").first().locator("td:visible")).toHaveCount(3);

  await unifiedToggle.click();
  await expect(unifiedToggle).toHaveAttribute("aria-checked", "false");
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
  await expect(page.locator("table tbody tr").first().locator("td:visible")).toHaveCount(3);

  await openGear(page);
  await expect(page.getByTestId("view-mode-unified")).toHaveAttribute("aria-checked", "true");
});

test("unified layout uses one gutter with a dash for deleted lines", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("big.ts", { exact: true }).first()).toBeVisible();

  await openGear(page);
  await page.getByTestId("view-mode-unified").click();

  const bigCard = page.getByTestId("file-card-big.ts");
  const contextRow = bigCard.locator("table tbody tr", { hasText: "const v18 = 18;" }).first();
  const deletedRow = bigCard.locator("table tbody tr", { hasText: "const v20 = 20;" }).first();
  const addedRow = bigCard.locator("table tbody tr", { hasText: "const v20 = 200;" }).first();

  await expect(contextRow.locator("td:visible")).toHaveCount(3);
  await expect(contextRow.locator("td:visible").first()).toHaveText("19");
  await expect(contextRow.locator("td:visible").first()).toHaveAttribute("data-side", "new");
  await expect(contextRow.locator("td:visible").first()).toHaveAttribute("data-old-line", "19");
  await expect(contextRow.locator("td:visible").first()).toHaveAttribute("data-new-line", "19");

  await expect(deletedRow.locator("td:visible")).toHaveCount(3);
  await expect(deletedRow.locator("td:visible").first()).toHaveText("-");
  await expect(deletedRow.locator("td:visible").first()).toHaveAttribute("data-side", "old");
  await expect(deletedRow.locator("td:visible").first()).toHaveAttribute("data-old-line", "21");

  await expect(addedRow.locator("td:visible")).toHaveCount(3);
  await expect(addedRow.locator("td:visible").first()).toHaveText("21");
  await expect(addedRow.locator("td:visible").first()).toHaveAttribute("data-side", "new");
  await expect(addedRow.locator("td:visible").first()).toHaveAttribute("data-new-line", "21");

  const deletedBorder = await deletedRow
    .locator("td:visible")
    .first()
    .evaluate((cell) => getComputedStyle(cell).boxShadow);
  const addedBorder = await addedRow
    .locator("td:visible")
    .first()
    .evaluate((cell) => getComputedStyle(cell).boxShadow);
  expect(deletedBorder).not.toBe("none");
  expect(addedBorder).not.toBe("none");

  const foldButtonHeight = await bigCard
    .locator('button[class*="code-fold-expand-button"]', { hasText: "17 unchanged lines" })
    .first()
    .evaluate((button) => Math.round(button.getBoundingClientRect().height));
  expect(foldButtonHeight).toBeLessThanOrEqual(28);

  const contentWidth = await addedRow
    .locator("td:visible")
    .last()
    .evaluate((cell) => {
      const table = cell.closest("table");
      if (!table) return 0;
      const cellRect = cell.getBoundingClientRect();
      const tableRect = table.getBoundingClientRect();
      return Math.round(tableRect.right - cellRect.right);
    });
  expect(contentWidth).toBeLessThanOrEqual(2);

  await addedRow.locator("td:visible").last().hover();
  const plusBox = await bigCard.locator("[data-staff-plus]").boundingBox();
  const cardBox = await bigCard.boundingBox();
  expect(plusBox).not.toBeNull();
  expect(cardBox).not.toBeNull();
  expect(plusBox?.x ?? 0).toBeGreaterThanOrEqual((cardBox?.x ?? 0) - 2);
});

test("unified range anchors include changed rows between the endpoints", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("big.ts", { exact: true }).first()).toBeVisible();

  await openGear(page);
  await page.getByTestId("view-mode-unified").click();
  await page.keyboard.press("Escape");

  const bigCard = page.getByTestId("file-card-big.ts");
  const contextBefore = bigCard.locator("table tbody tr", { hasText: "const v19 = 19;" }).first();
  const deletedRow = bigCard.locator("table tbody tr", { hasText: "const v20 = 20;" }).first();
  const addedRow = bigCard.locator("table tbody tr", { hasText: "const v20 = 200;" }).first();
  const contextAfter = bigCard.locator("table tbody tr", { hasText: "const v21 = 21;" }).first();

  await expect(bigCard.locator(".staff-diff")).toHaveClass(/staff-diff-unified/);
  await expect(contextBefore).toBeVisible();
  await expect(deletedRow).toBeVisible();
  await expect(addedRow).toBeVisible();
  await expect(contextAfter).toBeVisible();

  await page.evaluate(() => {
    window.location.hash = "big.ts:L20-L22";
  });
  await expect.poll(() => decodeURIComponent(new URL(page.url()).hash)).toBe("#big.ts:L20-L22");

  await expect(contextBefore).toHaveAttribute("data-anchored", "true");
  await expect(deletedRow).toHaveAttribute("data-anchored", "true");
  await expect(addedRow).toHaveAttribute("data-anchored", "true");
  await expect(contextAfter).toHaveAttribute("data-anchored", "true");
  await expect(bigCard.locator('table tbody tr[data-anchored="true"]')).toHaveCount(4);
});
