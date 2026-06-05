import { expect, test } from "@playwright/test";
import { resetDiffsJson, staff } from "./helpers.ts";

// A diff's base must be pinned to a concrete commit, never the moving `HEAD`
// pointer — otherwise the slug (and what the review is anchored to) silently
// changes the moment you commit. This mirrors what the UI's default target and
// the slug path already do; this guards the `--base/--head` CLI path.

test.beforeEach(async () => {
  await resetDiffsJson();
});

test("--base HEAD is pinned to a real commit, not the literal HEAD", async () => {
  const d = JSON.parse(await staff(["diff", "--base", "HEAD", "--head", "working-tree", "--json"]));
  expect(d.slug).not.toContain("HEAD");
  expect(d.slug).toMatch(/^[0-9a-f]{40}\.\.WT$/);
  expect(d.base.kind).toBe("commit");
  expect(d.base.ref).toMatch(/^[0-9a-f]{40}$/);
  // Labelled with the current branch so the stale-base banner can fire.
  expect(d.base.label).toBe("main");
  expect(d.head.kind).toBe("working-tree");
});

test("the default base (no --base flag) is pinned too", async () => {
  const d = JSON.parse(await staff(["diff", "--head", "working-tree", "--json"]));
  expect(d.slug).not.toContain("HEAD");
  expect(d.base.kind).toBe("commit");
  expect(d.base.ref).toMatch(/^[0-9a-f]{40}$/);
});

test("a branch name as base is pinned to its commit with the name as label", async () => {
  const d = JSON.parse(
    await staff(["diff", "--base", "feature/improve-math", "--head", "working-tree", "--json"]),
  );
  expect(d.base.kind).toBe("commit");
  expect(d.base.ref).toMatch(/^[0-9a-f]{40}$/);
  expect(d.base.label).toBe("feature/improve-math");
});
