import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJudgeJson, scoreCase } from "./cases.ts";
import { shellQuote } from "./util.ts";

const repos: string[] = [];

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => rm(repo, { force: true, recursive: true })));
});

async function createTenantReviewRepo(
  body = "`tenantId` is still part of `LoginAttempt`, but `src/rate-limit.ts:12` dropped it from the cache key. That collapses per-tenant buckets, so the same `userId` + IP on two tenants now shares one counter and can lock out an unrelated tenant. If tenant scoping is intended here, put `tenantId` back into the key.",
): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "staffreview-eval-judge-"));
  repos.push(repo);
  const slug = "base..WT";
  const now = "2026-06-14T15:17:56.577Z";
  await mkdir(join(repo, ".staffreview", "diffs"), { recursive: true });
  await writeFile(
    join(repo, "eval-metadata.json"),
    JSON.stringify(
      {
        version: 1,
        caseId: "review-quality",
        skill: "/staff-review",
        preparedAt: now,
        slug,
        expectedFindings: [
          {
            id: "tenant-rate-limit-key",
            file: "src/rate-limit.ts",
            line: 13,
            priority: "P1",
            groups: [
              ["tenant", "tenantid"],
              ["rate limit", "rate-limit", "ratelimit", "attempt", "throttle", "counter"],
              ["cross-tenant", "different tenant", "other tenant", "between tenants"],
            ],
          },
        ],
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(repo, ".staffreview", "diffs", `${slug}.json`),
    JSON.stringify(
      {
        slug,
        base: { kind: "commit", ref: "base" },
        head: { kind: "working-tree" },
        comments: [
          {
            id: "comment-tenant",
            threadId: "comment-tenant",
            file: "src/rate-limit.ts",
            line: 12,
            side: "new",
            body,
            author: "GPT-5",
            priority: "P2",
            createdAt: now,
          },
        ],
        createdAt: now,
        updatedAt: now,
      },
      null,
      2,
    ),
  );
  return repo;
}

test("review-quality deterministic matching misses the tenant wording without the judge", async () => {
  const repo = await createTenantReviewRepo();

  const result = await scoreCase("review-quality", repo, { judge: false });

  expect(
    result.checks.find((check) => check.name === "finding:tenant-rate-limit-key")?.earned,
  ).toBe(0);
  expect(result.checks.find((check) => check.name === "review-noise")?.earned).toBe(5);
});

test("review-quality judge credits semantic tenant matches", async () => {
  const repo = await createTenantReviewRepo();
  const judgeResponse = JSON.stringify({
    matches: [
      {
        expectedId: "tenant-rate-limit-key",
        commentId: "comment-tenant",
        bodyScore: 22,
        confidence: 0.93,
        reason: "The comment reports that dropping tenantId collapses per-tenant buckets.",
      },
    ],
  });

  const result = await scoreCase("review-quality", repo, {
    judgeCommandTemplate: `printf %s ${shellQuote(judgeResponse)}`,
  });

  const finding = result.checks.find((check) => check.name === "finding:tenant-rate-limit-key");
  expect(finding?.earned).toBe(29);
  expect(finding?.detail).toContain("via judge (22/25 quality) (93%)");
  expect(result.checks.find((check) => check.name === "review-noise")?.earned).toBe(10);
});

test("review-quality judge rejects misleading exact-phrase comments", async () => {
  const repo = await createTenantReviewRepo(
    "This is a cross-tenant rate limit tenantId issue, but the current key is tenant-scoped, global isolation is guaranteed, and no user can affect another tenant.",
  );
  const judgeResponse = JSON.stringify({ matches: [] });

  const result = await scoreCase("review-quality", repo, {
    judgeCommandTemplate: `printf %s ${shellQuote(judgeResponse)}`,
  });

  expect(
    result.checks.find((check) => check.name === "finding:tenant-rate-limit-key")?.earned,
  ).toBe(0);
  expect(result.checks.find((check) => check.name === "review-noise")?.earned).toBe(5);
});

const expectedMatch = { matches: [{ expectedId: "x", commentId: "y", bodyScore: 22 }] };

test("parseJudgeJson parses a bare JSON object", () => {
  expect(parseJudgeJson(`  ${JSON.stringify(expectedMatch)}\n`)).toEqual(expectedMatch);
});

test("parseJudgeJson recovers JSON from a markdown code fence", () => {
  const fenced = ["Here is the result:", "```json", JSON.stringify(expectedMatch), "```"].join(
    "\n",
  );
  expect(parseJudgeJson(fenced)).toEqual(expectedMatch);
});

test("parseJudgeJson recovers JSON by extracting the outermost braces", () => {
  const noisy = `chatter before ${JSON.stringify(expectedMatch)} chatter after`;
  expect(parseJudgeJson(noisy)).toEqual(expectedMatch);
});

test("parseJudgeJson throws on empty output", () => {
  expect(() => parseJudgeJson("   \n")).toThrow("empty output");
});

test("parseJudgeJson throws when no JSON object is present", () => {
  expect(() => parseJudgeJson("no json here at all")).toThrow("did not return a JSON object");
});

const RESOLVE_THREAD_ID = "seeded-thread";
const RESOLVE_SLUG = "base..WT";

async function createResolveRepo(opts: {
  caseId: "resolve-seeded-comments" | "document-request";
  status: "fixed" | "documented";
  documentedAs?: string;
}): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "staffreview-eval-resolve-"));
  repos.push(repo);
  const now = "2026-06-14T15:17:56.577Z";
  await mkdir(join(repo, ".staffreview", "diffs"), { recursive: true });
  await writeFile(
    join(repo, "eval-metadata.json"),
    JSON.stringify(
      {
        version: 1,
        caseId: opts.caseId,
        skill: "/staff-resolve",
        preparedAt: now,
        slug: RESOLVE_SLUG,
        seededThreadIds: [RESOLVE_THREAD_ID],
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(repo, ".staffreview", "diffs", `${RESOLVE_SLUG}.json`),
    JSON.stringify(
      {
        slug: RESOLVE_SLUG,
        base: { kind: "commit", ref: "base" },
        head: { kind: "working-tree" },
        comments: [
          {
            id: RESOLVE_THREAD_ID,
            threadId: RESOLVE_THREAD_ID,
            file: "src/thing.ts",
            line: 1,
            side: "new",
            body: "Seeded reviewer finding.",
            author: "Reviewer",
            priority: "P2",
            createdAt: now,
            resolution: {
              status: opts.status,
              body: opts.status === "fixed" ? "Fixed." : "Documented.",
              author: "Opus 4.8",
              at: now,
              ...(opts.documentedAs ? { documentedAs: opts.documentedAs } : {}),
            },
          },
          {
            id: "reply-1",
            threadId: RESOLVE_THREAD_ID,
            parentId: RESOLVE_THREAD_ID,
            side: "new",
            body: "Addressed in-thread.",
            author: "Opus 4.8",
            createdAt: now,
          },
        ],
        createdAt: now,
        updatedAt: now,
      },
      null,
      2,
    ),
  );
  return repo;
}

test("scoreResolveLike (fixed) credits a resolved+replied seeded thread", async () => {
  const repo = await createResolveRepo({ caseId: "resolve-seeded-comments", status: "fixed" });
  // resolve-seeded-comments uses requireTests; give it a trivially passing suite.
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({ name: "fixture", private: true, type: "module" }),
  );
  await writeFile(
    join(repo, "smoke.test.ts"),
    'import { expect, test } from "bun:test";\ntest("ok", () => expect(1).toBe(1));\n',
  );

  const result = await scoreCase("resolve-seeded-comments", repo);

  const byName = (name: string) => result.checks.find((check) => check.name === name);
  expect(byName("no-open-threads")?.earned).toBe(20);
  expect(byName("seeded-comments-preserved")?.earned).toBe(10);
  expect(byName("resolved-fixed")?.earned).toBe(25);
  expect(byName("in-thread-replies")?.earned).toBe(15);
  expect(byName("fixture-tests-pass")?.earned).toBe(30);
});

