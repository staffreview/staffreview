import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import Table from "cli-table3";
import {
  EVAL_RUNS_DIR,
  prepareSuite,
  resolveStaffTarget,
  type ScoreOptions,
  type SkippedCase,
  type StaffTarget,
  type SuitePrepareResult,
  type SuiteScoreResult,
  scoreSuite,
} from "./cases.ts";
import { commonAncestor, formatNumber, shellQuote, TIMEOUT_KILL_GRACE_MS } from "./util.ts";

type CodexOptions = {
  codexCommand?: string;
  commandTemplate?: string;
  concurrency?: number;
  judge?: boolean;
  judgeCommand?: string;
  judgeCommandTemplate?: string;
  judgeModel?: string;
  judgeTimeoutMs?: number;
  model?: string;
  modelLabel?: string;
  repeatCount?: number;
  repeatIndex?: number;
  runs?: number;
  skills?: string[];
  timeoutMs?: number;
};

export type ScoreStats = {
  max: number;
  mean: number;
  min: number;
  possible: number;
  runs: number;
  stdev: number;
};

export type VersionRunResult = {
  codex: Array<{
    caseId: string;
    exitCode: number;
    log: string;
  }>;
  model: string;
  repeatCount?: number;
  repeatIndex?: number;
  samples?: VersionRunResult[];
  score: SuiteScoreResult;
  skipped: SkippedCase[];
  stats?: ScoreStats;
  suite: string;
  version: string;
};

export type ModelTarget = {
  id: string;
  label: string;
  model?: string;
};

type TaskLimiter = <T>(task: () => Promise<T>) => Promise<T>;

function defaultConcurrency(...counts: number[]): number {
  return Math.max(1, ...counts);
}

function normalizeConcurrency(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("--concurrency must be a positive integer");
  }
  return value;
}

function normalizeRuns(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("--runs must be a positive integer");
  }
  return value;
}

export function createTaskLimiter(limit: number): TaskLimiter {
  let active = 0;
  const queue: Array<() => void> = [];

  const runNext = () => {
    active--;
    queue.shift()?.();
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await task();
    } finally {
      runNext();
    }
  };
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
}

function versionPathPart(version: string): string {
  return version.replace(/^v/, "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function modelPathPart(model: ModelTarget): string {
  return model.id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function repeatPathPart(index: number): string {
  return `run-${index}`;
}

function formatPercent(score: number, possible: number): string {
  return possible === 0 ? "0%" : `${Math.round((score / possible) * 100)}%`;
}

function suiteRoot(results: VersionRunResult[]): string {
  if (results.length === 1) return dirname(resolve(results[0]!.suite));
  // commonAncestor resolves each path internally, so no pre-resolve is needed.
  return commonAncestor(results.map((result) => result.suite));
}

function suiteLabel(suite: string, root: string): string {
  const label = relative(root, suite);
  if (!label || label.startsWith("..")) return basename(suite);
  return label;
}

function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(repo|prompt|promptFile|pathPrefix|model)\}/g, (_, key: string) =>
    shellQuote(values[key] ?? ""),
  );
}

function defaultCodexShellCommand(repo: string, prompt: string, options: CodexOptions): string {
  const resolveCodex = options.codexCommand
    ? `CODEX_EVAL_BIN=${shellQuote(options.codexCommand)}`
    : [
        'if [ -x "$HOME/.bun/bin/codex" ]; then',
        '  CODEX_EVAL_BIN="$HOME/.bun/bin/codex";',
        "else",
        '  CODEX_EVAL_BIN="$(command -v codex)";',
        "fi",
      ].join(" ");
  const model = options.model ? ` --model ${shellQuote(options.model)}` : "";
  return [
    `cd ${shellQuote(repo)}`,
    resolveCodex,
    'test -n "$CODEX_EVAL_BIN"',
    `PATH=${shellQuote(join(repo, ".eval-bin"))}:$PATH "$CODEX_EVAL_BIN" --ask-for-approval never exec --sandbox workspace-write --skip-git-repo-check${model} ${shellQuote(prompt)}`,
  ].join(" && ");
}

