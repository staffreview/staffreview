import { test, expect } from "@playwright/test";
import { resetDiffsJson } from "./helpers.ts";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { SCRATCH_DIR } from "./setup.ts";

test.beforeEach(async () => {
  await resetDiffsJson();
  await rm(join(SCRATCH_DIR, ".config-test"), { recursive: true, force: true });
});

async function openGear(page: import("@playwright/test").Page) {
  await page.getByTestId("settings-menu-button").click();
}

test("theme picker toggles the `dark` class on <html>", async ({ page }) => {
  // Force a known light system preference so the "System" default lands
  // on light mode for the assertion below.
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");

  // Default is "System" → with a light OS, no `dark` class on <html>.
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(false);

  await openGear(page);
  await page.getByTestId("theme-dark").click();
  await expect(page.getByTestId("theme-dark")).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);

  await page.getByTestId("theme-light").click();
  await expect(page.getByTestId("theme-light")).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(false);
});

test("syntax-theme typeahead is closed by default, filters the list, persists the pick", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();

  await openGear(page);
  // Closed by default — the trigger shows the current theme; the list
  // itself isn't rendered.
  const trigger = page.getByTestId("syntax-theme-button");
  await expect(trigger).toContainText("catppuccin-latte");
  await expect(page.getByTestId("syntax-theme-search")).toHaveCount(0);

  await trigger.click();
  // Light mode → light themes only.
  await expect(page.getByTestId("syntax-theme-catppuccin-latte")).toBeVisible();
  await expect(page.getByTestId("syntax-theme-catppuccin-mocha")).toHaveCount(0);

  // Typeahead filters: only names that match "rose" should remain.
  await page.getByTestId("syntax-theme-search").fill("rose");
  await expect(page.getByTestId("syntax-theme-rose-pine-dawn")).toBeVisible();
  await expect(page.getByTestId("syntax-theme-catppuccin-latte")).toHaveCount(0);

  const postSettings = page.waitForResponse(
    (r) => r.url().includes("/api/settings") && r.request().method() === "POST",
  );
  await page.getByTestId("syntax-theme-rose-pine-dawn").click();
  await postSettings;
  // Picking an item closes the popover.
  await expect(page.getByTestId("syntax-theme-search")).toHaveCount(0);
  await expect(trigger).toContainText("rose-pine-dawn");

  // Flip to dark — trigger updates to the dark-mode default, and
  // opening shows dark themes only.
  await page.getByTestId("theme-dark").click();
  await expect(trigger).toContainText("catppuccin-mocha");
  await trigger.click();
  await expect(page.getByTestId("syntax-theme-catppuccin-mocha")).toBeVisible();
  await expect(page.getByTestId("syntax-theme-rose-pine-dawn")).toHaveCount(0);
});

test("theme preference is persisted and survives reload; System follows OS", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");

  await openGear(page);
  const postSettings = page.waitForResponse(
    (r) => r.url().includes("/api/settings") && r.request().method() === "POST",
  );
  await page.getByTestId("theme-dark").click();
  await postSettings;

  await page.reload();
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);
  await openGear(page);
  await expect(page.getByTestId("theme-dark")).toHaveAttribute("aria-checked", "true");

  // Switch back to System and emulate a dark OS — the page should flip
  // dark without a reload.
  await page.getByTestId("theme-system").click();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);

  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(false);
});
