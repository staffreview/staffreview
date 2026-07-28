import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postReview, reviewPayload, validateDiffHead } from "./github-review.ts";
import type { Diff } from "./types.ts";

function diff(comments: Diff["comments"]): Diff {
  return {
    slug: "base..WT",
    base: { kind: "commit", ref: "base" },
    head: { kind: "working-tree" },
    comments,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

test("reviewPayload converts root comments and ignores replies", () => {
  const payload = reviewPayload(
    diff([
      {
        id: "inline",
        threadId: "inline",
        file: "src/a.ts",
        line: 4,
        endLine: 6,
        side: "new",
        body: "Inline issue",
        author: "agent",
        priority: "P1",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "reply",
        threadId: "inline",
        parentId: "inline",
        body: "A reply",
        author: "agent",
        createdAt: "2026-01-01T00:00:01Z",
      },
      {
        id: "top",
        threadId: "top",
        body: "Overall issue",
        author: "agent",
        createdAt: "2026-01-01T00:00:02Z",
      },
    ]),
    "head",
    "<!-- marker -->",
  );

  expect(payload).toEqual({
    commit_id: "head",
    event: "COMMENT",
    body: "Staff Review.\n\n<!-- marker -->\n\n**Finding**\n\nOverall issue",
    comments: [
      {
        path: "src/a.ts",
        side: "RIGHT",
        body: "**P1**\n\nInline issue",
        start_line: 4,
        start_side: "RIGHT",
        line: 6,
      },
    ],
  });
});

test("reviewPayload maps old-side comments to GitHub's LEFT side", () => {
  const payload = reviewPayload(
    diff([
      {
        id: "old",
        threadId: "old",
        file: "src/deleted.ts",
        line: 2,
        side: "old",
        body: "Deleted issue",
        author: "agent",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]),
    "head",
    "<!-- marker -->",
  );

  expect(payload.comments[0]).toMatchObject({ side: "LEFT", line: 2 });
});

test("validateDiffHead requires a clean working tree at the pull request head", () => {
  const active = diff([]);
  expect(() => validateDiffHead(active, "head", "head", true)).toThrow("uncommitted");
  expect(() => validateDiffHead(active, "head", "merge", false)).toThrow(
    "does not match the pull request head",
  );
  expect(() => validateDiffHead(active, "head", "head", false)).not.toThrow();
});

test("postReview resolves Informant context without changing review branding", async () => {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const commitDiff = diff([
    {
      id: "finding",
      threadId: "finding",
      file: "src/a.ts",
      line: 4,
      side: "new",
      body: "Issue",
      author: "agent",
      createdAt: "2026-01-01T00:00:00Z",
    },
  ]);
  commitDiff.head = { kind: "commit", ref: "head" };
  const result = await postReview(commitDiff, {
    env: {
      INFORMANT_REPOSITORY: "owner/repo",
      INFORMANT_BRANCH: "pull/42",
      INFORMANT_SHA: "head",
    },
    runGh: async (args, input) => {
      calls.push({ args, input });
      if (args[1] === "repos/owner/repo/pulls/42") {
        return JSON.stringify({ number: 42, head: { sha: "head" }, base: { sha: "base" } });
      }
      if (args.includes("--paginate")) return "[[]]";
      return "{}";
    },
  });

  expect(result).toEqual({
    posted: true,
    findingCount: 1,
    message: "Posted 1 staff review finding(s)",
  });
  const post = calls.at(-1)!;
  expect(post.args).toContain("POST");
  expect(JSON.parse(post.input!)).toMatchObject({
    commit_id: "head",
    event: "COMMENT",
    body: expect.stringContaining("Staff Review."),
  });
  expect(post.input).not.toContain("Informant");
});

test("postReview ignores an inherited GitHub event path in Informant context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "staffreview-event-"));
  const eventPath = join(directory, "event.json");
  await writeFile(eventPath, "'not json'");
  const commitDiff = diff([]);
  commitDiff.head = { kind: "commit", ref: "head" };

  try {
    const result = await postReview(commitDiff, {
      env: {
        GITHUB_EVENT_PATH: eventPath,
        INFORMANT_REPOSITORY: "owner/repo",
        INFORMANT_BRANCH: "pull/42",
        INFORMANT_SHA: "head",
      },
      runGh: async (args) => {
        if (args[1] === "repos/owner/repo/pulls/42") {
          return JSON.stringify({ number: 42, head: { sha: "head" }, base: { sha: "base" } });
        }
        return "{}";
      },
    });

    expect(result.message).toBe("Staff review found no actionable issues");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("postReview does not post a duplicate review", async () => {
  const commitDiff = diff([
    {
      id: "finding",
      threadId: "finding",
      body: "Issue",
      author: "agent",
      createdAt: "2026-01-01T00:00:00Z",
    },
  ]);
  commitDiff.head = { kind: "commit", ref: "head" };
  const result = await postReview(commitDiff, {
    env: {},
    repository: "owner/repo",
    pr: "42",
    runGh: async (args) => {
      if (args[1] === "repos/owner/repo/pulls/42") {
        return JSON.stringify({ number: 42, head: { sha: "head" }, base: { sha: "base" } });
      }
      return '[[{"body":"<!-- informant-staff-review:head -->"}]]';
    },
  });

  expect(result.posted).toBe(false);
  expect(result.message).toBe("Staff review already exists for this commit");
});

test("postReview resolves a pull request from GitHub Actions context", async () => {
  const calls: string[][] = [];
  const commitDiff = diff([
    {
      id: "finding",
      threadId: "finding",
      body: "Issue",
      author: "agent",
      createdAt: "2026-01-01T00:00:00Z",
    },
  ]);
  commitDiff.head = { kind: "commit", ref: "head" };
  await postReview(commitDiff, {
    env: {
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "actions/repo",
    },
    event: {
      number: 17,
      pull_request: { head: { sha: "head" }, base: { sha: "base" } },
    },
    runGh: async (args) => {
      calls.push(args);
      if (args[1] === "repos/actions/repo/pulls/17") {
        return JSON.stringify({ number: 17, head: { sha: "head" }, base: { sha: "base" } });
      }
      if (args.includes("--paginate")) return "[[]]";
      return "{}";
    },
  });

  expect(calls.some((args) => args[0] === "repo" || args[0] === "pr")).toBe(false);
  expect(calls.at(-1)).toContain("repos/actions/repo/pulls/17/reviews");
});
