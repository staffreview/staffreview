import { expect, test } from "bun:test";
import { resolve, sep } from "node:path";
import { commonAncestor, formatNumber, relativeFromCwd, shellQuote } from "./util.ts";

test("shellQuote wraps a value in single quotes", () => {
  expect(shellQuote("hello")).toBe("'hello'");
});

test("shellQuote escapes embedded single quotes", () => {
  expect(shellQuote("it's")).toBe("'it'\\''s'");
  // The escaped form is safe to re-interpolate: 'it'\''s' is the standard
  // single-quote escape sequence for zsh/bash.
});

test("formatNumber renders integers without a decimal", () => {
  expect(formatNumber(2)).toBe("2");
  expect(formatNumber(0)).toBe("0");
  expect(formatNumber(-3)).toBe("-3");
});

test("formatNumber keeps one decimal place for non-integers", () => {
  expect(formatNumber(2.04)).toBe("2.0");
  expect(formatNumber(0.04)).toBe("0.0");
  expect(formatNumber(2.5)).toBe("2.5");
  expect(formatNumber(2.46)).toBe("2.5");
});

test("commonAncestor returns cwd for an empty list", () => {
  expect(commonAncestor([])).toBe(process.cwd());
});

test("commonAncestor returns the deepest shared directory for absolute paths", () => {
  const root = resolve(sep, "tmp", "evals");
  expect(
    commonAncestor([resolve(root, "a", "report.html"), resolve(root, "b", "report.html")]),
  ).toBe(root);
});

test("commonAncestor resolves relative inputs before comparing", () => {
  // Regression: relative paths must be resolved against cwd, otherwise the loop
  // walks straight to the filesystem root and returns "/".
  expect(commonAncestor(["a/report.html", "b/report.html"])).toBe(process.cwd());
  expect(commonAncestor(["sub/run", "sub/other"])).toBe(resolve(process.cwd(), "sub"));
  // A single relative path resolves to itself (it is its own common ancestor),
  // never collapsing to the filesystem root.
  expect(commonAncestor(["only-run"])).toBe(resolve(process.cwd(), "only-run"));
});

test("commonAncestor returns the single path when it is the only entry", () => {
  const dir = resolve(sep, "var", "data", "run");
  expect(commonAncestor([dir])).toBe(dir);
});

test("relativeFromCwd shortens paths inside the cwd", () => {
  expect(relativeFromCwd(resolve(process.cwd(), "apps", "x"))).toBe(`apps${sep}x`);
});

test("relativeFromCwd returns '.' for the cwd itself", () => {
  expect(relativeFromCwd(process.cwd())).toBe(".");
});

test("relativeFromCwd leaves paths outside the cwd unchanged", () => {
  const outside = resolve(sep, "elsewhere", "report.html");
  expect(relativeFromCwd(outside)).toBe(outside);
});
