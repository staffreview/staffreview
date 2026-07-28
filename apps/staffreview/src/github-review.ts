import * as git from "./git.ts";
import type { Comment, Diff } from "./types.ts";

type GhRunner = (args: string[], input?: string) => Promise<string>;

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
  runGh?: GhRunner;
};

async function runGhCommand(
  args: string[],
  input?: string,
  cwd = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], {
    cwd,
    env,
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input !== undefined) {
    proc.stdin!.write(input);
    proc.stdin!.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`gh ${args.join(" ")} failed (${exitCode})\n${stderr.trim()}`);
  }
  return stdout;
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
  const runGh = options.runGh ?? ((args, input) => runGhCommand(args, input, cwd, env));
  // Informant provides the repository, PR number, and expected head directly.
  // Do not also consume an inherited GITHUB_EVENT_PATH in that environment:
  // it may belong to the host workflow rather than this checkout, and parsing
  // it can fail before the complete Informant context below is even used.
  const event = await githubEvent(
    env.INFORMANT_REPOSITORY && env.INFORMANT_BRANCH ? undefined : env.GITHUB_EVENT_PATH,
    options.event,
  );
  const eventPrNumber = event?.pull_request?.number ?? event?.number;

  const repository =
    options.repository ??
    env.INFORMANT_REPOSITORY ??
    env.GITHUB_REPOSITORY ??
    (
      JSON.parse(await runGh(["repo", "view", "--json", "nameWithOwner"])) as {
        nameWithOwner: string;
      }
    ).nameWithOwner;
  const prNumber =
    options.pr ??
    informantPrNumber(env.INFORMANT_BRANCH) ??
    (eventPrNumber === undefined
      ? String(
          (JSON.parse(await runGh(["pr", "view", "--json", "number"])) as { number: number })
            .number,
        )
      : String(eventPrNumber));
  const pr = JSON.parse(
    await runGh(["api", `repos/${repository}/pulls/${prNumber}`]),
  ) as PullRequest;

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
  const pages = JSON.parse(
    await runGh([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repository}/pulls/${pr.number}/reviews?per_page=100`,
    ]),
  ) as Review[][];
  if (
    pages
      .flat()
      .some((review) => review.body?.includes(marker) || review.body?.includes(legacyMarker))
  ) {
    return {
      posted: false,
      findingCount: findings.length,
      message: "Staff review already exists for this commit",
    };
  }

  const payload = reviewPayload(diff, pr.head.sha, marker);
  await runGh(
    ["api", `repos/${repository}/pulls/${pr.number}/reviews`, "--method", "POST", "--input", "-"],
    JSON.stringify(payload),
  );
  return {
    posted: true,
    findingCount: findings.length,
    message: `Posted ${findings.length} staff review finding(s)`,
  };
}
