import { Buffer } from "node:buffer";
import { watch } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import logoPngPath from "./frontend/logo.png";
import { frontendAssets, frontendHtml } from "./generated/frontend-assets.ts";
import * as git from "./git.ts";
import { listenOnRange } from "./port.ts";
import * as settings from "./settings.ts";
import * as store from "./store.ts";
import type { DiffTarget } from "./types.ts";

/** Extension → mime for the handful of image types we accept. */
const ATTACHMENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

function extForMime(mime: string): string | null {
  const m = mime.toLowerCase();
  for (const [ext, t] of Object.entries(ATTACHMENT_TYPES)) {
    if (t === m) return ext;
  }
  return null;
}

/**
 * Best-effort guess at who the human is for UI-driven comments. Tries
 * `git config user.name`, then the OS username, then "user" as a last
 * resort. Result is cached for the life of the server process.
 */
async function detectDefaultAuthor(cwd: string): Promise<string> {
  try {
    const proc = Bun.spawn(["git", "config", "user.name"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    if (out) return out;
  } catch {}
  try {
    const info = userInfo();
    if (info.username) return info.username;
  } catch {}
  return process.env.USER || process.env.USERNAME || "user";
}

type WSData = { id: string };

const sockets = new Set<ServerWebSocket<WSData>>();

type FrontendAssets = {
  css?: string;
  js?: string;
};

function frontendChunkKind(pathname: string): keyof FrontendAssets | null {
  const name = pathname.split("/").pop() ?? "";
  const match = /^chunk-[a-z0-9-]+\.(css|js)$/i.exec(name);
  if (!match) return null;
  return match[1] as keyof FrontendAssets;
}

function isFrontendLogoPath(pathname: string): boolean {
  const name = pathname.split("/").pop() ?? "";
  return pathname === "/frontend/logo.png" || /^logo-[a-z0-9-]+\.png$/i.test(name);
}

function parseFrontendAssets(html: string): FrontendAssets {
  const resolvePath = (raw: string): string => new URL(raw, "http://staff.local/").pathname;
  const css = html.match(/<link\b[^>]*\bhref=["']([^"']+\.css)["']/)?.[1];
  const js = html.match(/<script\b[^>]*\bsrc=["']([^"']+\.js)["']/)?.[1];
  return {
    css: css ? resolvePath(css) : undefined,
    js: js ? resolvePath(js) : undefined,
  };
}

function generatedFrontendResponse(pathname: string): Response | null {
  const asset = frontendAssets[pathname];
  if (!asset) return null;
  return new Response(Buffer.from(asset.body, "base64"), {
    headers: { "content-type": asset.type },
  });
}

function broadcast(msg: unknown) {
  const payload = JSON.stringify(msg);
  for (const ws of sockets) {
    try {
      ws.send(payload);
    } catch {}
  }
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

function err(message: string, status = 400): Response {
  return json({ error: message }, { status });
}

async function readJson<T>(req: Request): Promise<T> {
  return (await req.json()) as T;
}

export async function startServer(opts: { port?: number; cwd?: string } = {}) {
  const initialCwd = opts.cwd ?? process.cwd();

  if (!(await git.isGitRepo(initialCwd))) {
    throw new Error(`Not a git repository: ${initialCwd}`);
  }

  // Always operate on the repo root: git paths are root-relative, so file
  // reads (Bun.file(join(cwd, path))) must resolve from the same anchor.
  const cwd = await git.gitRoot(initialCwd);
  await store.ensureDirs(cwd);
  // One-shot startup sweep of orphaned `*.tmp` left by crashed writes. Done
  // here (before the server accepts requests) rather than on the hot save path
  // so it can never unlink a concurrent in-flight save's temp — see
  // store.sweepStaleTmp.
  await store.sweepStaleTmp(cwd);

  const defaultAuthor = await detectDefaultAuthor(cwd);

  // Coalesce per-file events so rapid temp+rename storms from Bun.write
  // become at most one broadcast per ~75ms per file, without a single shared
  // timer that the storm could keep resetting indefinitely.
  const perFileTimers = new Map<string, Timer>();
  const scheduleFile = (filename: string) => {
    if (perFileTimers.has(filename)) return;
    const t = setTimeout(() => {
      perFileTimers.delete(filename);
      broadcast({ type: "diff:changed", file: filename });
    }, 75);
    perFileTimers.set(filename, t);
  };

  try {
    watch(store.diffsDir(cwd), { recursive: true }, (_event, filename) => {
      // Only react to the canonical diff files. saveDiff writes a uniquely-
      // named `<slug>.json.<uuid>.tmp` then renames it into place; forwarding
      // those temp names would fire a spurious diff:changed per save (the UUID
      // defeats the per-file dedupe) and trigger a redundant client refetch.
      if (filename?.endsWith(".json")) scheduleFile(filename);
    });
    watch(store.activePointerPath(cwd).replace(/\/active\.json$/, ""), (_e, filename) => {
      if (filename === "active.json") {
        broadcast({ type: "active:changed" });
      }
    });
  } catch (e) {
    console.warn("fs.watch failed:", e);
  }

  // Watch the working tree so an edit to a source file refreshes the diff
  // in the open UI without a manual Refresh. `.git` and our own store are
  // skipped outright (the latter has its own watcher above); everything
  // else is batched per ~150ms and run through `git check-ignore` so we
  // never broadcast — or even bother diffing — for paths git ignores
  // (node_modules, build output, logs, etc.).
  const HARD_SKIP = new Set([".git", ".staffreview"]);
  const pendingPaths = new Set<string>();
  let repoTimer: Timer | null = null;

  const flushRepoChange = async () => {
    repoTimer = null;
    const batch = Array.from(pendingPaths);
    pendingPaths.clear();
    if (batch.length === 0) return;
    // `git check-ignore --stdin` echoes back the paths it ignores; keep
    // only the ones it didn't. One git call per window, not per event.
    let changed = batch;
    try {
      const proc = Bun.spawn(["git", "check-ignore", "--stdin"], {
        cwd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });
      proc.stdin.write(batch.join("\n"));
      proc.stdin.end();
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      const ignored = new Set(
        out
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
      );
      changed = batch.filter((p) => !ignored.has(p));
    } catch {
      // If check-ignore is unavailable, fall back to broadcasting.
    }
    if (changed.length > 0) broadcast({ type: "repo:changed" });
  };

  try {
    watch(cwd, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const segments = filename.split(/[\\/]/);
      if (segments.some((s) => HARD_SKIP.has(s))) return;
      pendingPaths.add(filename);
      if (!repoTimer) repoTimer = setTimeout(flushRepoChange, 150);
    });
  } catch (e) {
    console.warn("working-tree watch failed (live diff refresh disabled):", e);
  }

  // The recursive watch above skips `.git`, so `git add`/`git reset`/commit —
  // which only rewrite `.git/index` — wouldn't refresh a *staged* diff. Watch
  // the index separately and broadcast so staged (and HEAD) diffs update too.
  let indexTimer: Timer | null = null;
  try {
    watch(join(cwd, ".git"), (_event, filename) => {
      if (filename !== "index") return; // ignore HEAD, lockfiles, refs churn
      if (indexTimer) return;
      indexTimer = setTimeout(() => {
        indexTimer = null;
        broadcast({ type: "repo:changed" });
      }, 150);
    });
  } catch {
    // .git may be a file (worktrees/submodules); index-change refresh is
    // best-effort.
  }

  const isDev = process.env.STAFF_BUILD !== "binary";
  const devIndexHtml = isDev ? (await import("./index.html")).default : null;
  const rootRoute = isDev
    ? devIndexHtml
    : async () => new Response(frontendHtml, { headers: { "content-type": "text/html" } });
  let serverUrl: URL | null = null;
  let cachedFrontendAssets: Promise<FrontendAssets> | null = null;
  const currentFrontendAssets = async (): Promise<FrontendAssets> => {
    if (!serverUrl) return {};
    const load = () =>
      fetch(new URL("/", serverUrl!))
        .then((res) => res.text())
        .then(parseFrontendAssets)
        .catch(() => ({}));
    if (isDev) return load();
    cachedFrontendAssets ??= load();
    return cachedFrontendAssets;
  };
  const makeServer = (port: number) =>
    Bun.serve<WSData, {}>({
      port,
      // Bind the port *exclusively*. Otherwise a second `staff` (e.g. for another
      // project) can SO_REUSEPORT-share a port that's already serving instead of
      // walking up to a free one — so http://localhost:<port> load-balances
      // between the two projects. Forcing reuse off makes a taken port throw
      // EADDRINUSE, so listenOnRange walks to the next free port as intended.
      reusePort: false,
      development: isDev ? { hmr: true, console: true } : false,
      routes: {
        "/": rootRoute as any,

        "/api/info": async () => {
          const branch = await git.currentBranch(cwd);
          const root = await git.gitRoot(cwd);
          return json({ cwd, root, branch });
        },

        "/api/refs": async () => {
          const refs = await git.listRefs(cwd);
          return json({ refs });
        },

        "/api/diffs": async () => {
          const all = await store.listDiffs(cwd);
          return json({ diffs: all });
        },

        "/api/diff": {
          GET: async (req) => {
            const url = new URL(req.url);
            const slug = url.searchParams.get("slug");
            if (slug) {
              const c = await store.loadDiff(slug, cwd);
              if (!c) return err("not found", 404);
              return json({ diff: c });
            }
            return err("missing slug");
          },
          POST: async (req) => {
            const body = await readJson<{
              base: DiffTarget;
              head: DiffTarget;
              setActive?: boolean;
            }>(req);
            // Pin any moving refs (`HEAD`, a branch/tag name) to concrete commits
            // before persisting, exactly like the `staff diff` CLI path does. The
            // frontend usually pins via `defaultTargets`, but its branch-not-in-refs
            // fallback and the shared-link slug fallback can still POST an unpinned
            // ref — anchor it here so no creation path stores a moving base.
            const { base, head } = await git.resolveTargets(body.base, body.head, cwd);
            const c = await store.loadOrCreateDiff(base, head, cwd);
            if (body.setActive !== false) await store.setActiveDiff(c.slug, cwd);
            broadcast({ type: "diff:created", slug: c.slug });
            return json({ diff: c });
          },
        },

        "/api/files": {
          POST: async (req) => {
            const body = await readJson<{ base: DiffTarget; head: DiffTarget }>(req);
            const files = await git.getDiff(body.base, body.head, cwd);
            return json({ files });
          },
        },

        // Attachment upload: editors POST a pasted/dropped image here and
        // get back a URL to embed in the comment's markdown. Files live
        // under `.staffreview/attachments/` (gitignored, served below).
        "/api/attachment": {
          POST: async (req) => {
            const form = await req.formData();
            const file = form.get("file");
            if (!(file instanceof File)) return err("missing file");
            const ext = extForMime(file.type);
            if (!ext) return err(`unsupported type: ${file.type || "unknown"}`);
            const MAX = 10 * 1024 * 1024;
            if (file.size > MAX) return err("file too large (max 10MB)", 413);
            const name = `${crypto.randomUUID()}.${ext}`;
            await store.ensureDirs(cwd);
            await Bun.write(join(store.attachmentsDir(cwd), name), file);
            return json({ url: `/attachments/${name}`, name });
          },
        },

        // Serve uploaded attachments. The `:name` is a generated UUID, but
        // we still reject path separators defensively.
        "/attachments/:name": async (req) => {
          const name = (req.params as { name: string }).name;
          if (name.includes("/") || name.includes("\\") || name.includes("..")) {
            return err("bad name", 400);
          }
          const ext = name.split(".").pop()?.toLowerCase() ?? "";
          const type = ATTACHMENT_TYPES[ext];
          if (!type) return err("not found", 404);
          const f = Bun.file(join(store.attachmentsDir(cwd), name));
          if (!(await f.exists())) return err("not found", 404);
          return new Response(f, { headers: { "content-type": type } });
        },

        "/api/settings": {
          GET: async () => {
            const s = settings.settingsWithDefaults(await settings.readSettings());
            return json({ settings: s });
          },
          POST: async (req) => {
            const body = (await req.json()) as Partial<settings.GlobalSettings>;
            const updated = await settings.writeSettings(body);
            return json({ settings: updated });
          },
        },

        "/api/active": {
          GET: async () => {
            const slug = await store.getActiveDiffSlug(cwd);
            return json({ slug });
          },
          POST: async (req) => {
            const body = await readJson<{ slug: string }>(req);
            await store.setActiveDiff(body.slug, cwd);
            broadcast({ type: "active:changed", slug: body.slug });
            return json({ ok: true });
          },
        },

        "/api/comment": {
          POST: async (req) => {
            const body = await readJson<{
              slug: string;
              file?: string;
              line?: number;
              endLine?: number;
              side?: "old" | "new";
              body: string;
              author?: string;
              parentId?: string;
              threadId?: string;
            }>(req);
            const comment = await store.addComment(
              body.slug,
              {
                file: body.file,
                line: body.line,
                endLine: body.endLine,
                side: body.side,
                body: body.body,
                author: body.author?.trim() || defaultAuthor,
                parentId: body.parentId,
                threadId: body.threadId,
              },
              cwd,
            );
            broadcast({ type: "comment:added", slug: body.slug, comment });
            return json({ comment });
          },
          DELETE: async (req) => {
            const body = await readJson<{ slug: string; id: string }>(req);
            const c = await store.deleteComment(body.slug, body.id, cwd);
            broadcast({ type: "comment:deleted", slug: body.slug, id: body.id });
            return json({ diff: c });
          },
          PATCH: async (req) => {
            const body = await readJson<{ slug: string; id: string; body: string }>(req);
            const c = await store.updateComment(body.slug, body.id, body.body, cwd);
            broadcast({ type: "diff:changed", file: `${body.slug}.json` });
            return json({ diff: c });
          },
        },

        "/api/document": {
          POST: async (req) => {
            const body = await readJson<{
              slug: string;
              threadId: string;
              requested: boolean;
            }>(req);
            const c = await store.setDocumentRequested(
              body.slug,
              body.threadId,
              body.requested,
              cwd,
            );
            broadcast({ type: "diff:changed", file: `${body.slug}.json` });
            return json({ diff: c });
          },
        },

        "/api/resolve": {
          POST: async (req) => {
            const body = await readJson<{
              slug: string;
              threadId: string;
              status: "fixed" | "skipped" | "documented";
              body: string;
              author?: string;
              documentedAs?: string;
            }>(req);
            const c = await store.resolveThread(
              body.slug,
              body.threadId,
              {
                status: body.status,
                body: body.body,
                author: body.author?.trim() || defaultAuthor,
                documentedAs: body.documentedAs,
              },
              cwd,
            );
            broadcast({ type: "thread:resolved", slug: body.slug, threadId: body.threadId });
            return json({ diff: c });
          },
          DELETE: async (req) => {
            const body = await readJson<{ slug: string; threadId: string }>(req);
            const c = await store.unresolveThread(body.slug, body.threadId, cwd);
            broadcast({ type: "thread:unresolved", slug: body.slug, threadId: body.threadId });
            return json({ diff: c });
          },
        },

        "/api/ws": (req, server) => {
          if (server.upgrade(req, { data: { id: crypto.randomUUID() } })) return;
          return new Response("Upgrade failed", { status: 400 });
        },
      },

      fetch: async (req) => {
        const url = new URL(req.url);
        if (!isDev) {
          const asset = generatedFrontendResponse(url.pathname);
          if (asset) return asset;
        }
        if (isFrontendLogoPath(url.pathname)) {
          return new Response(Bun.file(logoPngPath), { headers: { "content-type": "image/png" } });
        }
        const kind = frontendChunkKind(url.pathname);
        if (kind) {
          const target = (await currentFrontendAssets())[kind];
          if (target && target !== url.pathname) {
            return new Response(null, { status: 302, headers: { Location: target } });
          }
        }
        return new Response(null, { status: 404 });
      },

      websocket: {
        open(ws) {
          sockets.add(ws);
          ws.send(JSON.stringify({ type: "hello", id: ws.data.id }));
        },
        close(ws) {
          sockets.delete(ws);
        },
        message(_ws, _msg) {},
      },

      error(e) {
        console.error("server error:", e);
        return new Response(`Internal error: ${e.message}`, { status: 500 });
      },
    });

  const server = listenOnRange(makeServer, opts.port);
  serverUrl = server.url;

  return server;
}
