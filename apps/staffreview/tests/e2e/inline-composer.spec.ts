import { expect, test } from "@playwright/test";
import { fillEditor, resetDiffsJson } from "./helpers.ts";

test.beforeEach(async () => {
  await resetDiffsJson();
});

test("clicking the floating + button opens the composer inline below the line", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();

  const mathCard = page.getByTestId("file-card-math.ts");
  await expect(mathCard.locator("table tbody tr").first()).toBeVisible();

  // Hover the inserted `if (typeof…)` line on the new side so the floating
  // "+" appears for that row.
  const ifRow = mathCard
    .locator("table tbody tr")
    .filter({ hasText: 'if (typeof a !== "number")' });
  await ifRow.locator("td").nth(5).hover();
  const plus = mathCard.locator("[data-staff-plus]");
  await expect(plus).toBeVisible();
  await plus.click();

  // The composer host row appears immediately after the line.
  const composerRow = mathCard.locator('tr[data-composer-host="true"]');
  await expect(composerRow).toBeVisible();

  const isImmediatelyAfter = await mathCard.evaluate((card) => {
    const rows = card.querySelectorAll("table tbody tr");
    for (let i = 0; i < rows.length - 1; i++) {
      const cells = rows[i].querySelectorAll(":scope > td");
      const newSideLineNumber =
        cells.length >= 6
          ? cells[3]?.textContent?.trim()
          : cells.length >= 4
            ? cells[1]?.textContent?.trim()
            : null;
      if (newSideLineNumber === "2") {
        return (rows[i + 1] as HTMLElement).dataset.composerHost === "true";
      }
    }
    return false;
  });
  expect(isImmediatelyAfter).toBe(true);

  await fillEditor(composerRow.getByTestId("comment-editor"), "inline composer works");
  await page.getByRole("button", { name: /^Comment$/ }).click();
  await expect(mathCard.getByTestId("comment-editor")).toHaveCount(0);
  await expect(mathCard.getByText("inline composer works")).toBeVisible();
});

test("clicking a line number updates the URL hash and does NOT open the composer", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();

  const mathCard = page.getByTestId("file-card-math.ts");
  const ifRow = mathCard
    .locator("table tbody tr")
    .filter({ hasText: 'if (typeof a !== "number")' });

  // Click the new-side line number cell.
  await ifRow.locator("td").nth(3).click();

  // The URL hash should anchor to the line.
  await expect.poll(() => decodeURIComponent(new URL(page.url()).hash)).toBe("#math.ts:R2");
  // No composer.
  await expect(mathCard.locator('tr[data-composer-host="true"]')).toHaveCount(0);
});

test("clicking a line number highlights that row, clicking another moves it", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();

  const mathCard = page.getByTestId("file-card-math.ts");
  const ifRow = mathCard
    .locator("table tbody tr")
    .filter({ hasText: 'if (typeof a !== "number")' });
  const returnRow = mathCard.locator("table tbody tr").filter({ hasText: "return a + b;" }).first();

  await ifRow.locator("td").nth(3).click();
  await expect(ifRow).toHaveAttribute("data-anchored", "true");

  // Move the anchor: previous row clears, new row gets it.
  await returnRow.locator("td").nth(3).click();
  await expect(ifRow).not.toHaveAttribute("data-anchored", "true");
  await expect(returnRow).toHaveAttribute("data-anchored", "true");
});

test("clicking the same line number again toggles the anchor off", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();

  const mathCard = page.getByTestId("file-card-math.ts");
  const ifRow = mathCard
    .locator("table tbody tr")
    .filter({ hasText: 'if (typeof a !== "number")' });

  await ifRow.locator("td").nth(3).click();
  await expect(ifRow).toHaveAttribute("data-anchored", "true");
  await expect.poll(() => decodeURIComponent(new URL(page.url()).hash)).toBe("#math.ts:R2");

  // Click the same line number — hash is cleared and the highlight goes away.
  await ifRow.locator("td").nth(3).click();
  await expect(ifRow).not.toHaveAttribute("data-anchored", "true");
  await expect.poll(() => new URL(page.url()).hash).toBe("");
});

