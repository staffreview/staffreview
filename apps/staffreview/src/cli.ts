#!/usr/bin/env bun
import { styleText } from "node:util";
import { settings as clackSettings, MultiSelectPrompt, wrapTextWithPrefix } from "@clack/core";
import { cancel, intro, isCancel, multiselect, outro, select } from "@clack/prompts";
import packageJson from "../package.json" with { type: "json" };
import { parseBooleanSetting } from "./boolean-setting.ts";
import * as git from "./git.ts";
import {
  GLOBAL_HARNESSES,
  type GlobalHarnessId,
  type InstallScope,
  installedGlobalHarnesses,
  installGlobal,
  installProject,
  parseGlobalHarnessIds,
  requiredTopLevelSkillGroups,
  STAFF_SKILL_NAMES,
  type StaffSkillName,
  skillsForTopLevelGroups,
  TOP_LEVEL_SKILL_GROUPS,
  type TopLevelSkillGroup,
  type TopLevelSkillGroupId,
  topLevelGroupsForWorkerSkill,
  topLevelSkillGroupClosure,
  topLevelSkillGroupDependencies,
  workerSkillsForTopLevelGroups,
} from "./install.ts";
import { shouldOpenBrowser as decideOpenBrowser } from "./open-browser-config.ts";
import { PORT_RANGE_START, resolvePort } from "./port.ts";
import { startServer } from "./server.ts";
import * as settings from "./settings.ts";
import * as store from "./store.ts";
import {
  COMMENT_PRIORITIES,
  type CommentPriority,
  type DiffTarget,
  type ResolutionStatus,
} from "./types.ts";
import { normalizeAgents, normalizeIntervalSeconds, runWatch } from "./watch.ts";

const VERSION = packageJson.version;
const BOOLEAN_FLAGS = new Set([
  "global",
  "help",
  "h",
  "all",
  "json",
  "no-open",
  "no-set-active",
  "open",
  "once",
  "project",
  "version",
  "v",
]);

