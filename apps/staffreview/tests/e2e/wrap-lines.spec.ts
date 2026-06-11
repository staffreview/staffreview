import { rm } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { resetDiffsJson, staff } from "./helpers.ts";
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

// The custom `<pre class="staff-content-text react-diff-content-text">` carries
// the wrap: `pre-wrap` wraps, `pre` doesn't.
function contentWhiteSpace(card: import("@playwright/test").Locator) {
  return card
    .locator('[class*="content-text"]')
    .first()
    .evaluate((el) => getComputedStyle(el).whiteSpace);
}

function visibleGlyphCoverageScript() {
  return (el: HTMLElement) => {
    const clipTextPairs = [...el.querySelectorAll(".staff-content-clip")]
      .map((clipNode) => {
        const clip = clipNode as HTMLElement;
        const text = clip.querySelector(".staff-content-text") as HTMLElement | null;
        return text ? { clip, text } : null;
      })
      .filter((pair): pair is { clip: HTMLElement; text: HTMLElement } => Boolean(pair));
    const visibleWidths = clipTextPairs.map(({ clip, text }) => {
      const clipRect = clip.getBoundingClientRect();
      const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
      let visibleWidth = 0;
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          const width = Math.max(
            0,
            Math.min(rect.right, clipRect.right) - Math.max(rect.left, clipRect.left),
          );
          const height = Math.max(
            0,
            Math.min(rect.bottom, clipRect.bottom) - Math.max(rect.top, clipRect.top),
          );
          if (height > 0) visibleWidth += width;
        }
        range.detach();
      }
      return Math.round(visibleWidth);
    });
    return {
      scrollLeft: Math.round(el.scrollLeft),
      visibleWidths,
      visibleGlyphCells: visibleWidths.filter((width) => width > 8).length,
    };
  };
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

