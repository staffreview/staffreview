import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REVIEW_AGENTS, MAX_REVIEW_AGENTS, MIN_REVIEW_AGENTS } from "./review-config.ts";
import type { WatchHarnessSettings } from "./settings.ts";
import * as store from "./store.ts";
import type { Comment, Diff } from "./types.ts";

const STATUS_MARKER = "<!-- staff-watch-status -->";
const COMMENT_MARKER_PREFIX = "<!-- staff-watch-comment:";
const COMMENT_MARKER_PATTERN =
  /^<!-- staff-watch-comment: [^\s#:/]+\/[^\s#:]+#\d+:[0-9a-fA-F]{40}:[0-9a-fA-F]{24} -->$/;
const DEFAULT_INTERVAL_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 2_147_483;
const GITHUB_CREDENTIAL_ENV_KEYS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];

type LogFn = (message: string) => void;

export type PullRequest = {
  number: number;
  title: string;
  url: string;
  state?: string;
  isDraft: boolean;
  baseRefName: string;
  baseRefOid: string;
  headRefName: string;
  headRefOid: string;
};

export type GithubRepo = {
  nameWithOwner: string;
  url: string;
};

export type GitRemote = {
  name: string;
  url: string;
};

type WatchedPullRequest = {
  pr: PullRequest;
  repo: GithubRepo;
};

export type WatchOptions = {
  cwd: string;
  prRef?: string;
  all?: boolean;
  once?: boolean;
  intervalSeconds?: number;
  agents?: number;
  reviewCommand?: string;
  watchHarness?: WatchHarnessSettings;
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
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  const [out, err, exitCode] = await Promise.all([stdout, stderr, proc.exited]);
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

function ghApiArgs(
  repo: GithubRepo,
  path: string,
  args: string[] = [],
  preArgs: string[] = [],
): string[] {
  let hostname: string | undefined;
  try {
    hostname = new URL(repo.url).host;
  } catch {
    hostname = undefined;
  }
  const hostArgs = hostname ? ["--hostname", hostname] : [];
  return ["api", ...hostArgs, ...preArgs, path, ...args];
}

async function ghApiJson<T>(
  repo: GithubRepo,
  path: string,
  cwd: string,
  args: string[] = [],
  preArgs: string[] = [],
): Promise<T> {
  return ghJson<T>(ghApiArgs(repo, path, args, preArgs), { cwd });
}

async function ghApiPaginatedJson<T>(repo: GithubRepo, path: string, cwd: string): Promise<T[]> {
  const pages = await ghApiJson<T[][]>(repo, path, cwd, [], ["--paginate", "--slurp"]);
  return pages.flat();
}

async function currentGithubLogin(cwd: string, repo: GithubRepo): Promise<string> {
  const result = await ghApiJson<{ login?: string }>(repo, "user", cwd);
  if (!result.login) throw new Error("could not determine authenticated GitHub login");
  return result.login;
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
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(MAX_TIMEOUT_SECONDS, Math.max(1, Math.round(parsed)))
    : DEFAULT_INTERVAL_SECONDS;
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

async function currentRepo(cwd: string): Promise<GithubRepo> {
  const result = await ghJson<{ nameWithOwner?: string; url?: string }>(
    ["repo", "view", "--json", "nameWithOwner,url"],
    { cwd },
  );
  if (!result.nameWithOwner) throw new Error("could not determine GitHub repository");
  return {
    nameWithOwner: result.nameWithOwner,
    url: result.url ?? `https://github.com/${result.nameWithOwner}`,
  };
}

function repoFetchUrl(repo: GithubRepo): string {
  const baseUrl = repo.url.replace(/\/+$/, "");
  return baseUrl.endsWith(".git") ? baseUrl : `${baseUrl}.git`;
}

function normalizedRepoPath(pathname: string): string | undefined {
  const path = pathname
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  return path ? path.toLowerCase() : undefined;
}

function normalizedRepoKey(remoteUrl: string): string | undefined {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return undefined;

  if (!trimmed.includes("://")) {
    const scpLike = trimmed.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
    if (scpLike?.[1] && scpLike[2]) {
      const path = normalizedRepoPath(scpLike[2]);
      return path ? `${scpLike[1].toLowerCase()}/${path}` : undefined;
    }
  }

  try {
    const url = new URL(trimmed);
    const path = normalizedRepoPath(url.pathname);
    return path ? `${url.host.toLowerCase()}/${path}` : undefined;
  } catch {
    return undefined;
  }
}

export function repoFetchTargetFromRemotes(repo: GithubRepo, remotes: GitRemote[]): string {
  const expected = normalizedRepoKey(repo.url);
  const matchingRemote = expected
    ? remotes.find((remote) => normalizedRepoKey(remote.url) === expected)
    : undefined;
  return matchingRemote?.name ?? repoFetchUrl(repo);
}

async function gitRemotes(cwd: string): Promise<GitRemote[]> {
  const names = (await git(["remote"], cwd, { allowFail: true }))
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean);
  const remotes: GitRemote[] = [];
  for (const name of names) {
    const url = (await git(["remote", "get-url", name], cwd, { allowFail: true })).trim();
    if (url) remotes.push({ name, url });
  }
  return remotes;
}

type RestPullRequest = {
  number: number;
  title: string;
  html_url: string;
  draft?: boolean;
  state?: string;
  base: {
    ref: string;
    sha: string;
  };
  head: {
    ref: string;
    sha: string;
  };
};

function pullRequestFromRest(pr: RestPullRequest): PullRequest {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    state: pr.state ?? "open",
    isDraft: pr.draft === true,
    baseRefName: pr.base.ref,
    baseRefOid: pr.base.sha,
    headRefName: pr.head.ref,
    headRefOid: pr.head.sha,
  };
}

