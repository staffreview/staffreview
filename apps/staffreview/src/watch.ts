import { DEFAULT_REVIEW_AGENTS, MAX_REVIEW_AGENTS, MIN_REVIEW_AGENTS } from "./review-config.ts";
import * as store from "./store.ts";
import type { Comment, Diff } from "./types.ts";

const STATUS_MARKER = "<!-- staff-watch-status -->";
const COMMENT_MARKER_PREFIX = "<!-- staff-watch-comment:";
const DEFAULT_INTERVAL_SECONDS = 60;

type LogFn = (message: string) => void;

export type PullRequest = {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  baseRefName: string;
  baseRefOid: string;
  headRefName: string;
  headRefOid: string;
};

export type WatchOptions = {
  cwd: string;
  prRef?: string;
  all?: boolean;
  once?: boolean;
  intervalSeconds?: number;
  agents?: number;
  reviewCommand?: string;
  log?: LogFn;
};

type CommandOptions = {
  cwd?: string;
  allowFail?: boolean;
};

async function run(cmd: string[], opts: CommandOptions = {}): Promise<string> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd ?? process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0 && !opts.allowFail) {
    throw new Error(`Command failed (${exitCode}): ${cmd.join(" ")}\n${err.trim()}`);
  }
  return out;
}

async function runJson<T>(cmd: string[], opts: CommandOptions = {}): Promise<T> {
  const out = await run(cmd, opts);
  return JSON.parse(out) as T;
}

async function gh(args: string[], opts: CommandOptions = {}): Promise<string> {
  return run(["gh", ...args], opts);
}

async function ghJson<T>(args: string[], opts: CommandOptions = {}): Promise<T> {
  return runJson<T>(["gh", ...args], opts);
}

async function git(args: string[], cwd: string, opts: Omit<CommandOptions, "cwd"> = {}) {
  return run(["git", ...args], { ...opts, cwd });
}

export function normalizeAgents(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : DEFAULT_REVIEW_AGENTS;
  const finite = Number.isFinite(parsed) ? parsed : DEFAULT_REVIEW_AGENTS;
  return Math.min(MAX_REVIEW_AGENTS, Math.max(MIN_REVIEW_AGENTS, Math.round(finite)));
}

export function normalizeIntervalSeconds(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : DEFAULT_INTERVAL_SECONDS;
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : DEFAULT_INTERVAL_SECONDS;
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

async function currentRepo(): Promise<string> {
  const result = await ghJson<{ nameWithOwner: string }>([
    "repo",
    "view",
    "--json",
    "nameWithOwner",
  ]);
  return result.nameWithOwner;
}

async function listPullRequests(
  prRef: string | undefined,
  all: boolean | undefined,
): Promise<PullRequest[]> {
  const fields = [
    "number",
    "title",
    "url",
    "isDraft",
    "baseRefName",
    "baseRefOid",
    "headRefName",
    "headRefOid",
  ].join(",");
  if (all) {
    const prs = await ghJson<PullRequest[]>([
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      fields,
    ]);
    return prs.filter((pr) => !pr.isDraft);
  }

  if (!prRef) throw new Error("pass a PR ref or use --all");
  const pr = await ghJson<PullRequest>(["pr", "view", prRef, "--json", fields]);
  if (pr.isDraft) return [];
  return [pr];
}

async function ensurePrCommits(
  pr: PullRequest,
  cwd: string,
): Promise<{ baseSha: string; headSha: string }> {
  await git(["fetch", "-q", "origin", `pull/${pr.number}/head`], cwd);
  const fetchedHead = (await git(["rev-parse", "FETCH_HEAD"], cwd)).trim();
  const headSha = fetchedHead || pr.headRefOid;

  await git(["fetch", "-q", "origin", pr.baseRefName], cwd, { allowFail: true });
  const hasBase = (
    await git(["rev-parse", "--verify", "--quiet", `${pr.baseRefOid}^{commit}`], cwd, {
      allowFail: true,
    })
  ).trim();
  if (hasBase) return { baseSha: pr.baseRefOid, headSha };

  await git(["fetch", "-q", "origin", pr.baseRefOid], cwd);
  return { baseSha: pr.baseRefOid, headSha };
}

async function createPrDiff(pr: PullRequest, cwd: string): Promise<Diff> {
  const { baseSha, headSha } = await ensurePrCommits(pr, cwd);
  return store.loadOrCreateDiff(
    { kind: "commit", ref: baseSha, label: pr.baseRefName },
    { kind: "commit", ref: headSha, label: pr.headRefName },
    cwd,
  );
}

export function buildReviewPrompt(pr: PullRequest, slug: string, agents: number): string {
  return [
    `Run /staff-review ${slug} ${agents}.`,
    "",
    `This is GitHub PR #${pr.number}: ${pr.title}`,
    pr.url,
    "",
    "Use the installed Staff Review skills and post findings to the local Staff Review diff only.",
    "Do not modify code, resolve comments, commit, push, open the UI, or create a pull request.",
    "The watch command will mirror any findings you leave on the local diff back to the GitHub PR.",
  ].join("\n");
}

function commandEnvironment(pr: PullRequest, slug: string, agents: number): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    STAFF_WATCH_PR_NUMBER: String(pr.number),
    STAFF_WATCH_PR_URL: pr.url,
    STAFF_WATCH_DIFF_SLUG: slug,
    STAFF_WATCH_AGENTS: String(agents),
  } as Record<string, string>;
}

