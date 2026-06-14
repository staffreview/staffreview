#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { cancel, intro, isCancel, multiselect, outro, spinner, text } from "@clack/prompts";
import {
  ensureRepoExists,
  latestPreparedRepo,
  latestPreparedSuite,
  listCases,
  listEvalSkills,
  prepareCase,
  prepareSuite,
  type ScoreOptions,
  type ScoreResult,
  STAFFREVIEW_ROOT,
  type SuiteScoreResult,
  scoreCase,
  scoreSuite,
  versionOptions,
} from "./cases.ts";
import { openHtmlReport, writeHtmlReport } from "./report.ts";
import {
  type ModelTarget,
  printRunSummary,
  runVersionComparison,
  runVersionEval,
  type VersionRunResult,
} from "./runner.ts";
import { relativeFromCwd } from "./util.ts";

const DEFAULT_INTERACTIVE_VERSIONS = ["current"];
const CUSTOM_MODEL = "__custom__";

type ParsedArgs = {
  positional: string[];
  flags: Record<string, string | boolean>;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { flags, positional };
}

function usage(): never {
  console.log(`Staff Review evals

USAGE
  bun evals/cli.ts list
  bun evals/cli.ts run [--runs <n>]
  bun evals/cli.ts compare [--runs <n>]
  bun evals/cli.ts prepare <case|all> [--out <dir>]
  bun evals/cli.ts score <case> [--repo <dir>] [--json]

EXAMPLES
  bun run eval
  bun evals/cli.ts prepare review-quality
  bun evals/cli.ts score review-quality
`);
  process.exit(1);
}

function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

function flagNumber(flags: Record<string, string | boolean>, key: string): number | undefined {
  const value = flagString(flags, key);
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${key} must be a number`);
  return parsed;
}

function positiveInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function envNumber(name: string): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
  return parsed;
}

function parseBooleanish(value: string, name: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be true or false`);
}

function resolveConcurrency(flags: Record<string, string | boolean>): number | undefined {
  return positiveInteger(
    flagNumber(flags, "concurrency") ?? envNumber("STAFF_EVAL_CONCURRENCY"),
    "--concurrency",
  );
}

function resolveRunsFlag(flags: Record<string, string | boolean>): number | undefined {
  return positiveInteger(flagNumber(flags, "runs") ?? envNumber("STAFF_EVAL_RUNS"), "--runs");
}

export function resolveJudgeEnabled(flags: Record<string, string | boolean>): boolean {
  const noJudge = flags["no-judge"];
  if (noJudge === true) return false;
  if (typeof noJudge === "string" && parseBooleanish(noJudge, "--no-judge")) return false;

  const judge = flags.judge;
  if (judge === true) return true;
  if (typeof judge === "string") return parseBooleanish(judge, "--judge");

  const env = process.env.STAFF_EVAL_JUDGE;
  if (env) return parseBooleanish(env, "STAFF_EVAL_JUDGE");
  return true;
}

function resolveScoreOptions(
  flags: Record<string, string | boolean>,
  codexCommand?: string,
): ScoreOptions {
  const judgeTimeoutMinutes = flagNumber(flags, "judge-timeout-minutes");
  return {
    judge: resolveJudgeEnabled(flags),
    judgeCommand: flagString(flags, "judge-codex") ?? codexCommand,
    judgeCommandTemplate:
      flagString(flags, "judge-template") ?? process.env.STAFF_EVAL_JUDGE_COMMAND,
    judgeModel: flagString(flags, "judge-model") ?? process.env.STAFF_EVAL_JUDGE_MODEL,
    judgeTimeoutMs: judgeTimeoutMinutes ? judgeTimeoutMinutes * 60 * 1000 : undefined,
  };
}

function valuesFromCsv(value: string, flag: string): string[] {
  const values = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (values.length === 0) throw new Error(`${flag} must name at least one value`);
  return values;
}

function selectedInOptionOrder<T>(
  selected: string[],
  options: T[],
  valueForOption: (option: T) => string,
): string[] {
  const selectedSet = new Set(selected);
  return options.map(valueForOption).filter((value) => selectedSet.has(value));
}

