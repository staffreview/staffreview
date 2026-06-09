import { rm } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { resetDiffsJson } from "./helpers.ts";
import { STAFF_CONFIG_DIR } from "./setup.ts";

test.beforeEach(async () => {
  await resetDiffsJson();
  await rm(STAFF_CONFIG_DIR, { recursive: true, force: true });
});

async function openFeatureDiff(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();
}

// The `.content-text` element (a div/ins/del the library tags with that emotion
// label) is what carries the wrap: `pre-wrap` wraps, `pre` doesn't.
function contentWhiteSpace(card: import("@playwright/test").Locator) {
  return card
    .locator('[class*="content-text"]')
    .first()
    .evaluate((el) => getComputedStyle(el).whiteSpace);
}

test("Wrap lines is on by default and the long line wraps", async ({ page }) => {
  await openFeatureDiff(page);
  const card = page.getByTestId("file-card-wrapme.ts");
  await expect(card.locator('[class*="content-text"]').first()).toBeVisible({ timeout: 10_000 });

  // Default: no `staff-diff-nowrap` class, content wraps (`pre-wrap`).
  await expect(card.locator(".staff-diff")).not.toHaveClass(/staff-diff-nowrap/);
  expect(await contentWhiteSpace(card)).toBe("pre-wrap");

  await page.getByTestId("settings-menu-button").click();
  await expect(page.getByTestId("wrap-lines-toggle")).toHaveAttribute("aria-checked", "true");
});

test("turning Wrap lines off lets the long line overflow and scroll horizontally", async ({
  page,
}) => {
  await openFeatureDiff(page);
  const card = page.getByTestId("file-card-wrapme.ts");
  const staffDiff = card.locator(".staff-diff");
  await expect(card.locator('[class*="content-text"]').first()).toBeVisible({ timeout: 10_000 });

  await page.getByTestId("settings-menu-button").click();
  const toggle = page.getByTestId("wrap-lines-toggle");
  const postSettings = page.waitForResponse(
    (r) => r.url().includes("/api/settings") && r.request().method() === "POST",
  );
  await toggle.click();
  await postSettings;
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");

  // No-wrap: the class is applied, content stops wrapping, and the wide 400-char
  // line makes the per-file container horizontally scrollable.
  await expect(staffDiff).toHaveClass(/staff-diff-nowrap/);
  expect(await contentWhiteSpace(card)).toBe("pre");
  await expect
    .poll(() => staffDiff.evaluate((el) => el.scrollWidth - el.clientWidth))
    .toBeGreaterThan(50);
});

test("no-wrap split keeps changed-line tint behind the full scrollable line", async ({ page }) => {
  await openFeatureDiff(page);
  const card = page.getByTestId("file-card-wrapme.ts");
  const staffDiff = card.locator(".staff-diff");
  await expect(card.locator('[class*="content-text"]').first()).toBeVisible({ timeout: 10_000 });

  await page.getByTestId("settings-menu-button").click();
  const postSettings = page.waitForResponse(
    (r) => r.url().includes("/api/settings") && r.request().method() === "POST",
  );
  await page.getByTestId("wrap-lines-toggle").click();
  await postSettings;
  await page.keyboard.press("Escape");

  await expect(staffDiff).toHaveClass(/staff-diff-split/);
  await expect(staffDiff).toHaveClass(/staff-diff-nowrap/);
  await staffDiff.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  await expect.poll(() => staffDiff.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);

  const gapToRightEdge = await staffDiff.evaluate((el) => {
    const visibleRight = el.getBoundingClientRect().right;
    const changedCells = [...el.querySelectorAll('td[class*="content"]')].filter((cell) =>
      /diff-(added|removed)/.test(cell.className),
    ) as HTMLElement[];
    return Math.round(
      Math.min(...changedCells.map((cell) => visibleRight - cell.getBoundingClientRect().right)),
    );
  });
  expect(gapToRightEdge).toBeLessThan(2);
});

