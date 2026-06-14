import { chmod, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installProject, SKILLS } from "../src/install.ts";
import * as store from "../src/store.ts";
import type { Comment, CommentPriority, Diff } from "../src/types.ts";
import { shellQuote, TIMEOUT_KILL_GRACE_MS } from "./util.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const STAFFREVIEW_ROOT = resolve(__dirname, "..");
const REPOSITORY_ROOT = resolve(STAFFREVIEW_ROOT, "..", "..");
const STAFF_CLI = join(STAFFREVIEW_ROOT, "src", "cli.ts");
export const EVAL_RUNS_DIR = join(__dirname, ".runs");
const SOURCE_CACHE_DIR = join(EVAL_RUNS_DIR, ".staff-sources");

export type StaffTarget = {
  id: string;
  label: string;
  command: string[];
  availableSkills: Set<string>;
  install(repo: string): Promise<void>;
};

type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type PreparedDiff = {
  slug: string;
};

type ExpectedFinding = {
  id: string;
  description?: string;
  file: string | null;
  line?: number;
  priority: CommentPriority;
  groups: string[][];
};

type EvalMetadata = {
  version: 1;
  caseId: string;
  skill: string;
  preparedAt: string;
  slug?: string;
  expectedFindings?: ExpectedFinding[];
  seededThreadIds?: string[];
};

type ScoreCheck = {
  name: string;
  earned: number;
  possible: number;
  detail: string;
};

export type ScoreResult = {
  caseId: string;
  score: number;
  possible: number;
  checks: ScoreCheck[];
};

export type SuiteScoreResult = {
  caseId: "all";
  score: number;
  possible: number;
  cases: ScoreResult[];
};

export type PrepareResult = {
  caseId: string;
  skill: string;
  repo: string;
  runbook: string;
};

export type SkippedCase = {
  caseId: string;
  skill: string;
  reason: string;
};

export type SuitePrepareResult = {
  caseId: "all";
  repo: string;
  runbook: string;
  cases: PrepareResult[];
  skipped: SkippedCase[];
};

type SuiteManifest = {
  version: 1;
  preparedAt: string;
  staffTarget?: string;
  selectedSkills?: string[];
  skipped?: SkippedCase[];
  cases: Array<{
    caseId: string;
    skill?: string;
    repo: string;
    runbook: string;
  }>;
};

type PrepContext = {
  repo: string;
  staffTarget: StaffTarget;
};

export type ScoreTaskLimiter = <T>(task: () => Promise<T>) => Promise<T>;

export type ScoreOptions = {
  judge?: boolean;
  judgeCommand?: string;
  judgeCommandTemplate?: string;
  judgeLimiter?: ScoreTaskLimiter;
  judgeModel?: string;
  judgeTimeoutMs?: number;
};

type ScoreContext = {
  repo: string;
  metadata: EvalMetadata;
  scoreOptions: ScoreOptions;
};

export type EvalCase = {
  id: string;
  title: string;
  skill: string;
  summary: string;
  agentPrompt: string;
  prepare(ctx: PrepContext): Promise<EvalMetadata>;
  score(ctx: ScoreContext): Promise<ScoreResult>;
};

type FileMap = Record<string, string>;

type Semver = {
  tag: string;
  major: number;
  minor: number;
  patch: number;
};

export type VersionOption = {
  value: string;
  label: string;
  hint?: string;
};

export type SkillOption = {
  value: string;
  label: string;
  hint?: string;
};

function isoNow(): string {
  return new Date().toISOString();
}

function dedent(text: string): string {
  const lines = text
    .replace(/^\n/, "")
    .replace(/\n\s*$/, "\n")
    .split("\n");
  const indents = lines
    .filter((line) => line.trim())
    .map((line) => line.match(/^ */)?.[0].length ?? 0);
  const min = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(min)).join("\n");
}

async function run(
  cmd: string[],
  options: { allowFail?: boolean; cwd: string },
): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd,
    env: {
      ...process.env,
      STAFF_CONFIG_DIR: join(options.cwd, ".staffreview", "config"),
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0 && !options.allowFail) {
    throw new Error(`Command failed (${exitCode}): ${cmd.join(" ")}\n${stderr}`);
  }
  return { exitCode, stdout, stderr };
}

export function currentStaffTarget(): StaffTarget {
  return {
    id: "current",
    label: "current",
    command: ["bun", STAFF_CLI],
    availableSkills: new Set(Object.keys(SKILLS).map((skill) => `/${skill}`)),
    install: async (repo: string) => {
      await installProject(repo, () => {});
    },
  };
}

