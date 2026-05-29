import { rm } from "node:fs/promises";
import { SCRATCH_DIR } from "./setup.ts";

export default async function globalTeardown() {
  if (process.env.STAFF_E2E_KEEP) return;
  await rm(SCRATCH_DIR, { recursive: true, force: true });
}
