import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, readlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "..", "src", "cli.ts");

const INSTALLED_SKILLS = [
  "staff-comment",
  "staff-copy",
  "staff-docs",
  "staff-docs-scout",
  "staff-document",
  "staff-loop",
  "staff-resolve",
  "staff-review",
  "staff-review-find",
  "staff-review-verify",
  "staff-section",
  "staff-section-find",
  "staff-section-verify",
];

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

test("staff install writes section skills, symlinks, and cache gitignore entry", async () => {
  const repo = await mkdtemp(join(tmpdir(), "staffreview-install-"));

  try {
    await run("git", ["init", "-q", "-b", "main"], repo);
    await run("bun", [CLI, "--repo", repo, "install"], repo);

    const installed = await readdir(join(repo, ".agents", "skills"));
    expect(installed.sort()).toEqual(INSTALLED_SKILLS);

    for (const name of ["staff-section", "staff-section-find", "staff-section-verify"]) {
      const skill = await readFile(join(repo, ".agents", "skills", name, "SKILL.md"), "utf8");
      expect(skill).toContain(`name: ${name}`);

      const link = await readlink(join(repo, ".claude", "skills", name));
      expect(link).toBe(join("..", "..", ".agents", "skills", name));
    }

    await stat(join(repo, ".staffreview"));
    const gitignore = await readFile(join(repo, ".gitignore"), "utf8");
    expect(gitignore.split(/\r?\n/)).toContain(".staffreview/section-cache.json");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