function parseSemverTag(value: string): Semver | undefined {
  const match = value.trim().match(/^v(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return undefined;
  return {
    tag: `v${match[1]}.${match[2]}.${match[3]}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareSemverDesc(a: Semver, b: Semver): number {
  return b.major - a.major || b.minor - a.minor || b.patch - a.patch;
}

function tagsFromLsRemote(output: string): string[] {
  const tags = new Set<string>();
  for (const line of output.split("\n")) {
    const ref = line.trim().split(/\s+/)[1];
    if (!ref || ref.endsWith("^{}")) continue;
    const tag = ref.match(/^refs\/tags\/(v\d+\.\d+\.\d+)$/)?.[1];
    if (tag) tags.add(tag);
  }
  return [...tags];
}

async function availableReleaseTags(): Promise<Semver[]> {
  const remote = await run(["git", "ls-remote", "--tags", "origin", "refs/tags/v*"], {
    cwd: REPOSITORY_ROOT,
    allowFail: true,
  });
  const remoteTags = remote.exitCode === 0 ? tagsFromLsRemote(remote.stdout) : [];
  const local =
    remoteTags.length > 0
      ? remoteTags
      : (
          await run(["git", "tag", "--list", "v*"], {
            cwd: REPOSITORY_ROOT,
          })
        ).stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
  return local
    .map(parseSemverTag)
    .filter((tag): tag is Semver => tag !== undefined)
    .sort(compareSemverDesc);
}

async function latestMinorReleaseTags(): Promise<Semver[]> {
  const byMinor = new Map<string, Semver>();
  for (const tag of await availableReleaseTags()) {
    const key = `${tag.major}.${tag.minor}`;
    const existing = byMinor.get(key);
    if (!existing || compareSemverDesc(tag, existing) < 0) byMinor.set(key, tag);
  }
  return [...byMinor.values()].sort(compareSemverDesc);
}

export async function versionOptions(): Promise<VersionOption[]> {
  const releases = await latestMinorReleaseTags();
  return [
    { value: "current", label: "Current checkout", hint: "source + skills in this branch" },
    ...releases.map((release, index) => ({
      value: release.tag,
      label: release.tag,
      hint:
        index === 0
          ? `latest release, latest ${release.major}.${release.minor}.x`
          : `latest ${release.major}.${release.minor}.x`,
    })),
  ];
}

async function normalizeReleaseVersion(version: string): Promise<string> {
  const trimmed = version.trim();
  if (!trimmed || trimmed === "current") return "current";
  const withoutPrefix = trimmed.replace(/^v/, "");
  if (/^\d+\.\d+\.\d+$/.test(withoutPrefix)) return `v${withoutPrefix}`;
  const minor = withoutPrefix.match(/^(\d+)\.(\d+)$/);
  if (minor) {
    const releases = await latestMinorReleaseTags();
    const release = releases.find(
      (tag) => tag.major === Number(minor[1]) && tag.minor === Number(minor[2]),
    );
    if (release) return release.tag;
  }
  const available = (await latestMinorReleaseTags()).map((tag) => tag.tag).join(", ");
  throw new Error(
    `Unsupported Staff Review version: ${version}. Available minor releases: ${available}`,
  );
}

async function ensureGitTag(tag: string): Promise<void> {
  const existing = await run(["git", "rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{}`], {
    cwd: REPOSITORY_ROOT,
    allowFail: true,
  });
  if (existing.exitCode === 0) return;
  await run(["git", "fetch", "origin", "tag", tag], { cwd: REPOSITORY_ROOT });
}

async function ensureSourceSnapshot(tag: string): Promise<string> {
  await ensureGitTag(tag);
  const root = join(SOURCE_CACHE_DIR, tag);
  const cli = join(root, "apps", "staffreview", "src", "cli.ts");
  const skills = join(root, "apps", "staffreview", "skills");
  const skillTarget = join(root, ".agents", "skills", "staff-review", "SKILL.md");
  const skillsInfo = await stat(skills).catch(() => undefined);
  if (
    (await Bun.file(cli).exists()) &&
    skillsInfo?.isDirectory() &&
    (await Bun.file(skillTarget).exists())
  ) {
    return root;
  }

  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await run(
    ["zsh", "-lc", `git archive --format=tar ${shellQuote(tag)} | tar -x -C ${shellQuote(root)}`],
    { cwd: REPOSITORY_ROOT },
  );
  return root;
}

async function appendGitignoreEntries(repo: string, entries: string[]): Promise<void> {
  const path = join(repo, ".gitignore");
  const file = Bun.file(path);
  let existing = (await file.exists()) ? await file.text() : "";
  const present = new Set(existing.split("\n").map((line) => line.trim().replace(/\/$/, "")));
  const missing = entries.filter((entry) => !present.has(entry.replace(/\/$/, "")));
  if (missing.length === 0) return;
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  existing = `${existing}${prefix}${missing.join("\n")}\n`;
  await writeFile(path, existing);
}

async function installSourceSnapshotProject(repo: string, sourceRoot: string): Promise<void> {
  const sourceSkillsRoot = join(sourceRoot, "apps", "staffreview", "skills");
  const agentsRoot = join(repo, ".agents", "skills");
  const claudeRoot = join(repo, ".claude", "skills");
  await mkdir(claudeRoot, { recursive: true });

  for (const entry of await readdir(sourceSkillsRoot)) {
    if (!entry.endsWith(".md")) continue;
    const name = basename(entry, ".md");
    const canonicalDir = join(agentsRoot, name);
    await mkdir(canonicalDir, { recursive: true });
    await writeFile(join(canonicalDir, "SKILL.md"), await readFile(join(sourceSkillsRoot, entry)));

    const link = join(claudeRoot, name);
    await rm(link, { recursive: true, force: true });
    await symlink(join("..", "..", ".agents", "skills", name), link, "dir");
  }

  await store.ensureDirs(repo);
  await appendGitignoreEntries(repo, [
    ".staffreview/diffs/",
    ".staffreview/attachments/",
    ".staffreview/active.json",
    ".staffreview/section-cache.json",
  ]);
}

async function sourceSnapshotSkills(sourceRoot: string): Promise<Set<string>> {
  const skillsRoot = join(sourceRoot, "apps", "staffreview", "skills");
  const skills = new Set<string>();
  for (const entry of await readdir(skillsRoot)) {
    if (entry.endsWith(".md")) skills.add(`/${basename(entry, ".md")}`);
  }
  return skills;
}

export async function resolveStaffTarget(version: string): Promise<StaffTarget> {
  const normalized = await normalizeReleaseVersion(version);
  if (normalized === "current") return currentStaffTarget();
  const sourceRoot = await ensureSourceSnapshot(normalized);
  const cli = join(sourceRoot, "apps", "staffreview", "src", "cli.ts");
  const availableSkills = await sourceSnapshotSkills(sourceRoot);
  return {
    id: normalized.replace(/^v/, ""),
    label: normalized,
    command: ["bun", cli],
    availableSkills,
    install: async (repo: string) => {
      await installSourceSnapshotProject(repo, sourceRoot);
    },
  };
}

async function writeFiles(root: string, files: FileMap): Promise<void> {
  for (const [path, body] of Object.entries(files)) {
    const fullPath = join(root, path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, body);
  }
}

async function appendFile(root: string, path: string, body: string): Promise<void> {
  const fullPath = join(root, path);
  const current = await readFile(fullPath, "utf8");
  await writeFile(fullPath, `${current}${body}`);
}

async function installEvalWrapper(repo: string, staffTarget: StaffTarget): Promise<void> {
  const binDir = join(repo, ".eval-bin");
  await mkdir(binDir, { recursive: true });
  const command = staffTarget.command.map(shellQuote).join(" ");
  const wrapper = dedent(`
    #!/usr/bin/env bash
    set -euo pipefail
    REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
    export STAFF_CONFIG_DIR="$REPO_ROOT/.staffreview/config"
    exec ${command} --repo "$REPO_ROOT" "$@"
  `);
  const wrapperPath = join(binDir, "staff");
  await writeFile(wrapperPath, wrapper);
  await chmod(wrapperPath, 0o755);
}

async function prepareCommon(
  repo: string,
  baseFiles: FileMap,
  changedFiles: FileMap,
  staffTarget: StaffTarget,
): Promise<void> {
  await rm(repo, { recursive: true, force: true });
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, ".gitignore"), "");
  await writeFiles(repo, baseFiles);
  await staffTarget.install(repo);
  await appendFile(
    repo,
    ".gitignore",
    dedent(`

    # Staff Review eval local state
    .eval-bin/
    .eval-judge/
    eval-metadata.json
    RUN.md
    CODEX_PROMPT.md
    `),
  );
  await run(["git", "init", "-b", "main"], { cwd: repo });
  await run(["git", "config", "user.name", "Staff Review Eval"], { cwd: repo });
  await run(["git", "config", "user.email", "staffreview-eval@example.invalid"], { cwd: repo });
  await run(["git", "add", "."], { cwd: repo });
  await run(["git", "commit", "-m", "base fixture"], { cwd: repo });
  await writeFiles(repo, changedFiles);
  await installEvalWrapper(repo, staffTarget);
}

async function staff(repo: string, args: string[], stdin?: string): Promise<string> {
  const proc = Bun.spawn(["bun", STAFF_CLI, "--repo", repo, ...args], {
    cwd: repo,
    env: {
      ...process.env,
      STAFF_CONFIG_DIR: join(repo, ".staffreview", "config"),
    },
    stdin: stdin === undefined ? "ignore" : "pipe",
    stderr: "pipe",
    stdout: "pipe",
  });
  if (stdin !== undefined) {
    const input = proc.stdin;
    if (!input) throw new Error("stdin pipe was not created for staff command");
    input.write(stdin);
    input.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`staff ${args.join(" ")} failed: ${stderr}`);
  return stdout;
}

async function createWorkingTreeDiff(repo: string): Promise<PreparedDiff> {
  const text = await staff(repo, ["diff", "--base", "HEAD", "--head", "working-tree", "--json"]);
  return JSON.parse(text) as PreparedDiff;
}

async function lineOf(repo: string, path: string, needle: string): Promise<number> {
  const content = await readFile(join(repo, path), "utf8");
  const lines = content.split("\n");
  const index = lines.findIndex((line) => line.includes(needle));
  if (index === -1) throw new Error(`Could not find ${JSON.stringify(needle)} in ${path}`);
  return index + 1;
}

