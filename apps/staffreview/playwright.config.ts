import { defineConfig, devices } from "@playwright/test";
import { TEST_PORT } from "./tests/e2e/setup.ts";

const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.spec\.ts$/,
  globalTeardown: "./tests/e2e/teardown.ts",
  timeout: 30_000,
  expect: { timeout: 7_500 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 7_500,
  },
  webServer: {
    command: `bun ./tests/e2e/start.ts`,
    url: `${BASE_URL}/api/info`,
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    stderr: "pipe",
    timeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1400, height: 900 } },
    },
  ],
});
