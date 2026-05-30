#!/usr/bin/env bun
import { mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { startServer } from "./server.ts";
import * as store from "./store.ts";
import * as git from "./git.ts";
import * as settings from "./settings.ts";
import type { DiffTarget, ResolutionStatus } from "./types.ts";

import skillReview from "../skills/staff-review.md" with { type: "text" };
import skillComment from "../skills/staff-comment.md" with { type: "text" };
import skillDocument from "../skills/staff-document.md" with { type: "text" };
import skillResolve from "../skills/staff-resolve.md" with { type: "text" };
import skillLoop from "../skills/staff-loop.md" with { type: "text" };

const SKILLS: Record<string, string> = {
  "staff-review": skillReview,
  "staff-comment": skillComment,
  "staff-document": skillDocument,
  "staff-resolve": skillResolve,
  "staff-loop": skillLoop,
};

const VERSION = "0.1.0";

function parseArgs(argv: string[]): {
  flags: Record<string, string | boolean>;
  positional: string[];
} {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          flags[a.slice(2)] = true;
        } else {
          flags[a.slice(2)] = next;
          i++;
        }
      }
    } else if (a.startsWith("-")) {
      flags[a.slice(1)] = true;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function parseTarget(spec: string | undefined): DiffTarget {
  if (!spec) return { kind: "ref", ref: "HEAD" };
  const lower = spec.toLowerCase();
  if (lower === "working-tree" || lower === "wt" || lower === "working") return { kind: "working-tree" };
  if (lower === "staged" || lower === "index") return { kind: "staged" };
  return { kind: "ref", ref: spec };
}

async function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? ["open", url]
    : process.platform === "win32" ? ["cmd", "/c", "start", "", url]
    : ["xdg-open", url];
  Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
}

function help() {
  console.log(`Staff Review — code review tool (v${VERSION})

USAGE
  staff [serve] [<slug>]        Start the web UI (default). Pass a diff slug
                                 (e.g. main..WT or <sha>..WT) to open the UI on
                                 that diff, creating it from the slug if needed.
    --port <n>                   Port (default: random open port).
    --no-open                    Don't open a browser.
    --repo <dir>                 Repository to review (default: current directory).

  staff active [--json]         Print the active diff.
  staff diff [<slug>] [--base <t>] [--head <t>] [--json] [--no-set-active]
                                 Create/load a diff and (optionally) set active.
                                 <slug> is base..head (e.g. main..WT); or use
                                 --base/--head where <t> is working-tree, staged,
                                 or any git ref.

  staff files [--slug <slug>] [--json]
                                 Print the file-level changes for a diff.

  staff comment add  [--slug <s>] [--file <p>] [--line <n>] [--end-line <n>]
                     [--side new|old] [--body <text>] [--reply-to <id>] [--author <name>]
                     (--line + --end-line anchors the comment to a line range)
                     (prints the new comment's JSON, including its id)
  staff comment edit   --id <id> [--body <text>] [--slug <s>]
                       (revise the body of a comment you posted)
  staff comment delete --id <id> [--slug <s>]
                       (remove a comment you posted; also removes its replies)
  staff comment list [--slug <s>] [--open] [--json]
  staff comment resolve --thread <id> --status <fixed|skipped|documented>
                        --body <text> [--documented-as <name>] [--slug <s>]
  staff comment unresolve --thread <id> [--slug <s>]

  staff settings [--json]       Print global settings (with defaults applied).
  staff settings get <key>      Print one setting's value (e.g. loopMaxRounds,
                                 the /staff-loop round cap; defaults to ${settings.DEFAULT_LOOP_ROUNDS}).

  staff install                 Set up the repo: write the five /staff-* skills to
                                 .agents/skills/ (symlinked into .claude/skills/),
                                 create the .staffreview/ store, and gitignore it.

  staff --version | --help
`);
}

async function readBodyFromStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  let s = "";
  for await (const chunk of process.stdin as any) s += chunk;
  return s.trimEnd();
}

async function activeSlugOrThrow(cwd: string, override?: string): Promise<string> {
  if (override) return override;
  const slug = await store.getActiveDiffSlug(cwd);
  if (!slug) {
    throw new Error(
      "No active diff. Run `staff diff --base <ref> --head <ref>` first, or open the web UI.",
    );
  }
  return slug;
}

