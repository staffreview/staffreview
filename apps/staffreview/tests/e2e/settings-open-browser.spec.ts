import { rm } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { resetDiffsJson, staff } from "./helpers.ts";
import { STAFF_CONFIG_DIR } from "./setup.ts";

test.beforeEach(async () => {
  await resetDiffsJson();
  // Start from no global settings so the default applies.
  await rm(STAFF_CONFIG_DIR, { recursive: true, force: true });
});

test("openBrowser: CLI default, gear-menu toggle persists, and CLI setter writes it", async ({
  page,
}) => {
  expect((await staff(["settings", "get", "openBrowser"])).trim()).toBe("true");

  await page.goto("/");
  await page.getByTestId("settings-menu-button").click();
  await expect(page.getByTestId("open-browser-auto")).toHaveAttribute("aria-checked", "true");

  const posted = page.waitForResponse(
    (r) => r.url().includes("/api/settings") && r.request().method() === "POST",
  );
  await page.getByTestId("open-browser-manual").click();
  await posted;
  await expect(page.getByTestId("open-browser-manual")).toHaveAttribute("aria-checked", "true");
  await expect
    .poll(async () => (await staff(["settings", "get", "openBrowser"])).trim())
    .toBe("false");

  expect((await staff(["settings", "set", "openBrowser", "true"])).trim()).toBe(
    "openBrowser: true",
  );
  await page.reload();
  await page.getByTestId("settings-menu-button").click();
  await expect(page.getByTestId("open-browser-auto")).toHaveAttribute("aria-checked", "true");
});
