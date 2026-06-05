import { expect, test } from "@playwright/test";
import { fillEditor, readActiveDiff, resetDiffsJson, staff } from "./helpers.ts";

test.beforeEach(async () => {
  await resetDiffsJson();
});

test("creates a top-level comment from the UI", async ({ page }) => {
  await page.goto("/");
  await page.waitForResponse(
    (r) => r.url().includes("/api/diff") && r.request().method() === "POST",
  );

  await page.getByRole("button", { name: /new comment/i }).click();
  await fillEditor(page.getByTestId("comment-editor"), "Overall LGTM, modulo nits below.");
  await page.getByRole("button", { name: /^Comment$/ }).click();

  await expect(page.getByText("Overall LGTM, modulo nits below.")).toBeVisible();

  const diff = await readActiveDiff();
  const topLevel = diff.comments.filter((c: any) => !c.file && !c.parentId);
  expect(topLevel).toHaveLength(1);
  expect(topLevel[0].body).toBe("Overall LGTM, modulo nits below.");
});

test("Fixed via the Resolve dropdown collapses the thread", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /new comment/i }).click();
  await fillEditor(page.getByTestId("comment-editor"), "Needs a CHANGELOG entry.");
  await page.getByRole("button", { name: /^Comment$/ }).click();
  await expect(page.getByText("Needs a CHANGELOG entry.")).toBeVisible();

  await page.getByTestId("thread-resolve").click();
  await page.getByTestId("thread-fixed").click();

  const collapsed = page.getByTestId("thread-collapsed-fixed");
  await expect(collapsed).toBeVisible();
  await expect(collapsed).toContainText("Fixed");
  // Body is hidden in the collapsed view.
  await expect(page.getByText("Needs a CHANGELOG entry.")).toHaveCount(0);
  await expect(page.getByTestId("thread-resolve")).toHaveCount(0);

  await collapsed.getByRole("button", { name: /reopen/i }).click();
  await expect(page.getByText("Needs a CHANGELOG entry.")).toBeVisible();
});

test("Skip via the Resolve dropdown collapses the thread", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /new comment/i }).click();
  await fillEditor(page.getByTestId("comment-editor"), "Consider memoizing.");
  await page.getByRole("button", { name: /^Comment$/ }).click();
  await expect(page.getByText("Consider memoizing.")).toBeVisible();

  await page.getByTestId("thread-resolve").click();
  await page.getByTestId("thread-skip").click();

  const collapsed = page.getByTestId("thread-collapsed-skipped");
  await expect(collapsed).toBeVisible();
  await expect(collapsed).toContainText("Skipped");
  await expect(page.getByText("Consider memoizing.")).toHaveCount(0);

  await collapsed.getByRole("button", { name: /reopen/i }).click();
  await expect(page.getByText("Consider memoizing.")).toBeVisible();
});

test("clicking a resolved card expands/collapses its content without reopening", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /new comment/i }).click();
  await fillEditor(page.getByTestId("comment-editor"), "Body to peek at.");
  await page.getByRole("button", { name: /^Comment$/ }).click();

  await page.getByTestId("thread-resolve").click();
  await page.getByTestId("thread-fixed").click();

  const collapsed = page.getByTestId("thread-collapsed-fixed");
  await expect(collapsed).toBeVisible();
  // Collapsed by default — body hidden.
  await expect(page.getByText("Body to peek at.")).toHaveCount(0);

  // Click the row (not the Reopen button) → expands in place.
  await page.getByTestId("thread-collapsed-toggle-fixed").click();
  await expect(page.getByText("Body to peek at.")).toBeVisible();
  // Still resolved — not reopened (no Resolve footer, still the collapsed card).
  await expect(collapsed).toBeVisible();
  await expect(page.getByTestId("thread-resolve")).toHaveCount(0);

  // Click again → collapses.
  await page.getByTestId("thread-collapsed-toggle-fixed").click();
  await expect(page.getByText("Body to peek at.")).toHaveCount(0);
  await expect(collapsed).toBeVisible();
});