async function main(argv: string[]) {
  const { flags, positional } = parseArgs(argv);

  if (flags.version || flags.v || positional[0] === "version") {
    console.log(VERSION);
    return;
  }
  if (flags.help || flags.h || positional[0] === "help") {
    help();
    return;
  }

  // `staff <slug>` (or `staff serve <slug>`) is shorthand for serving with
  // a specific diff targeted. A slug isn't a known subcommand and always
  // contains the ".." separator (e.g. `main..WT`, `<sha>..WT`).
  const KNOWN_COMMANDS = new Set([
    "serve", "active", "diff", "files", "comment", "settings", "install", "version", "help",
  ]);
  const first = positional[0] ?? "serve";
  const firstIsSlug = !KNOWN_COMMANDS.has(first) && first.includes("..");
  const cmd = firstIsSlug ? "serve" : first;
  const serveSlug = firstIsSlug
    ? first
    : first === "serve" && typeof positional[1] === "string" && positional[1].includes("..")
      ? positional[1]
      : undefined;
  const initialCwd = typeof flags.repo === "string" ? flags.repo : process.cwd();
  // Anchor to the repo root so paths line up between git and local file reads.
  // `version`/`help` don't touch the filesystem; everything else (including
  // `install`) prefers the git root when there is one, else the cwd.
  const cwd =
    cmd === "version" || cmd === "help"
      ? initialCwd
      : (await git.isGitRepo(initialCwd))
        ? await git.gitRoot(initialCwd)
        : initialCwd;

  switch (cmd) {
    case "serve": {
      const port = typeof flags.port === "string" ? Number(flags.port) : 0;

      // If a slug was passed, make it the active diff so the UI opens on
      // it. Load the existing diff file if present; otherwise reconstruct
      // base/head from the slug and create it.
      let activeSlug: string | undefined;
      if (serveSlug) {
        try {
          const existing = await store.loadDiff(serveSlug, cwd);
          if (existing) {
            await store.setActiveDiff(serveSlug, cwd);
            activeSlug = serveSlug;
          } else {
            const targets = await git.resolveSlugTargets(serveSlug, cwd);
            if (!targets) {
              console.error(`\x1b[31mwarning:\x1b[0m not a valid diff slug: ${serveSlug}`);
            } else {
              const c = await store.loadOrCreateDiff(targets.base, targets.head, cwd);
              await store.setActiveDiff(c.slug, cwd);
              activeSlug = c.slug;
            }
          }
        } catch (e) {
          console.error(`\x1b[31mwarning:\x1b[0m could not target ${serveSlug}: ${(e as Error).message}`);
        }
      }

      const server = await startServer({ port, cwd });
      const base = server.url.toString();
      const url = activeSlug ? `${base}?diff=${encodeURIComponent(activeSlug)}` : base;
      console.log(`\x1b[1m  Staff Review\x1b[0m  ${url}`);
      console.log(`  cwd: ${cwd}`);
      console.log(`  store: .staffreview/`);
      console.log("");
      // Only open the browser on first launch. With `bun --hot`, modules
      // re-evaluate on every source change; this sentinel survives across
      // hot reloads so we don't keep popping new tabs.
      const g = globalThis as { __staffBrowserOpened?: boolean };
      if (!flags["no-open"] && !g.__staffBrowserOpened) {
        openBrowser(url);
        g.__staffBrowserOpened = true;
      }
      return;
    }

    case "install": {
      // 1. Skills: canonical copies under .agents/skills/<name>/SKILL.md,
      //    symlinked into .claude/skills/<name> so both Claude Code and
      //    other agents resolve them.
      const agentsRoot = join(cwd, ".agents", "skills");
      const claudeRoot = join(cwd, ".claude", "skills");
      await mkdir(claudeRoot, { recursive: true });
      let count = 0;
      for (const [name, body] of Object.entries(SKILLS)) {
        const canonicalDir = join(agentsRoot, name);
        await mkdir(canonicalDir, { recursive: true });
        await Bun.write(join(canonicalDir, "SKILL.md"), body);

        const link = join(claudeRoot, name);
        // Replace whatever's there (a prior real dir or a stale symlink)
        // with a relative symlink to the canonical copy.
        await rm(link, { recursive: true, force: true });
        await symlink(join("..", "..", ".agents", "skills", name), link, "dir");
        console.log(`  ${join(".agents", "skills", name)}/SKILL.md  ←  .claude/skills/${name}`);
        count++;
      }

      // 2. Store: create the .staffreview directory tree.
      await store.ensureDirs(cwd);
      console.log("  created .staffreview/");

      // 3. gitignore the per-machine review data — the diffs (review
      //    sessions), attachments (pasted images), and the active-diff
      //    pointer. The library (documented examples) and the skills are
      //    meant to be committed.
      const ignoreEntries = [
        ".staffreview/diffs/",
        ".staffreview/attachments/",
        ".staffreview/active.json",
      ];
      const giPath = join(cwd, ".gitignore");
      const giFile = Bun.file(giPath);
      let existing = (await giFile.exists()) ? await giFile.text() : "";
      const present = new Set(
        existing.split("\n").map((l) => l.trim().replace(/\/$/, "")),
      );
      const missing = ignoreEntries.filter((e) => !present.has(e.replace(/\/$/, "")));
      if (missing.length > 0) {
        const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
        existing = `${existing}${prefix}${missing.join("\n")}\n`;
        await Bun.write(giPath, existing);
        for (const e of missing) console.log(`  added ${e} to .gitignore`);
      } else {
        console.log("  .gitignore already up to date");
      }

      console.log(`\nInstalled ${count} skills + initialized the store.`);
      return;
    }

    case "active": {
      const slug = await store.getActiveDiffSlug(cwd);
      if (!slug) {
        if (flags.json) console.log("null");
        else console.log("(no active diff)");
        return;
      }
      const c = await store.loadDiff(slug, cwd);
      if (flags.json) console.log(JSON.stringify(c, null, 2));
      else {
        console.log(`slug: ${c?.slug}`);
        console.log(`base: ${git.targetLabel(c!.base)}`);
        console.log(`head: ${git.targetLabel(c!.head)}`);
        console.log(`comments: ${c?.comments.length ?? 0}`);
      }
      return;
    }

    case "diff": {
      // Accept either a positional slug (`staff diff main..WT`) or the
      // explicit --base/--head flags. The slug form is what the skills
      // and the share UI use.
      const slugArg =
        typeof positional[1] === "string" && positional[1].includes("..")
          ? positional[1]
          : undefined;
      let base: DiffTarget;
      let head: DiffTarget;
      if (slugArg) {
        const targets = await git.resolveSlugTargets(slugArg, cwd);
        if (!targets) throw new Error(`not a valid diff slug: ${slugArg}`);
        base = targets.base;
        head = targets.head;
      } else {
        base = parseTarget(typeof flags.base === "string" ? flags.base : undefined);
        head = parseTarget(typeof flags.head === "string" ? flags.head : "working-tree");
      }
      const c = await store.loadOrCreateDiff(base, head, cwd);
      if (flags["no-set-active"] !== true) {
        await store.setActiveDiff(c.slug, cwd);
      }
      if (flags.json) console.log(JSON.stringify(c, null, 2));
      else console.log(`slug: ${c.slug}\nfile: .staffreview/diffs/${c.slug}.json`);
      return;
    }

    case "files": {
      const slug = await activeSlugOrThrow(cwd, typeof flags.slug === "string" ? flags.slug : undefined);
      const c = await store.loadDiff(slug, cwd);
      if (!c) throw new Error(`diff not found: ${slug}`);
      const files = await git.getDiff(c.base, c.head, cwd);
      if (flags.json) console.log(JSON.stringify({ slug, files }, null, 2));
      else {
        for (const f of files) console.log(`${f.status[0]!.toUpperCase()}\t${f.path}`);
      }
      return;
    }

    case "comment": {
      const sub = positional[1];
      if (!sub) {
        help();
        return;
      }
      const slug = await activeSlugOrThrow(cwd, typeof flags.slug === "string" ? flags.slug : undefined);

      if (sub === "add") {
        let body = typeof flags.body === "string" ? flags.body : "";
        if (!body) body = await readBodyFromStdin();
        if (!body.trim()) throw new Error("--body is required (or pipe via stdin)");
        const file = typeof flags.file === "string" ? flags.file : undefined;
        const line = typeof flags.line === "string" ? Number(flags.line) : undefined;
        // Optional end of a multi-line range; only meaningful with --line
        // and when it differs from it. Mirrors the UI's range comments.
        const endLineRaw = typeof flags["end-line"] === "string" ? Number(flags["end-line"]) : undefined;
        const endLine =
          endLineRaw != null && Number.isFinite(endLineRaw) && line != null && endLineRaw !== line
            ? endLineRaw
            : undefined;
        const side = (flags.side === "old" ? "old" : flags.side === "new" ? "new" : undefined) as
          | "old" | "new" | undefined;
        const author = typeof flags.author === "string" ? flags.author : "agent";
        const parentId = typeof flags["reply-to"] === "string" ? (flags["reply-to"] as string) : undefined;
        const comment = await store.addComment(
          slug,
          { body, file, line, endLine, side, author, parentId },
          cwd,
        );
        console.log(JSON.stringify(comment, null, 2));
        return;
      }

      if (sub === "edit") {
        const id = typeof flags.id === "string" ? flags.id : undefined;
        if (!id) throw new Error("--id is required (the comment id from `comment add`)");
        let body = typeof flags.body === "string" ? flags.body : "";
        if (!body) body = await readBodyFromStdin();
        if (!body.trim()) throw new Error("--body is required (or pipe via stdin)");
        const diff = await store.updateComment(slug, id, body, cwd);
        const updated = diff.comments.find((x) => x.id === id);
        console.log(JSON.stringify(updated, null, 2));
        return;
      }

      if (sub === "delete") {
        const id = typeof flags.id === "string" ? flags.id : undefined;
        if (!id) throw new Error("--id is required (the comment id from `comment add`)");
        const before = await store.loadDiff(slug, cwd);
        if (!before) throw new Error(`diff not found: ${slug}`);
        // Error rather than silently no-op on an unknown id.
        if (!before.comments.some((x) => x.id === id)) throw new Error(`comment not found: ${id}`);
        // deleteComment removes the whole reply subtree; derive the count from
        // the before/after sizes so it stays accurate regardless of nesting.
        const after = await store.deleteComment(slug, id, cwd);
        const removed = before.comments.length - after.comments.length;
        const replies = removed - 1;
        if (flags.json) console.log(JSON.stringify({ deleted: id, removed }, null, 2));
        else console.log(`deleted comment ${id.slice(0, 8)}${replies > 0 ? ` (+${replies} repl${replies === 1 ? "y" : "ies"})` : ""}`);
        return;
      }

      if (sub === "list") {
        const c = await store.loadDiff(slug, cwd);
        if (!c) throw new Error("diff not found");
        const byThread = new Map<string, typeof c.comments>();
        for (const cm of c.comments) {
          const a = byThread.get(cm.threadId) ?? [];
          a.push(cm);
          byThread.set(cm.threadId, a);
        }
        let threads = Array.from(byThread.values()).map((cs) =>
          cs.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        );
        if (flags.open) {
          threads = threads.filter((t) => !t.find((x) => !x.parentId)?.resolution);
        }
        if (flags.json) {
          const out = threads.map((t) => {
            const root = t.find((c) => !c.parentId) ?? t[0]!;
            return {
              threadId: root.threadId,
              file: root.file,
              line: root.line,
              endLine: root.endLine,
              side: root.side,
              resolution: root.resolution,
              documentRequested: root.documentRequested ?? false,
              comments: t,
            };
          });
          console.log(JSON.stringify(out, null, 2));
        } else {
          for (const t of threads) {
            const r = t.find((c) => !c.parentId)!;
            const status = r.resolution?.status ?? (r.documentRequested ? "to-document" : "open");
            const loc = r.file ? `${r.file}:${r.line ?? ""}` : "(top-level)";
            console.log(`[${status}] ${r.threadId.slice(0, 8)} ${loc}`);
            console.log(`  ${r.body.split("\n")[0]}`);
          }
        }
        return;
      }

      if (sub === "resolve") {
        const threadId = typeof flags.thread === "string" ? flags.thread : undefined;
        const status = (flags.status as ResolutionStatus | undefined);
        let body = typeof flags.body === "string" ? flags.body : "";
        if (!body) body = await readBodyFromStdin();
        const documentedAs =
          typeof flags["documented-as"] === "string" ? (flags["documented-as"] as string) : undefined;
        if (!threadId) throw new Error("--thread is required");
        if (!status || !["fixed", "skipped", "documented"].includes(status)) {
          throw new Error("--status must be one of: fixed | skipped | documented");
        }
        if (!body.trim()) throw new Error("--body is required (or pipe via stdin)");
        const author = typeof flags.author === "string" ? flags.author : "agent";
        const c = await store.resolveThread(slug, threadId, { status, body, author, documentedAs }, cwd);
        if (flags.json) console.log(JSON.stringify(c, null, 2));
        else console.log(`thread ${threadId.slice(0, 8)} → ${status}`);
        return;
      }

      if (sub === "unresolve") {
        const threadId = typeof flags.thread === "string" ? flags.thread : undefined;
        if (!threadId) throw new Error("--thread is required");
        const c = await store.unresolveThread(slug, threadId, cwd);
        if (flags.json) console.log(JSON.stringify(c, null, 2));
        else console.log(`thread ${threadId.slice(0, 8)} → reopened`);
        return;
      }

      throw new Error(`Unknown subcommand: comment ${sub}`);
    }

    case "settings": {
      // Settings are global (per-user config dir), not per-repo. Apply the
      // loop-cap default so `/staff-loop` always reads a concrete number.
      const resolved: Record<string, unknown> = {
        loopMaxRounds: settings.DEFAULT_LOOP_ROUNDS,
        ...(await settings.readSettings()),
      };
      if (positional[1] === "get") {
        const key = positional[2];
        if (!key) throw new Error("usage: staff settings get <key>");
        const value = resolved[key];
        if (value === undefined) {
          console.error(`\x1b[33mnote:\x1b[0m setting not set: ${key}`);
          return;
        }
        console.log(flags.json ? JSON.stringify(value) : String(value));
        return;
      }
      console.log(JSON.stringify(resolved, null, 2));
      return;
    }

    default:
      help();
      process.exit(1);
  }
}

main(process.argv.slice(2)).catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`\x1b[31merror:\x1b[0m ${msg}`);
  process.exit(1);
});