async function writeRunbook(
  repo: string,
  testCase: EvalCase,
  metadata: EvalMetadata,
): Promise<void> {
  const skillName = testCase.skill.replace(/^\//, "");
  const codexPrompt = dedent(`
    You are running an automated Staff Review eval in ${repo}.

    Use the local \`staff\` command from \`${repo}/.eval-bin\`; it points to the Staff Review version under test.

    Read \`.agents/skills/${skillName}/SKILL.md\` and follow it exactly for this task:

    ${testCase.agentPrompt}

    Important constraints:
    - Work only in this fixture repository.
    - Do not commit.
    - Do not ask for clarification.
    - When the skill is complete, stop.
  `);
  const runbook = dedent(`
    # ${testCase.title}

    ${testCase.summary}

    ## Skill Under Test

    ${testCase.skill}

    ## Before Running An Agent

    \`\`\`bash
    cd ${repo}
    export PATH="$PWD/.eval-bin:$PATH"
    staff active --json
    \`\`\`

    ## Agent Prompt

    ${testCase.agentPrompt}

    ## Score This Run

    From the Staff Review repository:

    \`\`\`bash
    bun ${STAFFREVIEW_ROOT}/evals/cli.ts score ${testCase.id} --repo ${repo}
    \`\`\`

    The scorer reads \`eval-metadata.json\` and the local \`.staffreview\` store.
    Do not commit fixture changes before scoring.
  `);
  await writeFile(join(repo, "RUN.md"), runbook);
  await writeFile(join(repo, "CODEX_PROMPT.md"), codexPrompt);
  await writeFile(join(repo, "eval-metadata.json"), JSON.stringify(metadata, null, 2));
}

async function metadataForReviewCase(
  repo: string,
  caseId: string,
  skill: string,
  diff: PreparedDiff,
  expectedFindings: Omit<ExpectedFinding, "line">[],
  lineNeedles: Partial<Record<string, string>>,
): Promise<EvalMetadata> {
  const withLines: ExpectedFinding[] = [];
  for (const finding of expectedFindings) {
    const needle = lineNeedles[finding.id];
    if (finding.file == null) {
      withLines.push(finding);
      continue;
    }
    if (!needle) throw new Error(`Missing line needle for expected finding: ${finding.id}`);
    withLines.push({
      ...finding,
      line: await lineOf(repo, finding.file, needle),
    });
  }
  return {
    version: 1,
    caseId,
    skill,
    preparedAt: isoNow(),
    slug: diff.slug,
    expectedFindings: withLines,
  };
}

async function loadMetadata(repo: string): Promise<EvalMetadata> {
  return JSON.parse(await readFile(join(repo, "eval-metadata.json"), "utf8")) as EvalMetadata;
}

async function loadDiffBySlug(repo: string, slug: string): Promise<Diff> {
  const diff = await store.loadDiff(slug, repo);
  if (!diff) throw new Error(`Diff not found: ${slug}`);
  return diff;
}

async function loadAllDiffs(repo: string): Promise<Diff[]> {
  return store.listDiffs(repo);
}

function rootComments(diff: Diff): Comment[] {
  return diff.comments.filter((comment) => !comment.parentId);
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

function bodyMatches(comment: Comment, groups: string[][]): boolean {
  const body = normalizeText(comment.body);
  return groups.every((group) => group.some((token) => body.includes(token.toLowerCase())));
}

type FindingMatch = {
  bodyScore: number;
  comment: Comment;
  confidence?: number;
  reason?: string;
  source: "deterministic" | "judge";
};

type JudgeAssignment = {
  bodyScore: number;
  commentId: string;
  confidence?: number;
  expectedId: string;
  reason?: string;
};

function scoreJudgeEnabled(options: ScoreOptions): boolean {
  return options.judge !== false;
}

function renderJudgeTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(repo|prompt|promptFile|model)\}/g, (_, key: string) =>
    shellQuote(values[key] ?? ""),
  );
}

function defaultJudgeCommand(prompt: string, options: ScoreOptions): string {
  const resolveCodex = options.judgeCommand
    ? `CODEX_EVAL_BIN=${shellQuote(options.judgeCommand)}`
    : [
        'if [ -x "$HOME/.bun/bin/codex" ]; then',
        '  CODEX_EVAL_BIN="$HOME/.bun/bin/codex";',
        "else",
        '  CODEX_EVAL_BIN="$(command -v codex)";',
        "fi",
      ].join(" ");
  const model = options.judgeModel ? ` --model ${shellQuote(options.judgeModel)}` : "";
  return [
    resolveCodex,
    'test -n "$CODEX_EVAL_BIN"',
    `"$CODEX_EVAL_BIN" --ask-for-approval never exec --sandbox workspace-write --skip-git-repo-check${model} ${shellQuote(prompt)}`,
  ].join(" && ");
}

async function runJudgeShell(
  repo: string,
  command: string,
  timeoutMs: number,
): Promise<{ exitCode: number; stderr: string; stdout: string; timedOut: boolean }> {
  const proc = Bun.spawn(["zsh", "-lc", command], {
    cwd: repo,
    stderr: "pipe",
    stdout: "pipe",
  });
  let timedOut = false;
  // Escalate to SIGKILL after a grace period: a judge subprocess that traps or
  // ignores SIGTERM would otherwise keep `proc.exited` (and the eval) pending
  // forever, defeating the timeout.
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
    killTimer = setTimeout(() => proc.kill("SIGKILL"), TIMEOUT_KILL_GRACE_MS);
  }, timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => {
    clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);
  });
  return { exitCode, stderr, stdout, timedOut };
}

async function runJudgePrompt(
  repo: string,
  prompt: string,
  options: ScoreOptions,
): Promise<string> {
  const dir = join(repo, ".eval-judge");
  await mkdir(dir, { recursive: true });
  const id = crypto.randomUUID();
  const promptFile = join(dir, `${id}.prompt.md`);
  const logFile = join(dir, `${id}.log`);
  await writeFile(promptFile, prompt);
  const command = options.judgeCommandTemplate
    ? renderJudgeTemplate(options.judgeCommandTemplate, {
        model: options.judgeModel ?? "",
        prompt,
        promptFile,
        repo,
      })
    : defaultJudgeCommand(prompt, options);

  const runJudge = () => runJudgeShell(repo, command, options.judgeTimeoutMs ?? 10 * 60 * 1000);
  const result = options.judgeLimiter ? await options.judgeLimiter(runJudge) : await runJudge();
  await writeFile(
    logFile,
    [
      `$ ${command}`,
      "",
      "## prompt",
      prompt,
      "",
      "## stdout",
      result.stdout,
      "",
      "## stderr",
      result.stderr,
      "",
      `exitCode=${result.exitCode}`,
      `timedOut=${result.timedOut}`,
    ].join("\n"),
  );
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(`Eval judge failed; see ${logFile}`);
  }
  return result.stdout;
}

export function parseJudgeJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("Eval judge returned empty output");
  try {
    return JSON.parse(trimmed);
  } catch {}

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1]!.trim());
    } catch {}
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }
  throw new Error("Eval judge did not return a JSON object");
}

function normalizeJudgeAssignments(value: unknown): JudgeAssignment[] {
  if (!value || typeof value !== "object") return [];
  const matches = (value as { matches?: unknown }).matches;
  if (!Array.isArray(matches)) return [];
  const assignments: JudgeAssignment[] = [];
  for (const match of matches) {
    if (!match || typeof match !== "object") continue;
    const item = match as Record<string, unknown>;
    if (typeof item.expectedId !== "string" || typeof item.commentId !== "string") continue;
    const rawBodyScore =
      typeof item.bodyScore === "number"
        ? item.bodyScore
        : typeof item.qualityScore === "number"
          ? item.qualityScore
          : typeof item.score === "number"
            ? item.score
            : undefined;
    if (rawBodyScore === undefined) continue;
    assignments.push({
      bodyScore: Math.max(0, Math.min(25, Math.round(rawBodyScore))),
      commentId: item.commentId,
      confidence: typeof item.confidence === "number" ? item.confidence : undefined,
      expectedId: item.expectedId,
      reason: typeof item.reason === "string" ? item.reason : undefined,
    });
  }
  return assignments;
}

function expectedForJudge(expected: ExpectedFinding) {
  return {
    id: expected.id,
    description: expected.description,
    expectedFile: expected.file,
    expectedLine: expected.line,
    expectedPriority: expected.priority,
    keywordGroups: expected.groups,
  };
}

function commentForJudge(comment: Comment) {
  return {
    id: comment.id,
    file: comment.file ?? null,
    line: comment.line ?? null,
    endLine: comment.endLine ?? null,
    priority: comment.priority ?? null,
    body: comment.body,
  };
}

async function judgeCommentMatches(
  repo: string,
  expectedFindings: ExpectedFinding[],
  comments: Comment[],
  options: ScoreOptions,
): Promise<JudgeAssignment[]> {
  if (!scoreJudgeEnabled(options) || expectedFindings.length === 0 || comments.length === 0) {
    return [];
  }
  const payload = {
    expectedFindings: expectedFindings.map(expectedForJudge),
    comments: comments.map(commentForJudge),
  };
  const prompt = dedent(`
    You are the semantic judge for a Staff Review eval scorer.

    Match and grade candidate review comments against expected findings. Use
    judgement, not keyword matching: different wording should still match when
    the comment clearly reports the same underlying defect and consequence, and
    exact accepted phrases should not match when the comment is wrong or
    misleading. Do not match a comment just because it mentions nearby code, the
    same file, or generic concepts. Each comment can match at most one expected
    finding, and each expected finding can receive at most one comment. Prefer
    the strongest match.

    Assign bodyScore from 0 to 25 for the review comment body only:
    - 0: no match, wrong issue, misleading, or materially incorrect.
    - 8: points at the rough area but misses the real failure mode or impact.
    - 15: identifies the defect but is vague, incomplete, or weakly actionable.
    - 20: correct, specific, and actionable with a useful failure mode.
    - 25: excellent: precise defect, concrete consequence, and clear fix with no
      misleading claims.

    Include only matches with bodyScore > 0. Priority and exact line anchors are
    useful hints but do not affect bodyScore; the scorer handles priority and
    anchor credit separately.
    A null expectedFile means the finding is broad and may be top-level or
    attached to any relevant file.

    Return only this JSON shape with no markdown:
    {
      "matches": [
        {
          "expectedId": "expected finding id",
          "commentId": "comment id",
          "bodyScore": 0,
          "confidence": 0.0,
          "reason": "short reason"
        }
      ]
    }

    If there are no semantic matches, return {"matches":[]}.

    Input:
    ${JSON.stringify(payload, null, 2)}
  `);
  return normalizeJudgeAssignments(parseJudgeJson(await runJudgePrompt(repo, prompt, options)));
}

