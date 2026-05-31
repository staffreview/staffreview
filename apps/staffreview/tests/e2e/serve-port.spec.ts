import { test, expect } from "@playwright/test";
import { staff } from "./helpers.ts";
import { TEST_PORT } from "./setup.ts";

// The `staff()` helper rejects (throws) when the CLI exits non-zero, embedding
// stderr in the error message — so these assert the clean failure paths of
// `staff serve` without needing to keep a server running.

test("serve rejects an invalid --port with a clear error", async () => {
  await expect(staff(["serve", "--port", "abc", "--no-open"])).rejects.toThrow(/invalid port/i);
  await expect(staff(["serve", "--port", "99999", "--no-open"])).rejects.toThrow(/invalid port/i);
});

test("serve fails cleanly when the requested port is already bound", async () => {
  // The Playwright web server is already listening on TEST_PORT, so binding it
  // again must fail with the friendly message rather than an uncaught stack.
  await expect(
    staff(["serve", "--port", String(TEST_PORT), "--no-open"]),
  ).rejects.toThrow(new RegExp(`could not bind port ${TEST_PORT}`, "i"));
});
