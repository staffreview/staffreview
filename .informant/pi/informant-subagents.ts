import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
	createAgentSession,
	CustomEditor,
	DefaultResourceLoader,
	DynamicBorder,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentSessionEvent,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	type ResourceLoader,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	Container,
	type EditorComponent,
	type Focusable,
	matchesKey,
	SelectList,
	type SelectItem,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
	FOOTER_CONTRIBUTION_EVENT,
	type FooterContribution,
	type FooterUsage,
} from "./informant-footer-events.js";

const MAX_SUBAGENTS = 8;
const MAX_ACTIVITY_ITEMS = 500;
const MAX_TRANSCRIPT_ITEMS = 500;
const MAX_TRANSCRIPT_ENTRY_CHARS = 100_000;
const MAX_TRANSCRIPT_CHARS = 1_000_000;
const MAX_TOOL_OUTPUT_BYTES = 50 * 1024;
const MAX_STAFF_FILE_CONTENT_BYTES = 32 * 1024;
const MAX_STAFF_FILE_LIST_ITEMS = 100;
const MAX_STAFF_THREAD_BODY_BYTES = 32 * 1024;
const MAX_STAFF_THREAD_LIST_ITEMS = 100;
const MAX_GITHUB_REVIEW_THREADS = 1_000;
const MAX_GITHUB_REVIEW_COMMENTS = 10_000;
const MAX_GITHUB_REVIEW_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const GITHUB_REVIEW_REQUEST_TIMEOUT_MS = 30_000;
const REVIEW_TOOL_NAMES = ["read", "grep", "find", "ls", "staff_files", "staff_threads"] as const;
const TRUSTED_SKILL_ROOT = "/opt/informant/skills";
const DEFAULT_READ_WAIT_SECONDS = 15;
const DETAIL_VIEW_LINES = 22;
const USAGE_STATE_ENTRY = "vessup-subagent-usage";
const SUBAGENT_SYSTEM_PROMPT = [
	"You are a subagent working for a main coding agent.",
	"Work independently on the delegated task in the current working directory.",
	"Use tools when useful, keep changes scoped to the task, and finish with a concise report of findings, changes, tests, and remaining risks.",
	"Messages received after the initial task are instructions from the main agent; urgent steering messages supersede your current approach.",
].join(" ");

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type SubagentEffort = (typeof THINKING_LEVELS)[number];
export type SubagentStatus = "creating" | "working" | "completed" | "failed" | "terminating" | "terminated";
export type MessageUrgency = "normal" | "urgent";

type ActivityItem = {
	timestamp: number;
	text: string;
};

type TranscriptItem = {
	timestamp: number;
	role: string;
	text: string;
};

type ManagedSubagent = {
	id: string;
	prompt: string;
	cwd: string;
	createdAt: number;
	updatedAt: number;
	completedAt?: number;
	status: SubagentStatus;
	model: string;
	effort: SubagentEffort;
	currentTool?: string;
	error?: string;
	lastStopReason?: string;
	turns: number;
	queuedSteering: number;
	queuedFollowUp: number;
	activity: ActivityItem[];
	lastReadActivity: number;
	transcript: TranscriptItem[];
	streamingText: string;
	finalOutput?: string;
	lastStreamActivityAt: number;
	usage: Usage;
	session?: AgentSession;
	unsubscribe?: () => void;
	runPromise?: Promise<void>;
	waiters: Set<() => void>;
};

type AgentSnapshot = {
	id: string;
	status: SubagentStatus;
	model: string;
	effort: SubagentEffort;
	turns: number;
	currentTool?: string;
	queued: number;
};

type ToolDetails = {
	agents: AgentSnapshot[];
};

type Usage = FooterUsage;
type AgentModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;
type AnyToolDefinition = ToolDefinition<any, any, any>;
type SessionFactory = typeof createAgentSession;
type ResourceLoaderFactory = (
	options: ConstructorParameters<typeof DefaultResourceLoader>[0],
) => ResourceLoader;
type SubagentManagerDependencies = {
	sessionFactory?: SessionFactory;
	resourceLoaderFactory?: ResourceLoaderFactory;
	modelRuntimeFactory?: (ctx: ExtensionContext) => Promise<ModelRuntime>;
};
type PersistedUsageState = { total: Usage; accounted: Usage };

type ManagerDialogResult =
	| { action: "close" }
	| { action: "view"; id: string }
	| { action: "back" }
	| { action: "model"; id: string }
	| { action: "effort"; id: string }
	| { action: "urgent"; id: string }
	| { action: "queue"; id: string }
	| { action: "terminate"; id: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function parseUsage(value: unknown): Usage | undefined {
	if (!isRecord(value) || !isRecord(value.cost)) return undefined;
	const cost = value.cost;
	const fields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
	if (fields.some((field) => typeof value[field] !== "number" || !Number.isFinite(value[field]))) return undefined;
	const costFields = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;
	if (costFields.some((field) => typeof cost[field] !== "number" || !Number.isFinite(cost[field]))) return undefined;
	return {
		input: value.input as number,
		output: value.output as number,
		cacheRead: value.cacheRead as number,
		cacheWrite: value.cacheWrite as number,
		totalTokens: value.totalTokens as number,
		cost: {
			input: cost.input as number,
			output: cost.output as number,
			cacheRead: cost.cacheRead as number,
			cacheWrite: cost.cacheWrite as number,
			total: cost.total as number,
		},
	};
}

export function parsePersistedUsageState(value: unknown): PersistedUsageState | undefined {
	if (!isRecord(value)) return undefined;
	const total = parseUsage(value.total);
	const accounted = parseUsage(value.accounted);
	return total && accounted ? { total, accounted } : undefined;
}

function cloneUsage(usage: Usage): Usage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: { ...usage.cost },
	};
}

function addUsage(target: Usage, usage: Usage | undefined): void {
	if (!usage) return;
	target.input += usage.input || 0;
	target.output += usage.output || 0;
	target.cacheRead += usage.cacheRead || 0;
	target.cacheWrite += usage.cacheWrite || 0;
	target.totalTokens += usage.totalTokens || 0;
	target.cost.input += usage.cost?.input || 0;
	target.cost.output += usage.cost?.output || 0;
	target.cost.cacheRead += usage.cost?.cacheRead || 0;
	target.cost.cacheWrite += usage.cost?.cacheWrite || 0;
	target.cost.total += usage.cost?.total || 0;
}

function subtractUsage(total: Usage, accounted: Usage): Usage {
	return {
		input: Math.max(0, total.input - accounted.input),
		output: Math.max(0, total.output - accounted.output),
		cacheRead: Math.max(0, total.cacheRead - accounted.cacheRead),
		cacheWrite: Math.max(0, total.cacheWrite - accounted.cacheWrite),
		totalTokens: Math.max(0, total.totalTokens - accounted.totalTokens),
		cost: {
			input: Math.max(0, total.cost.input - accounted.cost.input),
			output: Math.max(0, total.cost.output - accounted.cost.output),
			cacheRead: Math.max(0, total.cost.cacheRead - accounted.cost.cacheRead),
			cacheWrite: Math.max(0, total.cost.cacheWrite - accounted.cost.cacheWrite),
			total: Math.max(0, total.cost.total - accounted.cost.total),
		},
	};
}

function hasUsage(usage: Usage): boolean {
	return (
		usage.input > 0 ||
		usage.output > 0 ||
		usage.cacheRead > 0 ||
		usage.cacheWrite > 0 ||
		usage.totalTokens > 0 ||
		usage.cost.total > 0
	);
}