function expandedFindingGroups(expected: ExpectedFinding): string[][] {
  const expansions: Record<string, string[][]> = {
    "tenant-rate-limit-key": [
      [],
      ["rate-limit", "counter", "bucket"],
      ["across tenants", "tenant-scoped", "isolation", "global"],
    ],
    "export-path-traversal": [["..", "escape", "escapes", "path-like"], ["separator"], []],
    "missing-review-tests": [
      ["test", "tests", "coverage", "regression"],
      ["report", "rate", "tenant", "export", "behavior"],
    ],
    "session-expiry-units": [
      ["session", "expiry", "expired", "timeout", "idle"],
      ["millisecond", "milliseconds", "ms", "seconds", "unit", "units"],
      ["skew", "grace", "early", "soon"],
    ],
    "stale-export-doc": [
      ["comment", "docs", "documentation", "jsdoc"],
      ["allowlist", "daily", "weekly", "known", "supported"],
      ["stale", "misleading", "wrong", "outdated"],
    ],
    "unsupported-report-validation": [
      ["unknown report", "unsupported", "typo", "invalid", "allowlist", "daily", "weekly"],
      ["accepts", "arbitrary", "any string", "contract", "api", "fail"],
      ["report"],
    ],
  };
  const extra = expansions[expected.id] ?? [];
  return expected.groups.map((group, index) => [...new Set([...group, ...(extra[index] ?? [])])]);
}

function commentLineDistance(comment: Comment, line: number): number | undefined {
  if (comment.line == null) return undefined;
  const endLine = comment.endLine ?? comment.line;
  const start = Math.min(comment.line, endLine);
  const end = Math.max(comment.line, endLine);
  if (line >= start && line <= end) return 0;
  return Math.min(Math.abs(start - line), Math.abs(end - line));
}

function anchorScore(comment: Comment, expected: ExpectedFinding): number {
  // A null expected file means the location is broad: the judge prompt tells the
  // evaluator such a finding "may be top-level or attached to any relevant file",
  // so once it has matched, award anchor credit regardless of where the comment
  // is anchored rather than penalizing a file-anchored comment.
  if (expected.file == null) return 5;
  if (comment.file !== expected.file) return 0;
  if (expected.line == null) return 3;
  const distance = commentLineDistance(comment, expected.line);
  if (distance === undefined) return 3;
  return distance <= 3 ? 5 : 3;
}

function expectedLocation(expected: ExpectedFinding): string {
  if (expected.file == null) return "top-level";
  return `${expected.file}:${expected.line ?? "?"}`;
}

function commentLocation(comment: Comment): string {
  if (!comment.file) return "top-level";
  const file = comment.file;
  if (comment.line == null) return `${file}:?`;
  if (comment.endLine && comment.endLine !== comment.line) {
    return `${file}:${comment.line}-${comment.endLine}`;
  }
  return `${file}:${comment.line}`;
}

function findCommentForExpected(
  comments: Comment[],
  expected: ExpectedFinding,
  used: Set<string>,
): Comment | undefined {
  const groups = expandedFindingGroups(expected);
  const candidates = comments.filter((comment) => {
    if (used.has(comment.id)) return false;
    if (expected.file == null) return !comment.file;
    return comment.file === expected.file;
  });
  return (
    candidates.find((comment) => bodyMatches(comment, groups)) ??
    comments.find((comment) => !used.has(comment.id) && bodyMatches(comment, groups))
  );
}

async function matchExpectedFindings(
  repo: string,
  comments: Comment[],
  expectedFindings: ExpectedFinding[],
  options: ScoreOptions,
): Promise<Map<string, FindingMatch>> {
  const matches = new Map<string, FindingMatch>();

  if (scoreJudgeEnabled(options)) {
    const usedComments = new Set<string>();
    const usedExpected = new Set<string>();
    const expectedById = new Map(expectedFindings.map((expected) => [expected.id, expected]));
    const commentById = new Map(comments.map((comment) => [comment.id, comment]));
    for (const assignment of await judgeCommentMatches(repo, expectedFindings, comments, options)) {
      if (usedExpected.has(assignment.expectedId) || usedComments.has(assignment.commentId)) {
        continue;
      }
      if (assignment.bodyScore <= 0) continue;
      if (assignment.confidence !== undefined && assignment.confidence < 0.5) continue;
      const expected = expectedById.get(assignment.expectedId);
      const comment = commentById.get(assignment.commentId);
      if (!expected || !comment) continue;
      usedComments.add(comment.id);
      usedExpected.add(expected.id);
      matches.set(expected.id, {
        bodyScore: assignment.bodyScore,
        comment,
        confidence: assignment.confidence,
        reason: assignment.reason,
        source: "judge",
      });
    }
    return matches;
  }

  const used = new Set<string>();
  for (const expected of expectedFindings) {
    const match = findCommentForExpected(comments, expected, used);
    if (!match) continue;
    used.add(match.id);
    matches.set(expected.id, { bodyScore: 25, comment: match, source: "deterministic" });
  }

  return matches;
}

function matchDetail(match: FindingMatch): string {
  const suffix =
    match.source === "judge"
      ? ` via judge (${match.bodyScore}/25 quality)${
          match.confidence === undefined ? "" : ` (${Math.round(match.confidence * 100)}%)`
        }`
      : "";
  return `Matched by ${match.comment.id.slice(0, 8)} at ${commentLocation(match.comment)}${suffix}`;
}

async function scoreExpectedFindings(
  repo: string,
  diff: Diff,
  expectedFindings: ExpectedFinding[],
  options: ScoreOptions,
): Promise<ScoreCheck[]> {
  const checks: ScoreCheck[] = [];
  const comments = rootComments(diff);
  const matchedIds = new Set<string>();
  const matches = await matchExpectedFindings(repo, comments, expectedFindings, options);

  for (const expected of expectedFindings) {
    const match = matches.get(expected.id);
    if (!match) {
      checks.push({
        name: `finding:${expected.id}`,
        earned: 0,
        possible: 35,
        detail: `No comment matched ${expectedLocation(expected)}`,
      });
      continue;
    }

    matchedIds.add(match.comment.id);
    const anchor = anchorScore(match.comment, expected);
    const priority =
      match.comment.priority === expected.priority ? 5 : match.comment.priority ? 2 : 0;
    checks.push({
      name: `finding:${expected.id}`,
      earned: match.bodyScore + anchor + priority,
      possible: 35,
      detail: matchDetail(match),
    });
  }

  const unmatched = comments.filter((comment) => !matchedIds.has(comment.id));
  checks.push({
    name: "review-noise",
    earned: Math.max(0, 10 - unmatched.length * 5),
    possible: 10,
    detail:
      unmatched.length === 0
        ? "No unmatched root comments"
        : `${unmatched.length} unmatched root comment(s)`,
  });
  checks.push({
    name: "review-leaves-threads-open",
    earned: comments.every((comment) => !comment.resolution) ? 10 : 0,
    possible: 10,
    detail: "Review comments should not be resolved by /staff-review",
  });
  checks.push({
    name: "review-author-attribution",
    earned:
      comments.length > 0 &&
      comments.every((comment) => comment.author && comment.author !== "agent")
        ? 10
        : 0,
    possible: 10,
    detail: "Every posted finding should identify the model in --author",
  });
  return checks;
}

function sumChecks(caseId: string, checks: ScoreCheck[]): ScoreResult {
  const earned = checks.reduce((sum, check) => sum + check.earned, 0);
  const possible = checks.reduce((sum, check) => sum + check.possible, 0);
  return { caseId, score: earned, possible, checks };
}

