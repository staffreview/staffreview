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
    mounts: { source: string; target: string; write_back: boolean }[];
    container: { prepare: string };
  };

  expect(job.command).toContain("pi --print");
  expect(job.command).toContain("pi install npm:@vessup/pi-kit@0.1.2");
  expect(job.command).not.toMatch(/\bamp\b|AMP_API_KEY|@ampcode/);
  expect(job.command).not.toContain("/opt/informant/extensions");
  expect(job.command).not.toContain("staff_files");
  expect(job.runs_on).toContain("mount:pi-auth");
  expect(job.secrets).toEqual(["GITHUB_TOKEN"]);
  expect(job.environment.PI_OFFLINE).toBe("1");
  expect(job.mounts).toEqual([
    { source: "pi-auth", target: "/mnt/informant-pi", write_back: false },
  ]);
  expect(job.container.prepare).not.toContain(".informant/pi");
  expect(job.container.prepare).toContain("@earendil-works/pi-coding-agent@0.84.1");
});

test("configures GitHub Packages authentication for Pi package installation", async () => {
  const npmrc = await Bun.file(join(repositoryRoot, ".npmrc")).text();

  expect(npmrc).toContain("@vessup:registry=https://npm.pkg.github.com");
  expect(npmrc).toContain("//npm.pkg.github.com/:_authToken=$" + "{NODE_AUTH_TOKEN}");
});
