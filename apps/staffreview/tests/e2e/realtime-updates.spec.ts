import { expect, test } from "@playwright/test";
import { resetDiffsJson, staff } from "./helpers.ts";

// Regression guard for the live-update WebSocket: it must stay open across
// diff-target changes (a reconnect drops any event that lands during the gap).
//
// The basic "CLI create/resolve shows up live over WS" flows are owned by
// live-update.spec.ts ("CLI-added comment shows up…" / "CLI resolution updates
// the UI"); this file only covers the socket-stability case that's unique here.

test.beforeEach(async () => {
  await resetDiffsJson();
});

test("the WebSocket is not reopened when the diff target changes", async ({ page }) => {
  // Instrument the app WebSocket in-page *before* any app code runs: count how
  // many `/api/ws` sockets get constructed and keep a handle on the live one.
  // Unlike a plain `conns === baseline` count, holding the actual instance lets
  // us assert "the *same* socket is still OPEN" after the churn — which tells
  // "never reopened" apart from "flapped and reconnected back to the same
  // count", and turns any unrelated transient close into a created-count bump
  // rather than a silent pass.
  await page.addInitScript(() => {
    const w = window as unknown as {
      __wsCreated: number;
      __wsCurrent: WebSocket | null;
    };
    w.__wsCreated = 0;
    w.__wsCurrent = null;
    const Native = window.WebSocket;
    class TrackedWebSocket extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (String(url).includes("/api/ws")) {
          w.__wsCreated++;
          w.__wsCurrent = this;
        }
      }
    }
    window.WebSocket = TrackedWebSocket as unknown as typeof WebSocket;
  });

  await page.goto("/");
  await expect(page.locator('[data-testid^="file-card-"]').first()).toBeVisible();
  // The "Live" badge turns on only after the app socket's `hello` arrives, so
  // it's a deterministic "socket is up" signal — no fixed wait needed. (React
  // StrictMode mounts the socket effect twice in dev, so the absolute created
  // count isn't 1; we baseline it instead of asserting a literal value.)
  await expect(page.getByText("Live", { exact: true })).toBeVisible();

  // Pin the settled socket and the created-count as our baseline.
  const baseline = await page.evaluate(() => {
    const w = window as any;
    w.__wsRef = w.__wsCurrent; // remember the live instance to compare later
    return w.__wsCreated as number;
  });
  expect(baseline).toBeGreaterThan(0);

  // Switch head twice. Pre-fix, each switch tore down and reopened the socket
  // (its effect depended on a callback whose identity changed with the target).
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /feature\/improve-math/ }).click();
  await expect(page.getByText("math.ts", { exact: true }).first()).toBeVisible();
  await page.getByTestId("target-picker-head-button").click();
  await page.getByRole("option", { name: /working tree/i }).click();
  await expect(page.locator('[data-testid^="file-card-"]').first()).toBeVisible();

  // The baseline socket must still be the live one and OPEN — not torn down and
  // replaced. `sameInstance` catches a single flap-and-recover that a count
  // alone can't, and any unrelated transient close shows up as a created-count
  // bump rather than silently passing.
  const state = await page.evaluate(() => {
    const w = window as any;
    return {
      created: w.__wsCreated as number,
      sameInstance: w.__wsCurrent === w.__wsRef,
      stillOpen: w.__wsRef?.readyState === WebSocket.OPEN,
    };
  });
  expect(state.created).toBe(baseline);
  expect(state.sameInstance).toBe(true);
  expect(state.stillOpen).toBe(true);

  // And delivery still works after the target churn.
  await staff(["comment", "add", "--author", "cli", "--body", "live-after-target-change"]);
  await expect(page.getByText("live-after-target-change")).toBeVisible();
});