async function runShell(
  command: string,
  options: { cwd: string; timeoutMs: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["zsh", "-lc", command], {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  // Bound the run with a hard timeout: SIGTERM first, then escalate to SIGKILL
  // after a short grace period so a subprocess that traps/ignores SIGTERM
  // (e.g. one that spawned its own children) can't hang the whole eval matrix.
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = setTimeout(() => {
    proc.kill("SIGTERM");
    killTimer = setTimeout(() => proc.kill("SIGKILL"), TIMEOUT_KILL_GRACE_MS);
  }, options.timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => {
    clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);
  });

  return { exitCode, stdout, stderr };
}

async function runCodexForCase(
  repo: string,
  caseId: string,
  logsDir: string,
  options: CodexOptions,
): Promise<{ caseId: string; exitCode: number; log: string }> {
  const promptFile = join(repo, "CODEX_PROMPT.md");
  const prompt = await readFile(promptFile, "utf8");
  const pathPrefix = join(repo, ".eval-bin");
  const command = options.commandTemplate
    ? renderTemplate(options.commandTemplate, {
        repo,
        prompt,
        promptFile,
        pathPrefix,
        model: options.model ?? "",
      })
    : defaultCodexShellCommand(repo, prompt, options);

  const result = await runShell(command, {
    cwd: repo,
    timeoutMs: options.timeoutMs ?? 30 * 60 * 1000,
  });
  const log = join(logsDir, `${caseId}.log`);
  await writeFile(
    log,
    [
      `$ ${command}`,
      "",
      "## stdout",
      result.stdout,
      "",
      "## stderr",
      result.stderr,
      "",
      `exitCode=${result.exitCode}`,
    ].join("\n"),
  );
  return { caseId, exitCode: result.exitCode, log };
}

async function runSuiteCodex(
  suite: SuitePrepareResult,
  options: CodexOptions & { codexLimiter?: TaskLimiter },
): Promise<VersionRunResult["codex"]> {
  const logsDir = join(suite.repo, "codex-logs");
  await mkdir(logsDir, { recursive: true });
  const limiter =
    options.codexLimiter ??
    createTaskLimiter(
      normalizeConcurrency(
        options.concurrency,
        defaultConcurrency(options.skills?.length ?? suite.cases.length, suite.cases.length),
      ),
    );
  return Promise.all(
    suite.cases.map((item) =>
      limiter(() => runCodexForCase(item.repo, item.caseId, logsDir, options)),
    ),
  );
}

async function runResolvedVersionEval(
  staffTarget: StaffTarget,
  options: CodexOptions & { codexLimiter?: TaskLimiter; out?: string } = {},
): Promise<VersionRunResult> {
  const suiteRoot =
    options.out ?? join(EVAL_RUNS_DIR, `${stamp()}-${versionPathPart(staffTarget.id)}-auto`);
  const suite = await prepareSuite(suiteRoot, staffTarget, { skills: options.skills });
  const codex = await runSuiteCodex(suite, options);
  const scoreOptions: ScoreOptions = {
    judge: options.judge,
    judgeCommand: options.judgeCommand,
    judgeCommandTemplate: options.judgeCommandTemplate,
    judgeLimiter: options.codexLimiter,
    judgeModel: options.judgeModel,
    judgeTimeoutMs: options.judgeTimeoutMs,
  };
  const score = await scoreSuite(suite.repo, scoreOptions);
  const result: VersionRunResult = {
    version: staffTarget.label,
    model: options.modelLabel ?? options.model ?? "default",
    repeatCount: options.repeatCount,
    repeatIndex: options.repeatIndex,
    suite: suite.repo,
    score,
    skipped: suite.skipped,
    codex,
  };
  await writeFile(join(suite.repo, "eval-result.json"), JSON.stringify(result, null, 2));
  return result;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function stdev(values: number[]): number {
  if (values.length <= 1) return 0;
  const avg = mean(values);
  const variance = mean(values.map((value) => (value - avg) ** 2));
  return Math.sqrt(variance);
}

function uniqueSkipped(results: VersionRunResult[]): SkippedCase[] {
  const seen = new Set<string>();
  const skipped: SkippedCase[] = [];
  for (const result of results) {
    for (const item of result.skipped) {
      const key = `${item.caseId}\0${item.skill}\0${item.reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      skipped.push(item);
    }
  }
  return skipped;
}

export function averageChecks(results: VersionRunResult[], caseId: string) {
  const byName = new Map<string, Array<{ earned: number; possible: number }>>();
  for (const result of results) {
    const caseResult = result.score.cases.find((item) => item.caseId === caseId);
    if (!caseResult) continue;
    for (const check of caseResult.checks) {
      const checks = byName.get(check.name) ?? [];
      checks.push({ earned: check.earned, possible: check.possible });
      byName.set(check.name, checks);
    }
  }
  return [...byName.entries()].map(([name, checks]) => {
    const earned = mean(checks.map((check) => check.earned));
    const possible = checks[0]?.possible ?? 0;
    const minEarned = Math.min(...checks.map((check) => check.earned));
    const maxEarned = Math.max(...checks.map((check) => check.earned));
    return {
      name,
      earned,
      possible,
      detail: `mean across ${checks.length} run(s); range ${formatNumber(minEarned)}-${formatNumber(maxEarned)}/${possible}`,
    };
  });
}

export function aggregateScore(results: VersionRunResult[]): SuiteScoreResult {
  const caseIds = [
    ...new Set(results.flatMap((result) => result.score.cases.map((item) => item.caseId))),
  ];
  const cases = caseIds.map((caseId) => {
    const caseResults = results
      .map((result) => result.score.cases.find((item) => item.caseId === caseId))
      .filter((item): item is SuiteScoreResult["cases"][number] => item !== undefined);
    const scores = caseResults.map((item) => item.score);
    const score = mean(scores);
    const possible = caseResults[0]?.possible ?? 0;
    return {
      caseId,
      score,
      possible,
      checks: averageChecks(results, caseId),
    };
  });
  return {
    caseId: "all",
    score: mean(results.map((result) => result.score.score)),
    possible: results[0]?.score.possible ?? 0,
    cases,
  };
}

async function aggregateResults(
  suiteRoot: string,
  results: VersionRunResult[],
): Promise<VersionRunResult> {
  if (results.length === 0) throw new Error("Cannot aggregate zero eval results");
  const scores = results.map((result) => result.score.score);
  const aggregate: VersionRunResult = {
    codex: results.flatMap((result) => result.codex),
    model: results[0]!.model,
    repeatCount: results.length,
    samples: results,
    score: aggregateScore(results),
    skipped: uniqueSkipped(results),
    stats: {
      max: Math.max(...scores),
      mean: mean(scores),
      min: Math.min(...scores),
      possible: results[0]!.score.possible,
      runs: results.length,
      stdev: stdev(scores),
    },
    suite: suiteRoot,
    version: results[0]!.version,
  };
  await mkdir(suiteRoot, { recursive: true });
  await writeFile(join(suiteRoot, "aggregate-result.json"), JSON.stringify(aggregate, null, 2));
  return aggregate;
}

export async function runVersionEval(
  version: string,
  options: CodexOptions & { out?: string } = {},
): Promise<VersionRunResult> {
  const staffTarget = await resolveStaffTarget(version);
  const repeatCount = normalizeRuns(options.runs);
  const codexLimiter = createTaskLimiter(
    normalizeConcurrency(
      options.concurrency,
      defaultConcurrency(options.skills?.length ?? 1, 1, 1, repeatCount),
    ),
  );
  if (repeatCount === 1) {
    return runResolvedVersionEval(staffTarget, { ...options, codexLimiter });
  }
  const root =
    options.out ?? join(EVAL_RUNS_DIR, `${stamp()}-${versionPathPart(staffTarget.id)}-auto`);
  const results = await Promise.all(
    Array.from({ length: repeatCount }, (_, index) => {
      const repeatIndex = index + 1;
      return runResolvedVersionEval(staffTarget, {
        ...options,
        codexLimiter,
        out: join(root, repeatPathPart(repeatIndex)),
        repeatCount,
        repeatIndex,
      });
    }),
  );
  return aggregateResults(root, results);
}

export async function runVersionComparison(
  versions: string[],
  options: CodexOptions & { out?: string; models?: ModelTarget[] } = {},
): Promise<VersionRunResult[]> {
  const root = options.out ?? join(EVAL_RUNS_DIR, `${stamp()}-compare`);
  await mkdir(root, { recursive: true });
  const models = options.models ?? [{ id: "default", label: "default" }];
  const repeatCount = normalizeRuns(options.runs);
  const targets = new Map<string, StaffTarget>();
  for (const version of versions) {
    targets.set(version, await resolveStaffTarget(version));
  }
  const codexLimiter = createTaskLimiter(
    normalizeConcurrency(
      options.concurrency,
      defaultConcurrency(options.skills?.length ?? 1, versions.length, models.length, repeatCount),
    ),
  );
  const jobs: Array<{
    aggregateOut: string;
    model: ModelTarget;
    out: string;
    repeatIndex: number;
    target: StaffTarget;
  }> = [];
  for (const model of models) {
    for (const version of versions) {
      const aggregateOut =
        models.length === 1
          ? join(root, versionPathPart(version))
          : join(root, versionPathPart(version), modelPathPart(model));
      const target = targets.get(version);
      if (!target) throw new Error(`Resolved Staff Review target not found for ${version}`);
      for (let repeatIndex = 1; repeatIndex <= repeatCount; repeatIndex++) {
        const out =
          repeatCount === 1 ? aggregateOut : join(aggregateOut, repeatPathPart(repeatIndex));
        jobs.push({ aggregateOut, model, out, repeatIndex, target });
      }
    }
  }
  const sampleResults = await Promise.all(
    jobs.map((job) =>
      runResolvedVersionEval(job.target, {
        ...options,
        codexLimiter,
        model: job.model.model,
        modelLabel: job.model.label,
        out: job.out,
        repeatCount,
        repeatIndex: repeatCount === 1 ? undefined : job.repeatIndex,
      }),
    ),
  );
  const results =
    repeatCount === 1
      ? sampleResults
      : await Promise.all(
          [...new Set(jobs.map((job) => job.aggregateOut))].map((aggregateOut) =>
            aggregateResults(
              aggregateOut,
              sampleResults.filter((result) => result.suite.startsWith(`${aggregateOut}${sep}`)),
            ),
          ),
        );
  await writeFile(join(root, "comparison.json"), JSON.stringify(results, null, 2));
  return results;
}

export function printRunSummary(results: VersionRunResult[]): void {
  const hasRepeatedRuns = results.some((result) => (result.stats?.runs ?? 1) > 1);
  const root = suiteRoot(results);
  const table = new Table({
    chars: {
      mid: "",
      "left-mid": "",
      "mid-mid": "",
      "right-mid": "",
    },
    head: hasRepeatedRuns
      ? ["version", "model", "runs", "mean", "%", "low", "high", "σ", "fail", "skip", "suite"]
      : ["version", "model", "score", "%", "fail", "skip", "suite"],
    style: { head: [], border: [] },
    wordWrap: false,
  });
  for (const result of results) {
    const stats = result.stats ?? {
      max: result.score.score,
      mean: result.score.score,
      min: result.score.score,
      possible: result.score.possible,
      runs: 1,
      stdev: 0,
    };
    const failures = result.codex.filter((item) => item.exitCode !== 0).length;
    if (hasRepeatedRuns) {
      table.push([
        result.version,
        result.model,
        stats.runs,
        `${formatNumber(stats.mean)}/${result.score.possible}`,
        formatPercent(stats.mean, result.score.possible),
        formatPercent(stats.min, result.score.possible),
        formatPercent(stats.max, result.score.possible),
        formatNumber(stats.stdev),
        failures,
        result.skipped.length,
        suiteLabel(result.suite, root),
      ]);
    } else {
      table.push([
        result.version,
        result.model,
        `${formatNumber(stats.mean)}/${result.score.possible}`,
        formatPercent(stats.mean, result.score.possible),
        failures,
        result.skipped.length,
        suiteLabel(result.suite, root),
      ]);
    }
  }
  console.log(table.toString());
  console.log(`Suite root: ${root}`);
  const failed = results.flatMap((result) =>
    result.codex
      .filter((item) => item.exitCode !== 0)
      .map((item) => `${result.version}/${result.model}/${item.caseId}: ${basename(item.log)}`),
  );
  if (failed.length > 0) {
    console.log("");
    console.log("Codex failures are logged under each suite's codex-logs directory:");
    for (const item of failed) console.log(`  ${item}`);
  }
  const skipped = results.flatMap((result) =>
    result.skipped.map(
      (item) => `${result.version}/${result.model}/${item.caseId}: ${item.reason}`,
    ),
  );
  if (skipped.length > 0) {
    console.log("");
    console.log("Skipped eval cases:");
    for (const item of skipped) console.log(`  ${item}`);
  }
}
