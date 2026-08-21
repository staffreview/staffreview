import { expect, test } from "bun:test";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../../..");

test("Staff Review Informant job runs Pi with trusted review resources", async () => {
  const source = await Bun.file(join(repositoryRoot, ".informant/jobs/staffReview.toml")).text();
  const job = Bun.TOML.parse(source) as {
    command: string;
    runs_on: string[];
    secrets: string[];
    environment: Record<string, string>;
    container: { prepare: string; prepareInputs: string[]; trustedPrepareInputs: boolean };
  };

  expect(job.command).toContain("pi --print");
  expect(job.command).not.toMatch(/\bamp\b|AMP_API_KEY|@ampcode/);
  expect(job.runs_on).toContain("mount:pi-auth");
  expect(job.secrets).toEqual(["GITHUB_TOKEN"]);
  expect(job.environment.PI_CODING_AGENT_DIR).toBe("/mnt/informant-pi");
  expect(job.container.trustedPrepareInputs).toBe(true);
  expect(job.container.prepareInputs).toContain(".informant/pi/informant-subagents.ts");
  expect(job.container.prepare).toContain("@earendil-works/pi-coding-agent@0.84.1");
});

test("vendored review-thread query uses GitHub's current GraphQL schema", async () => {
  const source = await Bun.file(
    join(repositoryRoot, ".informant/pi/informant-subagents.ts"),
  ).text();

  expect(source).toContain("databaseId: fullDatabaseId");
  expect(source).not.toContain("originalStartLine side startSide author");
  expect(source).toContain("side: rawThread.diffSide");
  expect(source).toContain("startSide: rawThread.startDiffSide");
});
