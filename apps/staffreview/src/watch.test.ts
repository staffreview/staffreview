import { expect, test } from "bun:test";
import type { Diff } from "./types.ts";
import {
  buildReviewPrompt,
  commentBody,
  commentsToPublish,
  normalizeAgents,
  normalizeIntervalSeconds,
  type PullRequest,
  statusBody,
} from "./watch.ts";

const pr: PullRequest = {
  number: 42,
  title: "Add the thing",
  url: "https://github.com/acme/project/pull/42",
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
  expect(normalizeIntervalSeconds("0")).toBe(60);
  expect(normalizeIntervalSeconds("nope")).toBe(60);
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

test("commentsToPublish returns only new root comments without existing GitHub markers", () => {
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
    ],
  };

  const first = commentsToPublish({
    diff,
    beforeCommentIds: new Set(["old"]),
    existingMarkers: new Set(),
    repo: "acme/project",
    pr,
    headSha: pr.headRefOid,
  });
  expect(first).toHaveLength(1);
  expect(first[0]!.comment.id).toBe("root");
  expect(commentBody(first[0]!.comment, first[0]!.marker)).toContain("Priority: P2");

  const second = commentsToPublish({
    diff,
    beforeCommentIds: new Set(["old"]),
    existingMarkers: new Set([first[0]!.marker]),
    repo: "acme/project",
    pr,
    headSha: pr.headRefOid,
  });
  expect(second).toHaveLength(0);
});
