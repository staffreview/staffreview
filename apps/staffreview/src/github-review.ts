import * as git from "./git.ts";
import type { Comment, Diff } from "./types.ts";

type PullRequest = {
  number: number;
  head: { sha: string };
  base: { sha: string };
};

type Review = { body?: string | null };

type GitHubEvent = {
  number?: number;
  pull_request?: {
    number?: number;
    head?: { sha?: string };
    base?: { sha?: string };
  };
};

export type PostReviewOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  event?: GitHubEvent;
  pr?: string;
  repository?: string;
  expectedHead?: string;
  fetch?: typeof globalThis.fetch;
};

async function githubRequest<T>(
  url: string,
  token: string,
  fetch: typeof globalThis.fetch,
  init: RequestInit = {},
): Promise<{ data: T; response: Response }> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "staffreview",
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `GitHub API ${init.method ?? "GET"} ${new URL(url).pathname} failed (${response.status} ${response.statusText})${body ? `\n${body}` : ""}`,
    );
  }
  return {
    data: (body ? JSON.parse(body) : undefined) as T,
    response,
  };
}

function nextPage(link: string | null): string | undefined {
  if (!link) return undefined;
  for (const entry of link.split(",")) {
    const match = entry.match(/^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/);
    if (match?.[2] === "next") return match[1];
  }
  return undefined;
}

function priorityLabel(comment: Comment, fallback: string): string {
  return comment.priority ?? fallback;
}

export function reviewPayload(diff: Diff, commit: string, marker: string) {
  const findings = diff.comments.filter((comment) => !comment.parentId);
  const topLevel = findings.filter((comment) => !comment.file);
  const inline = findings.filter((comment) => comment.file);

  return {
    commit_id: commit,
    event: "COMMENT",
    body:
      `Staff Review.\n\n${marker}` +
      topLevel
        .map((comment) => `\n\n**${priorityLabel(comment, "Finding")}**\n\n${comment.body}`)
        .join(""),
    comments: inline.map((comment) => {
      if (comment.line == null || comment.side == null) {
        throw new Error(`invalid inline finding anchor: ${comment.file}`);
      }
      const side = comment.side === "new" ? "RIGHT" : "LEFT";
      return {
        path: comment.file!,
        side,
        body: `**${priorityLabel(comment, "P2")}**\n\n${comment.body}`,
        ...(comment.endLine != null && comment.endLine !== comment.line
          ? {
              start_line: comment.line,
              start_side: side,
              line: comment.endLine,
            }
          : { line: comment.line }),
      };
    }),
  };
}

export function validateDiffHead(
  diff: Diff,
  pullRequestHead: string,
  currentCommit: string | null,
  hasTrackedChanges: boolean,
): void {
  if (diff.head.kind === "working-tree") {
    if (hasTrackedChanges) {
      throw new Error("cannot post a working-tree diff with uncommitted tracked changes");
    }
    if (currentCommit !== pullRequestHead) {
      throw new Error("working-tree HEAD does not match the pull request head");
    }
    return;
  }
  if (diff.head.kind === "staged") {
    throw new Error("cannot post a staged diff as a pull request review");
  }
  if (diff.head.ref !== pullRequestHead) {
    throw new Error("active diff head does not match the pull request head");
  }
}

function informantPrNumber(branch: string | undefined): string | undefined {
  if (!branch?.startsWith("pull/")) return undefined;
  return branch.slice("pull/".length) || undefined;
}

async function githubEvent(
  path: string | undefined,
  supplied: GitHubEvent | undefined,
): Promise<GitHubEvent | undefined> {
  if (supplied) return supplied;
  if (!path) return undefined;
  try {
    return JSON.parse(await Bun.file(path).text()) as GitHubEvent;
  } catch (error) {
    throw new Error(`could not read GitHub event payload: ${path}`, { cause: error });
  }
}

export async function postReview(
  diff: Diff,
  options: PostReviewOptions = {},
): Promise<{ posted: boolean; findingCount: number; message: string }> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const fetch = options.fetch ?? globalThis.fetch;
  // Informant provides the repository, PR number, and expected head directly.
  // Do not also consume an inherited GITHUB_EVENT_PATH in that environment:
  // it may belong to the host workflow rather than this checkout, and parsing
  // it can fail before the complete Informant context below is even used.
  const event = await githubEvent(
    env.INFORMANT_REPOSITORY && env.INFORMANT_BRANCH ? undefined : env.GITHUB_EVENT_PATH,
    options.event,
  );
  const eventPrNumber = event?.pull_request?.number ?? event?.number;

  const repository = options.repository ?? env.INFORMANT_REPOSITORY ?? env.GITHUB_REPOSITORY;
  if (!repository) {
    throw new Error("GitHub repository is required; pass --github-repo <owner/name>");
  }
  const prNumber =
    options.pr ??
    informantPrNumber(env.INFORMANT_BRANCH) ??
    (eventPrNumber === undefined ? undefined : String(eventPrNumber));
  if (!prNumber) {
    throw new Error("GitHub pull request is required; pass --pr <number>");
  }
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GitHub token is required; set GH_TOKEN or GITHUB_TOKEN");
  }
  const apiUrl = (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const repositoryPath = repository.split("/").map(encodeURIComponent).join("/");
  const pullUrl = `${apiUrl}/repos/${repositoryPath}/pulls/${encodeURIComponent(prNumber)}`;
  const { data: pr } = await githubRequest<PullRequest>(pullUrl, token, fetch);

  const expectedHead = options.expectedHead ?? env.INFORMANT_SHA ?? event?.pull_request?.head?.sha;
  if (expectedHead && pr.head.sha !== expectedHead) {
    throw new Error("pull request head changed before the review was posted");
  }
  if (diff.base.ref !== pr.base.sha) {
    throw new Error("active diff does not match the pull request base");
  }
  if (diff.head.kind === "working-tree") {
    const [currentCommit, hasTrackedChanges] = await Promise.all([
      git.currentCommit(cwd),
      git.hasTrackedChanges(cwd),
    ]);
    validateDiffHead(diff, pr.head.sha, currentCommit, hasTrackedChanges);
  } else {
    validateDiffHead(diff, pr.head.sha, null, false);
  }

  const findings = diff.comments.filter((comment) => !comment.parentId);
  if (findings.length === 0) {
    return { posted: false, findingCount: 0, message: "Staff review found no actionable issues" };
  }
  if (findings.length > 50) {
    throw new Error("staff review produced more than 50 findings");
  }

  const marker = `<!-- staff-review:${pr.head.sha} -->`;
  const legacyMarker = `<!-- informant-staff-review:${pr.head.sha} -->`;
  let reviewsUrl: string | undefined =
    `${apiUrl}/repos/${repositoryPath}/pulls/${pr.number}/reviews?per_page=100`;
  while (reviewsUrl) {
    const { data: reviews, response } = await githubRequest<Review[]>(reviewsUrl, token, fetch);
    if (
      reviews.some((review) => review.body?.includes(marker) || review.body?.includes(legacyMarker))
    ) {
      return {
        posted: false,
        findingCount: findings.length,
        message: "Staff review already exists for this commit",
      };
    }
    reviewsUrl = nextPage(response.headers.get("link"));
  }

  const payload = reviewPayload(diff, pr.head.sha, marker);
  await githubRequest(
    `${apiUrl}/repos/${repositoryPath}/pulls/${pr.number}/reviews`,
    token,
    fetch,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  return {
    posted: true,
    findingCount: findings.length,
    message: `Posted ${findings.length} staff review finding(s)`,
  };
}
