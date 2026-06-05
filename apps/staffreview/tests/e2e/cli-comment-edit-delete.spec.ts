import { expect, test } from "@playwright/test";
import { readActiveDiff, resetDiffsJson, staff } from "./helpers.ts";

test.beforeEach(async () => {
  await resetDiffsJson();
});

// Covers `staff comment edit` / `staff comment delete` — including that delete
// removes the whole reply subtree (not just direct children) and errors on an
// unknown id. Pure CLI; the only requirement is an active diff.
test("comment edit revises the body; delete removes the full reply subtree", async () => {
  await staff(["diff", "--base", "HEAD", "--head", "working-tree"]); // creates + activates

  const root = JSON.parse(
    await staff([
      "comment",
      "add",
      "--file",
      "math.ts",
      "--line",
      "2",
      "--side",
      "new",
      "--author",
      "cli",
      "--body",
      "original",
    ]),
  );
  expect(root.body).toBe("original");

  // edit returns the updated comment and persists the new body.
  const edited = JSON.parse(await staff(["comment", "edit", "--id", root.id, "--body", "revised"]));
  expect(edited.id).toBe(root.id);
  expect(edited.body).toBe("revised");
  let diff = await readActiveDiff();
  expect(diff.comments.find((c: any) => c.id === root.id).body).toBe("revised");

  // Build a nested thread: reply -> reply-to-the-reply.
  const reply = JSON.parse(
    await staff(["comment", "add", "--reply-to", root.id, "--author", "cli", "--body", "reply"]),
  );
  await staff(["comment", "add", "--reply-to", reply.id, "--author", "cli", "--body", "sub-reply"]);
  diff = await readActiveDiff();
  expect(diff.comments).toHaveLength(3);

  // Deleting the root takes the whole subtree (root + reply + sub-reply) — no
  // orphan left pointing at a deleted parent.
  const out = JSON.parse(await staff(["comment", "delete", "--id", root.id, "--json"]));
  expect(out.removed).toBe(3);
  diff = await readActiveDiff();
  expect(diff.comments).toHaveLength(0);

  // Unknown id errors rather than silently no-op'ing.
  await expect(staff(["comment", "delete", "--id", "deadbeef"])).rejects.toThrow(
    /comment not found/,
  );
});
