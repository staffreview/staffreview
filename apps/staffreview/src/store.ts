import { mkdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { slugForDiff } from "./git.ts";
import type { Comment, Diff, DiffTarget, Resolution } from "./types.ts";

export function staffDir(cwd = process.cwd()) {
  return join(cwd, ".staffreview");
}

export function diffsDir(cwd = process.cwd()) {
  return join(staffDir(cwd), "diffs");
}

export function docsDir(cwd = process.cwd()) {
  return join(staffDir(cwd), "docs");
}

export function attachmentsDir(cwd = process.cwd()) {
  return join(staffDir(cwd), "attachments");
}

export function activePointerPath(cwd = process.cwd()) {
  return join(staffDir(cwd), "active.json");
}

export function diffPath(slug: string, cwd = process.cwd()) {
  return join(diffsDir(cwd), `${slug}.json`);
}

export async function ensureDirs(cwd = process.cwd()) {
  await mkdir(diffsDir(cwd), { recursive: true });
  await mkdir(docsDir(cwd), { recursive: true });
  await mkdir(attachmentsDir(cwd), { recursive: true });
}

// Reap orphaned `<slug>.json.<uuid>.tmp` files left in diffsDir. saveDiff
// writes to a fresh-UUID temp file then atomically renames it into place,
// unlinking it on rename failure — but if the process is killed (SIGKILL,
// OOM, power loss) between the write and the rename, the temp file survives.
// Each crash uses a new UUID, so without a reaper these accumulate unbounded.
//
// This is a one-shot startup sweep (called from server boot), NOT part of the
// hot save path. It must never run inside a `saveDiff` that may overlap an
// in-flight write: Bun serves overlapping requests on one event loop, so a
// per-write glob would unlink a *concurrent* save's just-written temp before
// that save's own `rename`, turning a successful write into an ENOENT failure
// and silently losing it. The glob is repo-wide, so it could also clobber
// temps for other slugs (two tabs, or the server plus a `staff` CLI). Keeping
// it to startup — before any save can be in flight — sidesteps both races.
//
// Best-effort: ignore per-file unlink errors and any scan error so cleanup
// never breaks an actual save/load.
export async function sweepStaleTmp(cwd = process.cwd()) {
  const dir = diffsDir(cwd);
  try {
    const glob = new Bun.Glob("*.tmp");
    for await (const file of glob.scan({ cwd: dir })) {
      await unlink(join(dir, file)).catch(() => {});
    }
  } catch {}
}

export async function loadDiff(slug: string, cwd = process.cwd()): Promise<Diff | null> {
  const file = Bun.file(diffPath(slug, cwd));
  if (!(await file.exists())) return null;
  const text = await file.text();
  if (text.trim() === "") {
    // An empty or whitespace-only file (e.g. read during a concurrent save, or
    // a 0-byte leftover from an interrupted write) isn't actionable — treat it
    // as "not there" rather than throwing an unhandled JSON parse error.
    // saveDiff writes atomically (below), so this is just a defensive backstop
    // for the transient mid-write window.
    return null;
  }
  try {
    return JSON.parse(text) as Diff;
  } catch (e) {
    // Non-empty but unparseable means real corruption, not a half-written
    // file. Returning null here would make loadOrCreateDiff recreate the diff
    // empty and silently destroy its comments — so throw a clear, actionable
    // error instead of swallowing it.
    throw new Error(`corrupt diff file: ${diffPath(slug, cwd)}`, { cause: e });
  }
}

export async function saveDiff(c: Diff, cwd = process.cwd()): Promise<void> {
  await ensureDirs(cwd);
  c.updatedAt = new Date().toISOString();
  // Write to a temp file then atomically rename into place, so a concurrent
  // reader (the file watcher, a browser refetch, another `staff`) never sees a
  // partially-written or empty file and trips a JSON parse error.
  const path = diffPath(c.slug, cwd);
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  await Bun.write(tmp, JSON.stringify(c, null, 2));
  try {
    await rename(tmp, path);
  } catch (e) {
    // The rename failed (or was interrupted), so the temp file would otherwise
    // be left orphaned in diffsDir. Clean it up; ignore unlink errors so we
    // surface the original rename failure, not a secondary cleanup error.
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

export async function loadOrCreateDiff(
  base: DiffTarget,
  head: DiffTarget,
  cwd = process.cwd(),
): Promise<Diff> {
  const slug = slugForDiff(base, head);
  return loadOrCreateDiffWithSlug(slug, base, head, cwd);
}

export async function loadOrCreateDiffWithSlug(
  slug: string,
  base: DiffTarget,
  head: DiffTarget,
  cwd = process.cwd(),
): Promise<Diff> {
  const existing = await loadDiff(slug, cwd);
  if (existing) return existing;
  const now = new Date().toISOString();
  const c: Diff = {
    slug,
    base,
    head,
    comments: [],
    createdAt: now,
    updatedAt: now,
  };
  await saveDiff(c, cwd);
  return c;
}

export async function listDiffs(cwd = process.cwd()): Promise<Diff[]> {
  await ensureDirs(cwd);
  const dir = diffsDir(cwd);
  const glob = new Bun.Glob("*.json");
  const out: Diff[] = [];
  for await (const file of glob.scan({ cwd: dir })) {
    try {
      const c = JSON.parse(await Bun.file(join(dir, file)).text()) as Diff;
      out.push(c);
    } catch {}
  }
  return out;
}

export async function setActiveDiff(slug: string, cwd = process.cwd()): Promise<void> {
  await ensureDirs(cwd);
  await Bun.write(activePointerPath(cwd), JSON.stringify({ slug }, null, 2));
}

export async function getActiveDiffSlug(cwd = process.cwd()): Promise<string | null> {
  const file = Bun.file(activePointerPath(cwd));
  if (!(await file.exists())) return null;
  try {
    const data = JSON.parse(await file.text()) as { slug?: string };
    return data.slug ?? null;
  } catch {
    return null;
  }
}

function newId() {
  return crypto.randomUUID();
}

export async function addComment(
  slug: string,
  partial: Omit<Comment, "id" | "createdAt" | "threadId"> & { threadId?: string },
  cwd = process.cwd(),
): Promise<Comment> {
  const c = await loadDiff(slug, cwd);
  if (!c) throw new Error(`diff not found: ${slug}`);
  const id = newId();
  const threadId =
    partial.threadId ??
    (partial.parentId ? (c.comments.find((x) => x.id === partial.parentId)?.threadId ?? id) : id);
  const comment: Comment = {
    id,
    threadId,
    parentId: partial.parentId,
    file: partial.file,
    line: partial.line,
    endLine: partial.endLine,
    side: partial.side,
    body: partial.body,
    author: partial.author,
    priority: partial.priority,
    createdAt: new Date().toISOString(),
  };
  c.comments.push(comment);
  await saveDiff(c, cwd);
  return comment;
}

function findThread(c: Diff, threadIdOrPrefix: string): Comment | undefined {
  const exact = c.comments.find(
    (x) => x.id === threadIdOrPrefix || x.threadId === threadIdOrPrefix,
  );
  if (exact) return exact;
  return c.comments.find(
    (x) => x.id.startsWith(threadIdOrPrefix) || x.threadId.startsWith(threadIdOrPrefix),
  );
}

export async function resolveThread(
  slug: string,
  threadId: string,
  res: Omit<Resolution, "at">,
  cwd = process.cwd(),
): Promise<Diff> {
  const c = await loadDiff(slug, cwd);
  if (!c) throw new Error(`diff not found: ${slug}`);
  const resolution: Resolution = { ...res, at: new Date().toISOString() };
  const root = findThread(c, threadId);
  if (!root) throw new Error(`thread not found: ${threadId}`);
  const realThreadId = root.threadId;
  for (const cm of c.comments) {
    if (cm.threadId === realThreadId && !cm.parentId) {
      cm.resolution = resolution;
      // The thread is now resolved — the documentation request (if any)
      // has been fulfilled, so clear the pending flag.
      cm.documentRequested = undefined;
    }
  }
  await saveDiff(c, cwd);
  return c;
}

export async function unresolveThread(
  slug: string,
  threadId: string,
  cwd = process.cwd(),
): Promise<Diff> {
  const c = await loadDiff(slug, cwd);
  if (!c) throw new Error(`diff not found: ${slug}`);
  const root = findThread(c, threadId);
  if (!root) throw new Error(`thread not found: ${threadId}`);
  const realThreadId = root.threadId;
  for (const cm of c.comments) {
    if (cm.threadId === realThreadId && !cm.parentId) {
      cm.resolution = undefined;
    }
  }
  await saveDiff(c, cwd);
  return c;
}

export async function setDocumentRequested(
  slug: string,
  threadId: string,
  requested: boolean,
  cwd = process.cwd(),
): Promise<Diff> {
  const c = await loadDiff(slug, cwd);
  if (!c) throw new Error(`diff not found: ${slug}`);
  const root = findThread(c, threadId);
  if (!root) throw new Error(`thread not found: ${threadId}`);
  const realThreadId = root.threadId;
  for (const cm of c.comments) {
    if (cm.threadId === realThreadId && !cm.parentId) {
      cm.documentRequested = requested || undefined;
    }
  }
  await saveDiff(c, cwd);
  return c;
}

export async function updateComment(
  slug: string,
  id: string,
  body: string,
  cwd = process.cwd(),
): Promise<Diff> {
  const c = await loadDiff(slug, cwd);
  if (!c) throw new Error(`diff not found: ${slug}`);
  const target = c.comments.find((x) => x.id === id);
  if (!target) throw new Error(`comment not found: ${id}`);
  target.body = body;
  await saveDiff(c, cwd);
  return c;
}

export async function deleteComment(slug: string, id: string, cwd = process.cwd()): Promise<Diff> {
  const c = await loadDiff(slug, cwd);
  if (!c) throw new Error(`diff not found: ${slug}`);
  // Remove the comment and its entire reply subtree (replies, replies-to-
  // replies, …). Filtering only direct children would orphan deeper replies,
  // leaving comments whose `parentId` points at a now-deleted comment.
  const removeIds = new Set<string>([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const cm of c.comments) {
      if (cm.parentId && removeIds.has(cm.parentId) && !removeIds.has(cm.id)) {
        removeIds.add(cm.id);
        grew = true;
      }
    }
  }
  c.comments = c.comments.filter((x) => !removeIds.has(x.id));
  await saveDiff(c, cwd);
  return c;
}
