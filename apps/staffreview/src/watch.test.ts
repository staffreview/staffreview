import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Diff } from "./types.ts";
import {
  assertPrHeadCurrent,
  assertPrPublishable,
  assertPrReviewedBaseCurrent,
  buildReviewPrompt,
  collectPublishedMarkers,
  commentBody,
  commentsToPublish,
  findingIdentity,
  normalizeAgents,
  normalizeIntervalSeconds,
  type PullRequest,
  parseRepoFromPullRequestUrl,
  repoFetchTargetFromRemotes,
  repoFromPullRequestUrl,
  reviewCommandFailureMessage,
  reviewerSourceChanges,
  reviewLauncher,
  statusBody,
  statusCommentToUpdate,
  watchDiffSlug,
  watchHarnessCommand,
  watchHarnessFailureMessage,
} from "./watch.ts";

const pr: PullRequest = {
  number: 42,
  title: "Add the thing",
  url: "https://github.com/acme/project/pull/42",
  state: "open",
  isDraft: false,
  baseRefName: "main",
  baseRefOid: "a".repeat(40),
  headRefName: "feature",
  headRefOid: "b".repeat(40),
};

test("normalizeAgents defaults and clamps to the review agent bounds", () => {
  expect(normalizeAgents(undefined)).toBe(2);
  expect(normalizeAgents("0")).toBe(1);
  expect(normalizeAgents("999")).toBe(20);
  expect(normalizeAgents("3.7")).toBe(4);
  expect(normalizeAgents("not-a-number")).toBe(2);
});

test("normalizeIntervalSeconds defaults invalid values", () => {
  expect(normalizeIntervalSeconds(undefined)).toBe(60);
  expect(normalizeIntervalSeconds("15")).toBe(15);
  expect(normalizeIntervalSeconds("0.4")).toBe(1);
  expect(normalizeIntervalSeconds("999999999")).toBe(2_147_483);
  expect(normalizeIntervalSeconds("0")).toBe(60);
  expect(normalizeIntervalSeconds("nope")).toBe(60);
});

test("repoFetchTargetFromRemotes prefers a remote matching the resolved GitHub repo", () => {
  const repo = {
    nameWithOwner: "acme/project",
    url: "https://github.com/acme/project",
  };
  expect(
    repoFetchTargetFromRemotes(repo, [
      { name: "origin", url: "git@github.com:someone/project.git" },
      { name: "upstream", url: "https://github.com/acme/project.git" },
    ]),
  ).toBe("upstream");
  expect(
    repoFetchTargetFromRemotes(repo, [
      { name: "origin", url: "git@github.com:someone/project.git" },
    ]),
  ).toBe("https://github.com/acme/project.git");
});

test("repoFetchTargetFromRemotes keeps non-default ports when matching remotes", () => {
  const repo = {
    nameWithOwner: "org/repo",
    url: "https://ghe.example.com:8443/org/repo",
  };
  expect(
    repoFetchTargetFromRemotes(repo, [
      { name: "wrong-host", url: "https://ghe.example.com/org/repo.git" },
      { name: "enterprise", url: "https://ghe.example.com:8443/org/repo.git" },
    ]),
  ).toBe("enterprise");
  expect(
    repoFetchTargetFromRemotes(repo, [
      { name: "wrong-host", url: "https://ghe.example.com/org/repo.git" },
    ]),
  ).toBe("https://ghe.example.com:8443/org/repo.git");
});

test("repoFromPullRequestUrl carries the PR URL repository when one is present", () => {
  const fallback = {
    nameWithOwner: "acme/project",
    url: "https://github.com/acme/project",
  };
  expect(parseRepoFromPullRequestUrl("https://github.com/other/repo/pull/5")).toEqual({
    nameWithOwner: "other/repo",
    url: "https://github.com/other/repo",
  });
  expect(repoFromPullRequestUrl("https://github.com/other/repo/pull/5", fallback)).toEqual({
    nameWithOwner: "other/repo",
    url: "https://github.com/other/repo",
  });
  expect(parseRepoFromPullRequestUrl("not-a-pr-url")).toBeUndefined();
  expect(repoFromPullRequestUrl("not-a-pr-url", fallback)).toEqual(fallback);
});

test("watchDiffSlug isolates PRs that share the same commits", () => {
  const repo = {
    nameWithOwner: "acme/project",
    url: "https://github.com/acme/project",
  };
  const baseSha = "e".repeat(40);
  const first = watchDiffSlug(repo, pr, baseSha, pr.headRefOid);
  const second = watchDiffSlug(repo, { ...pr, number: 43 }, baseSha, pr.headRefOid);

  expect(first).toContain(`${baseSha}..${pr.headRefOid}`);
  expect(first).not.toBe(second);
  expect(second).toContain("watch-acme_project-pr-43-");
});

test("reviewerSourceChanges reports non-staffreview source drift", () => {
  const before = {
    statusLines: [" M apps/staffreview/src/watch.ts"],
    stagedDiffHash: "staged-before",
    worktreeDiffHash: "worktree-before",
    untrackedFileHashes: {},
  };
  expect(reviewerSourceChanges(before, { ...before })).toEqual([]);
  expect(
    reviewerSourceChanges(before, {
      ...before,
      worktreeDiffHash: "worktree-after",
    }),
  ).toEqual(["apps/staffreview/src/watch.ts"]);
  expect(
    reviewerSourceChanges(before, {
      ...before,
      statusLines: [...before.statusLines, " M .staffreview/diffs/example.json"],
      worktreeDiffHash: "worktree-after",
    }),
  ).toEqual(["apps/staffreview/src/watch.ts"]);
  expect(
    reviewerSourceChanges(before, {
      ...before,
      statusLines: [...before.statusLines, "?? src/new-file.ts"],
      untrackedFileHashes: { "src/new-file.ts": "hash" },
    }),
  ).toEqual(["apps/staffreview/src/watch.ts", "src/new-file.ts"]);
});

