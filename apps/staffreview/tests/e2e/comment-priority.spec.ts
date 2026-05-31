import { test, expect } from "@playwright/test";
import { resetDiffsJson, staff, readActiveDiff } from "./helpers.ts";

test.beforeEach(async () => {
  await resetDiffsJson();
});

test("comment --priority is stored, normalized, and validated (CLI)", async () => {
  await staff(["diff", "--base", "HEAD", "--head", "working-tree"]);

  const p1 = JSON.parse(
    await staff(["comment", "add", "--file", "math.ts", "--line", "2", "--side", "new", "--author", "cli", "--priority", "P1", "--body", "Critical."]),
  );
  expect(p1.priority).toBe("P1");

  // A bare number (and lowercase) normalizes to P-form.
  const p2 = JSON.parse(await staff(["comment", "add", "--author", "cli", "--priority", "2", "--body", "Note."]));
  expect(p2.priority).toBe("P2");

  // No flag → no priority.
  const none = JSON.parse(await staff(["comment", "add", "--author", "cli", "--body", "Plain."]));
  expect(none.priority).toBeUndefined();

  // Out-of-range is rejected.
  await expect(
    staff(["comment", "add", "--author", "cli", "--priority", "P9", "--body", "x"]),
  ).rejects.toThrow(/priority must be/i);

  const diff = await readActiveDiff();
  expect(diff.comments.find((c: any) => c.id === p1.id).priority).toBe("P1");
});

test("a prioritized comment shows its P-badge in the UI", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByTestId("file-card-big.ts")).toBeVisible();

  // An agent posts a P1 finding on the active diff.
  await staff([
    "comment", "add",
    "--file", "big.ts", "--line", "21", "--side", "new",
    "--author", "Opus 4.8", "--priority", "P1",
    "--body", "This jumped 20 → 200 — confirm intentional.",
  ]);

  await expect(page.getByTestId("priority-P1").first()).toBeVisible();
});

test("a resolved thread shows its priority in the detail, not the summary row", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-testid^="file-card-"]').first()).toBeVisible();

  // Agent posts a top-level P1 — shown while open.
  await staff(["comment", "add", "--author", "Opus 4.8", "--priority", "P1", "--body", "Top-level P1 finding."]);
  await expect(page.getByTestId("priority-P1")).toHaveCount(1);

  // Resolve it → the cramped collapsed summary row omits the priority badge.
  await page.getByTestId("thread-resolve").click();
  await page.getByTestId("thread-fixed").click();
  await expect(page.getByTestId("thread-collapsed-fixed")).toBeVisible();
  await expect(page.getByTestId("priority-P1")).toHaveCount(0);

  // ...but expanding the card shows it on the comment's own header.
  await page.getByTestId("thread-collapsed-toggle-fixed").click();
  await expect(page.getByText("Top-level P1 finding.")).toBeVisible();
  await expect(page.getByTestId("priority-P1")).toHaveCount(1);
});