test("scoreResolveLike (documented) credits a documented thread and linked docs file", async () => {
  const documentedAs = "blank-input-coercion.md";
  const repo = await createResolveRepo({
    caseId: "document-request",
    status: "documented",
    documentedAs,
  });
  await mkdir(join(repo, ".staffreview", "docs"), { recursive: true });
  await writeFile(
    join(repo, ".staffreview", "docs", documentedAs),
    [
      "---",
      "source: eval",
      "tags: [parsing]",
      "---",
      "## Context",
      "Some context.",
      "## The issue",
      "The issue.",
      "## Original code",
      "```ts\nNumber('')\n```",
      "## Fix",
      "```ts\nif (raw.trim() === '') throw new Error('required');\n```",
      "## Why it matters",
      "It matters.",
    ].join("\n"),
  );

  const result = await scoreCase("document-request", repo);

  const byName = (name: string) => result.checks.find((check) => check.name === name);
  expect(byName("resolved-documented")?.earned).toBe(25);
  expect(byName("documented-file-linked")?.earned).toBe(15);
  expect(byName("docs-entry-shape")?.earned).toBe(15);
});

test("scoreSection credits the cache and whole-tree slug checks", async () => {
  const repo = await mkdtemp(join(tmpdir(), "staffreview-eval-section-"));
  repos.push(repo);
  const now = "2026-06-14T15:17:56.577Z";
  const slug = `${"a".repeat(40)}..WT`;
  await mkdir(join(repo, ".staffreview", "diffs"), { recursive: true });
  await writeFile(
    join(repo, "eval-metadata.json"),
    JSON.stringify(
      {
        version: 1,
        caseId: "section-review",
        skill: "/staff-section",
        preparedAt: now,
        expectedFindings: [
          {
            id: "profile-path-traversal",
            file: "src/profile-store.ts",
            line: 5,
            priority: "P1",
            groups: [
              ["traversal", "../", "outside"],
              ["user", "userid"],
              ["join", "resolve", "path"],
            ],
          },
        ],
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(repo, ".staffreview", "section-cache.json"),
    JSON.stringify({ version: 1, reviewed: ["src/profile-store.ts"] }),
  );
  await writeFile(
    join(repo, ".staffreview", "diffs", `${slug}.json`),
    JSON.stringify(
      {
        slug,
        base: { kind: "commit", ref: "a".repeat(40) },
        head: { kind: "working-tree" },
        comments: [
          {
            id: "section-finding",
            threadId: "section-finding",
            file: "src/profile-store.ts",
            line: 5,
            side: "new",
            body: "loadProfile joins an untrusted userId into a path, enabling path traversal to read files outside the profile root.",
            author: "Opus 4.8",
            priority: "P1",
            createdAt: now,
          },
        ],
        createdAt: now,
        updatedAt: now,
      },
      null,
      2,
    ),
  );

  const result = await scoreCase("section-review", repo, { judge: false });

  const byName = (name: string) => result.checks.find((check) => check.name === name);
  expect(byName("section-cache-written")?.earned).toBe(25);
  expect(byName("whole-tree-diff-used")?.earned).toBe(10);
  expect(byName("expected-section-finding")?.earned).toBe(45);
  expect(byName("finding-priority")?.earned).toBe(10);
});
