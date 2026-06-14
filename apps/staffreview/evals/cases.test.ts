import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scoreCase } from "./cases.ts";

const repos: string[] = [];

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => rm(repo, { force: true, recursive: true })));
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

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
