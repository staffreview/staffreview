import { expect, test } from "bun:test";
import type { SuiteScoreResult } from "./cases.ts";
import {
  aggregateScore,
  averageChecks,
  createTaskLimiter,
  stdev,
  type VersionRunResult,
} from "./runner.ts";

function suiteResult(score: SuiteScoreResult): VersionRunResult {
  return {
    codex: [],
    model: "default",
    score,
    skipped: [],
    suite: "/tmp/suite",
    version: "current",
  };
}

test("stdev returns 0 for fewer than two values", () => {
  expect(stdev([])).toBe(0);
  expect(stdev([5])).toBe(0);
});

test("stdev computes the population standard deviation", () => {
  // values 2,4,4,4,5,5,7,9 -> mean 5, population stdev 2
  expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2, 10);
  expect(stdev([1, 1, 1])).toBe(0);
  expect(stdev([0, 10])).toBeCloseTo(5, 10);
});

test("createTaskLimiter never exceeds the configured limit and drains the queue", async () => {
  const limit = 2;
  const limiter = createTaskLimiter(limit);
  let active = 0;
  let maxActive = 0;
  const release: Array<() => void> = [];

  const tasks = Array.from({ length: 6 }, (_, i) =>
    limiter(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((res) => release.push(res));
      active--;
      return i;
    }),
  );

  // Let the first batch reach the gate, then release everything in waves.
  while (release.length < limit) await Promise.resolve();
  expect(active).toBe(limit);

  while (release.length > 0) {
    const next = release.shift()!;
    next();
    await Promise.resolve();
    await Promise.resolve();
  }

  const results = await Promise.all(tasks);
  expect(results.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(maxActive).toBe(limit);
  expect(active).toBe(0);
});

test("createTaskLimiter releases its slot even when a task throws", async () => {
  const limiter = createTaskLimiter(1);
  await expect(limiter(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  // If the slot leaked, this follow-up task would deadlock.
  expect(await limiter(async () => "ok")).toBe("ok");
});

test("aggregateScore averages case scores and totals across runs", () => {
  const runA = suiteResult({
    caseId: "all",
    score: 8,
    possible: 10,
    cases: [
      {
        caseId: "review-quality",
        score: 8,
        possible: 10,
        checks: [{ name: "body", earned: 8, possible: 10, detail: "" }],
      },
    ],
  });
  const runB = suiteResult({
    caseId: "all",
    score: 6,
    possible: 10,
    cases: [
      {
        caseId: "review-quality",
        score: 6,
        possible: 10,
        checks: [{ name: "body", earned: 4, possible: 10, detail: "" }],
      },
    ],
  });

  const aggregate = aggregateScore([runA, runB]);
  expect(aggregate.caseId).toBe("all");
  expect(aggregate.score).toBe(7); // mean of 8 and 6
  expect(aggregate.possible).toBe(10);
  expect(aggregate.cases).toHaveLength(1);
  expect(aggregate.cases[0]!.caseId).toBe("review-quality");
  expect(aggregate.cases[0]!.score).toBe(7); // mean of case scores 8 and 6
  expect(aggregate.cases[0]!.checks[0]!.earned).toBe(6); // mean of 8 and 4
  expect(aggregate.cases[0]!.checks[0]!.possible).toBe(10);
});

test("averageChecks reports mean earned and the min-max range per check", () => {
  const results = [
    suiteResult({
      caseId: "all",
      score: 0,
      possible: 0,
      cases: [
        {
          caseId: "c1",
          score: 0,
          possible: 0,
          checks: [{ name: "anchor", earned: 5, possible: 5, detail: "" }],
        },
      ],
    }),
    suiteResult({
      caseId: "all",
      score: 0,
      possible: 0,
      cases: [
        {
          caseId: "c1",
          score: 0,
          possible: 0,
          checks: [{ name: "anchor", earned: 1, possible: 5, detail: "" }],
        },
      ],
    }),
  ];

  const checks = averageChecks(results, "c1");
  expect(checks).toHaveLength(1);
  expect(checks[0]!.name).toBe("anchor");
  expect(checks[0]!.earned).toBe(3); // mean of 5 and 1
  expect(checks[0]!.possible).toBe(5);
  expect(checks[0]!.detail).toBe("mean across 2 run(s); range 1-5/5");
});