test("no-wrap keeps the fold pill centered on the card, not the wide table", async ({ page }) => {
  await openFeatureDiff(page);
  const card = page.getByTestId("file-card-wrapme.ts");
  const staffDiff = card.locator(".staff-diff");
  // The wide line's unchanged context is folded into an "N unchanged lines" pill.
  const foldPill = card.locator('button[class*="code-fold-expand-button"]').first();
  await expect(foldPill).toBeVisible({ timeout: 10_000 });

  await page.getByTestId("settings-menu-button").click();
  const postSettings = page.waitForResponse(
    (r) => r.url().includes("/api/settings") && r.request().method() === "POST",
  );
  await page.getByTestId("wrap-lines-toggle").click();
  await postSettings;
  await page.keyboard.press("Escape");
  await expect(staffDiff).toHaveClass(/staff-diff-nowrap/);

  // Distance between the pill's center and the card's center, in px.
  const centerOffset = () =>
    foldPill.evaluate((btn) => {
      const fileCard = btn.closest('[data-testid^="file-card-"]') as HTMLElement;
      const b = btn.getBoundingClientRect();
      const c = fileCard.getBoundingClientRect();
      return Math.abs(b.left + b.width / 2 - (c.left + c.width / 2));
    });

  // Centered on the card before scrolling…
  expect(await centerOffset()).toBeLessThan(60);
  // …and still centered after scrolling the wide line far to the right.
  await staffDiff.evaluate((el) => {
    el.scrollLeft = 800;
  });
  await expect.poll(() => staffDiff.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);
  expect(await centerOffset()).toBeLessThan(60);
});

test("no-wrap keeps the comment button pinned beside the sticky gutter after horizontal scroll", async ({
  page,
}) => {
  await openFeatureDiff(page);
  const card = page.getByTestId("file-card-wrapme.ts");
  const staffDiff = card.locator(".staff-diff");
  await expect(card.locator('[class*="content-text"]').first()).toBeVisible({ timeout: 10_000 });

  await page.getByTestId("settings-menu-button").click();
  const postSettings = page.waitForResponse(
    (r) => r.url().includes("/api/settings") && r.request().method() === "POST",
  );
  await page.getByTestId("wrap-lines-toggle").click();
  await postSettings;
  await page.keyboard.press("Escape");
  await expect(staffDiff).toHaveClass(/staff-diff-nowrap/);

  await staffDiff.evaluate((el) => {
    el.scrollLeft = 700;
  });
  await expect.poll(() => staffDiff.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);

  const gutter = card.locator(".staff-gutter.diff-added").first();
  await gutter.hover();
  const plus = card.locator("[data-staff-plus]");
  await expect(plus).toBeVisible();

  const placement = await plus.evaluate((button) => {
    const diff = button.closest(".staff-diff") as HTMLElement;
    const gutter = diff.querySelector(".staff-gutter.diff-added") as HTMLElement;
    const marker = gutter.nextElementSibling as HTMLElement;
    const b = button.getBoundingClientRect();
    const d = diff.getBoundingClientRect();
    const m = marker.getBoundingClientRect();
    const g = gutter.getBoundingClientRect();
    return {
      buttonCenter: Math.round(b.left + b.width / 2),
      markerCenter: Math.round(m.left + m.width / 2 + 2),
      leftGapFromGutter: Math.round(b.left - g.right),
      leftInDiff: Math.round(b.left - d.left),
      rightInDiff: Math.round(b.right - d.left),
      diffWidth: Math.round(d.width),
    };
  });
  expect(
    Math.abs(placement.buttonCenter - placement.markerCenter),
    JSON.stringify(placement),
  ).toBeLessThan(2);
  expect(placement.leftGapFromGutter, JSON.stringify(placement)).toBeGreaterThanOrEqual(2);
  expect(placement.leftInDiff, JSON.stringify(placement)).toBeGreaterThan(0);
  expect(placement.rightInDiff, JSON.stringify(placement)).toBeLessThan(placement.diffWidth);
});

