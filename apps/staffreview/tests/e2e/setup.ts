import { spawn } from "node:child_process";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const SCRATCH_DIR = join(__dirname, ".tmp", "repo");
export const TEST_PORT = 4823;
// Isolated global-settings dir, shared by the test server (start.ts) and the
// CLI helper (helpers.ts) so both read/write the same settings file rather than
// the developer's real ~/.config/staffreview.
export const STAFF_CONFIG_DIR = join(SCRATCH_DIR, ".config-test");

const FILE_A_OLD = `export function add(a: number, b: number): number {
  return a + b;
}

export function sub(a: number, b: number): number {
  return a - b;
}
`;

const FILE_A_NEW = `export function add(a: number, b: number): number {
  if (typeof a !== "number") throw new Error("a must be a number");
  return a + b;
}

export function sub(a: number, b: number): number {
  return a - b;
}

export function mul(a: number, b: number): number {
  return a * b;
}
`;

// A file with a large unchanged region so that "collapsed" (showDiffOnly)
// mode folds context into expandable blocks — exercised by
// file-default-expand.spec.ts.
const BIG_LINES = Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`);
const BIG_OLD = `${BIG_LINES.join("\n")}\n`;
const BIG_NEW = `${BIG_LINES.map((l, i) => (i === 20 ? `const v20 = 200;` : l)).join("\n")}\n`;

const README_OLD = `# Demo
A toy module.
`;

const README_NEW = `# Demo
A toy module with extra helpers.

- add
- sub
- mul (new)
`;

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} (exit ${code}): ${stderr}`));
    });
  });
}

export default async function globalSetup() {
  await rm(SCRATCH_DIR, { recursive: true, force: true });
  await mkdir(SCRATCH_DIR, { recursive: true });

  await run("git", ["init", "-q", "-b", "main"], SCRATCH_DIR);
  await run("git", ["config", "user.email", "e2e@test"], SCRATCH_DIR);
  await run("git", ["config", "user.name", "e2e"], SCRATCH_DIR);
  await run("git", ["config", "commit.gpgsign", "false"], SCRATCH_DIR);

  await writeFile(join(SCRATCH_DIR, "math.ts"), FILE_A_OLD);
  await writeFile(join(SCRATCH_DIR, "README.md"), README_OLD);
  await writeFile(join(SCRATCH_DIR, "big.ts"), BIG_OLD);
  await run("git", ["add", "."], SCRATCH_DIR);
  await run("git", ["commit", "-qm", "initial"], SCRATCH_DIR);

  await run("git", ["checkout", "-qb", "feature/improve-math"], SCRATCH_DIR);
  await writeFile(join(SCRATCH_DIR, "math.ts"), FILE_A_NEW);
  await writeFile(join(SCRATCH_DIR, "README.md"), README_NEW);
  await writeFile(join(SCRATCH_DIR, "big.ts"), BIG_NEW);
  // A symlink (git mode 120000) added on the feature branch — exercises
  // the symlink indicator in the UI.
  await symlink("README.md", join(SCRATCH_DIR, "readme-link"));
  // A tiny binary blob (PNG magic + NUL bytes) added on the feature branch —
  // exercises the "Binary file not shown" handling instead of a text diff.
  await writeFile(
    join(SCRATCH_DIR, "pixel.png"),
    Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0xff, 0xd8, 0xff,
    ]),
  );
  await run("git", ["add", "-A"], SCRATCH_DIR);
  await run("git", ["commit", "-qm", "feature changes"], SCRATCH_DIR);
  for (let i = 1; i <= 6; i++) {
    await run("git", ["tag", `tag/release-${i}`], SCRATCH_DIR);
  }

  await run("git", ["checkout", "-q", "main"], SCRATCH_DIR);
  await run("git", ["tag", "tag/release-old"], SCRATCH_DIR);

  // Extra branches pointing at the (older) initial commit so the total
  // exceeds the target picker's idle cap of 5. They sort below
  // feature/improve-math (the newest) by commit date, so the cap test can
  // assert they're hidden until searched.
  for (let i = 1; i <= 5; i++) {
    await run("git", ["branch", `legacy/branch-${i}`, "main"], SCRATCH_DIR);
  }

  await writeFile(join(SCRATCH_DIR, "math.ts"), FILE_A_OLD.replace("a + b", "a + b /* sum */"));
}