function formatTokens(count: number): string {
	if (count < 1_000) return `${count}`;
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatClock(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function sanitizeName(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
}

function stringifyCompact(value: unknown, max = 200): string {
	let text: string;
	try {
		text = JSON.stringify(value);
	} catch {
		text = String(value);
	}
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function truncateChars(text: string, maximum: number): string {
	return text.length <= maximum ? text : `${text.slice(0, maximum)}\n[… ${text.length - maximum} characters omitted]`;
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const item = block as Record<string, unknown>;
		if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
		else if (item.type === "thinking" && typeof item.thinking === "string") parts.push(`[thinking]\n${item.thinking}`);
		else if (item.type === "toolCall" && typeof item.name === "string") {
			parts.push(`→ ${item.name} ${stringifyCompact(item.arguments)}`);
		} else if (item.type === "image") {
			parts.push("[image]");
		}
	}
	return parts.join("\n");
}

function messageToTranscript(message: unknown): TranscriptItem | undefined {
	if (!message || typeof message !== "object") return undefined;
	const item = message as Record<string, unknown>;
	if (typeof item.role !== "string") return undefined;
	const text = truncateChars(contentToText(item.content), MAX_TRANSCRIPT_ENTRY_CHARS).trim();
	if (!text) return undefined;
	return {
		timestamp: typeof item.timestamp === "number" ? item.timestamp : Date.now(),
		role: item.role,
		text,
	};
}

function messageUsage(message: unknown): Usage | undefined {
	if (!message || typeof message !== "object") return undefined;
	const usage = (message as Record<string, unknown>).usage;
	if (!usage || typeof usage !== "object") return undefined;
	return usage as Usage;
}

function messageRole(message: unknown): string | undefined {
	return message && typeof message === "object" && typeof (message as Record<string, unknown>).role === "string"
		? ((message as Record<string, unknown>).role as string)
		: undefined;
}

function messageStopReason(message: unknown): string | undefined {
	return message && typeof message === "object" && typeof (message as Record<string, unknown>).stopReason === "string"
		? ((message as Record<string, unknown>).stopReason as string)
		: undefined;
}

function messageError(message: unknown): string | undefined {
	return message && typeof message === "object" && typeof (message as Record<string, unknown>).errorMessage === "string"
		? ((message as Record<string, unknown>).errorMessage as string)
		: undefined;
}

function finalAssistantText(agent: ManagedSubagent): string {
	if (agent.finalOutput !== undefined) return agent.finalOutput;
	for (let index = agent.transcript.length - 1; index >= 0; index--) {
		const item = agent.transcript[index];
		if (item?.role === "assistant") return item.text;
	}
	return agent.streamingText.trim();
}

function isWithin(root: string, path: string): boolean {
	const fromRoot = relative(root, path);
	return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

async function canonicalReviewPath(root: string, rawPath: string): Promise<string> {
	const requested = resolve(root, rawPath.replace(/^@/, ""));
	let canonical: string;
	try {
		canonical = await realpath(requested);
	} catch {
		throw new Error(`Path not found: ${requested}`);
	}
	if (!isWithin(root, canonical) && !isWithin(TRUSTED_SKILL_ROOT, canonical))
		throw new Error("Staff Review tools may only access the workspace or trusted review skills.");
	return canonical;
}

function workspaceTools(root: string, cwd = root): AnyToolDefinition[] {
	const canonical = (path: string) => canonicalReviewPath(root, path);
	return [
		createReadToolDefinition(cwd, {
			autoResizeImages: false,
			operations: {
				async access(path) {
					await access(await canonical(path));
				},
				async readFile(path) {
					return readFile(await canonical(path));
				},
			},
		}),
		createGrepToolDefinition(cwd, {
			operations: {
				async isDirectory(path) {
					return (await stat(await canonical(path))).isDirectory();
				},
				async readFile(path) {
					return readFile(await canonical(path), "utf8");
				},
			},
		}),
		createFindToolDefinition(cwd, {
			operations: {
				async exists(path) {
					try {
						const canonicalPath = await canonical(path);
						return isWithin(root, canonicalPath);
					} catch {
						return false;
					}
				},
				async glob(pattern, searchPath, { limit }) {
					if (isAbsolute(pattern) || /^[A-Za-z]:[\\/]/.test(pattern) || pattern.startsWith("\\\\") || pattern.includes(".."))
						throw new Error("Find patterns must be relative and may not contain parent traversal.");
					const searchRoot = await canonical(searchPath);
					if (!isWithin(root, searchRoot))
						throw new Error("Staff Review find may only search within the workspace.");
					const results: string[] = [];
					for await (const path of new Bun.Glob(pattern).scan({
						cwd: searchRoot,
						dot: true,
						absolute: true,
						followSymlinks: false,
					})) {
						const relativePath = relative(searchRoot, path);
						if (relativePath.split(sep).some((part) => part === ".git" || part === "node_modules")) continue;
						let canonicalMatch: string;
						try {
							canonicalMatch = await realpath(path);
						} catch {
							continue;
						}
						if (!isWithin(root, canonicalMatch)) continue;
						results.push(path);
						if (results.length >= limit) break;
					}
					return results;
				},
			},
		}),
		createLsToolDefinition(cwd, {
			operations: {
				async exists(path) {
					try {
						await canonical(path);
						return true;
					} catch {
						return false;
					}
				},
				async stat(path) {
					return stat(await canonical(path));
				},
				async readdir(path) {
					return readdir(await canonical(path));
				},
			},
		}),
	];
}

type GithubGraphqlRequest = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

type GithubConnection = {
	nodes: Array<Record<string, unknown>>;
	hasNextPage: boolean;
	endCursor: string | null;
};

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
		if (!isRecord(current) || !isRecord(current[key])) throw new Error(`GitHub returned invalid ${label} data.`);
		current = current[key];
	}
	return current as Record<string, unknown>;
}

export async function snapshotGithubReviewThreads(
	options: {
		repository: string;
		pullRequest: number;
		token: string;
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

	const graphql = async (query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> => {
		const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
		const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
		signal.throwIfAborted();
		const response = await request("https://api.github.com/graphql", {
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
		if (!response.ok) throw new Error(`GitHub GraphQL request failed (${response.status}): ${text.slice(0, 500)}`);
		const payload = JSON.parse(text) as unknown;
		if (!isRecord(payload)) throw new Error("GitHub GraphQL returned invalid JSON.");
		if (Array.isArray(payload.errors) && payload.errors.length > 0)
			throw new Error(`GitHub GraphQL error: ${JSON.stringify(payload.errors).slice(0, 1_000)}`);
		return payload;
	};

	const threads: Array<Record<string, unknown>> = [];
	let totalComments = 0;
	let snapshotBytes = Buffer.byteLength(
		JSON.stringify({ repository: options.repository, pullRequest: options.pullRequest, threads: [] }),
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
		const pullRequest = nestedRecord(payload, ["data", "repository", "pullRequest"], "pull request");
		const connection = githubConnection(pullRequest.reviewThreads, "review threads");
		if (threads.length + connection.nodes.length > MAX_GITHUB_REVIEW_THREADS)
			throw new Error(`GitHub review snapshot exceeds ${MAX_GITHUB_REVIEW_THREADS} threads.`);

		for (const rawThread of connection.nodes) {
			if (typeof rawThread.id !== "string") throw new Error("GitHub review thread omitted its id.");
			const initialComments = githubConnection(rawThread.comments, `comments for thread ${rawThread.id}`);
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

type StaffFilePageState = {
	offsets: Map<number, number>;
	totalBytes: number;
};

type StaffFilesSnapshot = {
	files: Array<Record<string, unknown>>;
	filesByPath: Map<string, Record<string, unknown>>;
	pageStates: Map<string, StaffFilePageState>;
};

const staffFilesSnapshots = new Map<string, Promise<StaffFilesSnapshot>>();

function staffFilesResult(payload: unknown) {
	const text = JSON.stringify(payload);
	if (Buffer.byteLength(text, "utf8") > MAX_TOOL_OUTPUT_BYTES)
		throw new Error("Staff Review snapshot page exceeded its output limit.");
	return { content: [{ type: "text" as const, text }], details: {} };
}

function loadStaffFilesSnapshot(snapshotPath: string): Promise<StaffFilesSnapshot> {
	const existing = staffFilesSnapshots.get(snapshotPath);
	if (existing) return existing;

	const loading = readFile(snapshotPath, "utf8").then((text) => {
		const source = JSON.parse(text) as unknown;
		const rawFiles = isRecord(source) && Array.isArray(source.files) ? source.files : [];
		const files: Array<Record<string, unknown>> = [];
		const filesByPath = new Map<string, Record<string, unknown>>();
		for (const file of rawFiles) {
			if (!isRecord(file) || typeof file.path !== "string") throw new Error("Invalid path in Staff Review snapshot.");
			if (filesByPath.has(file.path)) throw new Error(`Duplicate path in Staff Review snapshot: ${file.path}`);
			files.push(file);
			filesByPath.set(file.path, file);
		}
		return { files, filesByPath, pageStates: new Map() };
	});
	staffFilesSnapshots.set(snapshotPath, loading);
	void loading.catch(() => {
		if (staffFilesSnapshots.get(snapshotPath) === loading) staffFilesSnapshots.delete(snapshotPath);
	});
	return loading;
}

function previousUtf16Boundary(content: string, offset: number): number {
	let boundary = Math.min(Math.max(0, offset), content.length);
	if (
		boundary > 0 &&
		boundary < content.length &&
		content.charCodeAt(boundary - 1) >= 0xd800 &&
		content.charCodeAt(boundary - 1) <= 0xdbff &&
		content.charCodeAt(boundary) >= 0xdc00 &&
		content.charCodeAt(boundary) <= 0xdfff
	)
		boundary--;
	return boundary;
}

function staffFileContentPage(
	snapshot: StaffFilesSnapshot,
	file: Record<string, unknown>,
	path: string,
	side: "old" | "new",
	offset: number,
	maximumBytes: number,
) {
	const value = file[`${side}Content`];
	if (value === null || value === undefined) {
		if (offset !== 0) throw new Error("offsetBytes must be 0 when this side has no content.");
		return staffFilesResult({
			file: { path, status: file.status, side, offsetBytes: 0, nextOffsetBytes: null, totalBytes: 0, content: null },
		});
	}
	if (typeof value !== "string") throw new Error(`Invalid ${side} content in Staff Review snapshot: ${path}`);

	const pageKey = JSON.stringify([path, side]);
	let pageState = snapshot.pageStates.get(pageKey);
	if (!pageState) {
		pageState = { offsets: new Map([[0, 0]]), totalBytes: Buffer.byteLength(value, "utf8") };
		snapshot.pageStates.set(pageKey, pageState);
	}
	const characterOffset = pageState.offsets.get(offset);
	if (characterOffset === undefined)
		throw new Error("offsetBytes must be 0 or a value returned by nextOffsetBytes for this file side.");
	if (characterOffset === value.length) {
		return staffFilesResult({
			file: {
				path,
				status: file.status,
				side,
				offsetBytes: offset,
				nextOffsetBytes: null,
				totalBytes: pageState.totalBytes,
				content: "",
			},
		});
	}

	let end = previousUtf16Boundary(value, Math.min(value.length, characterOffset + maximumBytes));
	while (end > characterOffset) {
		const content = value.slice(characterOffset, end);
		const contentBytes = Buffer.byteLength(content, "utf8");
		if (contentBytes > maximumBytes) {
			end = previousUtf16Boundary(value, characterOffset + Math.floor((end - characterOffset) / 2));
			continue;
		}
		const nextOffsetBytes = end < value.length ? offset + contentBytes : null;
		try {
			const result = staffFilesResult({
				file: {
					path,
					status: file.status,
					side,
					offsetBytes: offset,
					nextOffsetBytes,
					totalBytes: pageState.totalBytes,
					content,
				},
			});
			if (nextOffsetBytes !== null) pageState.offsets.set(nextOffsetBytes, end);
			return result;
		} catch {
			end = previousUtf16Boundary(value, characterOffset + Math.floor((end - characterOffset) / 2));
		}
	}
	throw new Error("Unable to fit Staff Review content in a bounded tool response.");
}

const StaffFilesParams = Type.Object({
	path: Type.Optional(Type.String()),
	side: Type.Optional(StringEnum(["old", "new"] as const)),
	cursor: Type.Optional(Type.Integer({ minimum: 0 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_STAFF_FILE_LIST_ITEMS })),
	offsetBytes: Type.Optional(Type.Integer({ minimum: 0 })),
	maxBytes: Type.Optional(Type.Integer({ minimum: 4, maximum: MAX_STAFF_FILE_CONTENT_BYTES })),
});

export function staffFilesTool() {
	return {
		name: "staff_files",
		label: "Staff Review files",
		description:
			"Read the immutable Staff Review diff snapshot in bounded pages. Omit path to list changed files and follow nextCursor. Pass one path and side, then follow nextOffsetBytes until null to read that content.",
		parameters: StaffFilesParams,
		async execute(_toolCallId: string, params: Static<typeof StaffFilesParams>) {
			const snapshotPath = process.env.INFORMANT_STAFF_FILES ?? "/tmp/staff-review-files.json";
			const snapshot = await loadStaffFilesSnapshot(snapshotPath);
			if (params.path !== undefined) {
				if (params.side === undefined) throw new Error("side is required when path is provided.");
				if (params.cursor !== undefined || params.limit !== undefined)
					throw new Error("cursor and limit are only valid when listing changed files.");
				const file = snapshot.filesByPath.get(params.path);
				if (!file) throw new Error(`Changed file not found in Staff Review snapshot: ${params.path}`);
				return staffFileContentPage(
					snapshot,
					file,
					params.path,
					params.side,
					params.offsetBytes ?? 0,
					params.maxBytes ?? MAX_STAFF_FILE_CONTENT_BYTES,
				);
			}
			if (params.side !== undefined || params.offsetBytes !== undefined || params.maxBytes !== undefined)
				throw new Error("path is required when reading file content.");

			const cursor = params.cursor ?? 0;
			if (cursor > snapshot.files.length) throw new Error("cursor exceeds the changed-file count.");
			const limit = params.limit ?? MAX_STAFF_FILE_LIST_ITEMS;
			const listed: Array<{ path: string; status: unknown }> = [];
			for (let index = cursor; index < snapshot.files.length && listed.length < limit; index++) {
				const file = snapshot.files[index];
				if (!file || typeof file.path !== "string") throw new Error("Invalid path in Staff Review snapshot.");
				const candidate = [...listed, { path: file.path, status: file.status }];
				const nextCursor = cursor + candidate.length < snapshot.files.length ? cursor + candidate.length : null;
				try {
					staffFilesResult({ files: candidate, nextCursor, totalFiles: snapshot.files.length });
					listed.push({ path: file.path, status: file.status });
				} catch {
					if (listed.length === 0) throw new Error("Changed-file metadata exceeds the Staff Review output limit.");
					break;
				}
			}
			const nextCursor = cursor + listed.length < snapshot.files.length ? cursor + listed.length : null;
			return staffFilesResult({ files: listed, nextCursor, totalFiles: snapshot.files.length });
		},
	};
}

type StaffThreadPageState = {
	offsets: Map<number, number>;
	totalBytes: number;
};

type StaffThreadsSnapshot = {
	threads: Array<Record<string, unknown>>;
	threadsById: Map<string, Record<string, unknown>>;
	commentsByThread: Map<string, Array<Record<string, unknown>>>;
	commentsById: Map<string, { threadId: string; comment: Record<string, unknown> }>;
	pageStates: Map<string, StaffThreadPageState>;
};

const staffThreadsSnapshots = new Map<string, Promise<StaffThreadsSnapshot>>();

function loadStaffThreadsSnapshot(snapshotPath: string): Promise<StaffThreadsSnapshot> {
	const existing = staffThreadsSnapshots.get(snapshotPath);
	if (existing) return existing;
	const loading = readFile(snapshotPath, "utf8").then((text) => {
		const source = JSON.parse(text) as unknown;
		const rawThreads = isRecord(source) && Array.isArray(source.threads) ? source.threads : [];
		const threads: Array<Record<string, unknown>> = [];
		const threadsById = new Map<string, Record<string, unknown>>();
		const commentsByThread = new Map<string, Array<Record<string, unknown>>>();
		const commentsById = new Map<string, { threadId: string; comment: Record<string, unknown> }>();
		for (const thread of rawThreads) {
			if (!isRecord(thread) || typeof thread.id !== "string")
				throw new Error("Invalid thread in Staff Review GitHub snapshot.");
			if (threadsById.has(thread.id)) throw new Error(`Duplicate thread in Staff Review snapshot: ${thread.id}`);
			if (!Array.isArray(thread.comments)) throw new Error(`Invalid comments for Staff Review thread: ${thread.id}`);
			const comments: Array<Record<string, unknown>> = [];
			for (const comment of thread.comments) {
				if (!isRecord(comment) || typeof comment.id !== "string" || typeof comment.body !== "string")
					throw new Error(`Invalid comment in Staff Review thread: ${thread.id}`);
				if (commentsById.has(comment.id)) throw new Error(`Duplicate comment in Staff Review snapshot: ${comment.id}`);
				comments.push(comment);
				commentsById.set(comment.id, { threadId: thread.id, comment });
			}
			threads.push(thread);
			threadsById.set(thread.id, thread);
			commentsByThread.set(thread.id, comments);
		}
		return { threads, threadsById, commentsByThread, commentsById, pageStates: new Map() };
	});
	staffThreadsSnapshots.set(snapshotPath, loading);
	void loading.catch(() => {
		if (staffThreadsSnapshots.get(snapshotPath) === loading) staffThreadsSnapshots.delete(snapshotPath);
	});
	return loading;
}

function staffThreadResult(payload: unknown) {
	const text = JSON.stringify(payload);
	if (Buffer.byteLength(text, "utf8") > MAX_TOOL_OUTPUT_BYTES)
		throw new Error("Staff Review thread snapshot page exceeded its output limit.");
	return { content: [{ type: "text" as const, text }], details: {} };
}

function githubAuthor(comment: Record<string, unknown>): unknown {
	return isRecord(comment.author) ? comment.author.login : null;
}

function staffCommentSummary(comment: Record<string, unknown>) {
	const body = comment.body;
	if (typeof body !== "string") throw new Error("Invalid comment body in Staff Review snapshot.");
	return {
		id: comment.id,
		databaseId: comment.databaseId,
		url: comment.url,
		author: githubAuthor(comment),
		createdAt: comment.createdAt,
		path: comment.path,
		line: comment.line,
		originalLine: comment.originalLine,
		startLine: comment.startLine,
		originalStartLine: comment.originalStartLine,
		side: comment.side,
		startSide: comment.startSide,
		bodyPreview: truncateChars(body, 1_000),
	};
}

function staffThreadSummary(snapshot: StaffThreadsSnapshot, thread: Record<string, unknown>) {
	if (typeof thread.id !== "string") throw new Error("Invalid thread id in Staff Review snapshot.");
	const comments = snapshot.commentsByThread.get(thread.id) ?? [];
	return {
		id: thread.id,
		isResolved: thread.isResolved,
		isOutdated: thread.isOutdated,
		path: thread.path,
		line: thread.line,
		startLine: thread.startLine,
		diffSide: thread.diffSide,
		startDiffSide: thread.startDiffSide,
		totalComments: comments.length,
		rootComment: comments[0] ? staffCommentSummary(comments[0]) : null,
	};
}

function staffThreadCommentBodyPage(
	snapshot: StaffThreadsSnapshot,
	threadId: string,
	comment: Record<string, unknown>,
	offset: number,
	maximumBytes: number,
) {
	if (typeof comment.id !== "string" || typeof comment.body !== "string")
		throw new Error("Invalid comment in Staff Review snapshot.");
	let pageState = snapshot.pageStates.get(comment.id);
	if (!pageState) {
		pageState = { offsets: new Map([[0, 0]]), totalBytes: Buffer.byteLength(comment.body, "utf8") };
		snapshot.pageStates.set(comment.id, pageState);
	}
	const characterOffset = pageState.offsets.get(offset);
	if (characterOffset === undefined)
		throw new Error("offsetBytes must be 0 or a value returned by nextOffsetBytes for this comment.");
	if (characterOffset === comment.body.length) {
		return staffThreadResult({
			comment: { ...staffCommentSummary(comment), threadId, offsetBytes: offset, nextOffsetBytes: null, totalBytes: pageState.totalBytes, body: "" },
		});
	}

	let end = previousUtf16Boundary(comment.body, Math.min(comment.body.length, characterOffset + maximumBytes));
	while (end > characterOffset) {
		const body = comment.body.slice(characterOffset, end);
		const bodyBytes = Buffer.byteLength(body, "utf8");
		if (bodyBytes > maximumBytes) {
			end = previousUtf16Boundary(comment.body, characterOffset + Math.floor((end - characterOffset) / 2));
			continue;
		}
		const nextOffsetBytes = end < comment.body.length ? offset + bodyBytes : null;
		try {
			const result = staffThreadResult({
				comment: {
					...staffCommentSummary(comment),
					threadId,
					offsetBytes: offset,
					nextOffsetBytes,
					totalBytes: pageState.totalBytes,
					body,
				},
			});
			if (nextOffsetBytes !== null) pageState.offsets.set(nextOffsetBytes, end);
			return result;
		} catch {
			end = previousUtf16Boundary(comment.body, characterOffset + Math.floor((end - characterOffset) / 2));
		}
	}
	throw new Error("Unable to fit Staff Review comment content in a bounded tool response.");
}

const StaffThreadsParams = Type.Object({
	threadId: Type.Optional(Type.String()),
	commentId: Type.Optional(Type.String()),
	cursor: Type.Optional(Type.Integer({ minimum: 0 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_STAFF_THREAD_LIST_ITEMS })),
	offsetBytes: Type.Optional(Type.Integer({ minimum: 0 })),
	maxBytes: Type.Optional(Type.Integer({ minimum: 4, maximum: MAX_STAFF_THREAD_BODY_BYTES })),
});

export function staffThreadsTool() {
	return {
		name: "staff_threads",
		label: "Staff Review GitHub threads",
		description:
			"Read the immutable pre-review snapshot of existing GitHub review threads. Omit threadId to list threads; pass threadId to list its comments; pass threadId and commentId to read a full comment body in byte-bounded pages.",
		parameters: StaffThreadsParams,
		async execute(_toolCallId: string, params: Static<typeof StaffThreadsParams>) {
			const snapshotPath = process.env.INFORMANT_STAFF_THREADS ?? "/tmp/staff-review-threads.json";
			const snapshot = await loadStaffThreadsSnapshot(snapshotPath);
			if (params.commentId !== undefined) {
				if (params.threadId === undefined) throw new Error("threadId is required when commentId is provided.");
				if (params.cursor !== undefined || params.limit !== undefined)
					throw new Error("cursor and limit are only valid when listing threads or comments.");
				const found = snapshot.commentsById.get(params.commentId);
				if (!found || found.threadId !== params.threadId)
					throw new Error(`Comment not found in Staff Review thread snapshot: ${params.commentId}`);
				return staffThreadCommentBodyPage(
					snapshot,
					params.threadId,
					found.comment,
					params.offsetBytes ?? 0,
					params.maxBytes ?? MAX_STAFF_THREAD_BODY_BYTES,
				);
			}
			if (params.offsetBytes !== undefined || params.maxBytes !== undefined)
				throw new Error("commentId is required when reading comment body content.");

			const cursor = params.cursor ?? 0;
			const limit = params.limit ?? MAX_STAFF_THREAD_LIST_ITEMS;
			if (params.threadId !== undefined) {
				if (!snapshot.threadsById.has(params.threadId))
					throw new Error(`Thread not found in Staff Review snapshot: ${params.threadId}`);
				const comments = snapshot.commentsByThread.get(params.threadId) ?? [];
				if (cursor > comments.length) throw new Error("cursor exceeds the thread comment count.");
				const listed: ReturnType<typeof staffCommentSummary>[] = [];
				for (let index = cursor; index < comments.length && listed.length < limit; index++) {
					const comment = comments[index];
					if (!comment) continue;
					const candidate = [...listed, staffCommentSummary(comment)];
					const nextCursor = cursor + candidate.length < comments.length ? cursor + candidate.length : null;
					try {
						staffThreadResult({ comments: candidate, nextCursor, totalComments: comments.length });
						listed.push(staffCommentSummary(comment));
					} catch {
						if (listed.length === 0) throw new Error("GitHub comment metadata exceeds the Staff Review output limit.");
						break;
					}
				}
				const nextCursor = cursor + listed.length < comments.length ? cursor + listed.length : null;
				return staffThreadResult({ threadId: params.threadId, comments: listed, nextCursor, totalComments: comments.length });
			}

			if (cursor > snapshot.threads.length) throw new Error("cursor exceeds the GitHub review-thread count.");
			const listed: ReturnType<typeof staffThreadSummary>[] = [];
			for (let index = cursor; index < snapshot.threads.length && listed.length < limit; index++) {
				const thread = snapshot.threads[index];
				if (!thread) continue;
				const candidate = [...listed, staffThreadSummary(snapshot, thread)];
				const nextCursor = cursor + candidate.length < snapshot.threads.length ? cursor + candidate.length : null;
				try {
					staffThreadResult({ threads: candidate, nextCursor, totalThreads: snapshot.threads.length });
					listed.push(staffThreadSummary(snapshot, thread));
				} catch {
					if (listed.length === 0) throw new Error("GitHub thread metadata exceeds the Staff Review output limit.");
					break;
				}
			}
			const nextCursor = cursor + listed.length < snapshot.threads.length ? cursor + listed.length : null;
			return staffThreadResult({ threads: listed, nextCursor, totalThreads: snapshot.threads.length });
		},
	};
}

function reviewTools(root: string, cwd = root): AnyToolDefinition[] {
	return [...workspaceTools(root, cwd), staffFilesTool(), staffThreadsTool()];
}

export function isFailedStopReason(stopReason: string | undefined): boolean {
	return stopReason === "error" || stopReason === "aborted";
}

export function countsAgainstSubagentLimit(agent: { status: SubagentStatus; session?: unknown }): boolean {
	return agent.status === "creating" || agent.session !== undefined;
}

function wasTerminated(agent: { status: SubagentStatus }): boolean {
	return agent.status === "terminating" || agent.status === "terminated";
}

export class SubagentCapacity {
	private pendingCreations = 0;

	constructor(private readonly maximum: number) {}

	reserve(activeSessions: number): () => void {
		if (activeSessions + this.pendingCreations >= this.maximum) {
			throw new Error(
				`At most ${this.maximum} live subagent sessions may be retained at once. Terminate one before creating another.`,
			);
		}
		this.pendingCreations++;
		let reserved = true;
		return () => {
			if (!reserved) return;
			reserved = false;
			this.pendingCreations--;
		};
	}
}

export function filterModelsToScope<T extends { provider: string; id: string }>(
	available: readonly T[],
	scoped: ReadonlyArray<{ model: { provider: string; id: string } }>,
): readonly T[] {
	if (scoped.length === 0) return available;
	const allowed = new Set(scoped.map(({ model }) => `${model.provider}/${model.id}`));
	return available.filter((model) => allowed.has(`${model.provider}/${model.id}`));
}

function statusIcon(status: SubagentStatus): string {
	switch (status) {
		case "creating":
		case "working":
		case "terminating":
			return "◐";
		case "completed":
			return "✓";
		case "failed":
			return "✗";
		case "terminated":
			return "■";
	}
}

function statusColor(status: SubagentStatus): "warning" | "success" | "error" | "muted" {
	switch (status) {
		case "creating":
		case "working":
		case "terminating":
			return "warning";
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "terminated":
			return "muted";
	}
}

function truncateToolOutput(text: string): string {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= MAX_TOOL_OUTPUT_BYTES) return text;
	let output = text.slice(0, MAX_TOOL_OUTPUT_BYTES);
	while (Buffer.byteLength(output, "utf8") > MAX_TOOL_OUTPUT_BYTES) output = output.slice(0, -1);
	return `${output}\n\n[Output truncated: ${bytes - Buffer.byteLength(output, "utf8")} bytes omitted. Re-read a specific subagent or use the transcript modal for details.]`;
}

function modelName(model: AgentModel | undefined): string {
	return model ? `${model.provider}/${model.id}` : "no-model";
}

function asFooterUsage(usage: Usage): FooterUsage {
	return cloneUsage(usage);
}

export class SubagentManager {
	readonly agents = new Map<string, ManagedSubagent>();
	private nextId = 1;
	private readonly capacity = new SubagentCapacity(MAX_SUBAGENTS);
	private readonly sessionFactory: SessionFactory;
	private readonly resourceLoaderFactory: ResourceLoaderFactory;
	private currentContext?: ExtensionContext;
	private modelRuntimePromise?: Promise<ModelRuntime>;
	private totalUsage = zeroUsage();
	private accountedUsage = zeroUsage();
	private usageDirty = false;
	private footerSelected = false;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly dependencies: SubagentManagerDependencies = {},
	) {
		this.sessionFactory = dependencies.sessionFactory ?? createAgentSession;
		this.resourceLoaderFactory =
			dependencies.resourceLoaderFactory ?? ((options) => new DefaultResourceLoader(options));
	}

	setContext(ctx: ExtensionContext): void {
		this.currentContext = ctx;
		this.footerSelected = false;
		this.totalUsage = zeroUsage();
		this.accountedUsage = zeroUsage();
		this.usageDirty = false;
		for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
			if (entry.type !== "custom" || entry.customType !== USAGE_STATE_ENTRY) continue;
			const restored = parsePersistedUsageState(entry.data);
			if (restored) {
				this.totalUsage = cloneUsage(restored.total);
				this.accountedUsage = cloneUsage(restored.accounted);
			}
			break;
		}
		this.publishFooter();
	}

	persistUsage(): void {
		if (!this.usageDirty || !hasUsage(this.totalUsage)) return;
		this.pi.appendEntry(USAGE_STATE_ENTRY, {
			total: cloneUsage(this.totalUsage),
			accounted: cloneUsage(this.accountedUsage),
		} satisfies PersistedUsageState);
		this.usageDirty = false;
	}

	clearContext(): void {
		const ctx = this.currentContext;
		if (ctx) {
			this.pi.events.emit(FOOTER_CONTRIBUTION_EVENT, {
				sessionId: ctx.sessionManager.getSessionId(),
				key: "subagents",
				remove: true,
			} satisfies FooterContribution);
		}
		this.currentContext = undefined;
		this.footerSelected = false;
	}

	hasAgents(): boolean {
		return this.agents.size > 0;
	}

	isFooterSelected(): boolean {
		return this.footerSelected;
	}

	setFooterSelected(selected: boolean): void {
		if (this.footerSelected === selected) return;
		this.footerSelected = selected && this.hasAgents();
		this.publishFooter();
	}

	getAgent(id: string): ManagedSubagent {
		const agent = this.agents.get(id);
		if (!agent) throw new Error(`Unknown subagent: ${id}`);
		return agent;
	}

	list(): ManagedSubagent[] {
		return Array.from(this.agents.values()).sort((a, b) => a.createdAt - b.createdAt);
	}

	snapshots(): AgentSnapshot[] {
		return this.list().map((agent) => ({
			id: agent.id,
			status: agent.status,
			model: agent.model,
			effort: agent.effort,
			turns: agent.turns,
			currentTool: agent.currentTool,
			queued: agent.queuedSteering + agent.queuedFollowUp,
		}));
	}

	private makeId(requestedName?: string): string {
		const base = requestedName ? sanitizeName(requestedName) : `agent-${this.nextId++}`;
		if (!base) return this.makeId();
		if (!this.agents.has(base)) return base;
		let suffix = 2;
		while (this.agents.has(`${base}-${suffix}`)) suffix++;
		return `${base}-${suffix}`;
	}

	private activeSessionCount(): number {
		return this.list().filter(countsAgainstSubagentLimit).length;
	}

	private async getModelRuntime(ctx: ExtensionContext): Promise<ModelRuntime> {
		if (!this.modelRuntimePromise) {
			this.modelRuntimePromise = this.dependencies.modelRuntimeFactory?.(ctx) ?? (async () => {
				const runtime = await ModelRuntime.create();
				for (const providerId of ctx.modelRegistry.getRegisteredProviderIds()) {
					const native = ctx.modelRegistry.getRegisteredNativeProvider(providerId);
					if (native) {
						runtime.registerNativeProvider(native);
						continue;
					}
					const config = ctx.modelRegistry.getRegisteredProviderConfig(providerId);
					if (config) runtime.registerProvider(providerId, config);
				}
				return runtime;
			})();
		}
		return this.modelRuntimePromise;
	}

	async availableModels(ctx: ExtensionContext): Promise<readonly AgentModel[]> {
		const available = await (await this.getModelRuntime(ctx)).getAvailable();
		return filterModelsToScope(available, ctx.scopedModels);
	}

	private async resolveModel(ctx: ExtensionContext, requested?: string): Promise<AgentModel | undefined> {
		const available = await this.availableModels(ctx);
		if (!requested) {
			if (!ctx.model) return undefined;
			const current = available.find(
				(model) => model.provider === ctx.model?.provider && model.id === ctx.model.id,
			);
			if (current) return current;
			throw new Error(`The current model is unavailable to subagents: ${modelName(ctx.model)}`);
		}

		const slash = requested.indexOf("/");
		if (slash > 0) {
			const provider = requested.slice(0, slash);
			const id = requested.slice(slash + 1);
			const model = available.find((item) => item.provider === provider && item.id === id);
			if (model) return model;
			const qualifier = ctx.scopedModels.length > 0 ? "outside the session model scope or unavailable" : "unavailable";
			throw new Error(`Model is ${qualifier}: ${requested}`);
		}

		const matches = available.filter((item) => item.id === requested || item.name === requested);
		if (matches.length === 1) return matches[0];
		if (matches.length > 1) {
			throw new Error(`Model name is ambiguous; use provider/model: ${matches.map(modelName).join(", ")}`);
		}
		throw new Error(`Model is unavailable${ctx.scopedModels.length > 0 ? " within the session scope" : ""}: ${requested}`);
	}

	private scopedEffort(ctx: ExtensionContext, model: AgentModel | undefined): SubagentEffort | undefined {
		if (!model) return undefined;
		return ctx.scopedModels.find(
			(scoped) => scoped.model.provider === model.provider && scoped.model.id === model.id,
		)?.thinkingLevel as SubagentEffort | undefined;
	}

	private activity(agent: ManagedSubagent, text: string): void {
		agent.updatedAt = Date.now();
		agent.activity.push({ timestamp: agent.updatedAt, text });
		if (agent.activity.length > MAX_ACTIVITY_ITEMS) {
			const removed = agent.activity.length - MAX_ACTIVITY_ITEMS;
			agent.activity.splice(0, removed);
			agent.lastReadActivity = Math.max(0, agent.lastReadActivity - removed);
		}
		for (const waiter of agent.waiters) waiter();
		agent.waiters.clear();
		this.publishFooter();
	}

	private addTranscript(agent: ManagedSubagent, message: unknown): void {
		const transcript = messageToTranscript(message);
		if (!transcript) return;
		agent.transcript.push(transcript);
		if (agent.transcript.length > MAX_TRANSCRIPT_ITEMS) agent.transcript.splice(0, agent.transcript.length - MAX_TRANSCRIPT_ITEMS);
		let retainedCharacters = agent.transcript.reduce((total, item) => total + item.text.length, 0);
		while (retainedCharacters > MAX_TRANSCRIPT_CHARS && agent.transcript.length > 1) {
			retainedCharacters -= agent.transcript.shift()?.text.length ?? 0;
		}
	}

	private accountUsage(agent: ManagedSubagent, usage: Usage | undefined): void {
		if (!usage) return;
		addUsage(agent.usage, usage);
		addUsage(this.totalUsage, usage);
		this.usageDirty = true;
		this.publishFooter();
	}

	private subscribe(agent: ManagedSubagent, session: AgentSession): void {
		agent.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			switch (event.type) {
				case "agent_start":
					agent.status = "working";
					agent.error = undefined;
					agent.lastStopReason = undefined;
					this.activity(agent, "started an agent turn");
					break;
				case "turn_start":
					agent.turns++;
					this.activity(agent, `started turn ${agent.turns}`);
					break;
				case "tool_execution_start":
					agent.currentTool = event.toolName;
					this.activity(agent, `running ${event.toolName} ${stringifyCompact(event.args)}`);
					break;
				case "tool_execution_end":
					this.activity(agent, `${event.isError ? "failed" : "finished"} ${event.toolName}`);
					agent.currentTool = undefined;
					break;
				case "message_update": {
					const update = event.assistantMessageEvent;
					if (update.type === "text_delta") agent.streamingText += update.delta;
					const now = Date.now();
					if (agent.streamingText && now - agent.lastStreamActivityAt >= 5_000) {
						agent.lastStreamActivityAt = now;
						this.activity(agent, "writing a response");
					}
					break;
				}
				case "message_end": {
					const role = messageRole(event.message);
					if (role === "assistant") agent.finalOutput = contentToText((event.message as { content?: unknown }).content).trim();
					this.addTranscript(agent, event.message);
					if (role === "assistant" || role === "toolResult") this.accountUsage(agent, messageUsage(event.message));
					if (role === "assistant") {
						agent.streamingText = "";
						const stopReason = messageStopReason(event.message);
						agent.lastStopReason = stopReason;
						const error = messageError(event.message);
						if (error) agent.error = error;
						else if (stopReason !== "error" && stopReason !== "aborted") agent.error = undefined;
						this.activity(agent, `assistant response finished${stopReason ? ` (${stopReason})` : ""}`);
					}
					break;
				}
				case "queue_update":
					agent.queuedSteering = event.steering.length;
					agent.queuedFollowUp = event.followUp.length;
					this.activity(
						agent,
						`queue updated: ${agent.queuedSteering} steering, ${agent.queuedFollowUp} follow-up`,
					);
					break;
				case "agent_end":
					if (event.willRetry) this.activity(agent, "waiting to retry");
					break;
				case "agent_settled":
					if (agent.status !== "terminated" && agent.status !== "terminating") {
						const failed = isFailedStopReason(agent.lastStopReason);
						agent.status = failed ? "failed" : "completed";
						agent.completedAt = Date.now();
						this.activity(
							agent,
							failed
								? `failed${agent.error ? `: ${agent.error}` : ` (${agent.lastStopReason})`}`
								: "completed and is waiting for more instructions",
						);
					}
					break;
				case "auto_retry_start":
					this.activity(agent, `retrying after an error (attempt ${event.attempt}/${event.maxAttempts})`);
					break;
				case "compaction_start":
					this.activity(agent, `compacting context (${event.reason})`);
					break;
				case "compaction_end":
					this.accountUsage(agent, event.result?.usage);
					this.activity(
						agent,
						event.errorMessage
							? `context compaction failed: ${event.errorMessage}`
							: event.aborted
								? "context compaction aborted"
								: `context compaction finished (${event.reason})`,
					);
					break;
			}
		});
	}

	private attachRun(agent: ManagedSubagent, promise: Promise<void>): void {
		agent.runPromise = promise
			.then(() => {
				if (agent.status !== "terminated" && agent.status !== "terminating" && agent.status !== "failed") {
					agent.status = "completed";
					agent.completedAt = Date.now();
					this.activity(agent, "task run settled");
				}
			})
			.catch((error: unknown) => {
				if (agent.status === "terminated" || agent.status === "terminating") return;
				agent.status = "failed";
				agent.error = error instanceof Error ? error.message : String(error);
				agent.completedAt = Date.now();
				this.activity(agent, `failed: ${agent.error}`);
			});
	}

	async create(
		ctx: ExtensionContext,
		options: { prompt: string; name?: string; model?: string; effort?: SubagentEffort; cwd?: string },
		signal?: AbortSignal,
	): Promise<ManagedSubagent> {
		if (signal?.aborted) throw new Error("Subagent creation was cancelled");
		const releaseSlot = this.capacity.reserve(this.activeSessionCount());

		let root: string;
		let cwd: string;
		try {
			root = await realpath(ctx.cwd);
			cwd = await canonicalReviewPath(root, options.cwd ?? ".");
		} finally {
			releaseSlot();
		}

		// Keep this synchronous through insertion so another creation sees this agent.
		const id = this.makeId(options.name);
		const activeTools = this.pi
			.getActiveTools()
			.filter((tool) => REVIEW_TOOL_NAMES.includes(tool as (typeof REVIEW_TOOL_NAMES)[number]));
		const childTools = reviewTools(root, cwd).filter((tool) => activeTools.includes(tool.name));
		const effort = options.effort ?? (ctx.thinkingLevel as SubagentEffort);
		const agent: ManagedSubagent = {
			id,
			prompt: options.prompt,
			cwd,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			status: "creating",
			model: options.model ?? modelName(ctx.model),
			effort,
			turns: 0,
			queuedSteering: 0,
			queuedFollowUp: 0,
			activity: [],
			lastReadActivity: 0,
			transcript: [],
			streamingText: "",
			lastStreamActivityAt: 0,
			usage: zeroUsage(),
			waiters: new Set(),
		};
		this.agents.set(id, agent);
		this.activity(agent, "creating isolated session");

		try {
			const runtime = await this.getModelRuntime(ctx);
			const selectedModel = await this.resolveModel(ctx, options.model);
			const selectedEffort = options.effort ?? this.scopedEffort(ctx, selectedModel) ?? effort;
			agent.effort = selectedEffort;
			const settingsManager = SettingsManager.inMemory({}, { projectTrusted: false });
			const workerSkill = options.prompt.includes("staff-review-verify")
				? "staff-review-verify"
				: options.prompt.includes("staff-review-find")
					? "staff-review-find"
					: undefined;
			if (!workerSkill)
				throw new Error("Staff Review subagents must use a trusted find or verify worker skill");
			const resourceLoader = this.resourceLoaderFactory({
				cwd,
				agentDir: getAgentDir(),
				settingsManager,
				additionalSkillPaths: [resolve(TRUSTED_SKILL_ROOT, `${workerSkill}/SKILL.md`)],
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noContextFiles: true,
				appendSystemPrompt: [SUBAGENT_SYSTEM_PROMPT],
			});
			await resourceLoader.reload();
			if (signal?.aborted) throw new Error("Subagent creation was cancelled");
			if (wasTerminated(agent)) throw new Error("Subagent creation was terminated");

			const { session } = await this.sessionFactory({
				cwd,
				agentDir: getAgentDir(),
				modelRuntime: runtime,
				model: selectedModel,
				thinkingLevel: selectedEffort,
				tools: activeTools,
				customTools: childTools,
				resourceLoader,
				settingsManager,
				sessionManager: SessionManager.inMemory(cwd),
			});
			if (!session.model) {
				session.dispose();
				throw new Error("No authenticated model is available for the subagent");
			}
			if (signal?.aborted || wasTerminated(agent)) {
				session.dispose();
				throw new Error(signal?.aborted ? "Subagent creation was cancelled" : "Subagent creation was terminated");
			}

			agent.session = session;
			agent.model = modelName(session.model);
			agent.effort = session.thinkingLevel as SubagentEffort;
			agent.status = "working";
			this.subscribe(agent, session);
			this.activity(agent, `started with ${agent.model} at ${agent.effort} effort`);
			this.attachRun(agent, session.prompt(options.prompt, { source: "extension" }));
			// Creation already reports these startup events, so the first read waits for new activity.
			agent.lastReadActivity = agent.activity.length;
			return agent;
		} catch (error) {
			const terminated = signal?.aborted || wasTerminated(agent);
			agent.status = terminated ? "terminated" : "failed";
			agent.error = error instanceof Error ? error.message : String(error);
			agent.completedAt = Date.now();
			this.activity(agent, `${agent.status}: ${agent.error}`);
			throw error;
		}
	}

	async send(id: string, message: string, urgency: MessageUrgency): Promise<void> {
		const agent = this.getAgent(id);
		const session = agent.session;
		if (!session) throw new Error(`Subagent ${id} no longer has a live session`);
		if (agent.status === "terminating" || agent.status === "terminated") {
			throw new Error(`Subagent ${id} is ${agent.status}`);
		}

		if (session.isStreaming) {
			if (urgency === "urgent") await session.steer(message);
			else await session.followUp(message);
			this.activity(agent, `${urgency === "urgent" ? "steered with" : "queued"} instruction: ${truncateChars(message, 160)}`);
			return;
		}

		agent.status = "working";
		this.activity(agent, `started follow-on instruction: ${truncateChars(message, 160)}`);
		this.attachRun(agent, session.prompt(message, { source: "extension" }));
	}

	async configure(
		ctx: ExtensionContext,
		id: string,
		options: { model?: string; effort?: SubagentEffort },
	): Promise<ManagedSubagent> {
		const agent = this.getAgent(id);
		const session = agent.session;
		if (!session) throw new Error(`Subagent ${id} no longer has a live session`);
		if (!options.model && !options.effort) throw new Error("Specify a model, effort, or both");

		if (options.model) {
			const model = await this.resolveModel(ctx, options.model);
			if (!model) throw new Error("No model was selected");
			await session.setModel(model);
			agent.model = modelName(session.model);
			const pinnedEffort = this.scopedEffort(ctx, model);
			if (!options.effort && pinnedEffort) session.setThinkingLevel(pinnedEffort);
			agent.effort = session.thinkingLevel as SubagentEffort;
			this.activity(agent, `model changed to ${agent.model} at ${agent.effort} effort`);
		}
		if (options.effort) {
			session.setThinkingLevel(options.effort);
			agent.effort = session.thinkingLevel as SubagentEffort;
			this.activity(agent, `effort changed to ${agent.effort}`);
		}
		return agent;
	}

	async terminate(id: string, remove = false): Promise<ManagedSubagent> {
		const agent = this.getAgent(id);
		if (agent.status !== "terminated") {
			agent.status = "terminating";
			this.activity(agent, "termination requested");
			const session = agent.session;
			if (session) {
				try {
					await session.abort();
				} catch (error) {
					agent.error = error instanceof Error ? error.message : String(error);
				} finally {
					agent.unsubscribe?.();
					agent.unsubscribe = undefined;
					try {
						session.dispose();
					} catch (error) {
						agent.error = error instanceof Error ? error.message : String(error);
					}
					agent.session = undefined;
				}
			}
			agent.status = "terminated";
			agent.completedAt = Date.now();
			this.activity(agent, "terminated and released session resources");
		}
		if (remove) {
			this.agents.delete(id);
			this.footerSelected = false;
			this.publishFooter();
		}
		return agent;
	}

	async terminateAll(remove = false): Promise<void> {
		await Promise.all(this.list().map(async (agent) => this.terminate(agent.id, remove)));
	}

	private hasUnread(agent: ManagedSubagent): boolean {
		return agent.lastReadActivity < agent.activity.length;
	}

	async waitForUpdates(agents: ManagedSubagent[], seconds: number, signal?: AbortSignal): Promise<void> {
		if (seconds <= 0 || agents.some((agent) => this.hasUnread(agent))) return;
		const running = agents.filter((agent) => agent.status === "creating" || agent.status === "working");
		if (running.length === 0) return;

		await new Promise<void>((done) => {
			let finished = false;
			const finish = () => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				for (const agent of running) agent.waiters.delete(finish);
				signal?.removeEventListener("abort", finish);
				done();
			};
			const timer = setTimeout(finish, Math.min(30, seconds) * 1_000);
			for (const agent of running) agent.waiters.add(finish);
			signal?.addEventListener("abort", finish, { once: true });
		});
	}

	read(agents: ManagedSubagent[], includeTranscript: boolean, completedOutput: boolean): string {
		if (agents.length === 0) return "No subagents are involved in this session.";
		const now = Date.now();
		const sections: string[] = [];
		for (const agent of agents) {
			const heading = `## ${statusIcon(agent.status)} ${agent.id} — ${agent.status}`;
			const metadata = [
				`Model: ${agent.model}`,
				`Effort: ${agent.effort}`,
				`Elapsed: ${formatDuration((agent.completedAt ?? now) - agent.createdAt)}`,
				`Turns: ${agent.turns}`,
				`Usage: ↑${formatTokens(agent.usage.input)} ↓${formatTokens(agent.usage.output)}${agent.usage.cost.total ? ` $${agent.usage.cost.total.toFixed(4)}` : ""}`,
			];
			if (agent.currentTool) metadata.push(`Current tool: ${agent.currentTool}`);
			if (agent.queuedSteering || agent.queuedFollowUp) {
				metadata.push(`Queued: ${agent.queuedSteering} steering, ${agent.queuedFollowUp} follow-up`);
			}
			if (agent.error) metadata.push(`Error: ${agent.error}`);

			const unread = agent.activity.slice(agent.lastReadActivity);
			const activity = unread.length
				? unread.map((item) => `- ${formatClock(item.timestamp)} ${item.text}`).join("\n")
				: "- No new activity.";
			agent.lastReadActivity = agent.activity.length;

			let output = `${heading}\n${metadata.join("\n")}\n\nActivity since last read:\n${activity}`;
			if (completedOutput && agents.length === 1 && (agent.status === "completed" || agent.status === "failed")) {
				const latest = finalAssistantText(agent);
				return latest || `Subagent ${agent.id} finished without assistant output.`;
			}
			if (includeTranscript) {
				const transcript = agent.transcript
					.map((item) => `### ${formatClock(item.timestamp)} ${item.role}\n${item.text}`)
					.join("\n\n");
				output += `\n\nTranscript:\n${transcript || agent.streamingText || "(empty)"}`;
			} else {
				const latest = finalAssistantText(agent);
				if (latest) output += `\n\nLatest assistant output:\n${latest}`;
			}
			sections.push(output);
		}
		return truncateToolOutput(sections.join("\n\n---\n\n"));
	}

	claimUnaccountedUsage(): Usage | undefined {
		const usage = subtractUsage(this.totalUsage, this.accountedUsage);
		if (!hasUsage(usage)) return undefined;
		this.accountedUsage = cloneUsage(this.totalUsage);
		this.usageDirty = true;
		this.publishFooter();
		return usage;
	}

	private footerText(): string | undefined {
		if (this.agents.size === 0) return undefined;
		let working = 0;
		let completed = 0;
		let failed = 0;
		let terminated = 0;
		for (const agent of this.agents.values()) {
			if (agent.status === "creating" || agent.status === "working" || agent.status === "terminating") working++;
			else if (agent.status === "completed") completed++;
			else if (agent.status === "failed") failed++;
			else terminated++;
		}
		const parts = [`◆ ${this.agents.size} subagent${this.agents.size === 1 ? "" : "s"}`];
		if (working) parts.push(`${working} working`);
		if (completed) parts.push(`${completed} done`);
		if (failed) parts.push(`${failed} failed`);
		if (terminated) parts.push(`${terminated} stopped`);
		return parts.join(" • ");
	}

	private publishFooter(): void {
		const ctx = this.currentContext;
		if (!ctx) return;
		const statusText = this.footerText();
		const contribution: FooterContribution = {
			sessionId: ctx.sessionManager.getSessionId(),
			key: "subagents",
			status: statusText ? { text: statusText, selected: this.footerSelected } : undefined,
			usage: asFooterUsage(subtractUsage(this.totalUsage, this.accountedUsage)),
		};
		this.pi.events.emit(FOOTER_CONTRIBUTION_EVENT, contribution);
	}
}

interface AppEditorComponent extends EditorComponent, Partial<Focusable> {
	getCursor?: () => { line: number; col: number };
	getLines?: () => string[];
	isShowingAutocomplete?: () => boolean;
	dispose?: () => void;
	actionHandlers?: Map<unknown, () => void>;
	onEscape?: () => void;
	onCtrlD?: () => void;
	onPasteImage?: () => void;
	onExtensionShortcut?: (data: string) => boolean;
}

class FooterNavigationEditor implements EditorComponent, Focusable {
	readonly actionHandlers?: Map<unknown, () => void>;

	constructor(
		private readonly base: AppEditorComponent,
		private readonly keybindings: KeybindingsManager,
		private readonly manager: SubagentManager,
		private readonly openManager: () => void,
	) {
		this.actionHandlers = base.actionHandlers;
	}

	get focused(): boolean {
		return this.base.focused ?? false;
	}
	set focused(value: boolean) {
		if ("focused" in this.base) this.base.focused = value;
	}
	get onSubmit(): ((text: string) => void) | undefined {
		return this.base.onSubmit;
	}
	set onSubmit(value: ((text: string) => void) | undefined) {
		this.base.onSubmit = value;
	}
	get onChange(): ((text: string) => void) | undefined {
		return this.base.onChange;
	}
	set onChange(value: ((text: string) => void) | undefined) {
		this.base.onChange = value;
	}
	get borderColor(): ((text: string) => string) | undefined {
		return this.base.borderColor;
	}
	set borderColor(value: ((text: string) => string) | undefined) {
		this.base.borderColor = value;
	}
	get onEscape(): (() => void) | undefined {
		return this.base.onEscape;
	}
	set onEscape(value: (() => void) | undefined) {
		this.base.onEscape = value;
	}
	get onCtrlD(): (() => void) | undefined {
		return this.base.onCtrlD;
	}
	set onCtrlD(value: (() => void) | undefined) {
		this.base.onCtrlD = value;
	}
	get onPasteImage(): (() => void) | undefined {
		return this.base.onPasteImage;
	}
	set onPasteImage(value: (() => void) | undefined) {
		this.base.onPasteImage = value;
	}
	get onExtensionShortcut(): ((data: string) => boolean) | undefined {
		return this.base.onExtensionShortcut;
	}
	set onExtensionShortcut(value: ((data: string) => boolean) | undefined) {
		this.base.onExtensionShortcut = value;
	}

	render(width: number): string[] {
		return this.base.render(width);
	}
	invalidate(): void {
		this.base.invalidate();
	}
	dispose(): void {
		this.base.dispose?.();
	}
	getText(): string {
		return this.base.getText();
	}
	setText(text: string): void {
		this.base.setText(text);
	}
	addToHistory(text: string): void {
		this.base.addToHistory?.(text);
	}
	insertTextAtCursor(text: string): void {
		this.base.insertTextAtCursor?.(text);
	}
	getExpandedText(): string {
		return this.base.getExpandedText?.() ?? this.base.getText();
	}
	setAutocompleteProvider(provider: Parameters<NonNullable<EditorComponent["setAutocompleteProvider"]>>[0]): void {
		this.base.setAutocompleteProvider?.(provider);
	}
	setPaddingX(padding: number): void {
		this.base.setPaddingX?.(padding);
	}
	setAutocompleteMaxVisible(maximum: number): void {
		this.base.setAutocompleteMaxVisible?.(maximum);
	}

	handleInput(data: string): void {
		if (this.manager.isFooterSelected()) {
			if (this.keybindings.matches(data, "tui.select.confirm")) {
				this.manager.setFooterSelected(false);
				this.openManager();
				return;
			}
			if (
				this.keybindings.matches(data, "tui.select.up") ||
				this.keybindings.matches(data, "tui.select.cancel")
			) {
				this.manager.setFooterSelected(false);
				return;
			}
			this.manager.setFooterSelected(false);
		}

		if (
			this.manager.hasAgents() &&
			this.base.getText().length === 0 &&
			!this.base.isShowingAutocomplete?.() &&
			matchesKey(data, "alt+down")
		) {
			const cursor = this.base.getCursor?.();
			const lines = this.base.getLines?.();
			if (!cursor || !lines || cursor.line === lines.length - 1) {
				this.manager.setFooterSelected(true);
				return;
			}
		}
		this.base.handleInput(data);
	}
}

function padAnsi(text: string, width: number): string {
	const fitted = truncateToWidth(text, Math.max(0, width), "…");
	return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}

function frameLines(theme: Theme, title: string, body: string[], width: number): string[] {
	if (width < 4) return body.map((line) => truncateToWidth(line, width, ""));
	const inner = width - 2;
	const titleText = truncateToWidth(` ${title} `, Math.max(0, inner - 2), "…");
	const topFill = Math.max(0, inner - visibleWidth(titleText));
	const top = theme.fg("borderAccent", `┌${titleText}${"─".repeat(topFill)}┐`);
	const bottom = theme.fg("borderAccent", `└${"─".repeat(inner)}┘`);
	return [
		top,
		...body.map(
			(line) => theme.fg("borderAccent", "│") + padAnsi(line, inner) + theme.fg("borderAccent", "│"),
		),
		bottom,
	];
}

class AgentListDialog implements Component {
	private selected = 0;
	private timer: ReturnType<typeof setInterval>;

	constructor(
		private readonly manager: SubagentManager,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly done: (result: ManagerDialogResult) => void,
	) {
		this.timer = setInterval(() => tui.requestRender(), 500);
	}

	dispose(): void {
		clearInterval(this.timer);
	}
	invalidate(): void {}

	handleInput(data: string): void {
		const agents = this.manager.list();
		if (this.keybindings.matches(data, "tui.select.cancel")) return this.done({ action: "close" });
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.selected = Math.max(0, this.selected - 1);
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.selected = Math.min(Math.max(0, agents.length - 1), this.selected + 1);
			this.tui.requestRender();
			return;
		}
		const agent = agents[this.selected];
		if (!agent) return;
		if (this.keybindings.matches(data, "tui.select.confirm")) return this.done({ action: "view", id: agent.id });
		if (data === "m") return this.done({ action: "model", id: agent.id });
		if (data === "e") return this.done({ action: "effort", id: agent.id });
		if (data === "x") return this.done({ action: "terminate", id: agent.id });
	}

	render(width: number): string[] {
		const agents = this.manager.list();
		this.selected = Math.min(this.selected, Math.max(0, agents.length - 1));
		const body: string[] = [];
		if (agents.length === 0) body.push(this.theme.fg("muted", " No subagents in this session"));
		for (let index = 0; index < agents.length; index++) {
			const agent = agents[index];
			if (!agent) continue;
			const icon = this.theme.fg(statusColor(agent.status), statusIcon(agent.status));
			const queue = agent.queuedSteering + agent.queuedFollowUp;
			let line = `${index === this.selected ? "›" : " "} ${icon} ${agent.id}  ${agent.status}`;
			if (agent.currentTool) line += ` · ${agent.currentTool}`;
			if (queue) line += ` · ${queue} queued`;
			line += ` · ${agent.model} · ${agent.effort}`;
			if (index === this.selected) line = this.theme.bg("selectedBg", this.theme.fg("accent", line));
			body.push(line);
		}
		body.push("");
		body.push(this.theme.fg("dim", " ↑↓ select · enter transcript · m model · e effort · x terminate · esc close"));
		return frameLines(this.theme, "Subagents", body, width);
	}
}

class AgentDetailDialog implements Component {
	private scrollOffset = 0;
	private timer: ReturnType<typeof setInterval>;

	constructor(
		private readonly agent: ManagedSubagent,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly done: (result: ManagerDialogResult) => void,
	) {
		this.timer = setInterval(() => tui.requestRender(), 300);
	}

	dispose(): void {
		clearInterval(this.timer);
	}
	invalidate(): void {}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel") || data === "b") return this.done({ action: "back" });
		if (this.keybindings.matches(data, "tui.select.up") || this.keybindings.matches(data, "tui.select.pageUp")) {
			this.scrollOffset += this.keybindings.matches(data, "tui.select.pageUp") ? DETAIL_VIEW_LINES : 1;
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down") || this.keybindings.matches(data, "tui.select.pageDown")) {
			this.scrollOffset = Math.max(
				0,
				this.scrollOffset - (this.keybindings.matches(data, "tui.select.pageDown") ? DETAIL_VIEW_LINES : 1),
			);
			this.tui.requestRender();
			return;
		}
		if (data === "m") return this.done({ action: "model", id: this.agent.id });
		if (data === "e") return this.done({ action: "effort", id: this.agent.id });
		if (data === "u") return this.done({ action: "urgent", id: this.agent.id });
		if (data === "q") return this.done({ action: "queue", id: this.agent.id });
		if (data === "x") return this.done({ action: "terminate", id: this.agent.id });
	}

	private transcriptLines(width: number): string[] {
		const lines: string[] = [];
		for (const item of this.agent.transcript) {
			lines.push(this.theme.fg("muted", `[${formatClock(item.timestamp)}] ${item.role}`));
			const roleColor = item.role === "assistant" ? "text" : item.role === "toolResult" ? "dim" : "accent";
			for (const line of wrapTextWithAnsi(this.theme.fg(roleColor, item.text), Math.max(1, width))) lines.push(line);
			lines.push("");
		}
		if (this.agent.streamingText) {
			lines.push(this.theme.fg("warning", "[streaming] assistant"));
			for (const line of wrapTextWithAnsi(this.agent.streamingText, Math.max(1, width))) lines.push(line);
		}
		if (lines.length === 0) lines.push(this.theme.fg("muted", "(transcript is empty)"));
		return lines;
	}

	render(width: number): string[] {
		const inner = Math.max(1, width - 4);
		const allLines = this.transcriptLines(inner);
		const maxOffset = Math.max(0, allLines.length - 1);
		this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
		const end = Math.max(0, allLines.length - this.scrollOffset);
		const start = Math.max(0, end - DETAIL_VIEW_LINES);
		const visible = allLines.slice(start, end);
		const status = this.theme.fg(statusColor(this.agent.status), `${statusIcon(this.agent.status)} ${this.agent.status}`);
		const body = [
			` ${status} · ${this.agent.model} · effort ${this.agent.effort} · ${formatDuration(Date.now() - this.agent.createdAt)}`,
			this.theme.fg("dim", ` Task: ${truncateChars(this.agent.prompt.replace(/\s+/g, " "), 180)}`),
			this.theme.fg(
				"dim",
				` Usage: ↑${formatTokens(this.agent.usage.input)} ↓${formatTokens(this.agent.usage.output)}${this.agent.usage.cost.total ? ` $${this.agent.usage.cost.total.toFixed(4)}` : ""}`,
			),
			this.theme.fg("borderMuted", " " + "─".repeat(Math.max(0, inner - 1))),
			...visible.map((line) => ` ${line}`),
			this.theme.fg("borderMuted", " " + "─".repeat(Math.max(0, inner - 1))),
			this.theme.fg(
				"dim",
				` ↑↓/pg scroll${this.scrollOffset ? ` · ${this.scrollOffset} lines below` : ""} · m model · e effort · u steer · q queue · x terminate · b back`,
			),
		];
		return frameLines(this.theme, this.agent.id, body, width);
	}
}