type ReviewQualityFindingSeed = Omit<ExpectedFinding, "line"> & {
  needle?: string;
};

const reviewQualityFindingSeeds: ReviewQualityFindingSeed[] = [
  {
    id: "tenant-rate-limit-key",
    description:
      "The rate limit key dropped tenantId, so login attempts for the same user and IP collide across tenants and one tenant can consume or block another tenant's bucket.",
    file: "src/rate-limit.ts",
    priority: "P1",
    groups: [
      ["tenant", "tenantid"],
      ["rate limit", "rate-limit", "ratelimit", "attempt", "throttle", "counter", "bucket"],
      [
        "cross-tenant",
        "different tenant",
        "other tenant",
        "between tenants",
        "across tenants",
        "tenant-scoped",
        "isolation",
        "global",
      ],
    ],
    needle: `return \`\${attempt.userId}:\${ip}\`;`,
  },
  {
    id: "export-path-traversal",
    description:
      "exportPath now builds a filesystem path from the raw report name without the old allowlist, so path-like input can escape the export root.",
    file: "src/export-path.ts",
    priority: "P1",
    groups: [
      ["traversal", "../", "..", "outside", "escape", "escapes", "path-like"],
      ["join", "resolve", "normalize", "path", "separator"],
      ["export", "report"],
    ],
    needle: `return join(EXPORT_ROOT, \`\${cleaned}.csv\`);`,
  },
  {
    id: "unsupported-report-validation",
    description:
      "exportPath no longer rejects unknown report names, widening the API contract from the supported daily/weekly reports to arbitrary strings.",
    file: "src/export-path.ts",
    priority: "P2",
    groups: [
      ["unknown report", "unsupported", "typo", "invalid", "allowlist", "daily", "weekly"],
      ["accepts", "arbitrary", "any string", "contract", "api", "fail"],
      ["report"],
    ],
    needle: "export function exportPath(reportName: string): string {",
  },
  {
    id: "session-expiry-units",
    description:
      "CLOCK_SKEW_MS lost the milliseconds conversion and now adds only 300 milliseconds instead of five minutes, making sessions expire too early under normal clock skew.",
    file: "src/session-expiry.ts",
    priority: "P2",
    groups: [
      ["session", "expiry", "expired", "timeout", "idle"],
      ["millisecond", "milliseconds", "ms", "seconds", "unit", "units"],
      ["skew", "grace", "early", "soon"],
    ],
    needle: "const CLOCK_SKEW_MS = 5 * 60;",
  },
  {
    id: "missing-review-tests",
    description:
      "The behavior changes are not covered by regression tests for tenant-scoped rate limits, supported report validation, export path safety, or session expiry units.",
    file: null,
    priority: "P3",
    groups: [
      ["test", "tests", "coverage", "regression"],
      ["report", "rate", "tenant", "export", "behavior"],
    ],
  },
  {
    id: "stale-export-doc",
    description:
      "The exportPath comment still claims it builds paths only for known built-in reports, but the implementation now accepts arbitrary trimmed report names.",
    file: "src/export-path.ts",
    priority: "P3",
    groups: [
      ["comment", "docs", "documentation", "jsdoc"],
      ["allowlist", "daily", "weekly", "known", "supported"],
      ["stale", "misleading", "wrong", "outdated"],
    ],
    needle: "Builds paths for the known built-in reports only.",
  },
];

function reviewQualityLineNeedles(): Partial<Record<string, string>> {
  return Object.fromEntries(
    reviewQualityFindingSeeds
      .filter((finding) => finding.needle)
      .map((finding) => [finding.id, finding.needle!]),
  );
}

function reviewQualitySeedDefaults(): Map<string, Omit<ReviewQualityFindingSeed, "needle">> {
  return new Map(
    reviewQualityFindingSeeds.map((seed) => {
      const { needle: _needle, ...finding } = seed;
      return [finding.id, finding];
    }),
  );
}

function enrichReviewQualityFinding(finding: ExpectedFinding): ExpectedFinding {
  const seed = reviewQualitySeedDefaults().get(finding.id);
  if (!seed) return finding;
  return {
    ...seed,
    ...finding,
    description: finding.description ?? seed.description,
    groups: finding.groups.length > 0 ? finding.groups : seed.groups,
  };
}

async function expectedReviewQualityFindings(repo: string, metadata: EvalMetadata) {
  const expected = (metadata.expectedFindings ?? []).map(enrichReviewQualityFinding);
  const present = new Set(expected.map((finding) => finding.id));
  for (const seed of reviewQualityFindingSeeds) {
    if (present.has(seed.id)) continue;
    const { needle, ...finding } = seed;
    if (seed.file == null) {
      expected.push(finding);
      continue;
    }
    if (!needle) continue;
    const line = await lineOf(repo, seed.file, needle).catch(() => undefined);
    if (line === undefined) continue;
    expected.push({ ...finding, line });
  }
  return expected;
}

async function openThreads(repo: string, slug: string): Promise<Array<{ threadId: string }>> {
  const text = await staff(repo, ["comment", "list", "--slug", slug, "--open", "--json"]);
  return JSON.parse(text) as Array<{ threadId: string }>;
}

function hasAgentReply(diff: Diff, threadId: string): boolean {
  return diff.comments.some(
    (comment) => comment.threadId === threadId && comment.parentId && comment.author !== "Reviewer",
  );
}

async function runFixtureTests(repo: string): Promise<RunResult> {
  return run(["bun", "test"], { allowFail: true, cwd: repo });
}

async function scoreResolveLike(
  ctx: ScoreContext,
  options: {
    expectedStatus: "fixed" | "documented";
    requireDocs?: boolean;
    requireTests?: boolean;
  },
): Promise<ScoreResult> {
  if (!ctx.metadata.slug) throw new Error("Missing slug in eval metadata");
  const diff = await loadDiffBySlug(ctx.repo, ctx.metadata.slug);
  const threadIds = ctx.metadata.seededThreadIds ?? [];
  // The seeded-thread checks below all become vacuously perfect when there is
  // nothing seeded (`[].every` is true, `0 === 0` resolves full credit). A
  // resolve-like case with no seeded threads is a harness bug, not a passing
  // run, so fail loudly instead of silently awarding a perfect score.
  if (threadIds.length === 0) {
    throw new Error(
      `Resolve-like case ${ctx.metadata.caseId} has no seededThreadIds; the scorer requires at least one seeded thread`,
    );
  }
  const roots = rootComments(diff);
  const open = await openThreads(ctx.repo, ctx.metadata.slug);
  const checks: ScoreCheck[] = [
    {
      name: "no-open-threads",
      earned: open.length === 0 ? 20 : 0,
      possible: 20,
      detail: open.length === 0 ? "All threads resolved" : `${open.length} open thread(s) remain`,
    },
    {
      name: "seeded-comments-preserved",
      earned: threadIds.every((id) => roots.some((comment) => comment.threadId === id)) ? 10 : 0,
      possible: 10,
      detail: "Root review comments should remain in the Staff Review store",
    },
  ];

  const resolved = threadIds.filter((id) =>
    roots.some(
      (comment) => comment.threadId === id && comment.resolution?.status === options.expectedStatus,
    ),
  );
  checks.push({
    name: `resolved-${options.expectedStatus}`,
    earned:
      resolved.length === threadIds.length
        ? 25
        : Math.round((resolved.length / threadIds.length) * 25),
    possible: 25,
    detail: `${resolved.length}/${threadIds.length} seeded thread(s) resolved as ${options.expectedStatus}`,
  });

  const replies = threadIds.filter((id) => hasAgentReply(diff, id));
  checks.push({
    name: "in-thread-replies",
    earned:
      replies.length === threadIds.length
        ? 15
        : Math.round((replies.length / threadIds.length) * 15),
    possible: 15,
    detail: `${replies.length}/${threadIds.length} seeded thread(s) got an agent reply`,
  });

  if (options.requireTests) {
    const testRun = await runFixtureTests(ctx.repo);
    checks.push({
      name: "fixture-tests-pass",
      earned: testRun.exitCode === 0 ? 30 : 0,
      possible: 30,
      detail: testRun.exitCode === 0 ? "bun test passed" : testRun.stderr || testRun.stdout,
    });
  }

  if (options.requireDocs) {
    const documented = roots.find((comment) => comment.resolution?.status === "documented");
    const documentedAs = documented?.resolution?.documentedAs;
    const docs = await listDocs(ctx.repo);
    const documentedFileExists = documentedAs ? docs.includes(documentedAs) : false;
    checks.push({
      name: "documented-file-linked",
      earned: documentedFileExists ? 15 : 0,
      possible: 15,
      detail: documentedAs
        ? documentedFileExists
          ? `Found .staffreview/docs/${documentedAs}`
          : `Missing .staffreview/docs/${documentedAs}`
        : "Resolution did not set documentedAs",
    });
    checks.push(await scoreDocsShape(ctx.repo, documentedAs));
  }

  return sumChecks(ctx.metadata.caseId, checks);
}