test("reviewCommandFailureMessage does not include configured command text", () => {
  const command = "secret-token=abc123 codex exec --profile prod -";
  const message = reviewCommandFailureMessage(command, 17);
  expect(message).toBe("configured review command failed with exit code 17");
  expect(message).not.toContain(command);
  expect(reviewCommandFailureMessage(undefined, 2)).toBe(
    "codex exec --cd <repo> - failed with exit code 2",
  );
});

test("reviewLauncher prefers explicit and env review commands over the TUI harness", () => {
  const launcher = reviewLauncher({
    command: "secret-token=abc123 codex exec -",
    envCommand: "ignored",
    harness: { command: "claude", args: ["--model", "sonnet"] },
    cwd: "/repo",
    prompt: "Run /staff-review slug 2.",
  });

  expect(launcher.stdin).toBe("pipe");
  expect(launcher.promptStdin).toBe("Run /staff-review slug 2.");
  expect(launcher.failureLabel).toBe("configured review command");
  expect(launcher.argv).toContain("secret-token=abc123 codex exec -");
});

test("reviewLauncher runs configured watch harness as TUI argv", () => {
  const launcher = reviewLauncher({
    harness: { command: "claude", args: ["--model", "sonnet"] },
    cwd: "/repo",
    prompt: "Run /staff-review slug 2.",
  });

  expect(launcher).toEqual({
    argv: ["claude", "--model", "sonnet", "Run /staff-review slug 2."],
    stdin: "inherit",
    failureLabel: "configured watch harness",
  });
});

test("reviewLauncher falls back to codex exec stdin when no harness is configured", () => {
  const launcher = reviewLauncher({
    cwd: "/repo",
    prompt: "Run /staff-review slug 2.",
  });

  expect(launcher).toEqual({
    argv: ["codex", "exec", "--cd", "/repo", "-"],
    stdin: "pipe",
    promptStdin: "Run /staff-review slug 2.",
    failureLabel: "codex exec --cd <repo> -",
  });
});

test("watchHarnessCommand appends the review prompt after configured harness flags", () => {
  expect(
    watchHarnessCommand(
      { command: "claude", args: ["--dangerously-skip-permissions", "--model", "sonnet"] },
      "Run /staff-review slug 2.",
    ),
  ).toEqual([
    "claude",
    "--dangerously-skip-permissions",
    "--model",
    "sonnet",
    "Run /staff-review slug 2.",
  ]);
});

test("watchHarnessFailureMessage does not include configured harness args", () => {
  expect(watchHarnessFailureMessage(9)).toBe("configured watch harness failed with exit code 9");
});

test("statusBody includes the stable status marker and current commit", () => {
  const body = statusBody({
    pr,
    headSha: pr.headRefOid,
    state: "reviewing",
    details: "Running with 2 agents.",
  });
  expect(body).toContain("<!-- staff-watch-status -->");
  expect(body).toContain("Review in progress");
  expect(body).toContain("bbbbbbbbbbbb");
  expect(body).toContain("Running with 2 agents.");
});

test("buildReviewPrompt targets the Staff Review skill without asking for code changes", () => {
  const prompt = buildReviewPrompt(pr, "main..feature", 6);
  expect(prompt).toContain("/staff-review main..feature 6");
  expect(prompt).toContain("GitHub PR #42");
  expect(prompt).toContain("Do not modify code");
  expect(prompt).toContain("mirror any findings");
});

test("commentsToPublish retries unpublished root comments until GitHub markers exist", () => {
  const diff: Diff = {
    slug: "a..b",
    base: { kind: "commit", ref: pr.baseRefOid },
    head: { kind: "commit", ref: pr.headRefOid },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    comments: [
      {
        id: "old",
        threadId: "old-thread",
        body: "old",
        author: "agent",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "root",
        threadId: "thread",
        file: "src/a.ts",
        line: 12,
        body: "finding",
        author: "agent",
        priority: "P2",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "reply",
        threadId: "thread",
        parentId: "root",
        body: "reply",
        author: "agent",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "resolved-root",
        threadId: "resolved-thread",
        body: "already resolved",
        author: "agent",
        createdAt: "2026-01-01T00:00:00.000Z",
        resolution: {
          status: "skipped",
          body: "False positive.",
          author: "GPT-5",
          at: "2026-01-01T00:00:00.000Z",
        },
      },
    ],
  };

  const first = commentsToPublish({
    diff,
    existingMarkers: new Set(),
    repo: "acme/project",
    pr,
    headSha: pr.headRefOid,
  });
  expect(first.map(({ comment }) => comment.id)).toEqual(["root"]);
  expect(first.map(({ comment }) => comment.id)).not.toContain("resolved-root");
  expect(commentBody(first[0]!.comment, first[0]!.marker)).toContain("Priority: P2");

  const second = commentsToPublish({
    diff,
    existingMarkers: new Set([first[0]!.marker]),
    repo: "acme/project",
    pr,
    headSha: pr.headRefOid,
  });
  expect(second).toHaveLength(0);

  const third = commentsToPublish({
    diff,
    existingMarkers: new Set(first.map(({ marker }) => marker)),
    repo: "acme/project",
    pr,
    headSha: pr.headRefOid,
  });
  expect(third).toHaveLength(0);
});