async function selectOverlay(
	ctx: ExtensionContext,
	title: string,
	items: SelectItem[],
): Promise<string | undefined> {
	if (ctx.mode !== "tui") return undefined;
	return ctx.ui.custom<string | undefined>(
		(tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
			container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
			const list = new SelectList(items, Math.min(12, Math.max(1, items.length)), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(undefined);
			container.addChild(list);
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate · enter select · esc cancel"), 1, 0));
			container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
			return {
				render: (width) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data) => {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		},
		{ overlay: true, overlayOptions: { anchor: "center", width: "70%", maxHeight: "80%", minWidth: 48 } },
	);
}

async function showManager(manager: SubagentManager, ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("The subagent manager is only available in TUI mode", "warning");
		return;
	}

	let detailId: string | undefined;
	while (true) {
		let result: ManagerDialogResult;
		if (detailId && manager.agents.has(detailId)) {
			const agent = manager.getAgent(detailId);
			result = await ctx.ui.custom<ManagerDialogResult>(
				(tui, theme, keybindings, done) => new AgentDetailDialog(agent, tui, theme, keybindings, done),
				{ overlay: true, overlayOptions: { anchor: "center", width: "85%", maxHeight: "90%", minWidth: 56 } },
			);
		} else {
			detailId = undefined;
			result = await ctx.ui.custom<ManagerDialogResult>(
				(tui, theme, keybindings, done) => new AgentListDialog(manager, tui, theme, keybindings, done),
				{ overlay: true, overlayOptions: { anchor: "center", width: "85%", maxHeight: "85%", minWidth: 56 } },
			);
		}

		if (!result || result.action === "close") return;
		if (result.action === "back") {
			detailId = undefined;
			continue;
		}
		if (result.action === "view") {
			detailId = result.id;
			continue;
		}

		detailId = result.id;
		try {
			if (result.action === "model") {
				const models = await manager.availableModels(ctx);
				const selected = await selectOverlay(
					ctx,
					`Model for ${result.id}`,
					models.map((model) => ({ value: modelName(model), label: model.id, description: `${model.provider} · ${model.name}` })),
				);
				if (selected) await manager.configure(ctx, result.id, { model: selected });
			} else if (result.action === "effort") {
				const selected = await selectOverlay(
					ctx,
					`Effort for ${result.id}`,
					THINKING_LEVELS.map((level) => ({ value: level, label: level })),
				);
				if (selected) await manager.configure(ctx, result.id, { effort: selected as SubagentEffort });
			} else if (result.action === "urgent" || result.action === "queue") {
				const message = await ctx.ui.input(
					result.action === "urgent" ? `Steer ${result.id}` : `Queue for ${result.id}`,
					"Instruction for the subagent",
				);
				if (message) await manager.send(result.id, message, result.action === "urgent" ? "urgent" : "normal");
			} else if (result.action === "terminate") {
				const confirmed = await ctx.ui.confirm("Terminate subagent?", `Stop ${result.id} and release its resources?`);
				if (confirmed) await manager.terminate(result.id);
			}
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	}
}

function toolResult(manager: SubagentManager, text: string): { content: [{ type: "text"; text: string }]; details: ToolDetails; usage?: Usage } {
	const usage = manager.claimUnaccountedUsage();
	return {
		content: [{ type: "text", text }],
		details: { agents: manager.snapshots() },
		...(usage ? { usage } : {}),
	};
}

function stringEnum<T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
) {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values,
		...(options?.description ? { description: options.description } : {}),
		...(options?.default ? { default: options.default } : {}),
	});
}

