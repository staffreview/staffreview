import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDiff } from "./git.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "staffreview-git-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function git(args: string[]) {
  const proc = Bun.spawn(["git", ...args], {
    cwd: tmp,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${exitCode})\n${err}`);
  }
  return out;
}

test("getDiff keeps renamed files marked binary by attributes as binary rows", async () => {
  await git(["init"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test User"]);
  await Bun.write(join(tmp, ".gitattributes"), "*.dat -diff\n");
  await Bun.write(join(tmp, "old.dat"), "plain text that attributes mark binary\n");
  await git(["add", "."]);
  await git(["commit", "-m", "initial"]);
  await git(["mv", "old.dat", "new.dat"]);

  const files = await getDiff({ kind: "commit", ref: "HEAD" }, { kind: "staged" }, tmp);

  expect(files).toHaveLength(1);
  expect(files[0]).toMatchObject({
    path: "new.dat",
    oldPath: "old.dat",
    status: "renamed",
    oldContent: "",
    newContent: "",
    isBinary: true,
  });
});