test("commentsToPublish deduplicates equivalent local findings in the same batch", () => {
  const firstComment = {
    id: "duplicate-root-1",
    threadId: "duplicate-thread-1",
    file: "src/a.ts",
    line: 12,
    side: "new" as const,
    body: "same finding",
    author: "agent",
    priority: "P2" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const diff: Diff = {
    slug: "a..b",
    base: { kind: "commit", ref: pr.baseRefOid },
    head: { kind: "commit", ref: pr.headRefOid },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    comments: [
      firstComment,
      {
        ...firstComment,
        id: "duplicate-root-2",
        threadId: "duplicate-thread-2",
      },
    ],
  };

  const publishable = commentsToPublish({
    diff,
    existingMarkers: new Set(),
    repo: "acme/project",
    pr,
    headSha: pr.headRefOid,
  });

  expect(publishable.map(({ comment }) => comment.id)).toEqual(["duplicate-root-1"]);
});

test("commentsToPublish uses deterministic finding markers across local thread ids", () => {
  const baseComment = {
    id: "root",
    threadId: "local-thread-1",
    file: "src/a.ts",
    line: 12,
    side: "new" as const,
    body: "finding\r\nwith whitespace\n",
    author: "agent",
    priority: "P2" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const diff: Diff = {
    slug: "a..b",
    base: { kind: "commit", ref: pr.baseRefOid },
    head: { kind: "commit", ref: pr.headRefOid },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    comments: [baseComment],
  };

  const first = commentsToPublish({
    diff,
    existingMarkers: new Set(),
    repo: "acme/project",
    pr,
    headSha: pr.headRefOid,
  });
  expect(first).toHaveLength(1);
  expect(first[0]!.marker).not.toContain(baseComment.threadId);

  const retryDiff: Diff = {
    ...diff,
    comments: [{ ...baseComment, id: "retry-root", threadId: "local-thread-2" }],
  };
  const retry = commentsToPublish({
    diff: retryDiff,
    existingMarkers: new Set([first[0]!.marker]),
    repo: "acme/project",
    pr,
    headSha: pr.headRefOid,
  });
  expect(retry).toHaveLength(0);
  expect(findingIdentity(baseComment)).toBe(
    findingIdentity({ ...baseComment, id: "retry-root", threadId: "local-thread-2" }),
  );
});

test("assertPrHeadCurrent rejects stale review findings before publishing", () => {
  expect(() => assertPrHeadCurrent(pr, pr.headRefOid, pr.headRefOid)).not.toThrow();
  expect(() => assertPrHeadCurrent(pr, pr.headRefOid, "c".repeat(40))).toThrow(
    "PR #42 head changed during review",
  );
  expect(() =>
    assertPrPublishable(pr, pr.headRefOid, {
      headSha: pr.headRefOid,
      baseSha: pr.baseRefOid,
      baseRefName: pr.baseRefName,
      state: "open",
      isDraft: false,
    }),
  ).not.toThrow();
  expect(() =>
    assertPrPublishable(pr, pr.headRefOid, {
      headSha: pr.headRefOid,
      baseSha: pr.baseRefOid,
      baseRefName: pr.baseRefName,
      state: "closed",
      isDraft: false,
    }),
  ).toThrow("PR #42 is closed");
  expect(() =>
    assertPrPublishable(pr, pr.headRefOid, {
      headSha: pr.headRefOid,
      baseSha: pr.baseRefOid,
      baseRefName: pr.baseRefName,
      state: "open",
      isDraft: true,
    }),
  ).toThrow("PR #42 is draft");
  expect(() => assertPrReviewedBaseCurrent(pr, pr.baseRefOid, pr.baseRefOid)).not.toThrow();
  expect(() => assertPrReviewedBaseCurrent(pr, pr.baseRefOid, "d".repeat(40))).toThrow(
    "PR #42 merge base changed during review",
  );
});

test("statusCommentToUpdate ignores status markers from other authors", () => {
  const existing = statusCommentToUpdate(
    [
      {
        id: 1,
        body: "looks official\n\n<!-- staff-watch-status -->",
        user: { login: "contributor" },
      },
      {
        id: 2,
        body: "ordinary comment",
        user: { login: "staff-bot" },
      },
      {
        id: 3,
        body: "<!-- staff-watch-status -->\n### Staff Review",
        user: { login: "staff-bot" },
      },
    ],
    "staff-bot",
  );
  expect(existing?.id).toBe(3);

  const missing = statusCommentToUpdate(
    [{ id: 4, body: "<!-- staff-watch-status -->", user: { login: "contributor" } }],
    "staff-bot",
  );
  expect(missing).toBeUndefined();
});

test("collectPublishedMarkers ignores finding markers from other authors", () => {
  const trusted = `<!-- staff-watch-comment: acme/project#42:${"b".repeat(40)}:${"a".repeat(24)} -->`;
  const forged = `<!-- staff-watch-comment: acme/project#42:${"b".repeat(40)}:${"f".repeat(24)} -->`;
  const anonymous = `<!-- staff-watch-comment: acme/project#42:${"b".repeat(40)}:${"1".repeat(24)} -->`;
  const markers = collectPublishedMarkers(
    [
      { body: forged, user: { login: "contributor" } },
      { body: trusted, user: { login: "staff-bot" } },
      { body: anonymous },
    ],
    "staff-bot",
  );

  expect([...markers]).toEqual([trusted]);
});

test("collectPublishedMarkers skips malformed marker prefixes before valid markers", () => {
  const trusted = `<!-- staff-watch-comment: acme/project#42:${"b".repeat(40)}:${"a".repeat(24)} -->`;
  const markers = collectPublishedMarkers(
    [
      {
        body: [
          "quoted malformed prefix: <!-- staff-watch-comment: not a marker",
          trusted,
          "<!-- staff-watch-comment: malformed -->",
        ].join("\n"),
        user: { login: "staff-bot" },
      },
    ],
    "staff-bot",
  );

  expect([...markers]).toEqual([trusted]);
});

test("staff watch CLI dispatches --all --once flags and review command environment", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "staffreview-watch-cli-"));
  try {
    const mergeBaseOid = "e".repeat(40);
    const repo = join(tmp, "repo");
    const bin = join(tmp, "bin");
    const capture = join(tmp, "review-capture.txt");
    const commandLog = join(tmp, "commands.log");
    const config = join(tmp, "config");
    const parentGhConfig = join(tmp, "parent-gh-config");
    mkdirSync(repo, { recursive: true });
    mkdirSync(bin, { recursive: true });

    const fakeGit = join(bin, "git");
    await Bun.write(
      fakeGit,
      `#!/bin/sh
if [ -n "$STAFF_WATCH_COMMAND_LOG" ]; then echo "git:$*" >> "$STAFF_WATCH_COMMAND_LOG"; fi
if [ "$1" = "rev-parse" ] && [ "$2" = "--is-inside-work-tree" ]; then echo true; exit 0; fi
if [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then pwd; exit 0; fi
if [ "$1" = "rev-parse" ] && [ "$2" = "FETCH_HEAD" ]; then echo "${pr.headRefOid}"; exit 0; fi
if [ "$1" = "rev-parse" ] && [ "$2" = "--verify" ]; then echo "${pr.baseRefOid}"; exit 0; fi
if [ "$1" = "status" ]; then
  if [ -f source-edit.ts ]; then echo "?? source-edit.ts"; fi
  exit 0
fi
if [ "$1" = "diff" ]; then
  if [ -f source-edit.ts ]; then echo "diff --git a/source-edit.ts b/source-edit.ts"; fi
  exit 0
fi
if [ "$1" = "merge-base" ]; then echo "${mergeBaseOid}"; exit 0; fi
if [ "$1" = "remote" ]; then exit 0; fi
if [ "$1" = "fetch" ]; then exit 0; fi
echo "unexpected git command: $*" >&2
exit 1
`,
    );
    chmodSync(fakeGit, 0o755);

    const fakeGh = join(bin, "gh");
    await Bun.write(
      fakeGh,
      `#!/bin/sh
if [ -n "$STAFF_WATCH_COMMAND_LOG" ]; then echo "gh:$*" >> "$STAFF_WATCH_COMMAND_LOG"; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi
if [ "$1" = "repo" ] && [ "$2" = "view" ]; then
  echo '{"nameWithOwner":"acme/project","url":"https://github.com/acme/project"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  if [ "$3" = "closed" ]; then
    echo '{"number":7,"title":"Closed thing","url":"https://github.com/acme/project/pull/7","state":"CLOSED","isDraft":false,"baseRefName":"main","baseRefOid":"${pr.baseRefOid}","headRefName":"feature","headRefOid":"${pr.headRefOid}"}'
    exit 0
  fi
  if [ "$3" = "https://ghe.example.com:8443/org/repo/pull/9" ]; then
    echo '{"number":9,"title":"Enterprise thing","url":"https://ghe.example.com:8443/org/repo/pull/9","state":"OPEN","isDraft":false,"baseRefName":"main","baseRefOid":"${"d".repeat(40)}","headRefName":"feature","headRefOid":"${pr.headRefOid}"}'
    exit 0
  fi
  echo '{"number":5,"title":"Cross repo thing","url":"https://github.com/other/repo/pull/5","state":"OPEN","isDraft":false,"baseRefName":"main","baseRefOid":"${"c".repeat(40)}","headRefName":"feature","headRefOid":"${pr.headRefOid}"}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "--hostname" ] && [ "$3" = "github.com" ]; then
  shift 3
  set -- api "$@"
fi
if [ "$1" = "api" ] && [ "$2" = "user" ]; then
  echo '{"login":"staff-bot"}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "--hostname" ] && [ "$3" = "ghe.example.com:8443" ] && [ "$4" = "user" ]; then
  echo '{"login":"staff-bot"}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/project/pulls/42" ]; then
  echo '{"number":42,"title":"Add the thing","html_url":"https://github.com/acme/project/pull/42","state":"open","draft":false,"base":{"ref":"main","sha":"${pr.baseRefOid}"},"head":{"ref":"feature","sha":"${pr.headRefOid}"}}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/project/pulls/43" ]; then
  echo '{"number":43,"title":"Add another thing","html_url":"https://github.com/acme/project/pull/43","state":"open","draft":false,"base":{"ref":"main","sha":"${pr.baseRefOid}"},"head":{"ref":"feature","sha":"${pr.headRefOid}"}}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/other/repo/pulls/5" ]; then
  echo '{"number":5,"title":"Cross repo thing","html_url":"https://github.com/other/repo/pull/5","state":"open","draft":false,"base":{"ref":"main","sha":"${"c".repeat(40)}"},"head":{"ref":"feature","sha":"${pr.headRefOid}"}}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "--hostname" ] && [ "$3" = "ghe.example.com:8443" ] && [ "$4" = "repos/org/repo/pulls/9" ]; then
  echo '{"number":9,"title":"Enterprise thing","html_url":"https://ghe.example.com:8443/org/repo/pull/9","state":"open","draft":false,"base":{"ref":"main","sha":"${"d".repeat(40)}"},"head":{"ref":"feature","sha":"${pr.headRefOid}"}}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "--paginate" ] && [ "$3" = "--slurp" ] && [ "$4" = "repos/acme/project/pulls?state=open&per_page=100" ]; then
  echo '[[{"number":42,"title":"Add the thing","html_url":"https://github.com/acme/project/pull/42","state":"open","draft":false,"base":{"ref":"main","sha":"${pr.baseRefOid}"},"head":{"ref":"feature","sha":"${pr.headRefOid}"}}],[{"number":43,"title":"Add another thing","html_url":"https://github.com/acme/project/pull/43","state":"open","draft":false,"base":{"ref":"main","sha":"${pr.baseRefOid}"},"head":{"ref":"feature","sha":"${pr.headRefOid}"}}]]'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "--paginate" ] && [ "$3" = "--slurp" ]; then
  echo '[[]]'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "--hostname" ] && [ "$3" = "ghe.example.com:8443" ] && [ "$4" = "--paginate" ] && [ "$5" = "--slurp" ]; then
  echo '[[]]'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/project/issues/42/comments" ]; then exit 0; fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/project/pulls/42/comments" ]; then exit 0; fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/project/issues/43/comments" ]; then exit 0; fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/project/pulls/43/comments" ]; then exit 0; fi
if [ "$1" = "api" ] && [ "$2" = "repos/other/repo/issues/5/comments" ]; then exit 0; fi
if [ "$1" = "api" ] && [ "$2" = "--hostname" ] && [ "$3" = "ghe.example.com:8443" ] && [ "$4" = "repos/org/repo/issues/9/comments" ]; then exit 0; fi
echo "unexpected gh command: $*" >&2
exit 1
`,
    );
    chmodSync(fakeGh, 0o755);

    const reviewCommand = join(bin, "capture-review");
    await Bun.write(
      reviewCommand,
      `#!${process.execPath}
const input = await Bun.stdin.text();
const capture = process.env.STAFF_WATCH_CAPTURE;
const slug = process.env.STAFF_WATCH_DIFF_SLUG;
const existingCapture = await Bun.file(capture).exists() ? await Bun.file(capture).text() : "";
await Bun.write(
  capture,
  existingCapture + [
    "PROMPT_START",
    input,
    "PROMPT_END",
    "PR=" + process.env.STAFF_WATCH_PR_NUMBER,
    "URL=" + process.env.STAFF_WATCH_PR_URL,
    "SLUG=" + slug,
    "AGENTS=" + process.env.STAFF_WATCH_AGENTS,
    "TOKENS=" + ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].filter((key) => process.env[key]).join(","),
    "GH_CONFIG_DIR=" + process.env.GH_CONFIG_DIR,
    "GH_PROMPT_DISABLED=" + process.env.GH_PROMPT_DISABLED,
    "",
  ].join("\\n"),
);
if (process.env.STAFF_WATCH_MUTATE_SOURCE === "1") {
  await Bun.write(process.cwd() + "/source-edit.ts", "reviewer changed source\\n");
}
if ((process.env.STAFF_WATCH_PR_NUMBER === "42" || process.env.STAFF_WATCH_PR_NUMBER === "43") && slug) {
  const path = process.cwd() + "/.staffreview/diffs/" + slug + ".json";
  const diff = JSON.parse(await Bun.file(path).text());
  const prNumber = process.env.STAFF_WATCH_PR_NUMBER;
  diff.comments.push({
    id: "review-root-" + prNumber,
    threadId: "review-thread-" + prNumber,
    file: "src/feature.ts",
    line: 12,
    side: "new",
    body: "mirrored finding " + prNumber,
    author: "GPT-5",
    priority: "P2",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  if (prNumber === "42") {
    diff.comments.push(
      {
        id: "review-old-root",
        threadId: "review-old-thread",
        file: "src/feature.ts",
        line: 8,
        side: "old",
        body: "mirrored old-side finding",
        author: "GPT-5",
        priority: "P3",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "review-range-root",
        threadId: "review-range-thread",
        file: "src/feature.ts",
        line: 12,
        endLine: 14,
        side: "new",
        body: "mirrored range finding",
        author: "GPT-5",
        priority: "P2",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    );
  }
  await Bun.write(path, JSON.stringify(diff, null, 2));
}
`,
    );
    chmodSync(reviewCommand, 0o755);

    const fakeCodex = join(bin, "codex");
    await Bun.write(
      fakeCodex,
      `#!${process.execPath}
const input = await Bun.stdin.text();
const log = process.env.STAFF_WATCH_COMMAND_LOG;
if (log) {
  const existing = await Bun.file(log).exists() ? await Bun.file(log).text() : "";
  const tokens = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].filter((key) => process.env[key]).join(",");
  await Bun.write(log, existing + "codex:" + process.argv.slice(2).join(" ") + "\\nTOKENS=" + tokens + "\\nGH_CONFIG_DIR=" + process.env.GH_CONFIG_DIR + "\\nGH_PROMPT_DISABLED=" + process.env.GH_PROMPT_DISABLED + "\\n" + input + "\\n");
}
`,
    );
    chmodSync(fakeCodex, 0o755);

    const fakeHarness = join(bin, "capture-harness");
    await Bun.write(
      fakeHarness,
      `#!${process.execPath}
const capture = process.env.STAFF_WATCH_CAPTURE;
const log = process.env.STAFF_WATCH_COMMAND_LOG;
const prompt = process.argv.at(-1) ?? "";
const args = process.argv.slice(2, -1);
if (log) {
  const existing = await Bun.file(log).exists() ? await Bun.file(log).text() : "";
  await Bun.write(log, existing + "harness:" + args.join(" ") + "\\n");
}
const existingCapture = await Bun.file(capture).exists() ? await Bun.file(capture).text() : "";
await Bun.write(
  capture,
  existingCapture + [
    "HARNESS_ARGS=" + args.join("|"),
    "PROMPT_ARG_START",
    prompt,
    "PROMPT_ARG_END",
    "PR=" + process.env.STAFF_WATCH_PR_NUMBER,
    "URL=" + process.env.STAFF_WATCH_PR_URL,
    "SLUG=" + process.env.STAFF_WATCH_DIFF_SLUG,
    "AGENTS=" + process.env.STAFF_WATCH_AGENTS,
    "TOKENS=" + ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].filter((key) => process.env[key]).join(","),
    "GH_CONFIG_DIR=" + process.env.GH_CONFIG_DIR,
    "GH_PROMPT_DISABLED=" + process.env.GH_PROMPT_DISABLED,
    "",
  ].join("\\n"),
);
`,
    );
    chmodSync(fakeHarness, 0o755);

    const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
    const cliEnv = () => {
      const env = { ...process.env };
      delete env.STAFF_WATCH_REVIEW_COMMAND;
      return env;
    };
    const runCli = async (args: string[], envOverride: Record<string, string> = {}) => {
      const proc = Bun.spawn([process.execPath, cliPath, ...args], {
        cwd: dirname(cliPath),
        env: {
          ...cliEnv(),
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          STAFF_CONFIG_DIR: config,
          STAFF_WATCH_CAPTURE: capture,
          STAFF_WATCH_COMMAND_LOG: commandLog,
          GH_HOST: "ghe.example.com",
          GH_TOKEN: "parent-gh-token",
          GITHUB_TOKEN: "parent-github-token",
          GH_ENTERPRISE_TOKEN: "parent-gh-enterprise-token",
          GITHUB_ENTERPRISE_TOKEN: "parent-github-enterprise-token",
          GH_CONFIG_DIR: parentGhConfig,
          ...envOverride,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdoutPromise = new Response(proc.stdout).text();
      const stderrPromise = new Response(proc.stderr).text();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const exitCode = await Promise.race([
        proc.exited,
        new Promise<number>((_, reject) => {
          timeout = setTimeout(() => {
            proc.kill();
            reject(new Error("staff watch CLI test timed out"));
          }, 5_000);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

      expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    };
    const runCliFailure = async (args: string[], envOverride: Record<string, string> = {}) => {
      const proc = Bun.spawn([process.execPath, cliPath, ...args], {
        cwd: dirname(cliPath),
        env: {
          ...cliEnv(),
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          STAFF_CONFIG_DIR: config,
          STAFF_WATCH_CAPTURE: capture,
          STAFF_WATCH_COMMAND_LOG: commandLog,
          GH_CONFIG_DIR: parentGhConfig,
          ...envOverride,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode, `${stdout}\n${stderr}`).not.toBe(0);
      return { stdout, stderr };
    };

    const missingReviewCommand = await runCliFailure([
      "watch",
      "--all",
      "--once",
      "--review-command",
      "--repo",
      repo,
    ]);
    expect(missingReviewCommand.stderr).toContain("pass a value for --review-command");

    const missingTarget = await runCliFailure(["watch", "--once", "--repo", repo]);
    expect(missingTarget.stderr).toContain("pass a PR ref or use --all");

    const missingInterval = await runCliFailure([
      "watch",
      "--all",
      "--once",
      "--interval",
      "--repo",
      repo,
    ]);
    expect(missingInterval.stderr).toContain("pass a value for --interval");

    const missingAgents = await runCliFailure([
      "watch",
      "--all",
      "--once",
      "--agents=",
      "--repo",
      repo,
    ]);
    expect(missingAgents.stderr).toContain("pass a value for --agents");

    await runCli([
      "watch",
      "--all",
      "--once",
      "--interval",
      "0.4",
      "--agents",
      "3",
      "--review-command",
      reviewCommand,
      "--repo",
      repo,
    ]);
    const captured = await Bun.file(capture).text();
    const pr42Slug = watchDiffSlug(
      { nameWithOwner: "acme/project", url: "https://github.com/acme/project" },
      pr,
      mergeBaseOid,
      pr.headRefOid,
    );
    const pr43Slug = watchDiffSlug(
      { nameWithOwner: "acme/project", url: "https://github.com/acme/project" },
      { ...pr, number: 43 },
      mergeBaseOid,
      pr.headRefOid,
    );
    expect(captured).toContain("Run /staff-review");
    expect(captured).toContain(`Run /staff-review ${pr42Slug} 3.`);
    expect(captured).toContain(`Run /staff-review ${pr43Slug} 3.`);
    expect(captured).toContain("This is GitHub PR #42: Add the thing");
    expect(captured).toContain("This is GitHub PR #43: Add another thing");
    expect(captured).toContain("PR=42");
    expect(captured).toContain("PR=43");
    expect(captured).toContain("URL=https://github.com/acme/project/pull/42");
    expect(captured).toContain("URL=https://github.com/acme/project/pull/43");
    expect(captured).toContain("AGENTS=3");
    expect(captured).not.toContain("parent-gh-token");
    expect(captured).not.toContain("parent-github-token");
    expect(captured).not.toContain("parent-gh-enterprise-token");
    expect(captured).not.toContain("parent-github-enterprise-token");
    expect(captured).not.toContain("GH_TOKEN");
    expect(captured).not.toContain("GITHUB_TOKEN");
    expect(captured).not.toContain("GH_ENTERPRISE_TOKEN");
    expect(captured).not.toContain("GITHUB_ENTERPRISE_TOKEN");
    expect(captured).toContain("GH_PROMPT_DISABLED=1");
    expect(captured).not.toContain(`GH_CONFIG_DIR=${parentGhConfig}`);
    const watchedDiff42 = JSON.parse(
      await Bun.file(join(repo, ".staffreview/diffs", `${pr42Slug}.json`)).text(),
    ) as Diff;
    const watchedDiff43 = JSON.parse(
      await Bun.file(join(repo, ".staffreview/diffs", `${pr43Slug}.json`)).text(),
    ) as Diff;
    expect(watchedDiff42.base).toEqual({ kind: "commit", ref: mergeBaseOid });
    expect(watchedDiff42.base.label).toBeUndefined();
    expect(watchedDiff42.comments.map((comment) => comment.body)).toContain("mirrored finding 42");
    expect(watchedDiff43.base).toEqual({ kind: "commit", ref: mergeBaseOid });
    expect(watchedDiff43.comments.map((comment) => comment.body)).toEqual(["mirrored finding 43"]);
    const allCommands = await Bun.file(commandLog).text();
    expect(allCommands).toContain(`git:merge-base ${pr.baseRefOid} ${pr.headRefOid}`);
    expect(allCommands).toContain(
      "gh:api --hostname github.com --paginate --slurp repos/acme/project/pulls?state=open&per_page=100",
    );
    expect(allCommands).toContain(
      "gh:api --hostname github.com repos/acme/project/pulls/42/comments -X POST",
    );
    expect(allCommands).toContain(
      "gh:api --hostname github.com repos/acme/project/pulls/43/comments -X POST",
    );
    expect(allCommands).toContain(
      "gh:api --hostname github.com repos/acme/project/issues/43/comments -X POST",
    );
    expect(allCommands).toContain(`commit_id=${pr.headRefOid}`);
    expect(allCommands).toContain("path=src/feature.ts");
    expect(allCommands).toContain("line=12");
    expect(allCommands).toContain("mirrored finding 42");
    expect(allCommands).toContain("mirrored finding 43");
    expect(allCommands).toContain("mirrored old-side finding");
    expect(allCommands).toContain("side=LEFT");
    expect(allCommands).toContain("mirrored range finding");
    expect(allCommands).toContain("line=14");
    expect(allCommands).toContain("start_line=12");
    expect(allCommands).toContain("start_side=RIGHT");
    expect(allCommands).toContain("<!-- staff-watch-comment: acme/project#42:");
    expect(allCommands).toContain("<!-- staff-watch-comment: acme/project#43:");
    const pr43CommentPosts =
      allCommands.match(
        /gh:api --hostname github\.com repos\/acme\/project\/pulls\/43\/comments -X POST[\s\S]*?(?=\ngh:|\ngit:|$)/g,
      ) ?? [];
    expect(pr43CommentPosts.join("\n")).toContain("mirrored finding 43");
    expect(pr43CommentPosts.join("\n")).not.toContain("mirrored finding 42");
    expect(
      allCommands.match(
        /gh:api --hostname github\.com --paginate --slurp repos\/acme\/project\/pulls\/42\/comments\?per_page=100/g,
      ) ?? [],
    ).toHaveLength(1);
    expect(
      allCommands.match(
        /gh:api --hostname github\.com --paginate --slurp repos\/acme\/project\/issues\/42\/comments\?per_page=100/g,
      ) ?? [],
    ).toHaveLength(3);

    await Bun.write(commandLog, "");
    await runCli([
      "watch",
      "https://github.com/other/repo/pull/5",
      "--once",
      "--agents",
      "3",
      "--review-command",
      reviewCommand,
      "--repo",
      repo,
    ]);
    const commands = await Bun.file(commandLog).text();
    expect(commands).not.toContain("gh:repo view");
    expect(commands).toContain("git:fetch -q https://github.com/other/repo.git pull/5/head");
    expect(commands).toContain(
      "gh:api --hostname github.com repos/other/repo/issues/5/comments -X POST",
    );

    await Bun.write(commandLog, "");
    await runCli([
      "watch",
      "https://ghe.example.com:8443/org/repo/pull/9",
      "--once",
      "--agents",
      "3",
      "--review-command",
      reviewCommand,
      "--repo",
      repo,
    ]);
    const enterpriseCommands = await Bun.file(commandLog).text();
    expect(enterpriseCommands).not.toContain("gh:repo view");
    expect(enterpriseCommands).not.toContain("gh:auth status");
    expect(enterpriseCommands).toContain(
      "git:fetch -q https://ghe.example.com:8443/org/repo.git pull/9/head",
    );
    expect(enterpriseCommands).toContain("gh:api --hostname ghe.example.com:8443 user");
    expect(enterpriseCommands).toContain(
      "gh:api --hostname ghe.example.com:8443 repos/org/repo/pulls/9",
    );
    expect(enterpriseCommands).toContain(
      "gh:api --hostname ghe.example.com:8443 repos/org/repo/issues/9/comments -X POST",
    );

    await Bun.write(commandLog, "");
    await runCli(["watch", "closed", "--once", "--review-command", reviewCommand, "--repo", repo]);
    const closedCommands = await Bun.file(commandLog).text();
    expect(closedCommands).toContain("gh:pr view closed --json");
    expect(closedCommands).not.toContain("git:fetch");
    expect(closedCommands).not.toContain(
      "api --hostname github.com repos/acme/project/issues/7/comments",
    );

    await Bun.write(commandLog, "");
    await runCli(["watch", "closed", "--once", "--repo", repo]);
    const codexCommands = await Bun.file(commandLog).text();
    expect(codexCommands).not.toContain("codex:");

    await Bun.write(commandLog, "");
    await runCli(["watch", "https://github.com/other/repo/pull/5", "--once", "--repo", repo]);
    const defaultCommands = await Bun.file(commandLog).text();
    expect(defaultCommands).toContain(`codex:exec --cd ${realpathSync(repo)} -`);
    expect(defaultCommands).not.toContain("GH_TOKEN");
    expect(defaultCommands).not.toContain("GITHUB_TOKEN");
    expect(defaultCommands).not.toContain("GH_ENTERPRISE_TOKEN");
    expect(defaultCommands).not.toContain("GITHUB_ENTERPRISE_TOKEN");
    expect(defaultCommands).toContain("GH_PROMPT_DISABLED=1");
    expect(defaultCommands).not.toContain(`GH_CONFIG_DIR=${parentGhConfig}`);
    expect(defaultCommands).toContain("Run /staff-review");
    expect(defaultCommands).toContain("This is GitHub PR #5: Cross repo thing");

    await Bun.write(capture, "");
    await Bun.write(commandLog, "");
    await runCli([
      "settings",
      "set",
      "watchHarness",
      "capture-harness",
      "--help",
      "--repo",
      "not-a-repo",
    ]);
    const collisionHarness = JSON.parse(await Bun.file(join(config, "settings.json")).text());
    expect(collisionHarness.watchHarness).toEqual({
      command: "capture-harness",
      args: ["--help", "--repo", "not-a-repo"],
    });

    await Bun.write(capture, "");
    await Bun.write(commandLog, "");
    await runCli([
      "settings",
      "set",
      "watchHarness",
      "capture-harness",
      "--subscription",
      "--model",
      "sonnet",
    ]);
    const configuredHarness = JSON.parse(await Bun.file(join(config, "settings.json")).text());
    expect(configuredHarness.watchHarness).toEqual({
      command: "capture-harness",
      args: ["--subscription", "--model", "sonnet"],
    });

    await runCli(["watch", "https://github.com/other/repo/pull/5", "--once", "--repo", repo]);
    const harnessCapture = await Bun.file(capture).text();
    expect(harnessCapture).toContain("HARNESS_ARGS=--subscription|--model|sonnet");
    expect(harnessCapture).toContain("PROMPT_ARG_START");
    expect(harnessCapture).toContain("Run /staff-review");
    expect(harnessCapture).toContain("This is GitHub PR #5: Cross repo thing");
    expect(harnessCapture).toContain("PR=5");
    expect(harnessCapture).toContain("URL=https://github.com/other/repo/pull/5");
    expect(harnessCapture).toContain("AGENTS=2");
    expect(harnessCapture).not.toContain("parent-gh-token");
    expect(harnessCapture).not.toContain("parent-github-token");
    expect(harnessCapture).not.toContain("parent-gh-enterprise-token");
    expect(harnessCapture).not.toContain("parent-github-enterprise-token");
    expect(harnessCapture).toContain("GH_PROMPT_DISABLED=1");
    expect(harnessCapture).not.toContain(`GH_CONFIG_DIR=${parentGhConfig}`);
    const harnessCommands = await Bun.file(commandLog).text();
    expect(harnessCommands).toContain("harness:--subscription --model sonnet");
    expect(harnessCommands).not.toContain("codex:");

    await Bun.write(capture, "");
    await Bun.write(commandLog, "");
    await runCli(["watch", "https://github.com/other/repo/pull/5", "--once", "--repo", repo], {
      STAFF_WATCH_REVIEW_COMMAND: reviewCommand,
    });
    const envCommandCapture = await Bun.file(capture).text();
    expect(envCommandCapture).toContain("Run /staff-review");
    expect(envCommandCapture).toContain("This is GitHub PR #5: Cross repo thing");
    expect(envCommandCapture).toContain("PR=5");
    expect(envCommandCapture).toContain("URL=https://github.com/other/repo/pull/5");
    expect(envCommandCapture).toContain("AGENTS=2");
    const envCommandLog = await Bun.file(commandLog).text();
    expect(envCommandLog).not.toContain("codex:");
    expect(envCommandLog).not.toContain("harness:");

    await Bun.write(capture, "");
    await Bun.write(commandLog, "");
    const sourceMutation = await runCliFailure(
      [
        "watch",
        "https://github.com/other/repo/pull/5",
        "--once",
        "--review-command",
        reviewCommand,
        "--repo",
        repo,
      ],
      { STAFF_WATCH_MUTATE_SOURCE: "1" },
    );
    expect(sourceMutation.stderr).toContain("reviewer modified files outside .staffreview");
    const sourceMutationLog = await Bun.file(commandLog).text();
    expect(sourceMutationLog).not.toContain("repos/other/repo/pulls/5/comments -X POST");
    expect(sourceMutationLog).toContain("repos/other/repo/issues/5/comments -X POST");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
