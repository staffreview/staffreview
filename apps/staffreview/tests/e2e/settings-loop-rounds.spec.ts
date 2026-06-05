import { rm } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { resetDiffsJson, staff } from "./helpers.ts";
import { STAFF_CONFIG_DIR } from "./setup.ts";

test.beforeEach(async () => {
  await resetDiffsJson();
  // Start from no global settings so the default applies.
  await rm(STAFF_CONFIG_DIR, { recursive: true, force: true });
});

test("loopMaxRounds: CLI default, gear-menu stepper persists, and the [1,20] clamp holds", async ({
  page,
}) => {
  // Default when unset (the /staff-loop skill reads this).
  expect((await staff(["settings", "get", "loopMaxRounds"])).trim()).toBe("5");

  // The gear-menu stepper changes and persists the value.
  await page.goto("/");
  await page.getByTestId("settings-menu-button").click();
  await expect(page.getByTestId("loop-rounds-value")).toHaveText("5 rounds max");
  const posted = page.waitForResponse(
    (r) => r.url().includes("/api/settings") && r.request().method() === "POST",
  );
  await page.getByTestId("loop-rounds-increase").click();
  await posted;
  await expect(page.getByTestId("loop-rounds-value")).toHaveText("6 rounds max");
  // The CLI reads the same value the UI just wrote (shared isolated config).
  await expect
    .poll(async () => (await staff(["settings", "get", "loopMaxRounds"])).trim())
    .toBe("6");

  // Out-of-range writes are clamped to [1, 20] server-side.
  const setRounds = async (v: number) => {
    const res = await page.request.post("/api/settings", { data: { loopMaxRounds: v } });
    return (await res.json()).settings.loopMaxRounds;
  };
  expect(await setRounds(999)).toBe(20);
  expect(await setRounds(0)).toBe(1);
});
