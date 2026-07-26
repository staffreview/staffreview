import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
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

async function initRepoWithBinaryAttributes() {
  await git(["init"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test User"]);
  await git(["config", "diff.renames", "true"]);
  await git(["config", "core.autocrlf", "false"]);
  await Bun.write(join(tmp, ".gitattributes"), "*.dat -diff\n");
  await Bun.write(join(tmp, "old.dat"), "plain text that attributes mark binary\n");
  await git(["add", "."]);
  await git(["commit", "-m", "initial"]);
}

async function initRepoWithFiles() {
  await git(["init"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test User"]);
  mkdirSync(join(tmp, "ignored"));
  await Bun.write(join(tmp, ".staffignore"), "ignored/*\n!ignored/keep.ts\n");
  await Bun.write(join(tmp, "keep.ts"), "export const keep = 1;\n");
  await Bun.write(join(tmp, "ignored", "skip.ts"), "export const skip = 1;\n");
  await Bun.write(join(tmp, "ignored", "keep.ts"), "export const nestedKeep = 1;\n");
  await git(["add", "."]);
  await git(["commit", "-m", "initial"]);
}

test("getDiff keeps renamed files marked binary by attributes as binary rows", async () => {
  await initRepoWithBinaryAttributes();
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

test("getDiff keeps modified files marked binary by attributes as binary rows", async () => {
  await initRepoWithBinaryAttributes();
  await Bun.write(join(tmp, "old.dat"), "changed text that attributes still mark binary\n");

  const files = await getDiff({ kind: "commit", ref: "HEAD" }, { kind: "working-tree" }, tmp);

  expect(files).toHaveLength(1);
  expect(files[0]).toMatchObject({
    path: "old.dat",
    status: "modified",
    oldContent: "",
    newContent: "",
    isBinary: true,
  });
});

test("getDiff excludes files matched by .staffignore", async () => {
  await initRepoWithFiles();
  await Bun.write(join(tmp, "keep.ts"), "export const keep = 2;\n");
  await Bun.write(join(tmp, "ignored", "skip.ts"), "export const skip = 2;\n");
  await Bun.write(join(tmp, "ignored", "keep.ts"), "export const nestedKeep = 2;\n");
  await Bun.write(join(tmp, "new.ts"), "export const added = true;\n");
  await Bun.write(join(tmp, "ignored", "untracked.ts"), "export const hidden = true;\n");

  const files = await getDiff({ kind: "commit", ref: "HEAD" }, { kind: "working-tree" }, tmp);

  expect(files.map((file) => file.path).sort()).toEqual(["ignored/keep.ts", "keep.ts", "new.ts"]);
});