test("no-wrap colors changed gutters to match their line backgrounds", async ({ page }) => {
  await openFeatureDiff(page);
  const card = page.getByTestId("file-card-wrapme.ts");
  const staffDiff = card.locator(".staff-diff");
  await expect(card.locator('[class*="content-text"]').first()).toBeVisible({ timeout: 10_000 });

  await page.getByTestId("settings-menu-button").click();
  const postSettings = page.waitForResponse(
    (r) => r.url().includes("/api/settings") && r.request().method() === "POST",
  );
  await page.getByTestId("wrap-lines-toggle").click();
  await postSettings;
  await page.keyboard.press("Escape");
  await expect(staffDiff).toHaveClass(/staff-diff-nowrap/);

  await staffDiff.evaluate((el) => {
    el.scrollLeft = 700;
  });
  await expect.poll(() => staffDiff.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);

  const colors = await staffDiff.evaluate((el) => {
    const rgbFromColor = (color: string) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("missing canvas context");
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return { r, g, b };
    };
    const addedGutter = el.querySelector(".staff-gutter.diff-added") as HTMLElement | null;
    const removedGutter = el.querySelector(".staff-gutter.diff-removed") as HTMLElement | null;
    const addedContent = addedGutter?.parentElement?.querySelector(
      ".staff-content.diff-added",
    ) as HTMLElement | null;
    const removedContent = removedGutter?.parentElement?.querySelector(
      ".staff-content.diff-removed",
    ) as HTMLElement | null;
    if (!addedGutter || !removedGutter || !addedContent || !removedContent) {
      throw new Error("missing changed line cells");
    }

    const probe = document.createElement("div");
    el.append(probe);
    probe.style.color = "var(--color-success)";
    const expectedAddedColor = getComputedStyle(probe).color;
    probe.style.color = "var(--color-destructive)";
    const expectedRemovedColor = getComputedStyle(probe).color;
    probe.remove();

    const addedGutterStyle = getComputedStyle(addedGutter);
    const removedGutterStyle = getComputedStyle(removedGutter);
    const addedGutterBg = addedGutterStyle.backgroundColor;
    const removedGutterBg = removedGutterStyle.backgroundColor;
    return {
      addedGutterBg,
      addedLineBg: getComputedStyle(addedContent).backgroundColor,
      addedRgb: rgbFromColor(addedGutterBg),
      addedColor: addedGutterStyle.color,
      expectedAddedColor,
      removedGutterBg,
      removedLineBg: getComputedStyle(removedContent).backgroundColor,
      removedRgb: rgbFromColor(removedGutterBg),
      removedColor: removedGutterStyle.color,
      expectedRemovedColor,
    };
  });

  expect(colors.addedGutterBg, JSON.stringify(colors)).toBe(colors.addedLineBg);
  expect(colors.addedRgb.g, JSON.stringify(colors)).toBeGreaterThan(colors.addedRgb.r);
  expect(colors.addedColor, JSON.stringify(colors)).toBe(colors.expectedAddedColor);
  expect(colors.removedGutterBg, JSON.stringify(colors)).toBe(colors.removedLineBg);
  expect(colors.removedRgb.r, JSON.stringify(colors)).toBeGreaterThan(colors.removedRgb.g);
  expect(colors.removedColor, JSON.stringify(colors)).toBe(colors.expectedRemovedColor);
});

test("no-wrap centers the fold pill on short-line files too (no horizontal scroll)", async ({
  page,
}) => {
  // big.ts has folded context but only short lines, so its table doesn't
  // overflow — the regression case where centering on the table center is right
  // but a naive sticky/clamp would shove the pill off to one side.
  await openFeatureDiff(page);
  const card = page.getByTestId("file-card-big.ts");
  const foldPill = card.locator('button[class*="code-fold-expand-button"]').first();
  await expect(foldPill).toBeVisible({ timeout: 10_000 });

  await page.getByTestId("settings-menu-button").click();
  const postSettings = page.waitForResponse(
    (r) => r.url().includes("/api/settings") && r.request().method() === "POST",
  );
  await page.getByTestId("wrap-lines-toggle").click();
  await postSettings;
  await page.keyboard.press("Escape");
  await expect(card.locator(".staff-diff")).toHaveClass(/staff-diff-nowrap/);

  const offset = await foldPill.evaluate((btn) => {
    const fileCard = btn.closest('[data-testid^="file-card-"]') as HTMLElement;
    const b = btn.getBoundingClientRect();
    const c = fileCard.getBoundingClientRect();
    return Math.abs(b.left + b.width / 2 - (c.left + c.width / 2));
  });
  expect(offset).toBeLessThan(60);
});