test("Document flags the thread for /staff-resolve without resolving it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /new comment/i }).click();
  await fillEditor(page.getByTestId("comment-editor"), "Pattern worth saving as an example.");
  await page.getByRole("button", { name: /^Comment$/ }).click();

  // Clicking Document does NOT open a form — it just marks the thread.
  const docBtn = page.getByTestId("thread-document");
  await docBtn.click();

  // The button flips to the pressed state with a green check icon.
  await expect(docBtn).toHaveAttribute("aria-pressed", "true");
  await expect(docBtn.locator("svg.lucide-check, svg.lucide-circle-check")).toBeVisible();
  // The thread stays open — the comment body is still shown and the
  // Resolve dropdown is still available.
  await expect(page.getByText("Pattern worth saving as an example.")).toBeVisible();
  await expect(page.getByTestId("thread-resolve")).toBeVisible();

  // Persisted as a non-resolution flag on the root comment.
  let diff = await readActiveDiff();
  let root = diff.comments.find((c: any) => !c.parentId);
  expect(root.documentRequested).toBe(true);
  expect(root.resolution).toBeUndefined();

  // Clicking again unmarks it.
  await docBtn.click();
  await expect(docBtn).toHaveAttribute("aria-pressed", "false");

  diff = await readActiveDiff();
  root = diff.comments.find((c: any) => !c.parentId);
  expect(root.documentRequested).toBeFalsy();
});

test("Reply adds a child comment to the thread", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /new comment/i }).click();
  await fillEditor(page.getByTestId("comment-editor"), "Root comment.");
  await page.getByRole("button", { name: /^Comment$/ }).click();
  await expect(page.getByText("Root comment.")).toBeVisible();

  await page.getByTestId("thread-reply").click();
  await fillEditor(page.getByTestId("comment-editor"), "Reply text.");
  await page.getByTestId("reply-submit").click();

  await expect(page.getByText("Reply text.")).toBeVisible();
  const diff = await readActiveDiff();
  const reply = diff.comments.find((c: any) => c.parentId);
  expect(reply.body).toBe("Reply text.");
});

test("CLI replies without file metadata render inline with their root thread", async ({ page }) => {
  await page.goto("/");
  await page.waitForResponse(
    (r) => r.url().includes("/api/diff") && r.request().method() === "POST",
  );

  const root = JSON.parse(
    await staff([
      "comment",
      "add",
      "--file",
      "math.ts",
      "--line",
      "2",
      "--side",
      "new",
      "--author",
      "Opus 4.8",
      "--body",
      "Root inline finding.",
    ]),
  );
  await staff([
    "comment",
    "add",
    "--reply-to",
    root.id,
    "--author",
    "agent",
    "--body",
    "Reply without file metadata.",
  ]);

  await page.reload();
  const mathCard = page.getByTestId("file-card-math.ts");
  const inlineThread = mathCard.locator(`[data-thread-id="${root.threadId}"]`);

  await expect(inlineThread).toContainText("Root inline finding.");
  await expect(inlineThread).toContainText("Reply without file metadata.");
});

test("an open (unresolved) thread can be collapsed and expanded via its chevron", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /new comment/i }).click();
  await fillEditor(page.getByTestId("comment-editor"), "Body to collapse.");
  await page.getByRole("button", { name: /^Comment$/ }).click();
  await expect(page.getByText("Body to collapse.")).toBeVisible();

  // The collapse chevron is now on every card, not just resolved ones.
  const toggle = page.getByTestId("thread-collapse-toggle");
  await expect(toggle).toBeVisible();

  // Collapsing must not shift the header — the chevron stays put.
  const before = await toggle.boundingBox();
  if (!before) throw new Error("no bounding box");

  // Collapse → body and the Resolve footer hide; the chevron stays.
  await toggle.click();
  const after = await toggle.boundingBox();
  if (!after) throw new Error("no bounding box");
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1);
  await expect(page.getByText("Body to collapse.")).toHaveCount(0);
  await expect(page.getByTestId("thread-resolve")).toHaveCount(0);
  await expect(toggle).toBeVisible();

  // Expand → both come back.
  await toggle.click();
  await expect(page.getByText("Body to collapse.")).toBeVisible();
  await expect(page.getByTestId("thread-resolve")).toBeVisible();
});

test("long inline-code paths wrap inside the comment card", async ({ page }) => {
  await page.goto("/");
  await page.waitForResponse(
    (r) => r.url().includes("/api/diff") && r.request().method() === "POST",
  );

  const diff = await readActiveDiff();
  const longPath =
    "packages/web/src/server/graphql/types/InvestAccountWithAnExtremelyLongGeneratedTypeName.ts";
  await page.request.post("/api/comment", {
    data: {
      slug: diff.slug,
      body: `\`${longPath}\` should stay inside the card.`,
    },
  });
  await page.reload();

  const body = page.locator(".staff-md").filter({ hasText: longPath }).first();
  await expect(body).toBeVisible();
  const card = body.locator("xpath=ancestor::*[@data-thread-card='true'][1]");
  const widths = await card.evaluate((el) => ({
    clientWidth: el.clientWidth,
    scrollWidth: el.scrollWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth + 1);
});
