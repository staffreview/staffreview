import { expect, test } from "@playwright/test";
import { resetDiffsJson } from "./helpers.ts";

test.beforeEach(async () => {
  await resetDiffsJson();
});

test("Live badge flips back to Connecting when the server connection drops", async ({ page }) => {
  // Intercept WebSocket construction in the page so we can force a close
  // without actually killing the test server (which would break the run).
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    const sockets: WebSocket[] = [];
    class Tracked extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    }
    (window as any).WebSocket = Tracked;
    (window as any).__staffWS = sockets;
  });

  await page.goto("/");
  await expect(page.getByText("Live", { exact: true })).toBeVisible();

  // Close every open WebSocket from the page side; the server is still up
  // and reachable, but the connection itself is now severed.
  await page.evaluate(() => {
    for (const ws of (window as any).__staffWS as WebSocket[]) ws.close();
  });

  await expect(page.getByText("Connecting…", { exact: true })).toBeVisible();

  // After the reconnect loop fires, the WS should reopen and the badge
  // should swing back to "Live" — confirms the synthetic disconnect event
  // didn't break the normal reconnect path.
  await expect(page.getByText("Live", { exact: true })).toBeVisible({ timeout: 10_000 });
});