async function listDocs(repo: string): Promise<string[]> {
  const docsDir = store.docsDir(repo);
  try {
    return (await readdir(docsDir)).filter((name) => name.endsWith(".md")).sort();
  } catch {
    return [];
  }
}

async function scoreDocsShape(repo: string, documentedAs?: string): Promise<ScoreCheck> {
  const docs = await listDocs(repo);
  const file = documentedAs ?? docs[0];
  if (!file) {
    return {
      name: "docs-entry-shape",
      earned: 0,
      possible: 15,
      detail: "No docs entry was written",
    };
  }
  const body = await readFile(join(store.docsDir(repo), file), "utf8");
  const required = [
    "---",
    "source:",
    "tags:",
    "## Context",
    "## The issue",
    "## Original code",
    "## Fix",
    "## Why it matters",
  ];
  const found = required.filter((token) => body.includes(token));
  return {
    name: "docs-entry-shape",
    earned: Math.round((found.length / required.length) * 15),
    possible: 15,
    detail: `Found ${found.length}/${required.length} required docs markers in ${file}`,
  };
}

async function scoreLoop(ctx: ScoreContext): Promise<ScoreResult> {
  if (!ctx.metadata.slug) throw new Error("Missing slug in eval metadata");
  const diff = await loadDiffBySlug(ctx.repo, ctx.metadata.slug);
  const roots = rootComments(diff);
  const open = await openThreads(ctx.repo, ctx.metadata.slug);
  const fixed = roots.filter((comment) => comment.resolution?.status === "fixed");
  const testRun = await runFixtureTests(ctx.repo);
  const checks: ScoreCheck[] = [
    {
      name: "review-posted-comment",
      earned: roots.length > 0 ? 20 : 0,
      possible: 20,
      detail:
        roots.length > 0 ? `${roots.length} root comment(s) posted` : "No review comments posted",
    },
    {
      name: "no-open-threads",
      earned: open.length === 0 ? 20 : 0,
      possible: 20,
      detail:
        open.length === 0
          ? "Loop converged with no open threads"
          : `${open.length} open thread(s) remain`,
    },
    {
      name: "fixed-resolution",
      earned: fixed.length > 0 ? 20 : 0,
      possible: 20,
      detail: fixed.length > 0 ? `${fixed.length} fixed thread(s)` : "No thread resolved as fixed",
    },
    {
      name: "fixture-tests-pass",
      earned: testRun.exitCode === 0 ? 30 : 0,
      possible: 30,
      detail: testRun.exitCode === 0 ? "bun test passed" : testRun.stderr || testRun.stdout,
    },
    {
      name: "agent-replies",
      earned:
        fixed.length > 0 && fixed.every((comment) => hasAgentReply(diff, comment.threadId))
          ? 10
          : 0,
      possible: 10,
      detail: "Fixed threads should include in-thread resolution replies",
    },
  ];
  return sumChecks(ctx.metadata.caseId, checks);
}

async function scoreSection(ctx: ScoreContext): Promise<ScoreResult> {
  const diffs = await loadAllDiffs(ctx.repo);
  const roots = diffs.flatMap((diff) => rootComments(diff));
  const expected = ctx.metadata.expectedFindings ?? [];
  const matching =
    expected.length > 0
      ? (await matchExpectedFindings(ctx.repo, roots, [expected[0]!], ctx.scoreOptions)).get(
          expected[0]!.id,
        )
      : undefined;
  const cachePath = join(ctx.repo, ".staffreview", "section-cache.json");
  let cacheBody = "";
  try {
    cacheBody = await readFile(cachePath, "utf8");
  } catch {}
  const statusRun = await run(["git", "diff", "--name-only", "HEAD"], {
    allowFail: true,
    cwd: ctx.repo,
  });
  const checks: ScoreCheck[] = [
    {
      name: "section-cache-written",
      earned: cacheBody.includes("src/profile-store.ts") ? 25 : 0,
      possible: 25,
      detail: cacheBody ? "section-cache.json exists" : "section-cache.json is missing",
    },
    {
      name: "expected-section-finding",
      earned: matching ? 45 : 0,
      possible: 45,
      detail: matching
        ? matchDetail(matching)
        : "No section-review comment matched the path traversal issue",
    },
    {
      name: "finding-priority",
      earned: matching?.comment.priority ? 10 : 0,
      possible: 10,
      detail: matching?.comment.priority
        ? `Priority ${matching.comment.priority}`
        : "No priority set on matching finding",
    },
    {
      name: "whole-tree-diff-used",
      earned: diffs.some((diff) => /^[0-9a-f]{40}\.\.WT$/.test(diff.slug)) ? 10 : 0,
      possible: 10,
      detail: "Section review should host comments on the empty-tree..WT diff",
    },
    {
      name: "no-code-edits",
      earned: statusRun.stdout.trim() === "" ? 10 : 0,
      possible: 10,
      detail: statusRun.stdout.trim() || "Tracked source files were left unchanged",
    },
  ];
  return sumChecks(ctx.metadata.caseId, checks);
}

const sharedPackage = dedent(`
  {
    "name": "staffreview-eval-fixture",
    "private": true,
    "type": "module",
    "scripts": {
      "test": "bun test"
    }
  }
`);

