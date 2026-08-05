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

type FetchCall = { url: string; init?: RequestInit };

function mockFetch(
  calls: FetchCall[],
  handler: (url: string, init?: RequestInit) => Response,
): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof globalThis.fetch;
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
  const calls: FetchCall[] = [];
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
      GH_TOKEN: "token",
    },
    fetch: mockFetch(calls, (url, init) => {
      if (url.endsWith("/pulls/42")) {
        return Response.json({ number: 42, head: { sha: "head" }, base: { sha: "base" } });
      }
      if (init?.method === "POST") return Response.json({ id: 1 });
      return Response.json([]);
    }),
  });

  expect(result).toEqual({
    posted: true,
    findingCount: 1,
    message: "Posted 1 staff review finding(s)",
  });
  const post = calls.at(-1)!;
  expect(post.init?.method).toBe("POST");
  expect(JSON.parse(String(post.init?.body))).toMatchObject({
    commit_id: "head",
    event: "COMMENT",
    body: expect.stringContaining("Staff Review."),
  });
  expect(post.init?.body).not.toContain("Informant");
  expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe("Bearer token");
});

test("postReview falls back to a PR-level review when inline comments cannot be resolved", async () => {
  const calls: FetchCall[] = [];
  const commitDiff = diff([
    {
      id: "finding",
      threadId: "finding",
      file: "src/moved.ts",
      line: 4,
      endLine: 6,
      side: "new",
      body: "Issue on a path GitHub cannot resolve",
      author: "agent",
      priority: "P1",
      createdAt: "2026-01-01T00:00:00Z",
    },
  ]);
  commitDiff.head = { kind: "commit", ref: "head" };
  let postCount = 0;

  const result = await postReview(commitDiff, {
    env: { GH_TOKEN: "token" },
    repository: "owner/repo",
    pr: "42",
    fetch: mockFetch(calls, (url, init) => {
      if (url.endsWith("/pulls/42")) {
        return Response.json({ number: 42, head: { sha: "head" }, base: { sha: "base" } });
      }
      if (init?.method === "POST" && postCount++ === 0) {
        return Response.json(
          { message: "Unprocessable Entity", errors: ["Path could not be resolved"] },
          { status: 422, statusText: "Unprocessable Entity" },
        );
      }
      if (init?.method === "POST") return Response.json({ id: 1 });
      return Response.json([]);
    }),
  });

  expect(result).toEqual({
    posted: true,
    findingCount: 1,
    message: "Posted 1 staff review finding(s)",
  });
  const posts = calls.filter((call) => call.init?.method === "POST");
  expect(posts).toHaveLength(2);
  expect(JSON.parse(String(posts[0]?.init?.body)).comments).toHaveLength(1);
  expect(JSON.parse(String(posts[1]?.init?.body))).toEqual({
    commit_id: "head",
    event: "COMMENT",
    body: expect.stringContaining(
      "**P1** — `src/moved.ts:4-6`\n\nIssue on a path GitHub cannot resolve",
    ),
  });
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
        GITHUB_TOKEN: "token",
      },
      fetch: mockFetch([], (url) => {
        if (url.endsWith("/pulls/42")) {
          return Response.json({ number: 42, head: { sha: "head" }, base: { sha: "base" } });
        }
        return Response.json([]);
      }),
    });

    expect(result.message).toBe("Staff review found no actionable issues");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("postReview does not post a duplicate review", async () => {
  const calls: FetchCall[] = [];
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
    env: { GITHUB_TOKEN: "token" },
    repository: "owner/repo",
    pr: "42",
    fetch: mockFetch(calls, (url) => {
      if (url.endsWith("/pulls/42")) {
        return Response.json({ number: 42, head: { sha: "head" }, base: { sha: "base" } });
      }
      if (url.includes("page=2")) {
        return Response.json([{ body: "<!-- informant-staff-review:head -->" }]);
      }
      return Response.json([], {
        headers: {
          Link: '<https://api.github.com/repos/owner/repo/pulls/42/reviews?per_page=100&page=2>; rel="next", <https://api.github.com/repos/owner/repo/pulls/42/reviews?per_page=100&page=2>; rel="last"',
        },
      });
    }),
  });

  expect(result.posted).toBe(false);
  expect(result.message).toBe("Staff review already exists for this commit");
  expect(calls).toHaveLength(3);
});

test("postReview resolves a pull request from GitHub Actions context", async () => {
  const calls: FetchCall[] = [];
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
      GITHUB_TOKEN: "token",
    },
    event: {
      number: 17,
      pull_request: { head: { sha: "head" }, base: { sha: "base" } },
    },
    fetch: mockFetch(calls, (url, init) => {
      if (url.endsWith("/pulls/17")) {
        return Response.json({ number: 17, head: { sha: "head" }, base: { sha: "base" } });
      }
      if (init?.method === "POST") return Response.json({ id: 1 });
      return Response.json([]);
    }),
  });

  expect(calls.at(-1)?.url).toContain("repos/actions/repo/pulls/17/reviews");
});

test("postReview reports GitHub API failures with the response body", async () => {
  const commitDiff = diff([]);
  commitDiff.head = { kind: "commit", ref: "head" };

  await expect(
    postReview(commitDiff, {
      env: { GH_TOKEN: "token" },
      repository: "owner/repo",
      pr: "42",
      fetch: mockFetch([], () =>
        Response.json(
          { message: "Resource not accessible by integration" },
          { status: 403, statusText: "Forbidden" },
        ),
      ),
    }),
  ).rejects.toThrow(
    'GitHub API GET /repos/owner/repo/pulls/42 failed (403 Forbidden)\n{"message":"Resource not accessible by integration"}',
  );
});

test("postReview requires explicit local GitHub context and authentication", async () => {
  const commitDiff = diff([]);
  commitDiff.head = { kind: "commit", ref: "head" };

  await expect(postReview(commitDiff, { env: {} })).rejects.toThrow("--github-repo");
  await expect(postReview(commitDiff, { env: {}, repository: "owner/repo" })).rejects.toThrow(
    "--pr",
  );
  await expect(
    postReview(commitDiff, { env: {}, repository: "owner/repo", pr: "42" }),
  ).rejects.toThrow("GH_TOKEN or GITHUB_TOKEN");
});
