import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  githubGraphqlEndpoint,
  snapshotGithubReviewThreads,
} from "../../../.informant/pi/github-review-threads.ts";

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
  expect(job.container.prepareInputs).toContain(".informant/pi/github-review-threads.ts");
  expect(job.container.prepare).toContain("github-review-threads.ts");
  expect(job.command).toContain("apiUrl: process.env.GITHUB_API_URL");
  expect(job.command).toContain("graphqlUrl: process.env.GITHUB_GRAPHQL_URL");
  expect(job.command).not.toContain("append-system-prompt");
  expect(job.container.prepare).toContain("@earendil-works/pi-coding-agent@0.84.1");
});

test("derives GitHub Enterprise GraphQL endpoints from the configured API URL", () => {
  expect(githubGraphqlEndpoint({ apiUrl: "https://github.example/api/v3" })).toBe(
    "https://github.example/api/graphql",
  );
  expect(
    githubGraphqlEndpoint({
      apiUrl: "https://github.example/api/v3",
      graphqlUrl: "https://graphql.example/custom",
    }),
  ).toBe("https://graphql.example/custom");
  expect(githubGraphqlEndpoint({ apiUrl: "https://api.github.com" })).toBe(
    "https://api.github.com/graphql",
  );
});

test("snapshots paginated review threads through the configured GraphQL endpoint", async () => {
  const requests: Array<{ url: string; variables: Record<string, unknown> }> = [];
  const request = async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { variables: Record<string, unknown> };
    requests.push({ url: String(input), variables: body.variables });
    if (body.variables.id === "thread-1") {
      return Response.json({
        data: {
          node: {
            comments: {
              nodes: [{ id: "comment-2", body: "reply" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    }
    const secondThreadPage = body.variables.cursor === "thread-page-2";
    return Response.json({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: secondThreadPage
              ? {
                  nodes: [
                    {
                      id: "thread-2",
                      isResolved: true,
                      comments: {
                        nodes: [{ id: "comment-3", body: "settled" }],
                        pageInfo: { hasNextPage: false, endCursor: null },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                }
              : {
                  nodes: [
                    {
                      id: "thread-1",
                      isResolved: false,
                      diffSide: "RIGHT",
                      startDiffSide: "LEFT",
                      comments: {
                        nodes: [{ id: "comment-1", body: "open" }],
                        pageInfo: { hasNextPage: true, endCursor: "comment-page-2" },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: true, endCursor: "thread-page-2" },
                },
          },
        },
      },
    });
  };

  const snapshot = await snapshotGithubReviewThreads(
    {
      repository: "owner/repo",
      pullRequest: 38,
      token: "secret",
      apiUrl: "https://github.example/api/v3",
    },
    request,
  );

  expect(snapshot.threads).toHaveLength(2);
  expect(snapshot.threads[0]?.comments).toEqual([
    { id: "comment-1", body: "open", side: "RIGHT", startSide: "LEFT" },
    { id: "comment-2", body: "reply", side: "RIGHT", startSide: "LEFT" },
  ]);
  expect(snapshot.threads[1]?.isResolved).toBe(true);
  expect(requests).toEqual([
    {
      url: "https://github.example/api/graphql",
      variables: { owner: "owner", name: "repo", number: 38, cursor: null },
    },
    {
      url: "https://github.example/api/graphql",
      variables: { id: "thread-1", cursor: "comment-page-2" },
    },
    {
      url: "https://github.example/api/graphql",
      variables: { owner: "owner", name: "repo", number: 38, cursor: "thread-page-2" },
    },
  ]);
});

test("rejects malformed and failed GitHub GraphQL responses", async () => {
  const options = { repository: "owner/repo", pullRequest: 38, token: "secret" };
  const malformed = () => Response.json({ data: { repository: {} } });
  const failed = () => Promise.resolve(new Response("unavailable", { status: 503 }));

  await expect(snapshotGithubReviewThreads(options, malformed)).rejects.toThrow(
    "invalid pull request data",
  );
  await expect(snapshotGithubReviewThreads(options, failed)).rejects.toThrow(
    "GitHub GraphQL request failed (503)",
  );
});