const cases: EvalCase[] = [
  {
    id: "review-quality",
    title: "Review Quality Eval",
    skill: "/staff-review",
    summary:
      "Reviews a multi-file working-tree diff with security, contract, test coverage, and maintainability regressions across P1/P2/P3 priorities.",
    agentPrompt:
      "Run /staff-review on the active diff. Post only real review findings through the Staff Review CLI. Do not modify code.",
    async prepare(ctx) {
      await prepareCommon(
        ctx.repo,
        {
          "package.json": sharedPackage,
          "src/export-path.ts": dedent(`
            import { join, resolve } from "node:path";

            const EXPORT_ROOT = resolve("/srv/app/exports");
            const ALLOWED_REPORTS = new Set(["daily", "weekly"]);

            /** Builds paths for the known built-in reports only. */
            export function exportPath(reportName: string): string {
              if (!ALLOWED_REPORTS.has(reportName)) {
                throw new Error("unknown report");
              }
              return join(EXPORT_ROOT, \`\${reportName}.csv\`);
            }
          `),
          "src/rate-limit.ts": dedent(`
            export type LoginAttempt = {
              tenantId: string;
              userId: string;
            };

            const attempts = new Map<string, number>();

            export function resetAttempts(): void {
              attempts.clear();
            }

            export function rateLimitKey(attempt: LoginAttempt, ip: string): string {
              return \`\${attempt.tenantId}:\${attempt.userId}:\${ip}\`;
            }

            export function allowLoginAttempt(
              attempt: LoginAttempt,
              ip: string,
              maxAttempts: number,
            ): boolean {
              const key = rateLimitKey(attempt, ip);
              const next = (attempts.get(key) ?? 0) + 1;
              attempts.set(key, next);
              return next <= maxAttempts;
            }
          `),
          "src/session-expiry.ts": dedent(`
            export type Session = {
              id: string;
              lastSeenAtMs: number;
              maxIdleMs: number;
            };

            const CLOCK_SKEW_MS = 5 * 60 * 1000;

            export function isSessionExpired(session: Session, nowMs: number): boolean {
              return nowMs - session.lastSeenAtMs > session.maxIdleMs + CLOCK_SKEW_MS;
            }
          `),
        },
        {
          "src/export-path.ts": dedent(`
            import { join, resolve } from "node:path";

            const EXPORT_ROOT = resolve("/srv/app/exports");

            /** Builds paths for the known built-in reports only. */
            export function exportPath(reportName: string): string {
              const cleaned = reportName.trim().replaceAll(" ", "-");
              return join(EXPORT_ROOT, \`\${cleaned}.csv\`);
            }
          `),
          "src/rate-limit.ts": dedent(`
            export type LoginAttempt = {
              tenantId: string;
              userId: string;
            };

            const attempts = new Map<string, number>();

            export function resetAttempts(): void {
              attempts.clear();
            }

            export function rateLimitKey(attempt: LoginAttempt, ip: string): string {
              return \`\${attempt.userId}:\${ip}\`;
            }

            export function allowLoginAttempt(
              attempt: LoginAttempt,
              ip: string,
              maxAttempts: number,
            ): boolean {
              const key = rateLimitKey(attempt, ip);
              const next = (attempts.get(key) ?? 0) + 1;
              attempts.set(key, next);
              return next <= maxAttempts;
            }
          `),
          "src/session-expiry.ts": dedent(`
            export type Session = {
              id: string;
              lastSeenAtMs: number;
              maxIdleMs: number;
            };

            const CLOCK_SKEW_MS = 5 * 60;

            export function isSessionExpired(session: Session, nowMs: number): boolean {
              return nowMs - session.lastSeenAtMs > session.maxIdleMs + CLOCK_SKEW_MS;
            }
          `),
        },
        ctx.staffTarget,
      );
      const diff = await createWorkingTreeDiff(ctx.repo);
      return metadataForReviewCase(
        ctx.repo,
        "review-quality",
        "/staff-review",
        diff,
        reviewQualityFindingSeeds.map(({ needle: _needle, ...finding }) => finding),
        reviewQualityLineNeedles(),
      );
    },
    async score(ctx) {
      if (!ctx.metadata.slug) throw new Error("Missing slug in eval metadata");
      const diff = await loadDiffBySlug(ctx.repo, ctx.metadata.slug);
      return sumChecks(
        ctx.metadata.caseId,
        await scoreExpectedFindings(
          ctx.repo,
          diff,
          await expectedReviewQualityFindings(ctx.repo, ctx.metadata),
          ctx.scoreOptions,
        ),
      );
    },
  },
  {
    id: "resolve-seeded-comments",
    title: "Resolve Seeded Comments Eval",
    skill: "/staff-resolve",
    summary:
      "Starts with an unresolved review thread on a failing discount edge case. The resolver should fix the code, reply, resolve, and leave tests green.",
    agentPrompt:
      "Run /staff-resolve on the active diff. Resolve every open thread by fixing the code, replying in-thread, and recording the resolution. Do not commit.",
    async prepare(ctx) {
      await prepareCommon(
        ctx.repo,
        {
          "package.json": sharedPackage,
          "src/invoice.test.ts": dedent(`
            import { expect, test } from "bun:test";
            import { applyDiscount } from "./invoice.ts";

            test("discounts cannot make an invoice negative", () => {
              expect(applyDiscount(500, 700)).toBe(0);
            });
          `),
          "src/invoice.ts": dedent(`
            export function applyDiscount(totalCents: number, discountCents: number): number {
              const discounted = totalCents - discountCents;
              return discounted < 0 ? 0 : discounted;
            }
          `),
        },
        {
          "src/invoice.ts": dedent(`
            export function applyDiscount(totalCents: number, discountCents: number): number {
              return totalCents - discountCents;
            }
          `),
        },
        ctx.staffTarget,
      );
      const diff = await createWorkingTreeDiff(ctx.repo);
      const line = await lineOf(ctx.repo, "src/invoice.ts", "return totalCents - discountCents;");
      const comment = JSON.parse(
        await staff(ctx.repo, [
          "comment",
          "add",
          "--slug",
          diff.slug,
          "--file",
          "src/invoice.ts",
          "--line",
          String(line),
          "--side",
          "new",
          "--author",
          "Reviewer",
          "--priority",
          "P1",
          "--body",
          "This can return a negative invoice total when the discount is larger than the subtotal. Clamp the result at zero and keep the regression test passing.",
        ]),
      ) as Comment;
      return {
        version: 1,
        caseId: "resolve-seeded-comments",
        skill: "/staff-resolve",
        preparedAt: isoNow(),
        slug: diff.slug,
        seededThreadIds: [comment.threadId],
      };
    },
    score(ctx) {
      return scoreResolveLike(ctx, { expectedStatus: "fixed", requireTests: true });
    },
  },
  {
    id: "document-request",
    title: "Document Request Eval",
    skill: "/staff-resolve",
    summary:
      "Starts with a human-requested documentation thread. The resolver should write a docs lesson and resolve the thread as documented.",
    agentPrompt:
      "Run /staff-resolve on the active diff. The open thread was marked for documentation; save the lesson under .staffreview/docs, reply in-thread, and resolve it as documented. Do not commit.",
    async prepare(ctx) {
      await prepareCommon(
        ctx.repo,
        {
          "package.json": sharedPackage,
          "src/quantity.ts": dedent(`
            export function parseQuantity(raw: string): number {
              const trimmed = raw.trim();
              if (trimmed === "") {
                throw new Error("quantity is required");
              }
              const value = Number(trimmed);
              if (!Number.isFinite(value) || value < 0) {
                throw new Error("quantity must be a non-negative number");
              }
              return value;
            }
          `),
        },
        {
          "src/quantity.ts": dedent(`
            export function parseQuantity(raw: string): number {
              const value = Number(raw);
              if (!Number.isFinite(value) || value < 0) {
                throw new Error("quantity must be a non-negative number");
              }
              return value;
            }
          `),
        },
        ctx.staffTarget,
      );
      const diff = await createWorkingTreeDiff(ctx.repo);
      const line = await lineOf(ctx.repo, "src/quantity.ts", "const value = Number(raw);");
      const comment = JSON.parse(
        await staff(ctx.repo, [
          "comment",
          "add",
          "--slug",
          diff.slug,
          "--file",
          "src/quantity.ts",
          "--line",
          String(line),
          "--side",
          "new",
          "--author",
          "Reviewer",
          "--priority",
          "P2",
          "--body",
          'Document this as a reusable parser lesson: Number("") accepts blank input as 0, so required numeric fields need an explicit blank check before coercion.',
        ]),
      ) as Comment;
      await store.setDocumentRequested(diff.slug, comment.threadId, true, ctx.repo);
      return {
        version: 1,
        caseId: "document-request",
        skill: "/staff-resolve",
        preparedAt: isoNow(),
        slug: diff.slug,
        seededThreadIds: [comment.threadId],
      };
    },
    score(ctx) {
      return scoreResolveLike(ctx, { expectedStatus: "documented", requireDocs: true });
    },
  },
  {
    id: "loop-end-to-end",
    title: "Loop End-to-End Eval",
    skill: "/staff-loop",
    summary:
      "Starts with a reviewable off-by-one regression and no seeded comments. The loop should review, resolve, and converge with tests passing.",
    agentPrompt:
      "Run /staff-loop on the active working-tree diff. Let the loop review, resolve, and re-review until it converges or reaches the configured cap. Do not commit.",
    async prepare(ctx) {
      await prepareCommon(
        ctx.repo,
        {
          "package.json": sharedPackage,
          "src/cart.test.ts": dedent(`
            import { expect, test } from "bun:test";
            import { qualifiesForFreeShipping } from "./cart.ts";

            test("orders at the free-shipping threshold qualify", () => {
              expect(qualifiesForFreeShipping([1200, 800], 2000)).toBe(true);
            });
          `),
          "src/cart.ts": dedent(`
            export function qualifiesForFreeShipping(itemCents: number[], thresholdCents: number): boolean {
              const subtotal = itemCents.reduce((sum, cents) => sum + cents, 0);
              return subtotal >= thresholdCents;
            }
          `),
        },
        {
          "src/cart.ts": dedent(`
            export function qualifiesForFreeShipping(itemCents: number[], thresholdCents: number): boolean {
              const subtotal = itemCents.reduce((sum, cents) => sum + cents, 0);
              return subtotal > thresholdCents;
            }
          `),
        },
        ctx.staffTarget,
      );
      const diff = await createWorkingTreeDiff(ctx.repo);
      return {
        version: 1,
        caseId: "loop-end-to-end",
        skill: "/staff-loop",
        preparedAt: isoNow(),
        slug: diff.slug,
      };
    },
    score: scoreLoop,
  },
  {
    id: "section-review",
    title: "Section Review Eval",
    skill: "/staff-section",
    summary:
      "Reviews an existing tiny codebase with no diff. The section reviewer should use the whole-tree diff, find a path traversal issue, and update section-cache.json.",
    agentPrompt:
      "Run /staff-section 1 in this repository. Review the selected section, post any verified findings, update the section cache, and do not modify source code.",
    async prepare(ctx) {
      await prepareCommon(
        ctx.repo,
        {
          "package.json": sharedPackage,
          "src/profile-store.ts": dedent(`
            import { readFile } from "node:fs/promises";
            import { join } from "node:path";

            export async function loadProfile(profileRoot: string, userId: string): Promise<string> {
              return readFile(join(profileRoot, \`\${userId}.json\`), "utf8");
            }
          `),
          "src/profile-store.test.ts": dedent(`
            import { expect, test } from "bun:test";
            import { loadProfile } from "./profile-store.ts";

            test("loadProfile is exported", () => {
              expect(loadProfile).toBeTypeOf("function");
            });
          `),
        },
        {},
        ctx.staffTarget,
      );
      return {
        version: 1,
        caseId: "section-review",
        skill: "/staff-section",
        preparedAt: isoNow(),
        expectedFindings: [
          {
            id: "profile-path-traversal",
            description:
              "loadProfile joins an untrusted userId directly into a filesystem path, so path traversal input can read files outside the profile root.",
            file: "src/profile-store.ts",
            line: await lineOf(ctx.repo, "src/profile-store.ts", "return readFile"),
            priority: "P1",
            groups: [
              ["traversal", "../", "outside"],
              ["user", "userid"],
              ["join", "resolve", "path"],
            ],
          },
        ],
      };
    },
    score: scoreSection,
  },
];