async function runReviewCommand({
  command,
  cwd,
  prompt,
  env,
}: {
  command?: string;
  cwd: string;
  prompt: string;
  env: Record<string, string>;
}) {
  const configured = command?.trim() || process.env.STAFF_WATCH_REVIEW_COMMAND?.trim();
  const proc = configured
    ? Bun.spawn(shellCommand(configured), {
        cwd,
        env,
        stdin: "pipe",
        stdout: "inherit",
        stderr: "inherit",
      })
    : Bun.spawn(["codex", "exec", "--cd", cwd, "-"], {
        cwd,
        env,
        stdin: "pipe",
        stdout: "inherit",
        stderr: "inherit",
      });

  proc.stdin.write(prompt);
  proc.stdin.end();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(
      `review command failed with exit code ${exitCode}: ${configured || "codex exec --cd <repo> -"}`,
    );
  }
}

function shellCommand(command: string): string[] {
  if (process.platform === "win32") return ["cmd", "/d", "/s", "/c", command];
  return [process.env.SHELL || "sh", "-lc", command];
}

export function statusBody({
  pr,
  headSha,
  state,
  details,
}: {
  pr: PullRequest;
  headSha: string;
  state: "reviewing" | "complete" | "failed";
  details?: string;
}): string {
  const status =
    state === "reviewing"
      ? "Review in progress"
      : state === "complete"
        ? "Review complete"
        : "Review failed";
  return [
    STATUS_MARKER,
    `### Staff Review: ${status}`,
    "",
    `PR #${pr.number} commit \`${shortSha(headSha)}\`.`,
    details ? `\n${details}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

type IssueComment = {
  id: number;
  body?: string;
  html_url?: string;
};

async function upsertStatusComment(repo: string, pr: PullRequest, body: string): Promise<void> {
  const comments = await ghJson<IssueComment[]>([
    "api",
    `repos/${repo}/issues/${pr.number}/comments?per_page=100`,
  ]);
  const existing = comments.find((comment) => comment.body?.includes(STATUS_MARKER));
  if (existing) {
    await gh([
      "api",
      `repos/${repo}/issues/comments/${existing.id}`,
      "-X",
      "PATCH",
      "-f",
      `body=${body}`,
    ]);
    return;
  }
  await gh([
    "api",
    `repos/${repo}/issues/${pr.number}/comments`,
    "-X",
    "POST",
    "-f",
    `body=${body}`,
  ]);
}

type ReviewComment = {
  body?: string;
};

async function existingPublishedMarkers(repo: string, pr: PullRequest): Promise<Set<string>> {
  const reviewComments = await ghJson<ReviewComment[]>([
    "api",
    `repos/${repo}/pulls/${pr.number}/comments?per_page=100`,
  ]);
  const issueComments = await ghJson<ReviewComment[]>([
    "api",
    `repos/${repo}/issues/${pr.number}/comments?per_page=100`,
  ]);
  const markers = new Set<string>();
  for (const comment of [...reviewComments, ...issueComments]) {
    const body = comment.body ?? "";
    for (const marker of extractCommentMarkers(body)) markers.add(marker);
  }
  return markers;
}

function extractCommentMarkers(body: string): string[] {
  const markers: string[] = [];
  let index = 0;
  while (index < body.length) {
    const start = body.indexOf(COMMENT_MARKER_PREFIX, index);
    if (start < 0) break;
    const end = body.indexOf("-->", start);
    if (end < 0) break;
    markers.push(body.slice(start, end + 3));
    index = end + 3;
  }
  return markers;
}

function commentMarker(repo: string, pr: PullRequest, headSha: string, comment: Comment): string {
  return `${COMMENT_MARKER_PREFIX} ${repo}#${pr.number}:${headSha}:${comment.threadId} -->`;
}

export function commentBody(comment: Comment, marker: string): string {
  const priority = comment.priority ? `\n\nPriority: ${comment.priority}` : "";
  return `${comment.body}${priority}\n\n${marker}`;
}

export function commentsToPublish({
  diff,
  beforeCommentIds,
  existingMarkers,
  repo,
  pr,
  headSha,
}: {
  diff: Diff;
  beforeCommentIds: Set<string>;
  existingMarkers: Set<string>;
  repo: string;
  pr: PullRequest;
  headSha: string;
}): Array<{ comment: Comment; marker: string }> {
  return diff.comments
    .filter((comment) => !comment.parentId)
    .filter((comment) => !beforeCommentIds.has(comment.id))
    .map((comment) => ({ comment, marker: commentMarker(repo, pr, headSha, comment) }))
    .filter(({ marker }) => !existingMarkers.has(marker));
}

async function postTopLevelComment(repo: string, pr: PullRequest, body: string): Promise<void> {
  await gh([
    "api",
    `repos/${repo}/issues/${pr.number}/comments`,
    "-X",
    "POST",
    "-f",
    `body=${body}`,
  ]);
}

async function postInlineComment(
  repo: string,
  pr: PullRequest,
  headSha: string,
  comment: Comment,
  body: string,
) {
  if (!comment.file || comment.line == null) {
    await postTopLevelComment(repo, pr, body);
    return;
  }

  const args = [
    "api",
    `repos/${repo}/pulls/${pr.number}/comments`,
    "-X",
    "POST",
    "-f",
    `body=${body}`,
    "-f",
    `commit_id=${headSha}`,
    "-f",
    `path=${comment.file}`,
    "-f",
    `side=${comment.side === "old" ? "LEFT" : "RIGHT"}`,
    "-F",
    `line=${comment.endLine ?? comment.line}`,
  ];
  if (comment.endLine != null && comment.endLine !== comment.line) {
    args.push(
      "-F",
      `start_line=${comment.line}`,
      "-f",
      `start_side=${comment.side === "old" ? "LEFT" : "RIGHT"}`,
    );
  }

  try {
    await gh(args);
  } catch (error) {
    const anchor = `Could not anchor this Staff Review finding at \`${comment.file}:${comment.line}\`, so it was posted as a top-level PR comment.`;
    const fallback = `${anchor}\n\n${body}`;
    await postTopLevelComment(repo, pr, fallback);
    if (error instanceof Error) {
      console.warn(
        `warning: inline comment fallback for ${comment.file}:${comment.line}: ${error.message}`,
      );
    }
  }
}

async function publishComments({
  repo,
  pr,
  headSha,
  diff,
  beforeCommentIds,
}: {
  repo: string;
  pr: PullRequest;
  headSha: string;
  diff: Diff;
  beforeCommentIds: Set<string>;
}): Promise<number> {
  const existingMarkers = await existingPublishedMarkers(repo, pr);
  const comments = commentsToPublish({
    diff,
    beforeCommentIds,
    existingMarkers,
    repo,
    pr,
    headSha,
  });
  for (const { comment, marker } of comments) {
    await postInlineComment(repo, pr, headSha, comment, commentBody(comment, marker));
  }
  return comments.length;
}

async function reviewPullRequest({
  repo,
  pr,
  cwd,
  agents,
  reviewCommand,
  log,
}: {
  repo: string;
  pr: PullRequest;
  cwd: string;
  agents: number;
  reviewCommand?: string;
  log: LogFn;
}): Promise<string> {
  const diff = await createPrDiff(pr, cwd);
  const headSha = diff.head.ref ?? pr.headRefOid;
  const beforeCommentIds = new Set(diff.comments.map((comment) => comment.id));
  await upsertStatusComment(
    repo,
    pr,
    statusBody({ pr, headSha, state: "reviewing", details: `Running with ${agents} agents.` }),
  );
  log(`reviewing PR #${pr.number} at ${shortSha(headSha)} (${diff.slug})`);

  try {
    await runReviewCommand({
      command: reviewCommand,
      cwd,
      prompt: buildReviewPrompt(pr, diff.slug, agents),
      env: commandEnvironment(pr, diff.slug, agents),
    });
    const updated = await store.loadDiff(diff.slug, cwd);
    if (!updated) throw new Error(`diff disappeared during review: ${diff.slug}`);
    const posted = await publishComments({
      repo,
      pr,
      headSha,
      diff: updated,
      beforeCommentIds,
    });
    await upsertStatusComment(
      repo,
      pr,
      statusBody({
        pr,
        headSha,
        state: "complete",
        details: posted === 1 ? "Posted 1 finding." : `Posted ${posted} findings.`,
      }),
    );
    log(`completed PR #${pr.number} at ${shortSha(headSha)}: posted ${posted} findings`);
    return headSha;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await upsertStatusComment(
      repo,
      pr,
      statusBody({ pr, headSha, state: "failed", details: message }),
    );
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runWatch(options: WatchOptions): Promise<void> {
  await gh(["auth", "status"]);
  const repo = await currentRepo();
  const agents = normalizeAgents(options.agents);
  const intervalSeconds = normalizeIntervalSeconds(options.intervalSeconds);
  const log = options.log ?? console.log;
  const seenHeads = new Map<number, string>();

  for (;;) {
    const prs = await listPullRequests(options.prRef, options.all);
    if (prs.length === 0) {
      log(options.all ? "no open non-draft PRs found" : "PR is draft or not found");
    }
    for (const pr of prs) {
      if (seenHeads.get(pr.number) === pr.headRefOid) continue;
      try {
        const reviewedHead = await reviewPullRequest({
          repo,
          pr,
          cwd: options.cwd,
          agents,
          reviewCommand: options.reviewCommand,
          log,
        });
        seenHeads.set(pr.number, reviewedHead || pr.headRefOid);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`failed PR #${pr.number}: ${message}`);
      }
    }
    if (options.once) return;
    await sleep(intervalSeconds * 1000);
  }
}
