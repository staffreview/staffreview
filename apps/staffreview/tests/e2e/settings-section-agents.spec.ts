import { rm } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { resetDiffsJson, staff } from "./helpers.ts";
import { STAFF_CONFIG_DIR } from "./setup.ts";

test.beforeEach(async () => {
  await resetDiffsJson();
  // Start from no global settings so the default applies.
  await rm(STAFF_CONFIG_DIR, { recursive: true, force: true });
});

test("sectionAgents: CLI default, gear-menu stepper persists, and the [1,20] clamp holds", async ({
  page,
}) => {
  // Default when unset (the /staff-section skill reads this).
  expect((await staff(["settings", "get", "sectionAgents"])).trim()).toBe("2");

  // The gear-menu stepper changes and persists the value.
  await page.goto("/");
  await page.getByTestId("settings-menu-button").click();
  await expect(page.getByTestId("section-agents-value")).toHaveText("2 agents");
  const posted = page.waitForResponse(
    (r) => r.url().includes("/api/settings") && r.request().method() === "POST",
  );
  await page.getByTestId("section-agents-increase").click();
  await posted;
  await expect(page.getByTestId("section-agents-value")).toHaveText("3 agents");
  // The CLI reads the same value the UI just wrote (shared isolated config).
  await expect
    .poll(async () => (await staff(["settings", "get", "sectionAgents"])).trim())
    .toBe("3");

  // Out-of-range writes are clamped to [1, 20] server-side.
  const setAgents = async (v: number) => {
    const res = await page.request.post("/api/settings", { data: { sectionAgents: v } });
    return (await res.json()).settings.sectionAgents;
  };
  expect(await setAgents(999)).toBe(20);
  expect(await setAgents(0)).toBe(1);

  // Singular label at 1.
  await page.reload();
  await page.getByTestId("settings-menu-button").click();
  await expect(page.getByTestId("section-agents-value")).toHaveText("1 agent");
});