export function parseRepoFromPullRequestUrl(prUrl: string): GithubRepo | undefined {
  try {
    const url = new URL(prUrl);
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/\d+\/?$/);
    if (!match?.[1] || !match[2]) return undefined;
    const owner = decodeURIComponent(match[1]);
    const name = decodeURIComponent(match[2]);
    return {
      nameWithOwner: `${owner}/${name}`,
      url: `${url.protocol}//${url.host}/${owner}/${name}`,
    };
  } catch {
    return undefined;
  }
}

export function repoFromPullRequestUrl(prUrl: string, fallback: GithubRepo): GithubRepo {
  return parseRepoFromPullRequestUrl(prUrl) ?? fallback;
}

async function listPullRequests(
  prRef: string | undefined,
  all: boolean | undefined,
  cwd: string,
  repo: GithubRepo,
): Promise<WatchedPullRequest[]> {
  const fields = [
    "number",
    "title",
    "url",
    "state",
    "isDraft",
    "baseRefName",
    "baseRefOid",
    "headRefName",
    "headRefOid",
  ].join(",");
  if (all) {
    const prs = await ghApiPaginatedJson<RestPullRequest>(
      repo,
      `repos/${repo.nameWithOwner}/pulls?state=open&per_page=100`,
      cwd,
    );
    return prs
      .map(pullRequestFromRest)
      .filter((pr) => !pr.isDraft)
      .map((pr) => ({ pr, repo }));
  }

  if (!prRef) throw new Error("pass a PR ref or use --all");
  const pr = await ghJson<PullRequest>(["pr", "view", prRef, "--json", fields], { cwd });
  if (pr.state && pr.state.toLowerCase() !== "open") return [];
  if (pr.isDraft) return [];
  return [{ pr, repo: repoFromPullRequestUrl(pr.url, repo) }];
}

async function ensurePrCommits(
  pr: PullRequest,
  cwd: string,
  repo: GithubRepo,
): Promise<{ baseSha: string; headSha: string }> {
  const fetchTarget = repoFetchTargetFromRemotes(repo, await gitRemotes(cwd));
  await git(["fetch", "-q", fetchTarget, `pull/${pr.number}/head`], cwd);
  const fetchedHead = (await git(["rev-parse", "FETCH_HEAD"], cwd)).trim();
  const headSha = fetchedHead || pr.headRefOid;

  await git(["fetch", "-q", fetchTarget, pr.baseRefName], cwd, { allowFail: true });
  const hasBase = (
    await git(["rev-parse", "--verify", "--quiet", `${pr.baseRefOid}^{commit}`], cwd, {
      allowFail: true,
    })
  ).trim();
  if (!hasBase) await git(["fetch", "-q", fetchTarget, pr.baseRefOid], cwd);

  const mergeBase = (await git(["merge-base", pr.baseRefOid, headSha], cwd)).trim();
  return { baseSha: mergeBase || pr.baseRefOid, headSha };
}