const EffortSchema = stringEnum(THINKING_LEVELS, {
	description: "Reasoning effort. The selected model may clamp unsupported levels.",
});

const CreateParams = Type.Object({
	prompt: Type.String({ description: "Complete task prompt for the new isolated subagent" }),
	name: Type.Optional(Type.String({ description: "Short stable name used to address the subagent" })),
	model: Type.Optional(Type.String({ description: "Model as provider/model-id, or an unambiguous model id" })),
	effort: Type.Optional(EffortSchema),
	cwd: Type.Optional(Type.String({ description: "Working directory, relative to the main session unless absolute" })),
});

const ReadParams = Type.Object({
	id: Type.Optional(Type.String({ description: "Subagent id. Omit to read all subagents." })),
	completed_output: Type.Optional(Type.Boolean({ description: "For one completed subagent, return its complete final assistant output without activity metadata or truncation." })),
	wait_seconds: Type.Optional(
		Type.Integer({
			description: `Wait for meaningful new activity before returning. Default ${DEFAULT_READ_WAIT_SECONDS}, maximum 30.`,
			minimum: 0,
			maximum: 30,
		}),
	),
	include_transcript: Type.Optional(Type.Boolean({ description: "Include the full retained transcript instead of only latest output" })),
});

const SendParams = Type.Object({
	id: Type.String({ description: "Subagent id" }),
	message: Type.String({ description: "Instruction to send" }),
	urgency: stringEnum(["normal", "urgent"] as const, {
		description: "urgent steers after the current tool batch; normal queues until the current run finishes",
	}),
});