function parseArgs(argv: string[]): {
  flags: Record<string, string | boolean>;
  positional: string[];
} {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (eq !== -1) {
        flags[name] = a.slice(eq + 1);
      } else if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = true;
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          flags[name] = true;
        } else {
          flags[name] = next;
          i++;
        }
      }
    } else if (a.startsWith("-")) {
      flags[a.slice(1)] = true;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function booleanFlag(value: string | boolean | undefined): boolean {
  return value === true || value === "true" || value === "1" || value === "yes" || value === "on";
}

function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export function installScopeFromFlags(
  flags: Record<string, string | boolean>,
): InstallScope | undefined {
  const project = booleanFlag(flags.project);
  const global = booleanFlag(flags.global);
  const scopeFlag = typeof flags.scope === "string" ? flags.scope.trim().toLowerCase() : undefined;

  if (flags.scope === true) {
    throw new Error("--scope requires a value: project or global");
  }
  if (project && global) {
    throw new Error("choose only one of --project or --global");
  }
  if (scopeFlag && (project || global)) {
    throw new Error("use either --scope or --project/--global, not both");
  }
  if (project) return "project";
  if (global) return "global";
  if (!scopeFlag) return undefined;
  if (scopeFlag === "project" || scopeFlag === "global") return scopeFlag;
  throw new Error("--scope must be one of: project, global");
}

export function globalHarnessSpecFromFlags(
  flags: Record<string, string | boolean>,
): string | undefined {
  const raw =
    typeof flags.harness === "string"
      ? flags.harness
      : typeof flags.harnesses === "string"
        ? flags.harnesses
        : undefined;
  // Once a real string value was supplied via either alias, honour it — even if
  // the *other* alias happens to parse as a valueless `true` (e.g.
  // `--harness codex --harnesses`). Only reject when no usable value was found:
  // a non-blank string already returned above, so reaching the guard with a
  // blank `raw` (`--harness=` / `--harness " "`) or a valueless flag and no
  // string at all (`raw === undefined`) both mean "asked for a harness but named
  // none". Without the blank-string guard, `--harness=` would fall through as a
  // falsy spec and silently downgrade to a project install.
  if (raw !== undefined) {
    if (raw.trim()) return raw;
    throw new Error(`--harness requires a value, e.g. --harness ${supportedGlobalHarnessIds()}`);
  }
  if (flags.harness === true || flags.harnesses === true) {
    throw new Error(`--harness requires a value, e.g. --harness ${supportedGlobalHarnessIds()}`);
  }
  return undefined;
}

/**
 * Pure resolution of the install command's scope/harness flags. Returns the
 * explicitly-requested `scope` (or `undefined`, to be filled in by the prompt /
 * project default) and the `harnessSpec` string, applying the precedence rule
 * (a bare `--harness` implies a global install) and rejecting the
 * `--project --harness` combination. Shared by `main`'s `install` dispatch and
 * the unit tests so the resolution table is asserted against the real logic.
 */
export function resolveInstallFlags(flags: Record<string, string | boolean>): {
  scope: InstallScope | undefined;
  harnessSpec: string | undefined;
} {
  const harnessSpec = globalHarnessSpecFromFlags(flags);
  const scope = installScopeFromFlags(flags) ?? (harnessSpec ? "global" : undefined);
  if (scope === "project" && harnessSpec) {
    throw new Error("--harness only applies to global installs");
  }
  return { scope, harnessSpec };
}

export async function globalHarnessesFromSpec(
  spec: string,
  homeDir?: string,
): Promise<GlobalHarnessId[]> {
  const allHarnesses = await installedGlobalHarnesses(homeDir);
  const harnesses = parseGlobalHarnessIds(spec, { allHarnesses });
  if (harnesses.length === 0) {
    throw new Error(
      "no installed global harness skill directories found. Install an agent first or create its skills directory.",
    );
  }
  return harnesses;
}

function supportedGlobalHarnessIds(): string {
  return GLOBAL_HARNESSES.map((h) => h.id).join(",");
}

function exitInstallCancelled(message = "Install cancelled."): never {
  cancel(message);
  process.exit(0);
}

async function promptInstallScope(): Promise<InstallScope> {
  const scope = await select<InstallScope>({
    message: "Where should Staff Review install its skills?",
    options: [
      {
        value: "project",
        label: "Project",
        hint: ".agents/skills + .claude/skills in this repo",
      },
      {
        value: "global",
        label: "Global",
        hint: "Install once into user-level harness skill directories",
      },
    ],
    initialValue: "project",
  });
  if (isCancel(scope)) {
    exitInstallCancelled();
  }
  return scope;
}

async function promptGlobalHarnesses(): Promise<GlobalHarnessId[] | undefined> {
  const availableHarnesses = await installedGlobalHarnesses();
  if (availableHarnesses.length === 0) {
    cancel(
      "No installed global harness skill directories found. Install an agent first or create its skills directory.",
    );
    return undefined;
  }
  const harnesses = await multiselect<GlobalHarnessId>({
    message: "Install globally to which harnesses? Press a to toggle all.",
    options: availableHarnesses.map((h) => ({
      value: h.id,
      label: h.label,
      hint: h.hint,
    })),
    required: true,
  });
  if (isCancel(harnesses)) {
    exitInstallCancelled();
  }
  return harnesses;
}

async function promptTopLevelSkillGroups(): Promise<StaffSkillName[]> {
  const selected = await promptDependencyAwareSkillGroups();
  if (isCancel(selected)) {
    exitInstallCancelled();
  }
  const orderedSelected = TOP_LEVEL_SKILL_GROUPS.filter((group) => selected.includes(group.id)).map(
    (group) => group.id,
  );
  return skillsForTopLevelGroups(orderedSelected);
}

interface SkillPromptOption {
  value: StaffSkillName;
  label: string;
  hint: string;
  kind: "top-level" | "worker";
  disabled?: boolean;
}

async function promptDependencyAwareSkillGroups(): Promise<TopLevelSkillGroupId[] | symbol> {
  const options = skillPromptOptions();
  const allGroupIds = TOP_LEVEL_SKILL_GROUPS.map((group) => group.id);
  syncLockedSkillGroupOptions(options, allGroupIds);

  const prompt = new MultiSelectPrompt<SkillPromptOption>({
    options,
    initialValues: allGroupIds,
    validate(value) {
      if (explicitTopLevelGroupIds(value ?? []).length === 0) {
        return "Choose at least one skill group, or press a to reselect all.";
      }
    },
    render() {
      syncLockedSkillGroupOptions(this.options, explicitTopLevelGroupIds(this.value ?? []));
      normalizeSkillGroupCursor(this);
      return renderSkillGroupPrompt(this);
    },
  });
  const promptInternals = prompt as unknown as {
    toggleAll(): void;
    toggleInvert(): void;
  };
  promptInternals.toggleAll = () => {
    prompt.value = toggleAllTopLevelSkillGroupSelection(prompt.value ?? []);
    syncLockedSkillGroupOptions(prompt.options, explicitTopLevelGroupIds(prompt.value));
    normalizeSkillGroupCursor(prompt);
  };
  promptInternals.toggleInvert = () => {
    const explicitGroups = explicitTopLevelGroupIds(prompt.value ?? []);
    const explicit = new Set(explicitGroups);
    const locked = new Set(requiredTopLevelSkillGroups(explicitGroups));
    prompt.value = allGroupIds.filter((id) => !locked.has(id) && !explicit.has(id));
    syncLockedSkillGroupOptions(prompt.options, explicitTopLevelGroupIds(prompt.value));
    normalizeSkillGroupCursor(prompt);
  };
  prompt.on("key", () => {
    syncLockedSkillGroupOptions(prompt.options, explicitTopLevelGroupIds(prompt.value ?? []));
    normalizeSkillGroupCursor(prompt);
  });

  const selected = await prompt.prompt();
  if (isCancel(selected)) return selected;
  return explicitTopLevelGroupIds(selected ?? []);
}

export function toggleAllTopLevelSkillGroupSelection(
  values: readonly StaffSkillName[],
): TopLevelSkillGroupId[] {
  const explicitGroups = explicitTopLevelGroupIds(values);
  const effectiveGroups = new Set(topLevelSkillGroupClosure(explicitGroups));
  const allGroupIds = TOP_LEVEL_SKILL_GROUPS.map((group) => group.id);
  const allSelected = allGroupIds.every((id) => effectiveGroups.has(id));
  return allSelected ? [] : [...allGroupIds];
}

function skillPromptOptions(): SkillPromptOption[] {
  const topLevelIds = new Set<StaffSkillName>(TOP_LEVEL_SKILL_GROUPS.map((group) => group.id));
  return STAFF_SKILL_NAMES.map((skill) => {
    const group = TOP_LEVEL_SKILL_GROUPS.find((candidate) => candidate.id === skill);
    if (group) {
      return {
        value: group.id,
        label: group.label,
        hint: skillGroupPromptHint(group),
        kind: "top-level",
      };
    }
    return {
      value: skill,
      label: `/${skill}`,
      hint: workerSkillPromptHint(skill),
      kind: "worker",
      disabled: true,
    };
  }).filter((option) => option.kind === "top-level" || !topLevelIds.has(option.value));
}

function explicitTopLevelGroupIds(values: readonly StaffSkillName[]): TopLevelSkillGroupId[] {
  const selected = new Set(values);
  return TOP_LEVEL_SKILL_GROUPS.map((group) => group.id).filter((id) => selected.has(id));
}

function syncLockedSkillGroupOptions(
  options: SkillPromptOption[],
  explicitGroupIds: readonly TopLevelSkillGroupId[],
): void {
  const locked = new Set(requiredTopLevelSkillGroups(explicitGroupIds));
  for (const option of options) {
    option.disabled = option.kind === "worker" || locked.has(option.value as TopLevelSkillGroupId);
  }
}

function normalizeSkillGroupCursor(
  prompt: Pick<MultiSelectPrompt<SkillPromptOption>, "cursor" | "options">,
): void {
  if (!prompt.options.some((option) => !option.disabled)) return;
  while (prompt.options[prompt.cursor]?.disabled) {
    prompt.cursor = (prompt.cursor + 1) % prompt.options.length;
  }
}

function renderSkillGroupPrompt(
  prompt: Omit<MultiSelectPrompt<SkillPromptOption>, "prompt">,
): string {
  const withGuide = clackSettings.withGuide;
  const explicitGroupIds = explicitTopLevelGroupIds(prompt.value ?? []);
  const lockedGroupIds = new Set(requiredTopLevelSkillGroups(explicitGroupIds));
  const selected = new Set<StaffSkillName>([
    ...topLevelSkillGroupClosure(explicitGroupIds),
    ...workerSkillsForTopLevelGroups(explicitGroupIds),
  ]);
  const submittedOptions = prompt.options.filter((option) => selected.has(option.value));
  const submitted =
    submittedOptions.length > 0
      ? submittedOptions.map((option) => option.label.trim()).join(", ")
      : "no skill groups";
  const message = "Select Staff Review skill groups to install. Press a to toggle all.";
  const header = `${withGuide ? `${styleText("gray", CLACK_BAR)}\n` : ""}${clackSymbol(prompt.state)}  ${message}\n`;

  switch (prompt.state) {
    case "submit":
      return `${header}${wrapTextWithPrefix(
        undefined,
        styleText("dim", submitted),
        withGuide ? `${styleText("gray", CLACK_BAR)}  ` : "",
      )}`;
    case "cancel":
      return `${header}${wrapTextWithPrefix(
        undefined,
        styleText(["strikethrough", "dim"], submitted),
        withGuide ? `${styleText("gray", CLACK_BAR)}  ` : "",
      )}${withGuide ? `\n${styleText("gray", CLACK_BAR)}` : ""}`;
    default: {
      const activeColor = prompt.state === "error" ? "yellow" : "cyanBright";
      const rowPrefix = withGuide ? `${styleText(activeColor, CLACK_BAR)}  ` : "";
      const rows = prompt.options.map((option, index) => {
        const locked =
          option.kind === "worker" || lockedGroupIds.has(option.value as TopLevelSkillGroupId);
        return wrapTextWithPrefix(
          undefined,
          renderSkillGroupPromptOption({
            option,
            active: index === prompt.cursor && !locked,
            selected: selected.has(option.value),
            locked,
            explicitGroupIds,
          }),
          rowPrefix,
        );
      });
      const error =
        prompt.state === "error" && prompt.error
          ? `\n${withGuide ? `${styleText("yellow", CLACK_BAR_END)}  ` : ""}${styleText(
              "yellow",
              prompt.error,
            )}`
          : "";
      return `${header}${rows.join("\n")}\n${withGuide ? styleText(activeColor, CLACK_BAR_END) : ""}${error}`;
    }
  }
}

const CLACK_BAR = "│";
const CLACK_BAR_END = "└";
const CLACK_STEP_ACTIVE = "◆";
const CLACK_STEP_CANCEL = "■";
const CLACK_STEP_ERROR = "▲";
const CLACK_STEP_SUBMIT = "◇";
const CLACK_CHECKBOX_ACTIVE = "◻";
const CLACK_CHECKBOX_SELECTED = "◼";
const CLACK_CHECKBOX_INACTIVE = "◻";

function clackSymbol(state: "initial" | "active" | "cancel" | "submit" | "error"): string {
  switch (state) {
    case "submit":
      return styleText("green", CLACK_STEP_SUBMIT);
    case "cancel":
      return styleText("red", CLACK_STEP_CANCEL);
    case "error":
      return styleText("yellow", CLACK_STEP_ERROR);
    default:
      return styleText("cyanBright", CLACK_STEP_ACTIVE);
  }
}

function renderSkillGroupPromptOption({
  option,
  active,
  selected,
  locked,
  explicitGroupIds,
}: {
  option: SkillPromptOption;
  active: boolean;
  selected: boolean;
  locked: boolean;
  explicitGroupIds: readonly TopLevelSkillGroupId[];
}): string {
  const hint = option.hint
    ? ` (${option.hint}${locked ? ` ${lockedByHint(option, explicitGroupIds)}` : ""})`
    : "";
  if (locked) {
    const connector = option.kind === "worker" ? styleText("gray", "└ ") : "";
    return `${styleText("gray", selected ? CLACK_CHECKBOX_SELECTED : CLACK_CHECKBOX_INACTIVE)} ${connector}${styleText("gray", option.label)}${styleText("dim", hint)}`;
  }
  if (active && selected) {
    return `${styleText("green", CLACK_CHECKBOX_SELECTED)} ${styleText(["bold", "cyanBright"], option.label)}${styleText("dim", hint)}`;
  }
  if (active) {
    return `${styleText("cyanBright", CLACK_CHECKBOX_ACTIVE)} ${styleText(["bold", "cyanBright"], option.label)}${styleText("dim", hint)}`;
  }
  if (selected) {
    return `${styleText("green", CLACK_CHECKBOX_SELECTED)} ${styleText("white", option.label)}${styleText("dim", hint)}`;
  }
  return `${styleText("dim", CLACK_CHECKBOX_INACTIVE)} ${styleText("white", option.label)}${styleText("dim", hint)}`;
}

function lockedByHint(
  option: SkillPromptOption,
  explicitGroupIds: readonly TopLevelSkillGroupId[],
): string {
  const parents =
    option.kind === "worker"
      ? selectedWorkerParents(option.value, explicitGroupIds)
      : explicitGroupIds.filter(
          (id) =>
            id !== option.value &&
            topLevelSkillGroupDependencies(id).includes(option.value as TopLevelSkillGroupId),
        );
  if (parents.length === 0) return "Required by selected groups.";
  return `${option.kind === "worker" ? "Included by" : "Required by"} ${parents.map((id) => `/${id}`).join(", ")}.`;
}

function skillGroupPromptHint(group: TopLevelSkillGroup): string {
  const parts = [group.description];
  const dependencies = topLevelSkillGroupDependencies(group.id);
  if (dependencies.length > 0) {
    parts.push(`Requires ${dependencies.map((id) => `/${id}`).join(", ")}.`);
  }
  if ((group.workers?.length ?? 0) > 0) {
    parts.push(`Includes workers ${group.workers!.map((name) => `/${name}`).join(", ")}.`);
  }
  return parts.join(" ");
}

function workerSkillPromptHint(skill: StaffSkillName): string {
  const parentGroups = topLevelGroupsForWorkerSkill(skill);
  const descriptions: Partial<Record<StaffSkillName, string>> = {
    "staff-review-find": "Find candidate issues in assigned review slices.",
    "staff-review-verify": "Verify candidate findings before comments are posted.",
    "staff-docs-scout": "Scout PR review history for reusable lessons.",
  };
  const description = descriptions[skill] ?? "Internal worker skill.";
  return `${description} Worker for ${parentGroups.map((id) => `/${id}`).join(", ")}.`;
}

function selectedWorkerParents(
  worker: StaffSkillName,
  explicitGroupIds: readonly TopLevelSkillGroupId[],
): TopLevelSkillGroupId[] {
  const effectiveGroups = new Set(topLevelSkillGroupClosure(explicitGroupIds));
  return topLevelGroupsForWorkerSkill(worker).filter((id) => effectiveGroups.has(id));
}

function parseTarget(spec: string | undefined): DiffTarget {
  if (!spec) return { kind: "ref", ref: "HEAD" };
  const lower = spec.toLowerCase();
  if (lower === "working-tree" || lower === "wt" || lower === "working")
    return { kind: "working-tree" };
  if (lower === "staged" || lower === "index") return { kind: "staged" };
  return { kind: "ref", ref: spec };
}

async function openBrowser(url: string) {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
}

function help() {
  console.log(`Staff Review — code review tool (v${VERSION})

USAGE
  staff [serve] [<slug>]        Start the web UI (default). Pass a diff slug
                                 (e.g. main..WT or <sha>..WT) to open the UI on
                                 that diff, creating it from the slug if needed.
    --port <n>                   Port (default: $PORT, else the first free
                                 port at or above ${PORT_RANGE_START}).
    --open                       Open a browser even if openBrowser is false.
    --no-open                    Don't open a browser.
    --repo <dir>                 Repository to review (default: current directory).

  staff active [--json]         Print the active diff.
  staff diff [<slug>] [--base <t>] [--head <t>] [--json] [--no-set-active]
                                 Create/load a diff and (optionally) set active.
                                 <slug> is base..head (e.g. main..WT); or use
                                 --base/--head where <t> is working-tree, staged,
                                 or any git ref.

  staff files [--slug <slug>] [--json]
                                 Print the file-level changes for a diff.

  staff comment add  [--slug <s>] [--file <p>] [--line <n>] [--end-line <n>]
                     [--side new|old] [--body <text>] [--reply-to <id>] [--author <name>]
                     [--priority P1|P2|P3]
                     (--line + --end-line anchors the comment to a line range)
                     (--priority is an AI-reviewer severity; P1 = most urgent)
                     (prints the new comment's JSON, including its id)
  staff comment edit   --id <id> [--body <text>] [--slug <s>]
                       (revise the body of a comment you posted)
  staff comment delete --id <id> [--slug <s>]
                       (remove a comment you posted; also removes its replies)
  staff comment list [--slug <s>] [--open] [--json]
  staff comment resolve --thread <id> --status <fixed|skipped|documented>
                        --body <text> [--documented-as <name>] [--slug <s>]
  staff comment unresolve --thread <id> [--slug <s>]

  staff settings [--json]       Print global settings (with defaults applied).
  staff settings get <key>      Print one setting's value: loopMaxRounds (the
                                 /staff-loop round cap, default ${settings.DEFAULT_LOOP_ROUNDS}), reviewAgents
                                 (the /staff-review fan-out, default ${settings.DEFAULT_REVIEW_AGENTS}), sectionAgents
                                 (the /staff-section fan-out, default ${settings.DEFAULT_SECTION_AGENTS}), or docsAgents
                                 (the /staff-docs scout fan-out, default ${settings.DEFAULT_DOCS_AGENTS}),
                                 openBrowser (whether serve opens a browser,
                                 default ${settings.DEFAULT_OPEN_BROWSER}), structuredHighlighting
                                 (intra-line word-diff highlighting,
                                 default ${settings.DEFAULT_STRUCTURED_HIGHLIGHTING}), or wrapLines
                                 (wrap long diff lines vs. scroll horizontally,
                                 default ${settings.DEFAULT_WRAP_LINES}).
  staff settings set <openBrowser|structuredHighlighting|wrapLines> <true|false>
                                 Persist whether serve opens a browser / shows
                                 intra-line word-diff highlighting / wraps long
                                 diff lines.

  staff watch <pr> [--agents <n>] [--interval <seconds>] [--once]
  staff watch --all [--agents <n>] [--interval <seconds>] [--once]
                                 Watch GitHub PR commits and run /staff-review
                                 whenever a watched PR gets a new commit.
                                 Posts a reusable status comment and mirrors
                                 findings to GitHub PR comments. <pr> is any ref
                                 accepted by \`gh pr view\`; --all watches open,
                                 non-draft PRs. Uses codex exec by default, or
                                 --review-command / $STAFF_WATCH_REVIEW_COMMAND.

  staff install [--scope project|global] [--harness <ids|all>]
                                 Set up Staff Review skills. In an interactive
                                 terminal, prompts for project vs global install
                                 and which top-level skill groups to include.
                                 All skill groups start selected; press a to
                                 toggle all on/off.
                                 Project install writes selected /staff-* skills
                                 plus required top-level groups and internal
                                 worker skills to .agents/skills/
                                 (symlinked into .claude/skills/),
                                 creates the .staffreview/ store, and gitignores
                                 per-machine state including section-cache.json.
                                 Global install writes selected skills to
                                 selected installed harness skill directories.
                                 Supported harness ids:
                                 ${supportedGlobalHarnessIds()}, or all installed.
                                 Use --project or --global as shorthand
                                 for --scope.

  staff --version | --help
`);
}

async function readBodyFromStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  let s = "";
  for await (const chunk of process.stdin as any) s += chunk;
  return s.trimEnd();
}