test("no-wrap also overflows and scrolls in unified layout", async ({ page }) => {
  // Unified view has a single sticky gutter and content column, so verify the
  // no-wrap overflow there too.
  await openFeatureDiff(page);
  const card = page.getByTestId("file-card-wrapme.ts");
  const staffDiff = card.locator(".staff-diff");
  await expect(card.locator('[class*="content-text"]').first()).toBeVisible({ timeout: 10_000 });

  await page.getByTestId("settings-menu-button").click();
  for (const testId of ["view-mode-unified", "wrap-lines-toggle"]) {
    const postSettings = page.waitForResponse(
      (r) => r.url().includes("/api/settings") && r.request().method() === "POST",
    );
    await page.getByTestId(testId).click();
    await postSettings;
  }
  await page.keyboard.press("Escape");

  await expect(staffDiff).toHaveClass(/staff-diff-unified/);
  await expect(staffDiff).toHaveClass(/staff-diff-nowrap/);
  expect(await contentWhiteSpace(card)).toBe("pre");
  // The genuinely-long line trips the overflow detector, enabling scroll…
  await expect(staffDiff).toHaveClass(/staff-diff-xscroll/);
  await expect(staffDiff).toHaveCSS("overflow-x", "auto");
  // …and the container actually scrolls horizontally.
  await expect
    .poll(() => staffDiff.evaluate((el) => el.scrollWidth - el.clientWidth))
    .toBeGreaterThan(50);
  await staffDiff.evaluate((el) => {
    el.scrollLeft = 400;
  });
  await expect.poll(() => staffDiff.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);
});

test("no-wrap unified keeps changed-line tint behind the full long line", async ({ page }) => {
  await openFeatureDiff(page);
  const card = page.getByTestId("file-card-wrapme.ts");
  const staffDiff = card.locator(".staff-diff");
  await expect(card.locator('[class*="content-text"]').first()).toBeVisible({ timeout: 10_000 });

  await page.getByTestId("settings-menu-button").click();
  for (const testId of ["view-mode-unified", "wrap-lines-toggle"]) {
    const postSettings = page.waitForResponse(
      (r) => r.url().includes("/api/settings") && r.request().method() === "POST",
    );
    await page.getByTestId(testId).click();
    await postSettings;
  }
  await page.keyboard.press("Escape");

  await expect(staffDiff).toHaveClass(/staff-diff-unified/);
  await expect(staffDiff).toHaveClass(/staff-diff-nowrap/);
  await expect(staffDiff).toHaveClass(/staff-diff-xscroll/);

  const coverage = await staffDiff.evaluate((el) => {
    const cell = [...el.querySelectorAll('td[class*="content"][class*="diff-added"]')].find((c) =>
      c.textContent?.includes("!!"),
    ) as HTMLElement | undefined;
    if (!cell) throw new Error("missing long added line");
    const text = cell.querySelector('[class*="content-text"]') as HTMLElement | null;
    if (!text) throw new Error("missing long added line text");
    const cellRect = cell.getBoundingClientRect();
    const textRect = text.getBoundingClientRect();
    return Math.round(textRect.right - cellRect.right);
  });
  expect(coverage).toBeLessThanOrEqual(1);

  await card.scrollIntoViewIfNeeded();
  await staffDiff.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  await expect.poll(() => staffDiff.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);
  const rightEdgeHit = await staffDiff.evaluate((el) => {
    const cell = [...el.querySelectorAll('td[class*="content"][class*="diff-added"]')].find((c) =>
      c.textContent?.includes("!!"),
    ) as HTMLElement | undefined;
    if (!cell) throw new Error("missing long added line");
    const table = el.querySelector("table") as HTMLElement | null;
    const cellRect = cell.getBoundingClientRect();
    const containerRect = el.getBoundingClientRect();
    const tableRect = table?.getBoundingClientRect();
    const x = Math.min(containerRect.right - 8, cellRect.right + 24);
    const y = cellRect.top + cellRect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      className: (hit as HTMLElement | null)?.className?.toString() ?? "",
      cellRight: Math.round(cellRect.right),
      containerRight: Math.round(containerRect.right),
      tableRight: tableRect ? Math.round(tableRect.right) : null,
      scrollLeft: Math.round(el.scrollLeft),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      tableMinWidth: table ? getComputedStyle(table).minWidth : null,
      gapToRightEdge: Math.round(containerRect.right - cellRect.right),
      hitChangedCell: Boolean(
        hit?.closest(
          'td[class*="content"][class*="diff-added"], td[class*="content"][class*="diff-removed"]',
        ),
      ),
    };
  });
  expect(rightEdgeHit.gapToRightEdge, JSON.stringify(rightEdgeHit)).toBeLessThanOrEqual(1);
  expect(rightEdgeHit.hitChangedCell, JSON.stringify(rightEdgeHit)).toBe(true);
});

