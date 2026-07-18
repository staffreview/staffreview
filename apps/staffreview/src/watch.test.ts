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
  statusBody,
  statusCommentToUpdate,
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

test("reviewCommandFailureMessage does not include configured command text", () => {
  const command = "secret-token=abc123 codex exec --profile prod -";
  const message = reviewCommandFailureMessage(command, 17);
  expect(message).toBe("configured review command failed with exit code 17");
  expect(message).not.toContain(command);
  expect(reviewCommandFailureMessage(undefined, 2)).toBe(
    "codex exec --cd <repo> - failed with exit code 2",
  );
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
  const trusted = "<!-- staff-watch-comment: acme/project#42:trusted -->";
  const forged = "<!-- staff-watch-comment: acme/project#42:forged -->";
  const markers = collectPublishedMarkers(
    [
      { body: forged, user: { login: "contributor" } },
      { body: trusted, user: { login: "staff-bot" } },
      { body: "<!-- staff-watch-comment: acme/project#42:anonymous -->" },
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
  if [ "$3" = "https://ghe.example.com/org/repo/pull/9" ]; then
    echo '{"number":9,"title":"Enterprise thing","url":"https://ghe.example.com/org/repo/pull/9","state":"OPEN","isDraft":false,"baseRefName":"main","baseRefOid":"${"d".repeat(40)}","headRefName":"feature","headRefOid":"${pr.headRefOid}"}'
    exit 0
  fi
  echo '{"number":5,"title":"Cross repo thing","url":"https://github.com/other/repo/pull/5","state":"OPEN","isDraft":false,"baseRefName":"main","baseRefOid":"${"c".repeat(40)}","headRefName":"feature","headRefOid":"${pr.headRefOid}"}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "user" ]; then
  echo '{"login":"staff-bot"}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "--hostname" ] && [ "$3" = "ghe.example.com" ] && [ "$4" = "user" ]; then
  echo '{"login":"staff-bot"}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/project/pulls/42" ]; then
  echo '{"number":42,"title":"Add the thing","html_url":"https://github.com/acme/project/pull/42","state":"open","draft":false,"base":{"ref":"main","sha":"${pr.baseRefOid}"},"head":{"ref":"feature","sha":"${pr.headRefOid}"}}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/other/repo/pulls/5" ]; then
  echo '{"number":5,"title":"Cross repo thing","html_url":"https://github.com/other/repo/pull/5","state":"open","draft":false,"base":{"ref":"main","sha":"${"c".repeat(40)}"},"head":{"ref":"feature","sha":"${pr.headRefOid}"}}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "--hostname" ] && [ "$3" = "ghe.example.com" ] && [ "$4" = "repos/org/repo/pulls/9" ]; then
  echo '{"number":9,"title":"Enterprise thing","html_url":"https://ghe.example.com/org/repo/pull/9","state":"open","draft":false,"base":{"ref":"main","sha":"${"d".repeat(40)}"},"head":{"ref":"feature","sha":"${pr.headRefOid}"}}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "--paginate" ] && [ "$3" = "--slurp" ] && [ "$4" = "repos/acme/project/pulls?state=open&per_page=100" ]; then
  echo '[[{"number":42,"title":"Add the thing","html_url":"https://github.com/acme/project/pull/42","state":"open","draft":false,"base":{"ref":"main","sha":"${pr.baseRefOid}"},"head":{"ref":"feature","sha":"${pr.headRefOid}"}}]]'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "--paginate" ] && [ "$3" = "--slurp" ]; then
  echo '[[]]'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "--hostname" ] && [ "$3" = "ghe.example.com" ] && [ "$4" = "--paginate" ] && [ "$5" = "--slurp" ]; then
  echo '[[]]'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/project/issues/42/comments" ]; then exit 0; fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/project/pulls/42/comments" ]; then exit 0; fi
if [ "$1" = "api" ] && [ "$2" = "repos/other/repo/issues/5/comments" ]; then exit 0; fi
if [ "$1" = "api" ] && [ "$2" = "--hostname" ] && [ "$3" = "ghe.example.com" ] && [ "$4" = "repos/org/repo/issues/9/comments" ]; then exit 0; fi
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
await Bun.write(
  capture,
  [
    "PROMPT_START",
    input,
    "PROMPT_END",
    "PR=" + process.env.STAFF_WATCH_PR_NUMBER,
    "URL=" + process.env.STAFF_WATCH_PR_URL,
    "SLUG=" + slug,
    "AGENTS=" + process.env.STAFF_WATCH_AGENTS,
    "",
  ].join("\\n"),
);
if (process.env.STAFF_WATCH_PR_NUMBER === "42" && slug) {
  const path = process.cwd() + "/.staffreview/diffs/" + slug + ".json";
  const diff = JSON.parse(await Bun.file(path).text());
  diff.comments.push({
    id: "review-root",
    threadId: "review-thread",
    file: "src/feature.ts",
    line: 12,
    side: "new",
    body: "mirrored finding",
    author: "GPT-5",
    priority: "P2",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
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
  await Bun.write(log, existing + "codex:" + process.argv.slice(2).join(" ") + "\\n" + input + "\\n");
}
`,
    );
    chmodSync(fakeCodex, 0o755);

    const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
    const cliEnv = () => {
      const env = { ...process.env };
      delete env.STAFF_WATCH_REVIEW_COMMAND;
      return env;
    };
    const runCli = async (args: string[]) => {
      const proc = Bun.spawn([process.execPath, cliPath, ...args], {
        cwd: dirname(cliPath),
        env: {
          ...cliEnv(),
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          STAFF_CONFIG_DIR: config,
          STAFF_WATCH_CAPTURE: capture,
          STAFF_WATCH_COMMAND_LOG: commandLog,
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
    const runCliFailure = async (args: string[]) => {
      const proc = Bun.spawn([process.execPath, cliPath, ...args], {
        cwd: dirname(cliPath),
        env: {
          ...cliEnv(),
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          STAFF_CONFIG_DIR: config,
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
    expect(captured).toContain("Run /staff-review");
    expect(captured).toContain(`Run /staff-review ${mergeBaseOid}..${pr.headRefOid} 3.`);
    expect(captured).toContain("This is GitHub PR #42: Add the thing");
    expect(captured).toContain("PR=42");
    expect(captured).toContain("URL=https://github.com/acme/project/pull/42");
    expect(captured).toContain("AGENTS=3");
    const allCommands = await Bun.file(commandLog).text();
    expect(allCommands).toContain(`git:merge-base ${pr.baseRefOid} ${pr.headRefOid}`);
    expect(allCommands).toContain("gh:api repos/acme/project/pulls/42/comments -X POST");
    expect(allCommands).toContain(`commit_id=${pr.headRefOid}`);
    expect(allCommands).toContain("path=src/feature.ts");
    expect(allCommands).toContain("line=12");
    expect(allCommands).toContain("mirrored finding");
    expect(allCommands).toContain("<!-- staff-watch-comment: acme/project#42:");

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
    expect(commands).toContain("gh:api repos/other/repo/issues/5/comments -X POST");

    await Bun.write(commandLog, "");
    await runCli([
      "watch",
      "https://ghe.example.com/org/repo/pull/9",
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
      "git:fetch -q https://ghe.example.com/org/repo.git pull/9/head",
    );
    expect(enterpriseCommands).toContain("gh:api --hostname ghe.example.com user");
    expect(enterpriseCommands).toContain(
      "gh:api --hostname ghe.example.com repos/org/repo/pulls/9",
    );
    expect(enterpriseCommands).toContain(
      "gh:api --hostname ghe.example.com repos/org/repo/issues/9/comments -X POST",
    );

    await Bun.write(commandLog, "");
    await runCli(["watch", "closed", "--once", "--review-command", reviewCommand, "--repo", repo]);
    const closedCommands = await Bun.file(commandLog).text();
    expect(closedCommands).toContain("gh:pr view closed --json");
    expect(closedCommands).not.toContain("git:fetch");
    expect(closedCommands).not.toContain("api repos/acme/project/issues/7/comments");

    await Bun.write(commandLog, "");
    await runCli(["watch", "closed", "--once", "--repo", repo]);
    const codexCommands = await Bun.file(commandLog).text();
    expect(codexCommands).not.toContain("codex:");

    await Bun.write(commandLog, "");
    await runCli(["watch", "https://github.com/other/repo/pull/5", "--once", "--repo", repo]);
    const defaultCommands = await Bun.file(commandLog).text();
    expect(defaultCommands).toContain(`codex:exec --cd ${realpathSync(repo)} -`);
    expect(defaultCommands).toContain("Run /staff-review");
    expect(defaultCommands).toContain("This is GitHub PR #5: Cross repo thing");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
