type GithubGraphqlRequest = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type GithubConnection = {
  nodes: Array<Record<string, unknown>>;
  hasNextPage: boolean;
  endCursor: string | null;
};

const GITHUB_REVIEW_REQUEST_TIMEOUT_MS = 30_000;
const MAX_GITHUB_REVIEW_THREADS = 1_000;
const MAX_GITHUB_REVIEW_COMMENTS = 10_000;
const MAX_GITHUB_REVIEW_SNAPSHOT_BYTES = 32 * 1024 * 1024;

const REVIEW_THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line startLine diffSide startDiffSide
          comments(first: 100) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id databaseId: fullDatabaseId url body createdAt diffHunk path line originalLine
              startLine originalStartLine author { login }
            }
          }
        }
      }
    }
  }
}`;

const REVIEW_THREAD_COMMENTS_QUERY = `
query($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id databaseId: fullDatabaseId url body createdAt diffHunk path line originalLine
          startLine originalStartLine author { login }
        }
      }
    }
  }
}`;

function githubConnection(value: unknown, label: string): GithubConnection {
  if (!isRecord(value) || !Array.isArray(value.nodes) || !isRecord(value.pageInfo))
    throw new Error(`GitHub returned an invalid ${label} connection.`);
  const nodes: Array<Record<string, unknown>> = [];
  for (const node of value.nodes) {
    if (!isRecord(node)) throw new Error(`GitHub returned an invalid node in ${label}.`);
    nodes.push(node);
  }
  const hasNextPage = value.pageInfo.hasNextPage;
  const endCursor = value.pageInfo.endCursor;
  if (typeof hasNextPage !== "boolean" || (endCursor !== null && typeof endCursor !== "string"))
    throw new Error(`GitHub returned invalid pagination for ${label}.`);
  if (hasNextPage && !endCursor) throw new Error(`GitHub omitted the next cursor for ${label}.`);
  return { nodes, hasNextPage, endCursor: endCursor as string | null };
}

function nestedRecord(value: unknown, keys: string[], label: string): Record<string, unknown> {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current) || !isRecord(current[key]))
      throw new Error(`GitHub returned invalid ${label} data.`);
    current = current[key];
  }
  return current as Record<string, unknown>;
}

function validatedUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error(`${label} must use HTTP or HTTPS.`);
  url.search = "";
  url.hash = "";
  return url;
}

export function githubGraphqlEndpoint(
  options: { apiUrl?: string; graphqlUrl?: string } = {},
): string {
  const configuredGraphqlUrl =
    options.graphqlUrl ??
    (typeof process !== "undefined" ? process.env.GITHUB_GRAPHQL_URL : undefined);
  if (configuredGraphqlUrl)
    return validatedUrl(configuredGraphqlUrl, "GITHUB_GRAPHQL_URL").toString().replace(/\/$/, "");

  const apiUrl =
    options.apiUrl ??
    (typeof process !== "undefined" ? process.env.GITHUB_API_URL : undefined) ??
    "https://api.github.com";
  const url = validatedUrl(apiUrl, "GITHUB_API_URL");
  const apiPath = url.pathname.replace(/\/+$/, "");
  url.pathname = apiPath.endsWith("/api/v3")
    ? `${apiPath.slice(0, -3)}/graphql`
    : `${apiPath}/graphql`;
  return url.toString().replace(/\/$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function snapshotGithubReviewThreads(
  options: {
    repository: string;
    pullRequest: number;
    token: string;
    apiUrl?: string;
    graphqlUrl?: string;
    signal?: AbortSignal;
    requestTimeoutMs?: number;
  },
  request: GithubGraphqlRequest = fetch,
): Promise<{ repository: string; pullRequest: number; threads: Array<Record<string, unknown>> }> {
  const repositoryParts = options.repository.split("/");
  if (repositoryParts.length !== 2 || repositoryParts.some((part) => !part))
    throw new Error("GitHub repository must be owner/name.");
  if (!Number.isInteger(options.pullRequest) || options.pullRequest <= 0)
    throw new Error("GitHub pull request number must be a positive integer.");
  if (!options.token) throw new Error("A GitHub token is required to snapshot review threads.");
  const requestTimeoutMs = options.requestTimeoutMs ?? GITHUB_REVIEW_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0)
    throw new Error("GitHub request timeout must be a positive integer.");
  const [owner, name] = repositoryParts as [string, string];
  const endpoint = githubGraphqlEndpoint(options);

  const graphql = async (
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    signal.throwIfAborted();
    const response = await request(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${options.token}`,
        "Content-Type": "application/json",
        "User-Agent": "informant-staff-review",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ query, variables }),
      signal,
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(`GitHub GraphQL request failed (${response.status}): ${text.slice(0, 500)}`);
    const payload = JSON.parse(text) as unknown;
    if (!isRecord(payload)) throw new Error("GitHub GraphQL returned invalid JSON.");
    if (Array.isArray(payload.errors) && payload.errors.length > 0)
      throw new Error(`GitHub GraphQL error: ${JSON.stringify(payload.errors).slice(0, 1_000)}`);
    return payload;
  };

  const threads: Array<Record<string, unknown>> = [];
  let totalComments = 0;
  let snapshotBytes = Buffer.byteLength(
    JSON.stringify({
      repository: options.repository,
      pullRequest: options.pullRequest,
      threads: [],
    }),
    "utf8",
  );
  let threadCursor: string | null = null;
  while (true) {
    const payload = await graphql(REVIEW_THREADS_QUERY, {
      owner,
      name,
      number: options.pullRequest,
      cursor: threadCursor,
    });
    const pullRequest = nestedRecord(
      payload,
      ["data", "repository", "pullRequest"],
      "pull request",
    );
    const connection = githubConnection(pullRequest.reviewThreads, "review threads");
    if (threads.length + connection.nodes.length > MAX_GITHUB_REVIEW_THREADS)
      throw new Error(`GitHub review snapshot exceeds ${MAX_GITHUB_REVIEW_THREADS} threads.`);

    for (const rawThread of connection.nodes) {
      if (typeof rawThread.id !== "string") throw new Error("GitHub review thread omitted its id.");
      const initialComments = githubConnection(
        rawThread.comments,
        `comments for thread ${rawThread.id}`,
      );
      const comments = initialComments.nodes.map((comment) => ({
        ...comment,
        side: rawThread.diffSide,
        startSide: rawThread.startDiffSide,
      }));
      if (totalComments + comments.length > MAX_GITHUB_REVIEW_COMMENTS)
        throw new Error(`GitHub review snapshot exceeds ${MAX_GITHUB_REVIEW_COMMENTS} comments.`);
      let commentCursor = initialComments.endCursor;
      let hasMoreComments = initialComments.hasNextPage;
      while (hasMoreComments) {
        const commentsPayload = await graphql(REVIEW_THREAD_COMMENTS_QUERY, {
          id: rawThread.id,
          cursor: commentCursor,
        });
        const node = nestedRecord(commentsPayload, ["data", "node"], `thread ${rawThread.id}`);
        const commentPage = githubConnection(node.comments, `comments for thread ${rawThread.id}`);
        if (totalComments + comments.length + commentPage.nodes.length > MAX_GITHUB_REVIEW_COMMENTS)
          throw new Error(`GitHub review snapshot exceeds ${MAX_GITHUB_REVIEW_COMMENTS} comments.`);
        comments.push(
          ...commentPage.nodes.map((comment) => ({
            ...comment,
            side: rawThread.diffSide,
            startSide: rawThread.startDiffSide,
          })),
        );
        hasMoreComments = commentPage.hasNextPage;
        commentCursor = commentPage.endCursor;
      }
      totalComments += comments.length;
      const thread = { ...rawThread, comments };
      snapshotBytes += Buffer.byteLength(JSON.stringify(thread), "utf8") + 1;
      if (snapshotBytes > MAX_GITHUB_REVIEW_SNAPSHOT_BYTES)
        throw new Error("GitHub review snapshot exceeds its 32 MiB size limit.");
      threads.push(thread);
    }

    if (!connection.hasNextPage) break;
    threadCursor = connection.endCursor;
  }
  return { repository: options.repository, pullRequest: options.pullRequest, threads };
}