test("no-wrap unified fills the pane tint with no spurious scroll for short lines", async ({
  page,
}) => {
  // Two regressions in one: in unified no-wrap the added/removed tint must span
  // the full card (the tint is painted on the row, which spans the table), AND
  // a file whose lines all fit must NOT scroll horizontally. big.ts has only
  // short lines, so it exercises both.
  await openFeatureDiff(page);
  const card = page.getByTestId("file-card-big.ts");
  const staffDiff = card.locator(".staff-diff");
  await expect(card.locator('[class*="content-text"]').first()).toBeVisible({ timeout: 10_000 });

  await page.getByTestId("settings-menu-button").click();
  for (const testId of ["view-mode-unified", "wrap-lines-toggle"]) {
    const postSettings = page.waitForResponse(
      (r) => r.url().includes("/api/settings") && r.request().method() === "POST",
    );
    await page.getByTestId(testId).click();
    await postSettings;
  }
  await page.keyboard.press("Escape");
  await expect(staffDiff).toHaveClass(/staff-diff-unified/);
  await expect(staffDiff).toHaveClass(/staff-diff-nowrap/);

  // The changed line's content cell (which carries the tint) reaches the pane's
  // right edge — i.e. the tint fills, instead of hugging the short text.
  const gapToRightEdge = await staffDiff.evaluate((el) => {
    const td = [...el.querySelectorAll('td[class*="content"]')].find((c) =>
      /diff-(added|removed)/.test(c.className),
    ) as HTMLElement;
    return Math.round(el.getBoundingClientRect().right - td.getBoundingClientRect().right);
  });
  expect(gapToRightEdge).toBeLessThan(20);
  // …and a file whose lines all fit is NOT horizontally scrollable (the constant
  // column-overflow phantom is clipped, not scrolled).
  await expect(staffDiff).not.toHaveClass(/staff-diff-xscroll/);
  await expect(staffDiff).toHaveCSS("overflow-x", "clip");
});

test("Wrap lines preference persists across reload", async ({ page }) => {
  await openFeatureDiff(page);
  const card = page.getByTestId("file-card-wrapme.ts");
  await expect(card.locator('[class*="content-text"]').first()).toBeVisible({ timeout: 10_000 });

  await page.getByTestId("settings-menu-button").click();
  const postSettings = page.waitForResponse(
    (r) => r.url().includes("/api/settings") && r.request().method() === "POST",
  );
  await page.getByTestId("wrap-lines-toggle").click();
  await postSettings;
  await page.keyboard.press("Escape");
  await expect(card.locator(".staff-diff")).toHaveClass(/staff-diff-nowrap/);

  await page.reload();
  await openFeatureDiff(page);
  await expect(page.getByTestId("file-card-wrapme.ts").locator(".staff-diff")).toHaveClass(
    /staff-diff-nowrap/,
  );
  await page.getByTestId("settings-menu-button").click();
  await expect(page.getByTestId("wrap-lines-toggle")).toHaveAttribute("aria-checked", "false");
});