test("no-wrap split keeps both gutters fixed while clipping code to each pane", async ({
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

  await expect(staffDiff).toHaveClass(/staff-diff-split/);
  await expect(staffDiff).toHaveClass(/staff-diff-nowrap/);
  const scrollSamples = await staffDiff.evaluate(async (el) => {
    const sample = () => {
      const diffRect = el.getBoundingClientRect();
      const newGutter = el.querySelector(".staff-gutter-new") as HTMLElement;
      const newMarker = el.querySelector(".staff-marker-new") as HTMLElement;
      const newContent = el.querySelector(".staff-content-new") as HTMLElement;
      const rect = (node: HTMLElement) => {
        const r = node.getBoundingClientRect();
        return {
          left: Math.round(r.left - diffRect.left),
          right: Math.round(r.right - diffRect.left),
        };
      };
      return {
        scrollLeft: Math.round(el.scrollLeft),
        newGutter: rect(newGutter),
        newMarker: rect(newMarker),
        newContent: rect(newContent),
      };
    };
    const samples = [];
    for (const left of [0, 250, 700]) {
      el.scrollLeft = left;
      await new Promise(requestAnimationFrame);
      samples.push(sample());
    }
    return samples;
  });
  const gutterLefts = scrollSamples.map((sample) => sample.newGutter.left);
  const markerLefts = scrollSamples.map((sample) => sample.newMarker.left);
  const contentLefts = scrollSamples.map((sample) => sample.newContent.left);
  expect(Math.max(...gutterLefts) - Math.min(...gutterLefts), JSON.stringify(scrollSamples)).toBe(
    0,
  );
  expect(Math.max(...markerLefts) - Math.min(...markerLefts), JSON.stringify(scrollSamples)).toBe(
    0,
  );
  expect(Math.max(...contentLefts) - Math.min(...contentLefts), JSON.stringify(scrollSamples)).toBe(
    0,
  );

  await staffDiff.evaluate((el) => {
    el.scrollLeft = 700;
  });
  await expect.poll(() => staffDiff.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);

  const geometry = await staffDiff.evaluate((el) => {
    const diffRect = el.getBoundingClientRect();
    const row = [...el.querySelectorAll("tr.react-diff-line")].find(
      (line) =>
        line.querySelector(".staff-content-old.diff-removed") &&
        line.querySelector(".staff-content-new.diff-added"),
    ) as HTMLElement;
    const oldGutter = row.querySelector(".staff-gutter-old") as HTMLElement;
    const oldMarker = row.querySelector(".staff-marker-old") as HTMLElement;
    const oldContent = row.querySelector(".staff-content-old") as HTMLElement;
    const oldClip = oldContent.querySelector(".staff-content-clip") as HTMLElement;
    const newGutter = row.querySelector(".staff-gutter-new") as HTMLElement;
    const newMarker = row.querySelector(".staff-marker-new") as HTMLElement;
    const newContent = row.querySelector(".staff-content-new") as HTMLElement;
    const newClip = newContent.querySelector(".staff-content-clip") as HTMLElement;
    const oldText = oldContent.querySelector(".staff-content-text") as HTMLElement;
    const newText = newContent.querySelector(".staff-content-text") as HTMLElement;
    const rect = (node: HTMLElement) => {
      const r = node.getBoundingClientRect();
      return {
        left: Math.round(r.left - diffRect.left),
        right: Math.round(r.right - diffRect.left),
        width: Math.round(r.width),
      };
    };
    return {
      diffWidth: Math.round(diffRect.width),
      scrollLeft: Math.round(el.scrollLeft),
      oldGutter: rect(oldGutter),
      oldMarker: rect(oldMarker),
      oldContent: rect(oldContent),
      oldClip: rect(oldClip),
      oldText: rect(oldText),
      newGutter: rect(newGutter),
      newMarker: rect(newMarker),
      newContent: rect(newContent),
      newClip: rect(newClip),
      newText: rect(newText),
      oldClipOverflowX: getComputedStyle(oldClip).overflowX,
      newClipOverflowX: getComputedStyle(newClip).overflowX,
    };
  });

  const divider = Math.round(geometry.diffWidth / 2);
  expect(geometry.oldGutter.left, JSON.stringify(geometry)).toBe(0);
  expect(geometry.oldGutter.width, JSON.stringify(geometry)).toBe(52);
  expect(geometry.oldMarker.left, JSON.stringify(geometry)).toBe(52);
  expect(geometry.oldMarker.width, JSON.stringify(geometry)).toBe(24);
  expect(geometry.oldContent.left, JSON.stringify(geometry)).toBe(76);
  expect(geometry.oldClip.left, JSON.stringify(geometry)).toBe(geometry.oldContent.left);
  expect(geometry.oldClip.right, JSON.stringify(geometry)).toBe(divider);
  expect(geometry.oldClipOverflowX, JSON.stringify(geometry)).toBe("hidden");
  expect(Math.abs(geometry.newGutter.left - divider), JSON.stringify(geometry)).toBeLessThanOrEqual(
    1,
  );
  expect(geometry.newGutter.width, JSON.stringify(geometry)).toBe(52);
  expect(geometry.newMarker.left, JSON.stringify(geometry)).toBe(geometry.newGutter.right);
  expect(geometry.newMarker.width, JSON.stringify(geometry)).toBe(24);
  expect(geometry.newContent.left, JSON.stringify(geometry)).toBe(geometry.newMarker.right);
  expect(geometry.newClip.left, JSON.stringify(geometry)).toBe(geometry.newContent.left);
  expect(geometry.newClip.right, JSON.stringify(geometry)).toBe(geometry.diffWidth);
  expect(geometry.newClipOverflowX, JSON.stringify(geometry)).toBe("hidden");
  expect(geometry.oldText.left, JSON.stringify(geometry)).toBeLessThan(geometry.oldContent.left);
  expect(geometry.oldText.right, JSON.stringify(geometry)).toBeGreaterThan(geometry.oldClip.right);
  expect(geometry.newText.left, JSON.stringify(geometry)).toBeLessThan(geometry.newContent.left);
  expect(geometry.newText.right, JSON.stringify(geometry)).toBeGreaterThan(geometry.newClip.right);

  await staffDiff.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  await expect
    .poll(() =>
      staffDiff.evaluate((el) =>
        Math.abs(
          el.scrollLeft -
            Number.parseFloat(el.style.getPropertyValue("--staff-diff-scroll-left") || "0"),
        ),
      ),
    )
    .toBeLessThanOrEqual(1);

  const endScroll = await staffDiff.evaluate((el) => {
    const measurements = [...el.querySelectorAll(".staff-content-clip")].map((clipNode) => {
      const clip = clipNode as HTMLElement;
      const text = clip.querySelector(".staff-content-text") as HTMLElement;
      const clipRect = clip.getBoundingClientRect();
      const textRect = text.getBoundingClientRect();
      return {
        paneWidth: Math.round(clipRect.width),
        textWidth: Math.round(textRect.width),
        rightOverflow: Math.round(textRect.right - clipRect.right),
      };
    });
    return {
      scrollLeft: Math.round(el.scrollLeft),
      scrollWidth: Math.round(el.scrollWidth),
      clientWidth: Math.round(el.clientWidth),
      maxRightOverflow: Math.max(...measurements.map((m) => m.rightOverflow)),
      widestTextWidth: Math.max(...measurements.map((m) => m.textWidth)),
      paneWidth: Math.max(...measurements.map((m) => m.paneWidth)),
    };
  });
  expect(endScroll.scrollLeft, JSON.stringify(endScroll)).toBeGreaterThan(100);
  expect(endScroll.maxRightOverflow, JSON.stringify(endScroll)).toBeLessThanOrEqual(1);
  expect(endScroll.scrollWidth - endScroll.clientWidth, JSON.stringify(endScroll)).toBeGreaterThan(
    endScroll.widestTextWidth - endScroll.paneWidth,
  );
});

test("no-wrap split fixed inline comments span the diff width", async ({ page }) => {
  await openFeatureDiff(page);

  const out = await staff([
    "comment",
    "add",
    "--file",
    "wrapme.ts",
    "--line",
    "15",
    "--side",
    "new",
    "--body",
    "fixed inline width",
    "--author",
    "cli",
  ]);
  const comment = JSON.parse(out);
  await staff([
    "comment",
    "resolve",
    "--thread",
    comment.threadId,
    "--status",
    "fixed",
    "--body",
    "Fixed.",
    "--author",
    "cli",
  ]);
  await staff(["settings", "set", "wrapLines", "false"]);

  await page.reload();
  const card = page.getByTestId("file-card-wrapme.ts");
  const staffDiff = card.locator(".staff-diff");
  await expect(staffDiff).toHaveClass(/staff-diff-nowrap/);
  await expect(staffDiff).toHaveClass(/staff-diff-split/);
  await expect(page.locator(`[data-thread-id="${comment.threadId}"]`)).toBeVisible();

  const geometry = await staffDiff.evaluate((diff, threadId) => {
    const host = diff.querySelector(`[data-thread-id="${threadId}"]`) as HTMLElement | null;
    const threadCard = host?.querySelector('[data-thread-card="true"]') as HTMLElement | null;
    if (!host || !threadCard) return null;
    const diffRect = diff.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const cardRect = threadCard.getBoundingClientRect();
    return {
      diffWidth: Math.round(diffRect.width),
      hostWidth: Math.round(hostRect.width),
      cardWidth: Math.round(cardRect.width),
    };
  }, comment.threadId);

  expect(geometry).not.toBeNull();
  expect(geometry!.hostWidth, JSON.stringify(geometry)).toBeGreaterThanOrEqual(
    geometry!.diffWidth - 2,
  );
  expect(geometry!.cardWidth, JSON.stringify(geometry)).toBeGreaterThanOrEqual(
    geometry!.diffWidth - 28,
  );
});

test("no-wrap split keeps code text visible while horizontally scrolling", async ({ page }) => {
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
  for (const left of [0, 250, 700]) {
    await staffDiff.evaluate((el, scrollLeft) => {
      el.scrollLeft = scrollLeft;
    }, left);
    await page.waitForTimeout(50);
    const coverage = await staffDiff.evaluate(visibleGlyphCoverageScript());
    expect(coverage.visibleGlyphCells, JSON.stringify(coverage)).toBeGreaterThan(0);
  }
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
  const foldGeometry = await foldPill.evaluate((btn) => {
    const diff = btn.closest(".staff-diff") as HTMLElement;
    const cell = btn.closest("td") as HTMLElement;
    const diffRect = diff.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    const buttonRect = btn.getBoundingClientRect();
    return {
      diffWidth: Math.round(diffRect.width),
      cellLeft: Math.round(cellRect.left - diffRect.left),
      cellRight: Math.round(cellRect.right - diffRect.left),
      buttonCenter: Math.round(buttonRect.left + buttonRect.width / 2 - diffRect.left),
    };
  });
  expect(foldGeometry.cellLeft, JSON.stringify(foldGeometry)).toBe(0);
  expect(foldGeometry.cellRight, JSON.stringify(foldGeometry)).toBe(foldGeometry.diffWidth);
  expect(Math.abs(foldGeometry.buttonCenter - foldGeometry.diffWidth / 2)).toBeLessThanOrEqual(1);
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

  const gutter = card.locator(".staff-gutter.diff-added").first();
  await gutter.hover();
  const plus = card.locator("[data-staff-plus]");
  await expect(plus).toBeVisible();

  await staffDiff.evaluate((el) => {
    el.scrollLeft = 700;
  });
  await expect.poll(() => staffDiff.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);

  await gutter.hover();
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

test("no-wrap unified keeps code text visible while horizontally scrolling", async ({ page }) => {
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
  for (const left of [0, 250, 700]) {
    await staffDiff.evaluate((el, scrollLeft) => {
      el.scrollLeft = scrollLeft;
    }, left);
    await page.waitForTimeout(50);
    const coverage = await staffDiff.evaluate(visibleGlyphCoverageScript());
    expect(coverage.visibleGlyphCells, JSON.stringify(coverage)).toBeGreaterThan(0);
  }
});

test("no-wrap unified keeps the gutter fixed while clipping code to the pane", async ({ page }) => {
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
  const scrollSamples = await staffDiff.evaluate(async (el) => {
    const sample = () => {
      const diffRect = el.getBoundingClientRect();
      const gutter = el.querySelector(".staff-gutter-unified") as HTMLElement;
      const marker = el.querySelector(".staff-marker") as HTMLElement;
      const content = el.querySelector(".staff-content") as HTMLElement;
      const rect = (node: HTMLElement) => {
        const r = node.getBoundingClientRect();
        return {
          left: Math.round(r.left - diffRect.left),
          right: Math.round(r.right - diffRect.left),
          width: Math.round(r.width),
        };
      };
      return {
        scrollLeft: Math.round(el.scrollLeft),
        gutter: rect(gutter),
        marker: rect(marker),
        content: rect(content),
      };
    };
    const samples = [];
    for (const left of [0, 250, 700]) {
      el.scrollLeft = left;
      await new Promise(requestAnimationFrame);
      samples.push(sample());
    }
    return samples;
  });
  for (const sample of scrollSamples) {
    expect(sample.gutter.left, JSON.stringify(scrollSamples)).toBe(0);
    expect(sample.gutter.width, JSON.stringify(scrollSamples)).toBe(52);
    expect(sample.marker.left, JSON.stringify(scrollSamples)).toBe(52);
    expect(sample.marker.width, JSON.stringify(scrollSamples)).toBe(24);
    expect(sample.content.left, JSON.stringify(scrollSamples)).toBe(76);
  }
});

test("no-wrap unified keeps the fold rule and pill fixed while horizontally scrolling", async ({
  page,
}) => {
  await openFeatureDiff(page);
  const card = page.getByTestId("file-card-wrapme.ts");
  const staffDiff = card.locator(".staff-diff");
  const foldPill = card.locator('button[class*="code-fold-expand-button"]').first();
  await expect(foldPill).toBeVisible({ timeout: 10_000 });

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
  await staffDiff.evaluate((el) => {
    el.scrollLeft = 800;
  });
  await expect.poll(() => staffDiff.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);

  const geometry = await foldPill.evaluate((btn) => {
    const diff = btn.closest(".staff-diff") as HTMLElement;
    const cell = btn.closest("td") as HTMLElement;
    const diffRect = diff.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    const buttonRect = btn.getBoundingClientRect();
    return {
      diffWidth: Math.round(diffRect.width),
      scrollLeft: Math.round(diff.scrollLeft),
      cellLeft: Math.round(cellRect.left - diffRect.left),
      cellRight: Math.round(cellRect.right - diffRect.left),
      buttonCenter: Math.round(buttonRect.left + buttonRect.width / 2 - diffRect.left),
    };
  });
  expect(geometry.cellLeft, JSON.stringify(geometry)).toBe(0);
  expect(geometry.cellRight, JSON.stringify(geometry)).toBe(geometry.diffWidth);
  expect(Math.abs(geometry.buttonCenter - geometry.diffWidth / 2)).toBeLessThanOrEqual(1);
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
    const clip = cell.querySelector(".staff-content-clip") as HTMLElement | null;
    if (!clip) throw new Error("missing long added line clip");
    const text = cell.querySelector('[class*="content-text"]') as HTMLElement | null;
    if (!text) throw new Error("missing long added line text");
    const cellRect = cell.getBoundingClientRect();
    const clipRect = clip.getBoundingClientRect();
    const textRect = text.getBoundingClientRect();
    return {
      clipRightGap: Math.round(cellRect.right - clipRect.right),
      clipOverflowX: getComputedStyle(clip).overflowX,
      textOverflowsClip: Math.round(textRect.right - clipRect.right),
    };
  });
  expect(Math.abs(coverage.clipRightGap), JSON.stringify(coverage)).toBeLessThanOrEqual(1);
  expect(coverage.clipOverflowX, JSON.stringify(coverage)).toBe("hidden");
  expect(coverage.textOverflowsClip, JSON.stringify(coverage)).toBeGreaterThan(100);

  await card.scrollIntoViewIfNeeded();
  await staffDiff.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  await expect.poll(() => staffDiff.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);
  const rightEdgeCoverage = await staffDiff.evaluate((el) => {
    const cell = [...el.querySelectorAll('td[class*="content"][class*="diff-added"]')].find((c) =>
      c.textContent?.includes("!!"),
    ) as HTMLElement | undefined;
    if (!cell) throw new Error("missing long added line");
    const table = el.querySelector("table") as HTMLElement | null;
    const row = cell.closest("tr") as HTMLElement | null;
    const cellRect = cell.getBoundingClientRect();
    const containerRect = el.getBoundingClientRect();
    const tableRect = table?.getBoundingClientRect();
    const cellBackground = getComputedStyle(cell).backgroundColor;
    const rowBackground = row ? getComputedStyle(row).backgroundColor : "";
    return {
      cellRight: Math.round(cellRect.right),
      containerRight: Math.round(containerRect.right),
      tableRight: tableRect ? Math.round(tableRect.right) : null,
      scrollLeft: Math.round(el.scrollLeft),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      tableMinWidth: table ? getComputedStyle(table).minWidth : null,
      gapToRightEdge: Math.round(containerRect.right - cellRect.right),
      cellBackground,
      rowBackground,
      hasChangedTint:
        cellBackground !== "rgba(0, 0, 0, 0)" ||
        (rowBackground !== "" && rowBackground !== "rgba(0, 0, 0, 0)"),
    };
  });
  expect(rightEdgeCoverage.gapToRightEdge, JSON.stringify(rightEdgeCoverage)).toBeLessThanOrEqual(
    1,
  );
  expect(rightEdgeCoverage.hasChangedTint, JSON.stringify(rightEdgeCoverage)).toBe(true);
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

test("Wrap lines preference persists across reload and can be set by CLI", async ({ page }) => {
  expect((await staff(["settings", "get", "wrapLines"])).trim()).toBe("true");

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

  expect((await staff(["settings", "set", "wrapLines", "true"])).trim()).toBe("wrapLines: true");
  await page.reload();
  await openFeatureDiff(page);
  const reloadedCard = page.getByTestId("file-card-wrapme.ts");
  await expect(reloadedCard.locator(".staff-diff")).not.toHaveClass(/staff-diff-nowrap/);
  await page.getByTestId("settings-menu-button").click();
  await expect(page.getByTestId("wrap-lines-toggle")).toHaveAttribute("aria-checked", "true");
});