const ConfigureParams = Type.Object({
	id: Type.String({ description: "Subagent id" }),
	model: Type.Optional(Type.String({ description: "New model as provider/model-id, or an unambiguous model id" })),
	effort: Type.Optional(EffortSchema),
});

const TerminateParams = Type.Object({
	id: Type.Optional(Type.String({ description: "Subagent id. Omit with all=true to terminate every subagent." })),
	all: Type.Optional(Type.Boolean({ description: "Terminate every subagent" })),
	remove: Type.Optional(Type.Boolean({ description: "Also remove terminated records from the footer and manager" })),
});

export default function subagentsExtension(pi: ExtensionAPI): void {
	const root = resolve(process.env.INFORMANT_REVIEW_ROOT ?? process.cwd());
	for (const tool of reviewTools(root)) pi.registerTool(tool);
	const manager = new SubagentManager(pi);
	let managerOpen = false;

	const openManager = (ctx: ExtensionContext) => {
		if (managerOpen) return;
		managerOpen = true;
		manager.setFooterSelected(false);
		void showManager(manager, ctx).finally(() => {
			managerOpen = false;
		});
	};

	pi.registerTool({
		name: "subagent_create",
		label: "Create subagent",
		description: `Create a background subagent with an isolated context, model, and reasoning effort. Returns immediately after startup. Up to ${MAX_SUBAGENTS} live subagent sessions are allowed.`,
		promptSnippet: "Create a background subagent with a chosen prompt, model, and effort",
		promptGuidelines: [
			"After subagent_create returns, use subagent_read with its default wait roughly every 15–30 seconds while work continues; briefly tell the user about meaningful progress between polls without narrating every event.",
			"Wait for subagent_create to return before calling another subagent management tool for that id.",
			"Use subagent_send with urgent only when the current approach must change immediately; use normal for work that can wait until the current run finishes.",
			"Use subagent_terminate when delegated work is no longer needed, and clean up retained subagents before finishing when appropriate.",
		],
		parameters: CreateParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const agent = await manager.create(ctx, params, signal);
			return toolResult(
				manager,
				`Created ${agent.id} with ${agent.model} at ${agent.effort} effort. It is running in ${agent.cwd}. Use subagent_read to wait for and inspect progress.`,
			);
		},
		renderCall(args, theme) {
			const name = args.name ? ` ${theme.fg("accent", args.name)}` : "";
			const model = args.model ? ` · ${args.model}` : "";
			const effort = args.effort ? ` · ${args.effort}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("subagent_create"))}${name}${theme.fg("muted", model + effort)}\n${theme.fg("dim", truncateChars(args.prompt, 180))}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.content[0];
			return new Text(theme.fg("toolOutput", text?.type === "text" ? text.text : "Created subagent"), 0, 0);
		},
	});

	pi.registerTool({
		name: "subagent_read",
		label: "Read subagents",
		description: "Wait for and read meaningful subagent activity, status, output, usage, or full transcripts. Omit id to monitor all subagents. Use completed_output=true with one completed id to retrieve an untruncated protocol result.",
		promptSnippet: "Read and monitor background subagent activity and output",
		parameters: ReadParams,
		async execute(_toolCallId, params, signal) {
			if (params.completed_output && !params.id) throw new Error("completed_output requires one subagent id");
			const agents = params.id ? [manager.getAgent(params.id)] : manager.list();
			await manager.waitForUpdates(agents, params.wait_seconds ?? DEFAULT_READ_WAIT_SECONDS, signal);
			if (signal?.aborted) throw new Error("Subagent read was cancelled");
			return toolResult(manager, manager.read(agents, params.include_transcript ?? false, params.completed_output ?? false));
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("subagent_read")) +
					theme.fg("muted", ` ${args.id ?? "all"} · wait ${args.wait_seconds ?? DEFAULT_READ_WAIT_SECONDS}s`),
				0,
				0,
			);
		},
		renderResult(result, { expanded }, theme) {
			const raw = result.content[0];
			const text = raw?.type === "text" ? raw.text : "(no output)";
			return new Text(theme.fg("toolOutput", expanded ? text : text.split("\n").slice(0, 14).join("\n")), 0, 0);
		},
	});

	pi.registerTool({
		name: "subagent_send",
		label: "Message subagent",
		description: "Send an urgent steering message to a running subagent or queue a normal follow-up message for it.",
		promptSnippet: "Steer a subagent urgently or queue a normal follow-up instruction",
		parameters: SendParams,
		async execute(_toolCallId, params) {
			await manager.send(params.id, params.message, params.urgency);
			return toolResult(
				manager,
				params.urgency === "urgent"
					? `Steering message sent to ${params.id}.`
					: `Follow-up message queued for ${params.id}.`,
			);
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent_send"))} ${theme.fg("accent", args.id)} ${theme.fg(args.urgency === "urgent" ? "warning" : "muted", args.urgency)}\n${theme.fg("dim", truncateChars(args.message, 180))}`,
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "subagent_configure",
		label: "Configure subagent",
		description: "Change a retained subagent's model and/or reasoning effort. Changes apply to its next model request.",
		promptSnippet: "Change a subagent model or reasoning effort",
		parameters: ConfigureParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const agent = await manager.configure(ctx, params.id, params);
			return toolResult(manager, `${agent.id} now uses ${agent.model} at ${agent.effort} effort.`);
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent_configure"))} ${theme.fg("accent", args.id)}${theme.fg("muted", `${args.model ? ` · ${args.model}` : ""}${args.effort ? ` · ${args.effort}` : ""}`)}`,
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "subagent_terminate",
		label: "Terminate subagent",
		description: "Abort one or all subagents, dispose their sessions, and optionally remove their retained transcript records.",
		promptSnippet: "Terminate subagents and release their resources",
		parameters: TerminateParams,
		async execute(_toolCallId, params) {
			if (params.all) {
				await manager.terminateAll(params.remove ?? false);
				return toolResult(manager, "Terminated all subagents and released their session resources.");
			}
			if (!params.id) throw new Error("Specify id or all=true");
			await manager.terminate(params.id, params.remove ?? false);
			return toolResult(manager, `Terminated ${params.id} and released its session resources.`);
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent_terminate"))} ${theme.fg("warning", args.all ? "all" : (args.id ?? "?"))}`,
				0,
				0,
			);
		},
	});

	pi.registerCommand("subagents", {
		description: "Open the subagent manager",
		handler: async (_args, ctx) => openManager(ctx),
	});

	pi.registerCommand("subagents-cleanup", {
		description: "Terminate and remove all subagents",
		handler: async (_args, ctx) => {
			await manager.terminateAll(true);
			ctx.ui.notify("All subagents terminated and removed", "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		manager.setContext(ctx);
		if (ctx.mode !== "tui") return;
		const previousFactory = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const base = (previousFactory?.(tui, theme, keybindings) ??
				new CustomEditor(tui, theme, keybindings)) as AppEditorComponent;
			return new FooterNavigationEditor(base, keybindings, manager, () => openManager(ctx));
		});
	});

	pi.on("session_shutdown", async () => {
		manager.setFooterSelected(false);
		try {
			await manager.terminateAll(false);
		} finally {
			manager.persistUsage();
			manager.clearContext();
		}
	});
}
