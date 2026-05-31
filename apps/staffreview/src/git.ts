import type { DiffTarget, FileDiff, GitRefInfo } from "./types.ts";
import { join } from "node:path";
import { lstat, readlink } from "node:fs/promises";

async function run(
  cmd: string[],
  opts: { allowFail?: boolean; cwd?: string } = {},
): Promise<string> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd ?? process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0 && !opts.allowFail) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`Command failed (${exitCode}): ${cmd.join(" ")}\n${err}`);
  }
  return out;
}

export async function isGitRepo(cwd = process.cwd()): Promise<boolean> {
  const proc = Bun.spawn(["git", "rev-parse", "--is-inside-work-tree"], {
    cwd,
    stdout: "pipe",
    stderr: "ignore",
  });
  await proc.exited;
  return proc.exitCode === 0;
}

export async function gitRoot(cwd = process.cwd()): Promise<string> {
  return (await run(["git", "rev-parse", "--show-toplevel"], { cwd })).trim();
}

export async function currentBranch(cwd = process.cwd()): Promise<string | null> {
  const out = (await run(["git", "branch", "--show-current"], { cwd })).trim();
  return out || null;
}

export async function listRefs(cwd = process.cwd()): Promise<GitRefInfo[]> {
  const refs: GitRefInfo[] = [];

  const branches = (await run([
    "git",
    "for-each-ref",
    "--sort=-committerdate", // most recently committed first
    "--format=%(refname:short)\t%(objectname)\t%(subject)",
    "refs/heads",
  ], { cwd })).trim();
  for (const line of branches.split("\n").filter(Boolean)) {
    const [name, sha, subject] = line.split("\t");
    refs.push({ name: name!, kind: "branch", sha, subject });
  }

  const remotes = (await run([
    "git",
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname:short)\t%(objectname)\t%(subject)",
    "refs/remotes",
  ], { cwd })).trim();
  for (const line of remotes.split("\n").filter(Boolean)) {
    const [name, sha, subject] = line.split("\t");
    if (name?.endsWith("/HEAD")) continue;
    refs.push({ name: name!, kind: "remote", sha, subject });
  }

  const tags = (await run([
    "git",
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname:short)\t%(objectname)\t%(subject)",
    "refs/tags",
  ], { cwd })).trim();
  for (const line of tags.split("\n").filter(Boolean)) {
    const [name, sha, subject] = line.split("\t");
    refs.push({ name: name!, kind: "tag", sha, subject });
  }

  const recent = (await run(["git", "log", "-50", "--pretty=%H%x09%s"], {
    cwd,
    allowFail: true,
  })).trim();
  for (const line of recent.split("\n").filter(Boolean)) {
    const [sha, subject] = line.split("\t");
    refs.push({ name: sha!.slice(0, 12), kind: "commit", sha, subject });
  }

  return refs;
}

export function targetLabel(t: DiffTarget): string {
  if (t.label) return t.label;
  if (t.kind === "working-tree") return "Working tree";
  if (t.kind === "staged") return "Staged";
  return t.ref ?? "(unknown)";
}