async function activeSlugOrThrow(cwd: string, override?: string): Promise<string> {
  if (override) return override;
  const slug = await store.getActiveDiffSlug(cwd);
  if (!slug) {
    throw new Error(
      "No active diff. Run `staff diff --base <ref> --head <ref>` first, or open the web UI.",
    );
  }
  return slug;
}

async function main(argv: string[]) {
  const { flags, positional } = parseArgs(argv);

  if (flags.version || flags.v || positional[0] === "version") {
    console.log(VERSION);
    return;
  }
  if (flags.help || flags.h || positional[0] === "help") {
    help();
    return;
  }

  // `staff <slug>` (or `staff serve <slug>`) is shorthand for serving with
  // a specific diff targeted. A slug isn't a known subcommand and always
  // contains the ".." separator (e.g. `main..WT`, `<sha>..WT`).
  const KNOWN_COMMANDS = new Set([
    "serve",
    "active",
    "diff",
    "files",
    "comment",
    "settings",
    "watch",
    "install",
    "version",
    "help",
  ]);
  const first = positional[0] ?? "serve";
  const firstIsSlug = !KNOWN_COMMANDS.has(first) && first.includes("..");
  const cmd = firstIsSlug ? "serve" : first;
  const serveSlug = firstIsSlug
    ? first
    : first === "serve" && typeof positional[1] === "string" && positional[1].includes("..")
      ? positional[1]
      : undefined;
  const initialCwd = typeof flags.repo === "string" ? flags.repo : process.cwd();
  // Anchor to the repo root so paths line up between git and local file reads.
  // `version`/`help` don't touch the filesystem; everything else (including
  // `install`) prefers the git root when there is one, else the cwd.
  const cwd =
    cmd === "version" || cmd === "help"
      ? initialCwd
      : (await git.isGitRepo(initialCwd))
        ? await git.gitRoot(initialCwd)
        : initialCwd;

  switch (cmd) {
    case "serve": {
      const port = resolvePort(flags.port);

      // If a slug was passed, make it the active diff so the UI opens on
      // it. Load the existing diff file if present; otherwise reconstruct
      // base/head from the slug and create it.
      let activeSlug: string | undefined;
      if (serveSlug) {
        try {
          const existing = await store.loadDiff(serveSlug, cwd);
          if (existing) {
            await store.setActiveDiff(serveSlug, cwd);
            activeSlug = serveSlug;
          } else {
            const targets = await git.resolveSlugTargets(serveSlug, cwd);
            if (!targets) {
              console.error(`\x1b[31mwarning:\x1b[0m not a valid diff slug: ${serveSlug}`);
            } else {
              const c = await store.loadOrCreateDiff(targets.base, targets.head, cwd);
              await store.setActiveDiff(c.slug, cwd);
              activeSlug = c.slug;
            }
          }
        } catch (e) {
          console.error(
            `\x1b[31mwarning:\x1b[0m could not target ${serveSlug}: ${(e as Error).message}`,
          );
        }
      }

      let server: Awaited<ReturnType<typeof startServer>>;
      try {
        server = await startServer({ port, cwd });
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        if (port !== undefined) {
          console.error(`\x1b[31merror:\x1b[0m could not bind port ${port}: ${msg}`);
          console.error(
            "  Pass a different --port (or $PORT), or omit it to auto-pick a free port.",
          );
        } else {
          console.error(`\x1b[31merror:\x1b[0m could not start the server: ${msg}`);
        }
        process.exit(1);
      }
      const base = server.url.toString();
      const url = activeSlug ? `${base}?diff=${encodeURIComponent(activeSlug)}` : base;
      console.log(`\x1b[1m  Staff Review\x1b[0m  ${url}`);
      console.log(`  cwd: ${cwd}`);
      console.log(`  store: .staffreview/`);
      console.log("");
      // Only open the browser on first launch. With `bun --hot`, modules
      // re-evaluate on every source change; this sentinel survives across
      // hot reloads so we don't keep popping new tabs.
      const g = globalThis as { __staffBrowserOpened?: boolean };
      const globalSettings = await settings.readSettings();
      const openBrowserSetting =
        typeof globalSettings.openBrowser === "boolean"
          ? globalSettings.openBrowser
          : settings.DEFAULT_OPEN_BROWSER;
      const shouldOpenBrowser = decideOpenBrowser({
        noOpen: booleanFlag(flags["no-open"]),
        open: booleanFlag(flags.open),
        setting: openBrowserSetting,
      });
      if (shouldOpenBrowser && !g.__staffBrowserOpened) {
        openBrowser(url);
        g.__staffBrowserOpened = true;
      }
      return;
    }

    case "install": {
      const interactive = isInteractiveTerminal();
      const { scope: resolvedScope, harnessSpec: harnessSpecFromFlags } =
        resolveInstallFlags(flags);
      let scope = resolvedScope;
      let usedPrompt = false;

      if (!scope) {
        if (interactive) {
          intro("Staff Review install");
          usedPrompt = true;
          scope = await promptInstallScope();
        } else {
          scope = "project";
        }
      }
      if (interactive && !usedPrompt) {
        intro("Staff Review install");
        usedPrompt = true;
      }
      const skillNames = interactive ? await promptTopLevelSkillGroups() : undefined;

      if (scope === "project") {
        await installProject(cwd, console.log, { skillNames });
        if (usedPrompt) outro("Project install complete.");
        return;
      }

      let harnesses = harnessSpecFromFlags
        ? await globalHarnessesFromSpec(harnessSpecFromFlags)
        : undefined;
      if (!harnesses) {
        if (!interactive) {
          throw new Error(
            `--global requires --harness <${supportedGlobalHarnessIds()}|all> when not running interactively`,
          );
        }
        if (!usedPrompt) {
          intro("Staff Review install");
          usedPrompt = true;
        }
        harnesses = await promptGlobalHarnesses();
        if (!harnesses) return;
      }

      await installGlobal(harnesses, { skillNames });
      if (usedPrompt) outro("Global install complete.");
      return;
    }

    case "active": {
      const slug = await store.getActiveDiffSlug(cwd);
      if (!slug) {
        if (flags.json) console.log("null");
        else console.log("(no active diff)");
        return;
      }
      const c = await store.loadDiff(slug, cwd);
      if (flags.json) console.log(JSON.stringify(c, null, 2));
      else {
        if (!c) {
          console.error("active diff is missing or corrupt");
          return;
        }
        console.log(`slug: ${c.slug}`);
        console.log(`base: ${git.targetLabel(c.base)}`);
        console.log(`head: ${git.targetLabel(c.head)}`);
        console.log(`comments: ${c.comments.length}`);
      }
      return;
    }

    case "diff": {
      // Accept either a positional slug (`staff diff main..WT`) or the
      // explicit --base/--head flags. The slug form is what the skills
      // and the share UI use.
      const slugArg =
        typeof positional[1] === "string" && positional[1].includes("..")
          ? positional[1]
          : undefined;
      let base: DiffTarget;
      let head: DiffTarget;
      if (slugArg) {
        const targets = await git.resolveSlugTargets(slugArg, cwd);
        if (!targets) throw new Error(`not a valid diff slug: ${slugArg}`);
        base = targets.base;
        head = targets.head;
      } else {
        // Pin refs (esp. the default `HEAD`) to concrete commits so the diff
        // and its slug are anchored — never `HEAD..WT`, which moves on commit.
        const resolved = await git.resolveTargets(
          parseTarget(typeof flags.base === "string" ? flags.base : undefined),
          parseTarget(typeof flags.head === "string" ? flags.head : "working-tree"),
          cwd,
        );
        base = resolved.base;
        head = resolved.head;
      }
      const c = await store.loadOrCreateDiff(base, head, cwd);
      if (flags["no-set-active"] !== true) {
        await store.setActiveDiff(c.slug, cwd);
      }
      if (flags.json) console.log(JSON.stringify(c, null, 2));
      else console.log(`slug: ${c.slug}\nfile: .staffreview/diffs/${c.slug}.json`);
      return;
    }

    case "files": {
      const slug = await activeSlugOrThrow(
        cwd,
        typeof flags.slug === "string" ? flags.slug : undefined,
      );
      const c = await store.loadDiff(slug, cwd);
      if (!c) throw new Error(`diff not found: ${slug}`);
      const files = await git.getDiff(c.base, c.head, cwd);
      if (flags.json) console.log(JSON.stringify({ slug, files }, null, 2));
      else {
        for (const f of files) console.log(`${f.status[0]!.toUpperCase()}\t${f.path}`);
      }
      return;
    }

    case "comment": {
      const sub = positional[1];
      if (!sub) {
        help();
        return;
      }
      const slug = await activeSlugOrThrow(
        cwd,
        typeof flags.slug === "string" ? flags.slug : undefined,
      );

      if (sub === "add") {
        let body = typeof flags.body === "string" ? flags.body : "";
        if (!body) body = await readBodyFromStdin();
        if (!body.trim()) throw new Error("--body is required (or pipe via stdin)");
        const file = typeof flags.file === "string" ? flags.file : undefined;
        const line = typeof flags.line === "string" ? Number(flags.line) : undefined;
        // Optional end of a multi-line range; only meaningful with --line
        // and when it differs from it. Mirrors the UI's range comments.
        const endLineRaw =
          typeof flags["end-line"] === "string" ? Number(flags["end-line"]) : undefined;
        const endLine =
          endLineRaw != null && Number.isFinite(endLineRaw) && line != null && endLineRaw !== line
            ? endLineRaw
            : undefined;
        const side = (flags.side === "old" ? "old" : flags.side === "new" ? "new" : undefined) as
          | "old"
          | "new"
          | undefined;
        const author = typeof flags.author === "string" ? flags.author : "agent";
        const parentId =
          typeof flags["reply-to"] === "string" ? (flags["reply-to"] as string) : undefined;
        // Optional agent-only severity (P1 = most urgent). Accept P1/P2/P3 or a
        // bare 1/2/3, validated against the canonical set so they can't drift.
        let priority: CommentPriority | undefined;
        if (typeof flags.priority === "string") {
          const norm =
            `P${flags.priority.trim().toUpperCase().replace(/^P/, "")}` as CommentPriority;
          if (!COMMENT_PRIORITIES.includes(norm)) {
            throw new Error(
              `--priority must be one of: ${COMMENT_PRIORITIES.join(", ")} (P1 = most urgent/serious)`,
            );
          }
          priority = norm;
        }
        const comment = await store.addComment(
          slug,
          { body, file, line, endLine, side, author, parentId, priority },
          cwd,
        );
        console.log(JSON.stringify(comment, null, 2));
        return;
      }

      if (sub === "edit") {
        const id = typeof flags.id === "string" ? flags.id : undefined;
        if (!id) throw new Error("--id is required (the comment id from `comment add`)");
        let body = typeof flags.body === "string" ? flags.body : "";
        if (!body) body = await readBodyFromStdin();
        if (!body.trim()) throw new Error("--body is required (or pipe via stdin)");
        const diff = await store.updateComment(slug, id, body, cwd);
        const updated = diff.comments.find((x) => x.id === id);
        console.log(JSON.stringify(updated, null, 2));
        return;
      }

      if (sub === "delete") {
        const id = typeof flags.id === "string" ? flags.id : undefined;
        if (!id) throw new Error("--id is required (the comment id from `comment add`)");
        const before = await store.loadDiff(slug, cwd);
        if (!before) throw new Error(`diff not found: ${slug}`);
        // Error rather than silently no-op on an unknown id.
        if (!before.comments.some((x) => x.id === id)) throw new Error(`comment not found: ${id}`);
        // deleteComment removes the whole reply subtree; derive the count from
        // the before/after sizes so it stays accurate regardless of nesting.
        const after = await store.deleteComment(slug, id, cwd);
        const removed = before.comments.length - after.comments.length;
        const replies = removed - 1;
        if (flags.json) console.log(JSON.stringify({ deleted: id, removed }, null, 2));
        else
          console.log(
            `deleted comment ${id.slice(0, 8)}${replies > 0 ? ` (+${replies} repl${replies === 1 ? "y" : "ies"})` : ""}`,
          );
        return;
      }

      if (sub === "list") {
        const c = await store.loadDiff(slug, cwd);
        if (!c) throw new Error("diff not found");
        const byThread = new Map<string, typeof c.comments>();
        for (const cm of c.comments) {
          const a = byThread.get(cm.threadId) ?? [];
          a.push(cm);
          byThread.set(cm.threadId, a);
        }
        let threads = Array.from(byThread.values()).map((cs) =>
          cs.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        );
        if (flags.open) {
          threads = threads.filter((t) => !t.find((x) => !x.parentId)?.resolution);
        }
        if (flags.json) {
          const out = threads.map((t) => {
            const root = t.find((c) => !c.parentId) ?? t[0]!;
            return {
              threadId: root.threadId,
              file: root.file,
              line: root.line,
              endLine: root.endLine,
              side: root.side,
              resolution: root.resolution,
              documentRequested: root.documentRequested ?? false,
              comments: t,
            };
          });
          console.log(JSON.stringify(out, null, 2));
        } else {
          for (const t of threads) {
            const r = t.find((c) => !c.parentId)!;
            const status = r.resolution?.status ?? (r.documentRequested ? "to-document" : "open");
            const loc = r.file ? `${r.file}:${r.line ?? ""}` : "(top-level)";
            console.log(`[${status}] ${r.threadId.slice(0, 8)} ${loc}`);
            console.log(`  ${r.body.split("\n")[0]}`);
          }
        }
        return;
      }

      if (sub === "resolve") {
        const threadId = typeof flags.thread === "string" ? flags.thread : undefined;
        const status = flags.status as ResolutionStatus | undefined;
        let body = typeof flags.body === "string" ? flags.body : "";
        if (!body) body = await readBodyFromStdin();
        const documentedAs =
          typeof flags["documented-as"] === "string"
            ? (flags["documented-as"] as string)
            : undefined;
        if (!threadId) throw new Error("--thread is required");
        if (!status || !["fixed", "skipped", "documented"].includes(status)) {
          throw new Error("--status must be one of: fixed | skipped | documented");
        }
        if (!body.trim()) throw new Error("--body is required (or pipe via stdin)");
        const author = typeof flags.author === "string" ? flags.author : "agent";
        const c = await store.resolveThread(
          slug,
          threadId,
          { status, body, author, documentedAs },
          cwd,
        );
        if (flags.json) console.log(JSON.stringify(c, null, 2));
        else console.log(`thread ${threadId.slice(0, 8)} → ${status}`);
        return;
      }

      if (sub === "unresolve") {
        const threadId = typeof flags.thread === "string" ? flags.thread : undefined;
        if (!threadId) throw new Error("--thread is required");
        const c = await store.unresolveThread(slug, threadId, cwd);
        if (flags.json) console.log(JSON.stringify(c, null, 2));
        else console.log(`thread ${threadId.slice(0, 8)} → reopened`);
        return;
      }

      throw new Error(`Unknown subcommand: comment ${sub}`);
    }

    case "settings": {
      // Settings are global (per-user config dir), not per-repo. Seed defaults
      // so skills and CLI callers read concrete values even when unset.
      // Annotate as a string-indexable record so `resolved[key]` below (key is
      // an arbitrary CLI argument) type-checks under strict mode — `GlobalSettings`
      // has no string index signature.
      const resolved: Record<string, unknown> = settings.settingsWithDefaults(
        await settings.readSettings(),
      );
      if (positional[1] === "get") {
        const key = positional[2];
        if (!key) throw new Error("usage: staff settings get <key>");
        const value = resolved[key];
        if (value === undefined) {
          console.error(`\x1b[33mnote:\x1b[0m setting not set: ${key}`);
          return;
        }
        console.log(flags.json ? JSON.stringify(value) : String(value));
        return;
      }
      if (positional[1] === "set") {
        const key = positional[2];
        if (key !== "openBrowser" && key !== "structuredHighlighting" && key !== "wrapLines") {
          throw new Error(
            "usage: staff settings set <openBrowser|structuredHighlighting|wrapLines> <true|false>",
          );
        }
        const value = parseBooleanSetting(positional[3], key);
        const update: settings.GlobalSettings = { [key]: value };
        await settings.writeSettings(update);
        if (flags.json) console.log(JSON.stringify({ [key]: value }, null, 2));
        else console.log(`${key}: ${value}`);
        return;
      }
      console.log(JSON.stringify(resolved, null, 2));
      return;
    }

    case "watch": {
      const prRef = positional[1];
      const watchAll = booleanFlag(flags.all);
      if (watchAll && prRef) {
        throw new Error("use either `staff watch <pr>` or `staff watch --all`, not both");
      }
      const configuredSettings = settings.settingsWithDefaults(await settings.readSettings());
      await runWatch({
        cwd,
        prRef,
        all: watchAll,
        once: booleanFlag(flags.once),
        intervalSeconds: normalizeIntervalSeconds(
          typeof flags.interval === "string" ? flags.interval : undefined,
        ),
        agents: normalizeAgents(
          typeof flags.agents === "string" ? flags.agents : configuredSettings.reviewAgents,
        ),
        reviewCommand:
          typeof flags["review-command"] === "string" ? flags["review-command"] : undefined,
        log: console.log,
      });
      return;
    }

    default:
      help();
      process.exit(1);
  }
}

// Only dispatch the CLI when run as the entrypoint (`bun src/cli.ts` or the
// compiled binary). Guarding on `import.meta.main` lets tests import the pure
// flag-resolution helpers above without invoking `main` against the test
// runner's argv.
if (import.meta.main) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`\x1b[31merror:\x1b[0m ${msg}`);
    process.exit(1);
  });
}
