import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { diffFileForWatchEvent } from "./server.ts";

test("diffFileForWatchEvent keeps canonical diff JSON filenames", () => {
  expect(diffFileForWatchEvent("abc123..WT.json")).toBe("abc123..WT.json");
});

test("diffFileForWatchEvent normalizes atomic-save temp filenames", () => {
  expect(diffFileForWatchEvent("abc123..WT.json.550e8400-e29b-41d4-a716-446655440000.tmp")).toBe(
    "abc123..WT.json",
  );
});

test("diffFileForWatchEvent handles Buffer filenames from fs.watch", () => {
  expect(diffFileForWatchEvent(Buffer.from("abc123..WT.json"))).toBe("abc123..WT.json");
});

test("diffFileForWatchEvent ignores unrelated files and missing filenames", () => {
  expect(diffFileForWatchEvent("abc123..WT.json.lock")).toBeNull();
  expect(diffFileForWatchEvent(null)).toBeNull();
});