export function listCases(): EvalCase[] {
  return cases;
}

export function listEvalSkills(): SkillOption[] {
  const bySkill = new Map<string, string[]>();
  for (const testCase of cases) {
    const ids = bySkill.get(testCase.skill) ?? [];
    ids.push(testCase.id);
    bySkill.set(testCase.skill, ids);
  }
  return [...bySkill.entries()].map(([skill, ids]) => ({
    value: skill,
    label: skill,
    hint: ids.join(", "),
  }));
}

export function getCase(id: string): EvalCase {
  const testCase = cases.find((candidate) => candidate.id === id);
  if (!testCase) {
    throw new Error(`Unknown eval case: ${id}. Available: ${cases.map((c) => c.id).join(", ")}`);
  }
  return testCase;
}

export function defaultRunDir(caseId: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  return join(EVAL_RUNS_DIR, `${stamp}-${caseId}`);
}

export function defaultSuiteRunDir(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  return join(EVAL_RUNS_DIR, `${stamp}-suite`);
}

export async function prepareCase(
  caseId: string,
  repo = defaultRunDir(caseId),
  staffTarget: StaffTarget = currentStaffTarget(),
): Promise<PrepareResult> {
  const testCase = getCase(caseId);
  if (!staffTarget.availableSkills.has(testCase.skill)) {
    throw new Error(`${staffTarget.label} does not include ${testCase.skill}`);
  }
  const metadata = await testCase.prepare({ repo, staffTarget });
  await writeRunbook(repo, testCase, metadata);
  return {
    caseId,
    skill: testCase.skill,
    repo,
    runbook: join(repo, "RUN.md"),
  };
}

async function writeSuiteRunbook(root: string, results: PrepareResult[]): Promise<string> {
  const rows = results
    .map(
      (result, index) => `${index + 1}. ${result.caseId}

   \`\`\`bash
   cd ${result.repo}
   export PATH="$PWD/.eval-bin:$PATH"
   cat RUN.md
   \`\`\`
`,
    )
    .join("\n");
  const runbook = dedent(`
    # Staff Review Eval Suite

    This directory contains one prepared repository per eval case.

    ## Run The Agent

    Run the agent/model version you want to evaluate once in each case directory,
    following that case's \`RUN.md\` prompt:

    ${rows}
    ## Score Everything

    From the Staff Review repository:

    \`\`\`bash
    bun ${STAFFREVIEW_ROOT}/evals/cli.ts score all --repo ${root}
    \`\`\`
  `);
  const path = join(root, "RUN_ALL.md");
  await writeFile(path, runbook);
  return path;
}

export async function prepareSuite(
  root = defaultSuiteRunDir(),
  staffTarget: StaffTarget = currentStaffTarget(),
  options: { skills?: string[] } = {},
): Promise<SuitePrepareResult> {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const selectedSkills = new Set(options.skills ?? listEvalSkills().map((skill) => skill.value));
  const selectedCases = listCases().filter((testCase) => selectedSkills.has(testCase.skill));
  const results: PrepareResult[] = [];
  const skipped: SkippedCase[] = [];
  for (const testCase of selectedCases) {
    if (!staffTarget.availableSkills.has(testCase.skill)) {
      skipped.push({
        caseId: testCase.id,
        skill: testCase.skill,
        reason: `${staffTarget.label} does not include ${testCase.skill}`,
      });
      continue;
    }
    results.push(await prepareCase(testCase.id, join(root, testCase.id), staffTarget));
  }
  const runbook = await writeSuiteRunbook(root, results);
  const manifest: SuiteManifest = {
    version: 1,
    preparedAt: isoNow(),
    staffTarget: staffTarget.label,
    selectedSkills: [...selectedSkills],
    skipped,
    cases: results.map((result) => ({
      caseId: result.caseId,
      skill: result.skill,
      repo: result.repo,
      runbook: result.runbook,
    })),
  };
  await writeFile(join(root, "eval-suite.json"), JSON.stringify(manifest, null, 2));
  return { caseId: "all", repo: root, runbook, cases: results, skipped };
}

export async function scoreCase(
  caseId: string,
  repo: string,
  scoreOptions: ScoreOptions = {},
): Promise<ScoreResult> {
  const testCase = getCase(caseId);
  const metadata = await loadMetadata(repo);
  if (metadata.caseId !== caseId) {
    throw new Error(`Metadata case is ${metadata.caseId}, but scorer was asked for ${caseId}`);
  }
  return testCase.score({ repo, metadata, scoreOptions });
}

async function loadSuiteManifest(root: string): Promise<SuiteManifest> {
  const path = join(root, "eval-suite.json");
  try {
    return JSON.parse(await readFile(path, "utf8")) as SuiteManifest;
  } catch {
    return {
      version: 1,
      preparedAt: "",
      cases: listCases().map((testCase) => ({
        caseId: testCase.id,
        repo: join(root, testCase.id),
        runbook: join(root, testCase.id, "RUN.md"),
      })),
    };
  }
}

export async function scoreSuite(
  root: string,
  scoreOptions: ScoreOptions = {},
): Promise<SuiteScoreResult> {
  const manifest = await loadSuiteManifest(root);
  const cases: ScoreResult[] = [];
  for (const item of manifest.cases) {
    cases.push(await scoreCase(item.caseId, item.repo, scoreOptions));
  }
  return {
    caseId: "all",
    score: cases.reduce((sum, result) => sum + result.score, 0),
    possible: cases.reduce((sum, result) => sum + result.possible, 0),
    cases,
  };
}

export async function latestPreparedRepo(caseId: string): Promise<string | undefined> {
  try {
    const names = await readdir(EVAL_RUNS_DIR);
    const matches = names.filter((name) => name.endsWith(`-${caseId}`)).sort();
    const latest = matches.at(-1);
    return latest ? join(EVAL_RUNS_DIR, latest) : undefined;
  } catch {
    return undefined;
  }
}

export async function latestPreparedSuite(): Promise<string | undefined> {
  try {
    const names = await readdir(EVAL_RUNS_DIR);
    const matches = names.filter((name) => name.endsWith("-suite")).sort();
    const latest = matches.at(-1);
    return latest ? join(EVAL_RUNS_DIR, latest) : undefined;
  } catch {
    return undefined;
  }
}

export async function ensureRepoExists(repo: string): Promise<void> {
  const info = await stat(repo).catch(() => undefined);
  if (!info?.isDirectory()) {
    throw new Error(`Repo does not exist: ${repo}`);
  }
}