function allEvalSkills(): string[] {
  return listEvalSkills().map((option) => option.value);
}

function normalizeSkill(value: string): string {
  if (value === "all") return value;
  return value.startsWith("/") ? value : `/${value}`;
}

export function skillsFromCsv(value: string): string[] {
  const skills = valuesFromCsv(value, "--skills").map(normalizeSkill);
  if (skills.includes("all")) return allEvalSkills();
  const unique = [...new Set(skills)];
  const known = new Set(allEvalSkills());
  const unknown = unique.filter((skill) => !known.has(skill));
  if (unknown.length > 0) {
    throw new Error(`Unknown eval skill(s): ${unknown.join(", ")}`);
  }
  return unique;
}

type ModelOption = Omit<ModelTarget, "model"> & {
  hint?: string;
  model?: string;
};

async function cachedModelOptions(): Promise<ModelOption[]> {
  const cachePath = join(homedir(), ".codex", "models_cache.json");
  const cache = await Bun.file(cachePath)
    .json()
    .catch(() => undefined);
  const models = Array.isArray(cache?.models) ? cache.models : [];
  return models
    .filter((model) => typeof model?.slug === "string")
    .filter((model) => model.slug !== "default")
    .map((model) => ({
      id: model.slug,
      label: typeof model.display_name === "string" ? model.display_name : model.slug,
      model: model.slug,
      hint: typeof model.description === "string" ? model.description : undefined,
    }));
}

async function modelOptions(): Promise<ModelOption[]> {
  return [
    ...(await cachedModelOptions()),
    { id: CUSTOM_MODEL, label: "Custom model", hint: "enter one or more model ids" },
  ];
}

export function modelsFromCsv(value: string): ModelTarget[] {
  const models = valuesFromCsv(value, "--models");
  if (models.includes("default")) {
    throw new Error("Eval models must be explicit; 'default' is not supported");
  }
  return models.map((model) => ({ id: model, label: model, model }));
}

function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function exitCancelled(): never {
  cancel("Eval cancelled.");
  process.exit(0);
}

async function promptSkills(): Promise<string[]> {
  const options = listEvalSkills();
  const selected = await multiselect<string>({
    message: "Select skills to eval",
    options: options.map((option) => ({
      value: option.value,
      label: option.label,
      hint: option.hint,
    })),
    initialValues: options.map((option) => option.value),
    required: true,
  });
  if (isCancel(selected)) exitCancelled();
  return selectedInOptionOrder(selected, options, (option) => option.value);
}

async function promptVersion(): Promise<string[]> {
  const options = await versionOptions();
  const selected = await multiselect<string>({
    message: "Select versions to eval",
    options: options.map((option) => ({
      value: option.value,
      label: option.label,
      hint: option.hint,
    })),
    initialValues: DEFAULT_INTERACTIVE_VERSIONS,
    required: true,
  });
  if (isCancel(selected)) exitCancelled();
  return selectedInOptionOrder(selected, options, (option) => option.value);
}

