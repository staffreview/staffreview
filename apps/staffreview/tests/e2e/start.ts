#!/usr/bin/env bun
import { spawn } from "node:child_process";
import setup, { SCRATCH_DIR, STAFF_CONFIG_DIR, TEST_PORT } from "./setup.ts";

await setup();

const child = spawn(
  "bun",
  ["run", "src/cli.ts", "serve", "--port", String(TEST_PORT), "--no-open", "--repo", SCRATCH_DIR],
  { stdio: "inherit", env: { ...process.env, STAFF_CONFIG_DIR } },
);

child.on("exit", (code) => process.exit(code ?? 0));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => child.kill(sig));
}
