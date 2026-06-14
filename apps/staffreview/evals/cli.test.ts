import { afterEach, expect, test } from "bun:test";
import { modelsFromCsv, parseArgs, resolveJudgeEnabled, skillsFromCsv } from "./cli.ts";

const originalJudgeEnv = process.env.STAFF_EVAL_JUDGE;

afterEach(() => {
  if (originalJudgeEnv === undefined) delete process.env.STAFF_EVAL_JUDGE;
  else process.env.STAFF_EVAL_JUDGE = originalJudgeEnv;
});

test("parseArgs splits positionals from flags", () => {
  const { positional, flags } = parseArgs(["run", "--runs", "3", "--json"]);
  expect(positional).toEqual(["run"]);
  expect(flags).toEqual({ runs: "3", json: true });
});

test("parseArgs supports --key=value form", () => {
  const { positional, flags } = parseArgs(["prepare", "all", "--out=my-run"]);
  expect(positional).toEqual(["prepare", "all"]);
  expect(flags.out).toBe("my-run");
});

test("parseArgs treats a flag followed by another flag as boolean", () => {
  const { flags } = parseArgs(["--no-judge", "--runs", "2"]);
  expect(flags["no-judge"]).toBe(true);
  expect(flags.runs).toBe("2");
});

test("resolveJudgeEnabled defaults to true with no flags or env", () => {
  delete process.env.STAFF_EVAL_JUDGE;
  expect(resolveJudgeEnabled({})).toBe(true);
});

test("resolveJudgeEnabled honours --no-judge over everything else", () => {
  delete process.env.STAFF_EVAL_JUDGE;
  expect(resolveJudgeEnabled({ "no-judge": true })).toBe(false);
  expect(resolveJudgeEnabled({ "no-judge": "yes", judge: true })).toBe(false);
});

test("resolveJudgeEnabled parses an explicit --judge value", () => {
  delete process.env.STAFF_EVAL_JUDGE;
  expect(resolveJudgeEnabled({ judge: "false" })).toBe(false);
  expect(resolveJudgeEnabled({ judge: "true" })).toBe(true);
  expect(resolveJudgeEnabled({ judge: true })).toBe(true);
});

test("resolveJudgeEnabled falls back to STAFF_EVAL_JUDGE env", () => {
  process.env.STAFF_EVAL_JUDGE = "false";
  expect(resolveJudgeEnabled({})).toBe(false);
  process.env.STAFF_EVAL_JUDGE = "on";
  expect(resolveJudgeEnabled({})).toBe(true);
});

test("modelsFromCsv maps explicit models verbatim", () => {
  expect(modelsFromCsv("gpt-5, o3")).toEqual([
    { id: "gpt-5", label: "gpt-5", model: "gpt-5" },
    { id: "o3", label: "o3", model: "o3" },
  ]);
});

test("modelsFromCsv rejects default Codex config", () => {
  expect(() => modelsFromCsv("default")).toThrow(/default.*not supported/);
  expect(() => modelsFromCsv("gpt-5, default")).toThrow(/default.*not supported/);
});

test("skillsFromCsv normalizes, dedupes, and validates known skills", () => {
  expect(skillsFromCsv("staff-review, /staff-review, staff-resolve")).toEqual([
    "/staff-review",
    "/staff-resolve",
  ]);
});

test("skillsFromCsv rejects unknown skills", () => {
  expect(() => skillsFromCsv("staff-nope")).toThrow(/Unknown eval skill/);
});

test("skillsFromCsv expands 'all' to the full skill set", () => {
  const all = skillsFromCsv("all");
  expect(all).toContain("/staff-review");
  expect(all.length).toBeGreaterThan(1);
});