async function promptModels(): Promise<ModelTarget[]> {
  const options = await modelOptions();
  const firstExplicitModel = options.find((option) => option.id !== CUSTOM_MODEL);
  const selected = await multiselect<string>({
    message: "Select Codex models to eval",
    options: options.map((option) => ({
      value: option.id,
      label: option.label,
      hint: option.hint,
    })),
    initialValues: [firstExplicitModel?.id ?? CUSTOM_MODEL],
    required: true,
  });
  if (isCancel(selected)) exitCancelled();
  const orderedSelected = selectedInOptionOrder(selected, options, (option) => option.id);

  const models = orderedSelected
    .filter((id) => id !== CUSTOM_MODEL)
    .map((id) => options.find((option) => option.id === id))
    .filter((option): option is ModelOption => option !== undefined)
    .map((option) => ({ id: option.id, label: option.label, model: option.model ?? option.id }));

  if (orderedSelected.includes(CUSTOM_MODEL)) {
    const value = await text({
      message: "Custom model id(s)",
      placeholder: "gpt-5.4-mini,gpt-5.3-codex-spark",
      validate(input) {
        try {
          modelsFromCsv(input);
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    });
    if (isCancel(value)) exitCancelled();
    models.push(...modelsFromCsv(value));
  }

  return models;
}

async function promptRunCount(): Promise<number> {
  const value = await text({
    message: "Runs per version/model",
    initialValue: "1",
    placeholder: "1",
    validate(input) {
      const parsed = Number(input);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return "Enter a positive integer";
      }
    },
  });
  if (isCancel(value)) exitCancelled();
  return Number(value);
}

async function resolveRunSkills(
  flags: Record<string, string | boolean>,
  interactive: boolean,
): Promise<string[]> {
  const skillsFlag = flagString(flags, "skills");
  if (skillsFlag) return skillsFromCsv(skillsFlag);

  const skillFlag = flagString(flags, "skill");
  if (skillFlag) return skillsFromCsv(skillFlag);

  if (interactive) return promptSkills();
  return allEvalSkills();
}

async function resolveRunVersions(
  command: string,
  positional: string[],
  flags: Record<string, string | boolean>,
  interactive: boolean,
): Promise<string[]> {
  const versionsFlag = flagString(flags, "versions");
  if (versionsFlag) return valuesFromCsv(versionsFlag, "--versions");

  const versionFlag = flagString(flags, "version");
  if (versionFlag) return [versionFlag];

  if (positional[1]) return valuesFromCsv(positional[1], "--versions");

  if (command === "compare") {
    return (await versionOptions()).map((option) => option.value);
  }

  if (interactive) return promptVersion();
  return ["current"];
}

async function resolveRunModels(
  flags: Record<string, string | boolean>,
  interactive: boolean,
): Promise<ModelTarget[]> {
  const modelsFlag = flagString(flags, "models");
  if (modelsFlag) return modelsFromCsv(modelsFlag);

  const modelFlag = flagString(flags, "model");
  if (modelFlag) return modelsFromCsv(modelFlag);

  if (interactive) return promptModels();
  throw new Error("Pass --model <id> or --models <ids>; evals do not use default Codex config");
}

async function resolveRunCount(
  flags: Record<string, string | boolean>,
  interactive: boolean,
): Promise<number> {
  const runsFlag = resolveRunsFlag(flags);
  if (runsFlag !== undefined) return runsFlag;
  if (interactive) return promptRunCount();
  return 1;
}

function assertRunnableMatrix(
  skills: string[],
  versions: string[],
  models: ModelTarget[],
  runs: number,
): void {
  if (skills.length === 0) throw new Error("No eval skills selected");
  if (versions.length === 0) throw new Error("No Staff Review versions selected");
  if (models.length === 0) throw new Error("No Codex models selected");
  if (!Number.isInteger(runs) || runs < 1) throw new Error("No eval runs selected");
}

function printOneScore(result: ScoreResult): void {
  const pct = result.possible === 0 ? 0 : Math.round((result.score / result.possible) * 100);
  console.log(`${result.caseId}: ${result.score}/${result.possible} (${pct}%)`);
  for (const check of result.checks) {
    console.log(`  ${check.earned}/${check.possible} ${check.name}: ${check.detail}`);
  }
}

function printScore(result: ScoreResult | SuiteScoreResult): void {
  if (result.caseId !== "all") {
    printOneScore(result);
    return;
  }
  const pct = result.possible === 0 ? 0 : Math.round((result.score / result.possible) * 100);
  console.log(`all: ${result.score}/${result.possible} (${pct}%)`);
  for (const caseResult of result.cases) {
    console.log("");
    printOneScore(caseResult);
  }
}

async function main(argv: string[]): Promise<void> {
  const { flags, positional } = parseArgs(argv);
  const command = positional[0];
  if (!command) usage();

  if (command === "list") {
    for (const testCase of listCases()) {
      console.log(`${testCase.id}\t${testCase.skill}\t${testCase.title}`);
      console.log(`  ${testCase.summary}`);
    }
    return;
  }

  if (command === "run" || command === "compare") {
    const interactive = isInteractiveTerminal();
    if (interactive) intro("Staff Review evals");
    const out = flagString(flags, "out");
    const codexCommand = flagString(flags, "codex");
    const commandTemplate = flagString(flags, "codex-template") ?? process.env.CODEX_EVAL_COMMAND;
    const scoreOptions = resolveScoreOptions(flags, codexCommand);
    const timeoutMinutes = flagNumber(flags, "timeout-minutes");
    const timeoutMs = timeoutMinutes ? timeoutMinutes * 60 * 1000 : undefined;
    const concurrency = resolveConcurrency(flags);
    const skills = await resolveRunSkills(flags, interactive);
    const versions = await resolveRunVersions(command, positional, flags, interactive);
    const models = await resolveRunModels(flags, interactive);
    const runs = await resolveRunCount(flags, interactive);
    assertRunnableMatrix(skills, versions, models, runs);
    const options = {
      concurrency,
      out,
      codexCommand,
      commandTemplate,
      runs,
      skills,
      timeoutMs,
      ...scoreOptions,
    };
    const loading = interactive ? spinner() : undefined;
    loading?.start("Running eval matrix...");
    let results: VersionRunResult[];
    try {
      results =
        versions.length === 1 && models.length === 1 && runs === 1
          ? [
              await runVersionEval(versions[0]!, {
                ...options,
                model: models[0]?.model,
                modelLabel: models[0]?.label,
              }),
            ]
          : await runVersionComparison(versions, { ...options, models });
      loading?.stop("Eval matrix complete.");
    } catch (error) {
      loading?.stop("Eval matrix failed.");
      throw error;
    }
    if (flags.json) {
      console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
    } else {
      printRunSummary(results);
      const reportPath = await writeHtmlReport(results);
      console.log("");
      console.log(`HTML report: ${reportPath}`);
      if (interactive) {
        try {
          await openHtmlReport(reportPath);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`Could not open HTML report: ${message}`);
        }
      }
    }
    if (interactive) outro("Eval complete.");
    return;
  }

  if (command === "prepare") {
    const caseId = positional[1];
    if (!caseId) usage();
    const out = flagString(flags, "out");
    if (caseId === "all") {
      const result = await prepareSuite(out);
      console.log("Prepared all eval cases");
      console.log(`  suite: ${relativeFromCwd(result.repo)}`);
      console.log(`  runbook: ${relativeFromCwd(result.runbook)}`);
      console.log("");
      console.log("Run each case from RUN_ALL.md, then score the suite:");
      console.log(`  bun ${STAFFREVIEW_ROOT}/evals/cli.ts score all --repo ${result.repo}`);
      return;
    }
    const result = await prepareCase(caseId, out);
    console.log(`Prepared ${result.caseId}`);
    console.log(`  repo: ${relativeFromCwd(result.repo)}`);
    console.log(`  runbook: ${relativeFromCwd(result.runbook)}`);
    return;
  }

  if (command === "score") {
    const caseId = positional[1];
    if (!caseId) usage();
    const repo =
      flagString(flags, "repo") ??
      (caseId === "all" ? await latestPreparedSuite() : await latestPreparedRepo(caseId));
    if (!repo) {
      throw new Error(`No prepared repo found for ${caseId}; pass --repo or run prepare first`);
    }
    await ensureRepoExists(repo);
    const scoreOptions = resolveScoreOptions(flags, flagString(flags, "codex"));
    const result =
      caseId === "all"
        ? await scoreSuite(repo, scoreOptions)
        : await scoreCase(caseId, repo, scoreOptions);
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else printScore(result);
    return;
  }

  usage();
}

// Only dispatch the CLI when run as the entrypoint (`bun evals/cli.ts`).
// Guarding on `import.meta.main` lets tests import the pure parsing/resolution
// helpers above without invoking `main` against the test runner's argv.
if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: ${message}`);
    process.exit(1);
  });
}
