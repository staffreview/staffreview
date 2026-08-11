import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageJson from "../package.json" with { type: "json" };

const packageDir = join(import.meta.dir, "..");

async function run(command: string[], cwd: string): Promise<string> {
  const process = Bun.spawn(command, {
    cwd,
    env: Bun.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed (${exitCode})\n${stderr || stdout}`);
  }
  return stdout;
}

const tempRoot = await mkdtemp(join(tmpdir(), "staffreview-package-test-"));

try {
  await run(["npm", "pack", "--pack-destination", tempRoot], packageDir);

  const tarballName = `${packageJson.name.replace(/^@/, "").replaceAll("/", "-")}-${packageJson.version}.tgz`;
  const tarballPath = join(tempRoot, tarballName);
  await access(tarballPath);

  const installPrefix = join(tempRoot, "install");
  const workingDir = join(tempRoot, "work");
  await mkdir(workingDir);
  await run(["npm", "install", "--global", "--prefix", installPrefix, tarballPath], workingDir);

  const staffBin = join(installPrefix, "bin", "staff");
  const installedVersion = (await run([staffBin, "--version"], workingDir)).trim();
  if (installedVersion !== packageJson.version) {
    throw new Error(
      `expected staff --version to return ${packageJson.version}, got ${installedVersion}`,
    );
  }

  const help = await run([staffBin, "--help"], workingDir);
  if (!help.includes("Staff Review") || !help.includes("USAGE")) {
    throw new Error("staff --help did not return the expected usage text");
  }

  console.log(`Package smoke test passed for @staffreview/staff@${packageJson.version}`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