async function currentMergeBase(
  repo: GithubRepo,
  pr: PullRequest,
  currentBaseRefName: string,
  currentBaseSha: string,
  reviewedHeadSha: string,
  cwd: string,
): Promise<string> {
  const fetchTarget = repoFetchTargetFromRemotes(repo, await gitRemotes(cwd));
  await git(["fetch", "-q", fetchTarget, currentBaseRefName], cwd, { allowFail: true });
  const hasBase = (
    await git(["rev-parse", "--verify", "--quiet", `${currentBaseSha}^{commit}`], cwd, {
      allowFail: true,
    })
  ).trim();
  if (!hasBase) await git(["fetch", "-q", fetchTarget, currentBaseSha], cwd);

  const hasHead = (
    await git(["rev-parse", "--verify", "--quiet", `${reviewedHeadSha}^{commit}`], cwd, {
      allowFail: true,
    })
  ).trim();
  if (!hasHead) await git(["fetch", "-q", fetchTarget, `pull/${pr.number}/head`], cwd);

  return (await git(["merge-base", currentBaseSha, reviewedHeadSha], cwd)).trim();
}

async function createPrDiff(pr: PullRequest, cwd: string, repo: GithubRepo): Promise<Diff> {
  const { baseSha, headSha } = await ensurePrCommits(pr, cwd, repo);
  return store.loadOrCreateDiffWithSlug(
    watchDiffSlug(repo, pr, baseSha, headSha),
    { kind: "commit", ref: baseSha },
    { kind: "commit", ref: headSha, label: pr.headRefName },
    cwd,
  );
}

function safeSlugPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

export function watchDiffSlug(
  repo: GithubRepo,
  pr: PullRequest,
  baseSha: string,
  headSha: string,
): string {
  return `watch-${safeSlugPart(repo.nameWithOwner)}-pr-${pr.number}-${baseSha}..${headSha}`;
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
  for (const key of GITHUB_CREDENTIAL_ENV_KEYS) delete env[key];
  return {
    ...env,
    GH_CONFIG_DIR: mkdtempSync(join(tmpdir(), "staff-watch-gh-")),
    GH_PROMPT_DISABLED: "1",
    STAFF_WATCH_PR_NUMBER: String(pr.number),
    STAFF_WATCH_PR_URL: pr.url,
    STAFF_WATCH_DIFF_SLUG: slug,
    STAFF_WATCH_AGENTS: String(agents),
  } as Record<string, string>;
}