test("shift-click extends the anchor to a range — URL + multi-row highlight", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();

  const mathCard = page.getByTestId("file-card-math.ts");
  const ifRow = mathCard
    .locator("table tbody tr")
    .filter({ hasText: 'if (typeof a !== "number")' });
  const returnRow = mathCard.locator("table tbody tr").filter({ hasText: "return a + b;" }).first();

  // Anchor on `if (typeof…)` (R2), then shift-click `return a + b;` (R3)
  // to form an R2-R3 range.
  await ifRow.locator("td").nth(3).click();
  await expect.poll(() => decodeURIComponent(new URL(page.url()).hash)).toBe("#math.ts:R2");

  await returnRow
    .locator("td")
    .nth(3)
    .click({ modifiers: ["Shift"] });
  await expect.poll(() => decodeURIComponent(new URL(page.url()).hash)).toBe("#math.ts:R2-R3");

  // Both rows in the range should be marked anchored.
  await expect(mathCard.locator('table tbody tr[data-anchored="true"]')).toHaveCount(2);
});

test("range anchor flows through to the comment (line + endLine)", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();

  const mathCard = page.getByTestId("file-card-math.ts");
  const ifRow = mathCard
    .locator("table tbody tr")
    .filter({ hasText: 'if (typeof a !== "number")' });
  const returnRow = mathCard.locator("table tbody tr").filter({ hasText: "return a + b;" }).first();

  // Select R2-R3, then hover the last row and click "+" to open a
  // range-attached composer.
  await ifRow.locator("td").nth(3).click();
  await returnRow
    .locator("td")
    .nth(3)
    .click({ modifiers: ["Shift"] });
  await returnRow.locator("td").nth(5).hover();
  await mathCard.locator("[data-staff-plus]").click();

  // The composer host sits at the end of the range (R3 = the `return` row).
  const composerRow = mathCard.locator('tr[data-composer-host="true"]');
  await expect(composerRow).toHaveCount(1);
  const hostFollowsReturnRow = await mathCard.evaluate((card) => {
    const rows = card.querySelectorAll("table tbody tr");
    for (let i = 0; i < rows.length - 1; i++) {
      const cells = rows[i].querySelectorAll(":scope > td");
      const newSideLineNumber =
        cells.length >= 6
          ? cells[3]?.textContent?.trim()
          : cells.length >= 4
            ? cells[1]?.textContent?.trim()
            : null;
      if (newSideLineNumber === "3") {
        return (rows[i + 1] as HTMLElement).dataset.composerHost === "true";
      }
    }
    return false;
  });
  expect(hostFollowsReturnRow).toBe(true);

  await fillEditor(composerRow.getByTestId("comment-editor"), "range comment");
  await page.getByRole("button", { name: /^Comment$/ }).click();
  await expect(mathCard.getByText("range comment")).toBeVisible();

  // Sidebar shows the file:start-end label, and clicking it puts the
  // range hash back in the URL.
  const sidebarLink = page.locator("[data-testid^=sidebar-inline-thread-]").first();
  await expect(sidebarLink).toContainText("math.ts:2-3");
  await sidebarLink.click();
  await expect.poll(() => decodeURIComponent(new URL(page.url()).hash)).toBe("#math.ts:R2-R3");
});

test("loading the page with a #file:line hash scrolls to that line", async ({ page }) => {
  // Open the diff first so the file is rendered, then navigate with the hash.
  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();

  // Make the page long enough that scrolling is observable, then scroll
  // down — the row is near the top, so navigation must scroll UP for the
  // delta to be visible.
  await page.evaluate(() => {
    const s = document.createElement("div");
    s.style.height = "2000px";
    document.body.appendChild(s);
    window.scrollTo(0, 1500);
  });

  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(0);
  // Navigate to the new-side line 2 of math.ts.
  await page.evaluate(() => {
    window.location.hash = "math.ts:R2";
  });
  // The hashchange should kick off scrollToLine.
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => window.scrollY);
  expect(after).toBeLessThan(before);
});

test("multiple composers can be open simultaneously", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();

  const mathCard = page.getByTestId("file-card-math.ts");

  // Open the first composer via the floating "+".
  const ifRow = mathCard
    .locator("table tbody tr")
    .filter({ hasText: 'if (typeof a !== "number")' });
  await ifRow.locator("td").nth(5).hover();
  await mathCard.locator("[data-staff-plus]").click();
  await expect(mathCard.locator('tr[data-composer-host="true"]')).toHaveCount(1);

  // Open another on the unchanged `return a + b;` line.
  const returnRow = mathCard.locator("table tbody tr").filter({ hasText: "return a + b;" }).first();
  await returnRow.locator("td").nth(5).hover();
  await mathCard.locator("[data-staff-plus]").click();
  await expect(mathCard.locator('tr[data-composer-host="true"]')).toHaveCount(2);

  // Cancel the first — the second stays.
  const firstComposer = mathCard.locator('tr[data-composer-host="true"]').first();
  await firstComposer.getByRole("button", { name: /^Cancel$/ }).click();
  await expect(mathCard.locator('tr[data-composer-host="true"]')).toHaveCount(1);
});
