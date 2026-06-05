import { expect, test } from "@playwright/test";
import { readActiveDiff, resetDiffsJson } from "./helpers.ts";

test.beforeEach(async () => {
  await resetDiffsJson();
});

function editor(page: import("@playwright/test").Page) {
  return page.getByTestId("comment-editor");
}

async function openComposer(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.waitForResponse(
    (r) => r.url().includes("/api/diff") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: /new comment/i }).click();
  await editor(page).click();
}

test("formats markdown inline as you type (WYSIWYG, no separate preview)", async ({ page }) => {
  await openComposer(page);

  // Typing markdown applies formatting live inside the editor itself —
  // proving it's a rich editor, not a textarea or a side preview.
  await page.keyboard.type("**bold** and `code`");
  await expect(editor(page).locator("strong", { hasText: "bold" })).toBeVisible();
  await expect(editor(page).locator("code", { hasText: "code" })).toBeVisible();

  // There is no separate preview pane.
  await expect(page.getByTestId("md-preview")).toHaveCount(0);

  await page.getByRole("button", { name: /^Comment$/ }).click();

  // The body round-tripped back to markdown for storage.
  const diff = await readActiveDiff();
  const root = diff.comments.find((c: any) => !c.parentId);
  expect(root.body).toContain("**bold**");
  expect(root.body).toContain("`code`");
  // And it renders as markdown in the posted comment.
  await expect(page.locator(".staff-md strong", { hasText: "bold" }).first()).toBeVisible();
});

test("does not auto-link bare file paths like scripts/test-desktop-e2e.sh", async ({ page }) => {
  await openComposer(page);
  await page.keyboard.type("see scripts/test-desktop-e2e.sh for details");

  // No link is created in the editor for the file path.
  await expect(editor(page).locator("a")).toHaveCount(0);

  await page.getByRole("button", { name: /^Comment$/ }).click();

  // Stored body is the plain text (no markdown link syntax injected).
  const diff = await readActiveDiff();
  const root = diff.comments.find((c: any) => !c.parentId);
  expect(root.body).toContain("scripts/test-desktop-e2e.sh");
  expect(root.body).not.toMatch(/\]\(.*e2e\.sh/);
  // And it renders without an anchor tag.
  await expect(page.locator(".staff-md a")).toHaveCount(0);
});

test("heading input rule renders a real heading while editing", async ({ page }) => {
  await openComposer(page);
  await page.keyboard.type("# Heading");
  await expect(editor(page).locator("h1", { hasText: "Heading" })).toBeVisible();

  await page.getByRole("button", { name: /^Comment$/ }).click();
  const diff = await readActiveDiff();
  const root = diff.comments.find((c: any) => !c.parentId);
  expect(root.body).toContain("# Heading");
});

test("persists an in-progress draft to localStorage and restores it on reload", async ({
  page,
}) => {
  await openComposer(page);
  await page.keyboard.type("half-written thought");

  const stored = await page.evaluate(
    () => Object.keys(localStorage).filter((k) => k.startsWith("staff:draft:")).length,
  );
  expect(stored).toBeGreaterThan(0);

  // Reload — the composer should reopen with the draft restored.
  await page.reload();
  await page.waitForResponse(
    (r) => r.url().includes("/api/diff") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: /new comment/i }).click();
  await expect(editor(page)).toContainText("half-written thought");
});

test("clears the draft from localStorage after a successful post", async ({ page }) => {
  await openComposer(page);
  await page.keyboard.type("ship it");
  await page.getByRole("button", { name: /^Comment$/ }).click();
  await expect(page.getByText("ship it")).toBeVisible();

  const remaining = await page.evaluate(
    () => Object.keys(localStorage).filter((k) => k.startsWith("staff:draft:")).length,
  );
  expect(remaining).toBe(0);
});

test("attaching an image inserts an inline image and uploads to /api/attachment", async ({
  page,
}) => {
  await openComposer(page);

  // A 1x1 transparent PNG.
  const pngB64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAQAB3kqkAAAAAElFTkSuQmCC";
  const uploadResp = page.waitForResponse(
    (r) => r.url().includes("/api/attachment") && r.request().method() === "POST",
  );
  await page.getByTestId("md-attach").click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "shot.png",
    mimeType: "image/png",
    buffer: Buffer.from(pngB64, "base64"),
  });
  const resp = await uploadResp;
  expect(resp.ok()).toBe(true);
  const { url } = await resp.json();
  expect(url).toMatch(/^\/attachments\/[0-9a-f-]+\.png$/);

  // The editor shows the image inline.
  await expect(editor(page).locator(`img[src="${url}"]`)).toBeVisible();

  // The served file is reachable and is a PNG.
  const fetched = await page.request.get(url);
  expect(fetched.ok()).toBe(true);
  expect(fetched.headers()["content-type"]).toBe("image/png");

  // Posting stores a markdown image and renders it in the comment body.
  await page.getByRole("button", { name: /^Comment$/ }).click();
  const diff = await readActiveDiff();
  const root = diff.comments.find((c: any) => !c.parentId);
  expect(root.body).toContain(`(${url})`);
  await expect(page.locator(`.staff-md img[src="${url}"]`)).toBeVisible();
});