async function runReviewCommand({
  command,
  harness,
  cwd,
  prompt,
  env,
}: {
  command?: string;
  harness?: WatchHarnessSettings;
  cwd: string;
  prompt: string;
  env: Record<string, string>;
}) {
  const configured = command?.trim() || process.env.STAFF_WATCH_REVIEW_COMMAND?.trim();
  if (configured) {
    const proc = Bun.spawn(shellCommand(configured), {
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
      throw new Error(reviewCommandFailureMessage(configured, exitCode));
    }
    return;
  }

  if (harness) {
    const proc = Bun.spawn(watchHarnessCommand(harness, prompt), {
      cwd,
      env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(watchHarnessFailureMessage(exitCode));
    }
    return;
  }

  const proc = Bun.spawn(["codex", "exec", "--cd", cwd, "-"], {
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
    throw new Error(reviewCommandFailureMessage(undefined, exitCode));
  }
}

export function reviewCommandFailureMessage(command: string | undefined, exitCode: number): string {
  const label = command?.trim() ? "configured review command" : "codex exec --cd <repo> -";
  return `${label} failed with exit code ${exitCode}`;
}

export function watchHarnessCommand(harness: WatchHarnessSettings, prompt: string): string[] {
  return [harness.command, ...harness.args, prompt];
}

export function watchHarnessFailureMessage(exitCode: number): string {
  return `configured watch harness failed with exit code ${exitCode}`;
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
  user?: {
    login?: string;
  } | null;
};

export function statusCommentToUpdate(
  comments: IssueComment[],
  authorLogin: string,
): IssueComment | undefined {
  return comments.find(
    (comment) => comment.body?.includes(STATUS_MARKER) && comment.user?.login === authorLogin,
  );
}

async function upsertStatusComment(
  repo: GithubRepo,
  pr: PullRequest,
  body: string,
  cwd: string,
  authorLogin: string,
): Promise<void> {
  const comments = await ghApiPaginatedJson<IssueComment>(
    repo,
    `repos/${repo.nameWithOwner}/issues/${pr.number}/comments?per_page=100`,
    cwd,
  );
  const existing = statusCommentToUpdate(comments, authorLogin);
  if (existing) {
    await gh(
      ghApiArgs(repo, `repos/${repo.nameWithOwner}/issues/comments/${existing.id}`, [
        "-X",
        "PATCH",
        "-f",
        `body=${body}`,
      ]),
      { cwd },
    );
    return;
  }
  await gh(
    ghApiArgs(repo, `repos/${repo.nameWithOwner}/issues/${pr.number}/comments`, [
      "-X",
      "POST",
      "-f",
      `body=${body}`,
    ]),
    { cwd },
  );
}

type ReviewComment = {
  body?: string;
  user?: {
    login?: string;
  } | null;
};

async function existingPublishedMarkers(
  repo: GithubRepo,
  pr: PullRequest,
  cwd: string,
  authorLogin: string,
): Promise<Set<string>> {
  const reviewComments = await ghApiPaginatedJson<ReviewComment>(
    repo,
    `repos/${repo.nameWithOwner}/pulls/${pr.number}/comments?per_page=100`,
    cwd,
  );
  const issueComments = await ghApiPaginatedJson<ReviewComment>(
    repo,
    `repos/${repo.nameWithOwner}/issues/${pr.number}/comments?per_page=100`,
    cwd,
  );
  return collectPublishedMarkers([...reviewComments, ...issueComments], authorLogin);
}

export function collectPublishedMarkers(
  comments: ReviewComment[],
  authorLogin: string,
): Set<string> {
  const markers = new Set<string>();
  for (const comment of comments) {
    if (comment.user?.login !== authorLogin) continue;
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
    const marker = body.slice(start, end + 3);
    if (COMMENT_MARKER_PATTERN.test(marker)) {
      markers.push(marker);
      index = end + 3;
    } else {
      index = start + COMMENT_MARKER_PREFIX.length;
    }
  }
  return markers;
}

export function findingIdentity(comment: Comment): string {
  const normalizedBody = comment.body.replace(/\r\n?/g, "\n").trim();
  const payload = JSON.stringify({
    file: comment.file ?? null,
    side: comment.side ?? "new",
    line: comment.line ?? null,
    endLine: comment.endLine ?? comment.line ?? null,
    priority: comment.priority ?? null,
    body: normalizedBody,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 24);
}

function commentMarker(repo: string, pr: PullRequest, headSha: string, comment: Comment): string {
  return `${COMMENT_MARKER_PREFIX} ${repo}#${pr.number}:${headSha}:${findingIdentity(comment)} -->`;
}

export function commentBody(comment: Comment, marker: string): string {
  const priority = comment.priority ? `\n\nPriority: ${comment.priority}` : "";
  return `${comment.body}${priority}\n\n${marker}`;
}

export function commentsToPublish({
  diff,
  existingMarkers,
  repo,
  pr,
  headSha,
}: {
  diff: Diff;
  existingMarkers: Set<string>;
  repo: string;
  pr: PullRequest;
  headSha: string;
}): Array<{ comment: Comment; marker: string }> {
  const seenMarkers = new Set(existingMarkers);
  const comments: Array<{ comment: Comment; marker: string }> = [];
  for (const comment of diff.comments) {
    if (comment.parentId || comment.resolution || !comment.priority) continue;
    const marker = commentMarker(repo, pr, headSha, comment);
    if (seenMarkers.has(marker)) continue;
    seenMarkers.add(marker);
    comments.push({ comment, marker });
  }
  return comments;
}

async function postTopLevelComment(
  repo: GithubRepo,
  pr: PullRequest,
  body: string,
  cwd: string,
): Promise<void> {
  await gh(
    ghApiArgs(repo, `repos/${repo.nameWithOwner}/issues/${pr.number}/comments`, [
      "-X",
      "POST",
      "-f",
      `body=${body}`,
    ]),
    { cwd },
  );
}

async function postInlineComment(
  repo: GithubRepo,
  pr: PullRequest,
  headSha: string,
  comment: Comment,
  body: string,
  cwd: string,
) {
  if (!comment.file || comment.line == null) {
    await postTopLevelComment(repo, pr, body, cwd);
    return;
  }

  const args = ghApiArgs(repo, `repos/${repo.nameWithOwner}/pulls/${pr.number}/comments`, [
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
  ]);
  if (comment.endLine != null && comment.endLine !== comment.line) {
    args.push(
      "-F",
      `start_line=${comment.line}`,
      "-f",
      `start_side=${comment.side === "old" ? "LEFT" : "RIGHT"}`,
    );
  }

  try {
    await gh(args, { cwd });
  } catch (error) {
    const anchor = `Could not anchor this Staff Review finding at \`${comment.file}:${comment.line}\`, so it was posted as a top-level PR comment.`;
    const fallback = `${anchor}\n\n${body}`;
    await postTopLevelComment(repo, pr, fallback, cwd);
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
  cwd,
  authorLogin,
}: {
  repo: GithubRepo;
  pr: PullRequest;
  headSha: string;
  diff: Diff;
  cwd: string;
  authorLogin: string;
}): Promise<number> {
  const existingMarkers = await existingPublishedMarkers(repo, pr, cwd, authorLogin);
  const comments = commentsToPublish({
    diff,
    existingMarkers,
    repo: repo.nameWithOwner,
    pr,
    headSha,
  });
  let posted = 0;
  for (const { comment, marker } of comments) {
    await postInlineComment(repo, pr, headSha, comment, commentBody(comment, marker), cwd);
    existingMarkers.add(marker);
    posted++;
  }
  return posted;
}

type CurrentPullRequestState = {
  headSha: string;
  baseSha: string;
  baseRefName: string;
  state: string;
  isDraft: boolean;
};

async function currentPullRequestState(
  repo: GithubRepo,
  pr: PullRequest,
  cwd: string,
): Promise<CurrentPullRequestState> {
  const latest = await ghApiJson<RestPullRequest>(
    repo,
    `repos/${repo.nameWithOwner}/pulls/${pr.number}`,
    cwd,
  );
  if (!latest.head?.sha) throw new Error(`could not determine current head for PR #${pr.number}`);
  if (!latest.base?.sha) throw new Error(`could not determine current base for PR #${pr.number}`);
  return {
    headSha: latest.head.sha,
    baseSha: latest.base.sha,
    baseRefName: latest.base.ref || pr.baseRefName,
    state: latest.state ?? "open",
    isDraft: latest.draft === true,
  };
}

export function assertPrHeadCurrent(
  pr: PullRequest,
  reviewedHeadSha: string,
  currentHeadSha: string,
) {
  if (currentHeadSha !== reviewedHeadSha) {
    throw new Error(
      `PR #${pr.number} head changed during review from ${shortSha(reviewedHeadSha)} to ${shortSha(currentHeadSha)}; skipping stale findings.`,
    );
  }
}

export function assertPrPublishable(
  pr: PullRequest,
  reviewedHeadSha: string,
  current: CurrentPullRequestState,
) {
  assertPrHeadCurrent(pr, reviewedHeadSha, current.headSha);
  if (current.state !== "open") {
    throw new Error(`PR #${pr.number} is ${current.state}; skipping findings.`);
  }
  if (current.isDraft) {
    throw new Error(`PR #${pr.number} is draft; skipping findings.`);
  }
}

export function assertPrReviewedBaseCurrent(
  pr: PullRequest,
  reviewedBaseSha: string,
  currentBaseSha: string,
) {
  if (currentBaseSha !== reviewedBaseSha) {
    throw new Error(
      `PR #${pr.number} merge base changed during review from ${shortSha(reviewedBaseSha)} to ${shortSha(currentBaseSha)}; skipping stale findings.`,
    );
  }
}

export type ReviewerSourceSnapshot = {
  statusLines: string[];
  stagedDiffHash: string;
  worktreeDiffHash: string;
  untrackedFileHashes: Record<string, string>;
};

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function unquoteStatusPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  try {
    return JSON.parse(trimmed) as string;
  } catch {
    return trimmed.slice(1, -1);
  }
}

function statusLinePaths(line: string): string[] {
  if (line.length < 4) return [];
  const pathText = line.slice(3);
  return pathText.split(" -> ").map(unquoteStatusPath);
}

function isStaffreviewPath(path: string): boolean {
  return path === ".staffreview" || path.startsWith(".staffreview/");
}

function nonStaffreviewStatusLines(status: string): string[] {
  return status
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => statusLinePaths(line).some((path) => !isStaffreviewPath(path)));
}

async function untrackedFileHash(path: string, cwd: string): Promise<string> {
  try {
    const file = Bun.file(join(cwd, path));
    if (!(await file.exists())) return "<missing>";
    return createHash("sha256")
      .update(new Uint8Array(await file.arrayBuffer()))
      .digest("hex");
  } catch {
    return "<unreadable>";
  }
}

async function reviewerSourceSnapshot(cwd: string): Promise<ReviewerSourceSnapshot> {
  const [status, stagedDiff, worktreeDiff] = await Promise.all([
    git(["status", "--porcelain=v1", "--untracked-files=all"], cwd, { allowFail: true }),
    git(["diff", "--cached", "--binary", "--", ".", ":(exclude).staffreview/**"], cwd, {
      allowFail: true,
    }),
    git(["diff", "--binary", "--", ".", ":(exclude).staffreview/**"], cwd, {
      allowFail: true,
    }),
  ]);
  const statusLines = nonStaffreviewStatusLines(status);
  const untrackedPaths = statusLines
    .filter((line) => line.startsWith("?? "))
    .flatMap(statusLinePaths)
    .filter((path) => !isStaffreviewPath(path))
    .sort();
  const untrackedFileHashes: Record<string, string> = {};
  for (const path of untrackedPaths) {
    untrackedFileHashes[path] = await untrackedFileHash(path, cwd);
  }
  return {
    statusLines,
    stagedDiffHash: hashText(stagedDiff),
    worktreeDiffHash: hashText(worktreeDiff),
    untrackedFileHashes,
  };
}

export function reviewerSourceChanges(
  before: ReviewerSourceSnapshot,
  after: ReviewerSourceSnapshot,
): string[] {
  const unchanged =
    before.stagedDiffHash === after.stagedDiffHash &&
    before.worktreeDiffHash === after.worktreeDiffHash &&
    JSON.stringify(before.statusLines) === JSON.stringify(after.statusLines) &&
    JSON.stringify(before.untrackedFileHashes) === JSON.stringify(after.untrackedFileHashes);
  if (unchanged) return [];

  const paths = new Set<string>();
  for (const line of [...before.statusLines, ...after.statusLines]) {
    for (const path of statusLinePaths(line)) {
      if (!isStaffreviewPath(path)) paths.add(path);
    }
  }
  for (const path of Object.keys(before.untrackedFileHashes)) paths.add(path);
  for (const path of Object.keys(after.untrackedFileHashes)) paths.add(path);
  return [...paths].sort();
}

function assertReviewerDidNotChangeSource(
  before: ReviewerSourceSnapshot,
  after: ReviewerSourceSnapshot,
): void {
  const changed = reviewerSourceChanges(before, after);
  if (changed.length === 0) return;
  const detail = changed.length > 0 ? `: ${changed.join(", ")}` : "";
  throw new Error(`reviewer modified files outside .staffreview${detail}`);
}

async function reviewPullRequest({
  repo,
  pr,
  cwd,
  agents,
  reviewCommand,
  watchHarness,
  authorLogin,
  log,
}: {
  repo: GithubRepo;
  pr: PullRequest;
  cwd: string;
  agents: number;
  reviewCommand?: string;
  watchHarness?: WatchHarnessSettings;
  authorLogin: string;
  log: LogFn;
}): Promise<string> {
  const diff = await createPrDiff(pr, cwd, repo);
  const reviewedBaseSha = diff.base.ref ?? pr.baseRefOid;
  const headSha = diff.head.ref ?? pr.headRefOid;
  await upsertStatusComment(
    repo,
    pr,
    statusBody({ pr, headSha, state: "reviewing", details: `Running with ${agents} agents.` }),
    cwd,
    authorLogin,
  );
  log(`reviewing PR #${pr.number} at ${shortSha(headSha)} (${diff.slug})`);

  try {
    const sourceBeforeReview = await reviewerSourceSnapshot(cwd);
    await runReviewCommand({
      command: reviewCommand,
      harness: watchHarness,
      cwd,
      prompt: buildReviewPrompt(pr, diff.slug, agents),
      env: commandEnvironment(pr, diff.slug, agents),
    });
    const sourceAfterReview = await reviewerSourceSnapshot(cwd);
    assertReviewerDidNotChangeSource(sourceBeforeReview, sourceAfterReview);
    const updated = await store.loadDiff(diff.slug, cwd);
    if (!updated) throw new Error(`diff disappeared during review: ${diff.slug}`);
    const current = await currentPullRequestState(repo, pr, cwd);
    assertPrPublishable(pr, headSha, current);
    const currentBaseSha = await currentMergeBase(
      repo,
      pr,
      current.baseRefName,
      current.baseSha,
      headSha,
      cwd,
    );
    assertPrReviewedBaseCurrent(pr, reviewedBaseSha, currentBaseSha);
    const posted = await publishComments({
      repo,
      pr,
      headSha,
      diff: updated,
      cwd,
      authorLogin,
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
      cwd,
      authorLogin,
    );
    log(`completed PR #${pr.number} at ${shortSha(headSha)}: posted ${posted} findings`);
    return headSha;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await upsertStatusComment(
      repo,
      pr,
      statusBody({ pr, headSha, state: "failed", details: message }),
      cwd,
      authorLogin,
    );
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runWatch(options: WatchOptions): Promise<void> {
  const repo =
    !options.all && options.prRef
      ? (parseRepoFromPullRequestUrl(options.prRef) ?? undefined)
      : undefined;
  const checkoutRepo = repo ?? (await currentRepo(options.cwd));
  const authorLogin = await currentGithubLogin(options.cwd, checkoutRepo);
  const agents = normalizeAgents(options.agents);
  const intervalSeconds = normalizeIntervalSeconds(options.intervalSeconds);
  const log = options.log ?? console.log;
  const seenHeads = new Map<string, string>();

  for (;;) {
    const failures: string[] = [];
    let prs: WatchedPullRequest[];
    try {
      prs = await listPullRequests(options.prRef, options.all, options.cwd, checkoutRepo);
    } catch (error) {
      if (options.once) throw error;
      const message = error instanceof Error ? error.message : String(error);
      log(`failed to list PRs: ${message}`);
      await sleep(intervalSeconds * 1000);
      continue;
    }
    if (prs.length === 0) {
      log(options.all ? "no open non-draft PRs found" : "PR is draft or not found");
    }
    for (const { pr, repo: prRepo } of prs) {
      const seenKey = `${prRepo.nameWithOwner}#${pr.number}`;
      if (seenHeads.get(seenKey) === pr.headRefOid) continue;
      try {
        const reviewedHead = await reviewPullRequest({
          repo: prRepo,
          pr,
          cwd: options.cwd,
          agents,
          reviewCommand: options.reviewCommand,
          watchHarness: options.watchHarness,
          authorLogin,
          log,
        });
        seenHeads.set(seenKey, reviewedHead || pr.headRefOid);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`failed PR #${pr.number}: ${message}`);
        if (options.once) failures.push(`PR #${pr.number}: ${message}`);
      }
    }
    if (options.once) {
      if (failures.length > 0) {
        throw new Error(
          `staff watch --once failed for ${failures.length} PR(s): ${failures.join("; ")}`,
        );
      }
      return;
    }
    await sleep(intervalSeconds * 1000);
  }
}