export function slugForDiff(base: DiffTarget, head: DiffTarget): string {
  const norm = (t: DiffTarget) => {
    if (t.kind === "working-tree") return "WT";
    if (t.kind === "staged") return "STAGED";
    return (t.ref ?? "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
  };
  return `${norm(base)}..${norm(head)}`;
}

/**
 * Inverse of `slugForDiff`: parse a `<base>..<head>` slug back into a
 * base/head pair. `WT`/`STAGED` map to the working-tree/staged kinds;
 * any other token is treated as a git ref — a full SHA, but also a
 * branch/tag name like `main` (the diff then uses that ref's current
 * commit). Returns null if the slug isn't in `<a>..<b>` form.
 */
export function targetsForSlug(slug: string): { base: DiffTarget; head: DiffTarget } | null {
  const idx = slug.indexOf("..");
  if (idx < 0) return null;
  const baseTok = slug.slice(0, idx);
  const headTok = slug.slice(idx + 2);
  if (!baseTok || !headTok) return null;
  const toTarget = (tok: string): DiffTarget => {
    if (tok === "WT") return { kind: "working-tree" };
    if (tok === "STAGED") return { kind: "staged" };
    return { kind: "ref", ref: tok };
  };
  return { base: toTarget(baseTok), head: toTarget(headTok) };
}

/**
 * Pin a single target to a concrete commit:
 * - bare `HEAD` → the *current branch's* commit, labelled with the branch name
 *   (or, when detached, the bare HEAD commit). Never stored as the literal
 *   "HEAD", which is a moving pointer.
 * - a branch/tag/remote name → that ref's commit, keeping the name as `label`
 *   so the stale-base banner can tell when it later advances.
 * - a bare SHA or rev like `HEAD~2` → peeled to the commit it points at.
 * WT/STAGED, already-pinned commits, and anything unresolvable are returned
 * unchanged.
 */
async function resolveTarget(
  t: DiffTarget,
  refs: GitRefInfo[],
  cwd: string,
): Promise<DiffTarget> {
  if (t.kind !== "ref" || !t.ref) return t;

  const peel = async (rev: string): Promise<string> =>
    (
      await run(["git", "rev-parse", "--verify", "--quiet", `${rev}^{commit}`], {
        cwd,
        allowFail: true,
      })
    ).trim();

  if (t.ref === "HEAD") {
    const branch = await currentBranch(cwd);
    const branchRef = branch
      ? refs.find((r) => r.kind === "branch" && r.name === branch)
      : undefined;
    if (branchRef?.sha) return { kind: "commit", ref: branchRef.sha, label: branchRef.name };
    const sha = await peel("HEAD");
    return sha ? { kind: "commit", ref: sha } : t;
  }

  // Prefer branch > remote > tag when a name is ambiguous (later sets win).
  const named = new Map<string, GitRefInfo>();
  for (const kind of ["tag", "remote", "branch"] as const) {
    for (const r of refs) if (r.kind === kind && r.sha) named.set(r.name, r);
  }
  const hit = named.get(t.ref);
  if (hit?.sha) return { kind: "commit", ref: hit.sha, label: hit.name };

  const sha = await peel(t.ref);
  return sha ? { kind: "commit", ref: sha } : t;
}

/**
 * Pin a base/head pair to concrete commits (see `resolveTarget`). Call this
 * whenever a diff is created from user-supplied targets so the stored diff and
 * its slug are anchored to a real commit instead of a moving ref like HEAD.
 */
export async function resolveTargets(
  base: DiffTarget,
  head: DiffTarget,
  cwd = process.cwd(),
): Promise<{ base: DiffTarget; head: DiffTarget }> {
  const refs = await listRefs(cwd);
  return {
    base: await resolveTarget(base, refs, cwd),
    head: await resolveTarget(head, refs, cwd),
  };
}

export async function resolveSlugTargets(
  slug: string,
  cwd = process.cwd(),
): Promise<{ base: DiffTarget; head: DiffTarget } | null> {
  const parsed = targetsForSlug(slug);
  if (!parsed) return null;
  return resolveTargets(parsed.base, parsed.head, cwd);
}

function gitRefForTarget(t: DiffTarget): string | null {
  if (t.kind === "working-tree") return null;
  if (t.kind === "staged") return null;
  return t.ref ?? null;
}

async function listChangedFiles(
  base: DiffTarget,
  head: DiffTarget,
  cwd: string,
): Promise<{ path: string; status: string; oldPath?: string }[]> {
  const results: { path: string; status: string; oldPath?: string }[] = [];
  const baseRef = gitRefForTarget(base);
  const headRef = gitRefForTarget(head);

  if (base.kind !== "working-tree" && base.kind !== "staged" && head.kind === "working-tree") {
    const out = (await run(["git", "diff", "--name-status", baseRef!], { cwd })).trim();
    parseStatus(out, results);
    const untracked = (await run(["git", "ls-files", "--others", "--exclude-standard"], {
      cwd,
      allowFail: true,
    })).trim();
    for (const p of untracked.split("\n").filter(Boolean)) {
      if (!results.find((r) => r.path === p)) results.push({ path: p, status: "A" });
    }
    return results;
  }

  if (base.kind === "staged" || head.kind === "staged") {
    const out = (await run(["git", "diff", "--cached", "--name-status"], { cwd })).trim();
    parseStatus(out, results);
    return results;
  }

  if (baseRef && headRef) {
    const out = (await run(["git", "diff", "--name-status", baseRef, headRef], { cwd })).trim();
    parseStatus(out, results);
    return results;
  }

  if (head.kind === "working-tree" && (base.kind === "working-tree" || !baseRef)) {
    const out = (await run(["git", "diff", "--name-status", "HEAD"], { cwd })).trim();
    parseStatus(out, results);
    const untracked = (await run(["git", "ls-files", "--others", "--exclude-standard"], {
      cwd,
      allowFail: true,
    })).trim();
    for (const p of untracked.split("\n").filter(Boolean)) {
      if (!results.find((r) => r.path === p)) results.push({ path: p, status: "A" });
    }
    return results;
  }

  return results;
}

function parseStatus(out: string, results: { path: string; status: string; oldPath?: string }[]) {
  for (const line of out.split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    const status = parts[0]!;
    if (status.startsWith("R") || status.startsWith("C")) {
      results.push({ path: parts[2]!, status, oldPath: parts[1]! });
    } else {
      results.push({ path: parts[1]!, status });
    }
  }
}

async function readContent(t: DiffTarget, path: string, cwd: string): Promise<string> {
  if (t.kind === "working-tree") {
    try {
      return await Bun.file(join(cwd, path)).text();
    } catch {
      return "";
    }
  }
  if (t.kind === "staged") {
    const out = await run(["git", "show", `:${path}`], { cwd, allowFail: true });
    return out;
  }
  const ref = gitRefForTarget(t);
  if (!ref) return "";
  const out = await run(["git", "show", `${ref}:${path}`], { cwd, allowFail: true });
  return out;
}

/**
 * Whether `path` is a symlink (git mode 120000) on the given side.
 * Working-tree uses an lstat; staged/ref sides read the recorded mode
 * from the index or tree.
 */
async function isSymlinkAt(t: DiffTarget, path: string, cwd: string): Promise<boolean> {
  if (t.kind === "working-tree") {
    try {
      return (await lstat(join(cwd, path))).isSymbolicLink();
    } catch {
      return false;
    }
  }
  if (t.kind === "staged") {
    const out = await run(["git", "ls-files", "-s", "--", path], { cwd, allowFail: true });
    return out.trimStart().startsWith("120000");
  }
  const ref = gitRefForTarget(t);
  if (!ref) return false;
  const out = await run(["git", "ls-tree", ref, "--", path], { cwd, allowFail: true });
  return out.trimStart().startsWith("120000");
}

/**
 * Read a side's content, but for a symlink return the *link target* path
 * rather than following it. For the working tree we'd otherwise follow
 * the link (Bun.file reads the target file's content); `git show` on a
 * mode-120000 blob already yields the target path, so refs/staged are
 * fine through `readContent`.
 */
async function readSide(t: DiffTarget, path: string, cwd: string, isSymlink: boolean): Promise<string> {
  if (isSymlink && t.kind === "working-tree") {
    try {
      return await readlink(join(cwd, path));
    } catch {
      return "";
    }
  }
  return readContent(t, path, cwd);
}

/**
 * Git's binary heuristic: a NUL byte in the first ~8 KB means binary. We read
 * content as text (decoding lossily), so a binary blob shows up as a string
 * containing U+0000 (preserved NUL) and/or U+FFFD (invalid-UTF-8 replacement).
 */
function looksBinary(content: string): boolean {
  if (!content) return false;
  const head = content.slice(0, 8000);
  for (let i = 0; i < head.length; i++) {
    const code = head.charCodeAt(i);
    if (code === 0 || code === 0xfffd) return true; // NUL or U+FFFD
  }
  return false;
}

export async function getDiff(
  base: DiffTarget,
  head: DiffTarget,
  cwd = process.cwd(),
): Promise<FileDiff[]> {
  const files = (await listChangedFiles(base, head, cwd)).filter(
    (f) => !f.path.startsWith(".staffreview/") && !f.path.startsWith(".staff-review/"),
  );
  const diffs: FileDiff[] = [];
  for (const f of files) {
    const status =
      f.status.startsWith("A") ? "added" :
      f.status.startsWith("D") ? "deleted" :
      f.status.startsWith("R") ? "renamed" :
      "modified";

    const oldPath = f.oldPath ?? f.path;
    const baseIsSymlink = status === "added" ? false : await isSymlinkAt(base, oldPath, cwd);
    const headIsSymlink = status === "deleted" ? false : await isSymlinkAt(head, f.path, cwd);
    const oldContent = status === "added" ? "" : await readSide(base, oldPath, cwd, baseIsSymlink);
    const newContent = status === "deleted" ? "" : await readSide(head, f.path, cwd, headIsSymlink);

    // The file is "a symlink" when the side that exists for this status is
    // one (head normally; base for deletions). Then we show a compact
    // target row instead of the (non-)content.
    const isSymlink = status === "deleted" ? baseIsSymlink : headIsSymlink;
    const symlinkTarget = isSymlink
      ? (status === "deleted" ? oldContent : newContent).trim() || undefined
      : undefined;
    // Only carry an "old target" when the previous version was itself a
    // symlink (a repointed link) — not for a file→symlink conversion.
    const oldSymlinkTarget =
      baseIsSymlink && status !== "added" ? oldContent.trim() || undefined : undefined;

    // Binary blobs (images, etc.) can't be shown as a text diff. Flag them and
    // drop the (lossily-decoded) bytes so the UI renders a "Binary file" row
    // instead of garbage. Symlinks are handled above and are never binary.
    const isBinary = !isSymlink && (looksBinary(oldContent) || looksBinary(newContent));

    diffs.push({
      path: f.path,
      oldPath: f.oldPath,
      status,
      oldContent: isBinary ? "" : oldContent,
      newContent: isBinary ? "" : newContent,
      isSymlink,
      symlinkTarget,
      oldSymlinkTarget,
      isBinary,
    });
  }
  return diffs;
}
