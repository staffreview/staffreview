import { mkdir, rm, stat, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
// Reference guides: each thin SKILL.md points at a `references/<file>.md` that
// holds the actual brief. They live beside the canonical SKILL.md under
// `.agents/skills/<name>/references/`; the build inlines them as text (just like
// the SKILL.md symlinks above) so `staff install` can write them next to the
// SKILL.md. Without this the installed skill is a dangling pointer — the
// orchestrators tell their sub-agents to read a reference file that isn't there.
import refCommentCli from "../../../.agents/skills/staff-comment/references/cli.md" with {
  type: "text",
};
import refCopyWorkflow from "../../../.agents/skills/staff-copy/references/copy-workflow.md" with {
  type: "text",
};
import refDocsWorkflow from "../../../.agents/skills/staff-docs/references/workflow.md" with {
  type: "text",
};
import refDocsScoutGuide from "../../../.agents/skills/staff-docs-scout/references/scout-guide.md" with {
  type: "text",
};
import refDocumentFormat from "../../../.agents/skills/staff-document/references/document-format.md" with {
  type: "text",
};
import refLoopWorkflow from "../../../.agents/skills/staff-loop/references/loop-workflow.md" with {
  type: "text",
};
import refResolveWorkflow from "../../../.agents/skills/staff-resolve/references/resolve-workflow.md" with {
  type: "text",
};
import refReviewWorkflow from "../../../.agents/skills/staff-review/references/review-workflow.md" with {
  type: "text",
};
import refReviewFindGuide from "../../../.agents/skills/staff-review-find/references/find-guide.md" with {
  type: "text",
};
import refReviewVerifyGuide from "../../../.agents/skills/staff-review-verify/references/verify-guide.md" with {
  type: "text",
};
import refSectionWorkflow from "../../../.agents/skills/staff-section/references/section-workflow.md" with {
  type: "text",
};
import skillComment from "../skills/staff-comment.md" with { type: "text" };
import skillCopy from "../skills/staff-copy.md" with { type: "text" };
import skillDocs from "../skills/staff-docs.md" with { type: "text" };
import skillDocsScout from "../skills/staff-docs-scout.md" with { type: "text" };
import skillDocument from "../skills/staff-document.md" with { type: "text" };
import skillLoop from "../skills/staff-loop.md" with { type: "text" };
import skillResolve from "../skills/staff-resolve.md" with { type: "text" };
import skillReview from "../skills/staff-review.md" with { type: "text" };
import skillReviewFind from "../skills/staff-review-find.md" with { type: "text" };
import skillReviewVerify from "../skills/staff-review-verify.md" with { type: "text" };
import skillSection from "../skills/staff-section.md" with { type: "text" };
import * as store from "./store.ts";

export const STAFF_SKILL_NAMES = [
  "staff-review",
  "staff-review-find",
  "staff-review-verify",
  "staff-section",
  "staff-comment",
  "staff-copy",
  "staff-document",
  "staff-resolve",
  "staff-loop",
  "staff-docs",
  "staff-docs-scout",
] as const;

export type StaffSkillName = (typeof STAFF_SKILL_NAMES)[number];

export const SKILLS: Record<StaffSkillName, string> = {
  "staff-review": skillReview,
  "staff-review-find": skillReviewFind,
  "staff-review-verify": skillReviewVerify,
  "staff-section": skillSection,
  "staff-comment": skillComment,
  "staff-copy": skillCopy,
  "staff-document": skillDocument,
  "staff-resolve": skillResolve,
  "staff-loop": skillLoop,
  "staff-docs": skillDocs,
  "staff-docs-scout": skillDocsScout,
};

export const TOP_LEVEL_SKILL_GROUP_IDS = [
  "staff-review",
  "staff-section",
  "staff-resolve",
  "staff-loop",
  "staff-copy",
  "staff-document",
  "staff-docs",
  "staff-comment",
] as const satisfies readonly StaffSkillName[];

export type TopLevelSkillGroupId = (typeof TOP_LEVEL_SKILL_GROUP_IDS)[number];

export interface TopLevelSkillGroup {
  id: TopLevelSkillGroupId;
  label: string;
  description: string;
  skill: StaffSkillName;
  requires?: readonly TopLevelSkillGroupId[];
  workers?: readonly StaffSkillName[];
}

export const TOP_LEVEL_SKILL_GROUPS = [
  {
    id: "staff-review",
    label: "/staff-review",
    description: "Review active diffs with find/verify agents and post confirmed comments.",
    skill: "staff-review",
    requires: ["staff-comment"],
    workers: ["staff-review-find", "staff-review-verify"],
  },
  {
    id: "staff-section",
    label: "/staff-section",
    description: "Review existing code section by section using the standard review workers.",
    skill: "staff-section",
    requires: ["staff-comment"],
    workers: ["staff-review-find", "staff-review-verify"],
  },
  {
    id: "staff-resolve",
    label: "/staff-resolve",
    description: "Fix, document, or skip open Staff Review threads.",
    skill: "staff-resolve",
    requires: ["staff-comment", "staff-document"],
  },
  {
    id: "staff-loop",
    label: "/staff-loop",
    description: "Review and resolve repeatedly until a working-tree diff converges.",
    skill: "staff-loop",
    requires: ["staff-resolve"],
    workers: ["staff-review-find", "staff-review-verify"],
  },
  {
    id: "staff-copy",
    label: "/staff-copy",
    description: "Copy unresolved GitHub PR review threads into local Staff Review diffs.",
    skill: "staff-copy",
  },
  {
    id: "staff-document",
    label: "/staff-document",
    description: "Save a review comment as a reusable .staffreview/docs lesson.",
    skill: "staff-document",
  },
  {
    id: "staff-docs",
    label: "/staff-docs",
    description: "Mine GitHub PR review history for reusable lessons.",
    skill: "staff-docs",
    requires: ["staff-comment", "staff-document"],
    workers: ["staff-docs-scout"],
  },
  {
    id: "staff-comment",
    label: "/staff-comment",
    description: "Add, edit, delete, list, and resolve Staff Review comments.",
    skill: "staff-comment",
  },
] as const satisfies readonly TopLevelSkillGroup[];

function topLevelGroupById(id: TopLevelSkillGroupId): TopLevelSkillGroup {
  const group = TOP_LEVEL_SKILL_GROUPS.find((g) => g.id === id);
  if (!group) throw new Error(`unknown top-level skill group: ${id}`);
  return group;
}

export function topLevelSkillGroupDependencies(
  groupId: TopLevelSkillGroupId,
): TopLevelSkillGroupId[] {
  const dependencies: TopLevelSkillGroupId[] = [];
  const seen = new Set<TopLevelSkillGroupId>();
  const visit = (id: TopLevelSkillGroupId) => {
    for (const dependency of topLevelGroupById(id).requires ?? []) {
      if (seen.has(dependency)) continue;
      seen.add(dependency);
      dependencies.push(dependency);
      visit(dependency);
    }
  };
  visit(groupId);
  return dependencies;
}

export function requiredTopLevelSkillGroups(
  groupIds: readonly TopLevelSkillGroupId[],
): TopLevelSkillGroupId[] {
  const required: TopLevelSkillGroupId[] = [];
  const seen = new Set<TopLevelSkillGroupId>();
  for (const groupId of groupIds) {
    for (const dependency of topLevelSkillGroupDependencies(groupId)) {
      if (seen.has(dependency)) continue;
      seen.add(dependency);
      required.push(dependency);
    }
  }
  return required;
}

export function topLevelSkillGroupClosure(
  groupIds: readonly TopLevelSkillGroupId[],
): TopLevelSkillGroupId[] {
  const selected: TopLevelSkillGroupId[] = [];
  const seen = new Set<TopLevelSkillGroupId>();
  const add = (id: TopLevelSkillGroupId) => {
    if (seen.has(id)) return;
    seen.add(id);
    selected.push(id);
  };
  for (const id of groupIds) {
    add(id);
    for (const dependency of topLevelSkillGroupDependencies(id)) {
      add(dependency);
    }
  }
  return selected;
}

export function workerSkillsForTopLevelGroups(
  groupIds: readonly TopLevelSkillGroupId[],
): StaffSkillName[] {
  const selectedWorkers = new Set<StaffSkillName>();
  const selectedGroups = new Set(topLevelSkillGroupClosure(groupIds));
  for (const group of TOP_LEVEL_SKILL_GROUPS) {
    if (!selectedGroups.has(group.id)) continue;
    for (const worker of group.workers ?? []) selectedWorkers.add(worker);
  }
  return STAFF_SKILL_NAMES.filter((skill) => selectedWorkers.has(skill));
}

export function topLevelGroupsForWorkerSkill(skill: StaffSkillName): TopLevelSkillGroupId[] {
  return TOP_LEVEL_SKILL_GROUPS.filter((group) => group.workers?.includes(skill)).map(
    (group) => group.id,
  );
}

export function skillsForTopLevelGroups(
  groupIds: readonly TopLevelSkillGroupId[],
): StaffSkillName[] {
  const selectedSkills = new Set<StaffSkillName>();
  const selectedGroups = new Set(topLevelSkillGroupClosure(groupIds));
  for (const group of TOP_LEVEL_SKILL_GROUPS) {
    if (!selectedGroups.has(group.id)) continue;
    selectedSkills.add(group.skill);
    for (const worker of workerSkillsForTopLevelGroups([group.id])) selectedSkills.add(worker);
  }
  return STAFF_SKILL_NAMES.filter((skill) => selectedSkills.has(skill));
}

/**
 * Per-skill reference files, keyed by skill name. Each entry is the repo-relative
 * `references/<file>.md` path (written verbatim under the skill's canonical dir)
 * and its embedded body. A skill with no references is simply absent here.
 */
export const SKILL_REFERENCES: Partial<
  Record<StaffSkillName, Array<{ path: string; body: string }>>
> = {
  "staff-review": [{ path: "references/review-workflow.md", body: refReviewWorkflow }],
  "staff-review-find": [{ path: "references/find-guide.md", body: refReviewFindGuide }],
  "staff-review-verify": [{ path: "references/verify-guide.md", body: refReviewVerifyGuide }],
  "staff-section": [{ path: "references/section-workflow.md", body: refSectionWorkflow }],
  "staff-comment": [{ path: "references/cli.md", body: refCommentCli }],
  "staff-copy": [{ path: "references/copy-workflow.md", body: refCopyWorkflow }],
  "staff-document": [{ path: "references/document-format.md", body: refDocumentFormat }],
  "staff-resolve": [{ path: "references/resolve-workflow.md", body: refResolveWorkflow }],
  "staff-loop": [{ path: "references/loop-workflow.md", body: refLoopWorkflow }],
  "staff-docs": [{ path: "references/workflow.md", body: refDocsWorkflow }],
  "staff-docs-scout": [{ path: "references/scout-guide.md", body: refDocsScoutGuide }],
};

async function writeSkillReferences(skillDir: string, name: string): Promise<void> {
  for (const ref of SKILL_REFERENCES[name] ?? []) {
    const refPath = join(skillDir, ref.path);
    await mkdir(dirname(refPath), { recursive: true });
    await Bun.write(refPath, ref.body);
  }
}

export type InstallScope = "project" | "global";
export type GlobalHarnessId = "codex" | "claude" | "cursor" | "opencode" | "pi" | "amp" | "agents";

export interface GlobalHarness {
  id: GlobalHarnessId;
  label: string;
  hint: string;
  relativeSkillsRoot: string[];
}

export const GLOBAL_HARNESSES: GlobalHarness[] = [
  {
    id: "codex",
    label: "Codex",
    hint: "~/.codex/skills",
    relativeSkillsRoot: [".codex", "skills"],
  },
  {
    id: "claude",
    label: "Claude Code",
    hint: "~/.claude/skills",
    relativeSkillsRoot: [".claude", "skills"],
  },
  {
    id: "cursor",
    label: "Cursor CLI Agent",
    hint: "~/.cursor/skills",
    relativeSkillsRoot: [".cursor", "skills"],
  },
  {
    id: "opencode",
    label: "OpenCode",
    hint: "~/.config/opencode/skills",
    relativeSkillsRoot: [".config", "opencode", "skills"],
  },
  {
    id: "pi",
    label: "Pi",
    hint: "~/.pi/agent/skills",
    relativeSkillsRoot: [".pi", "agent", "skills"],
  },
  {
    id: "amp",
    label: "Amp",
    hint: "~/.config/agents/skills",
    relativeSkillsRoot: [".config", "agents", "skills"],
  },
  {
    id: "agents",
    label: "Generic Agent Skills",
    hint: "~/.agents/skills",
    relativeSkillsRoot: [".agents", "skills"],
  },
];

const GLOBAL_HARNESS_ALIASES: Record<string, GlobalHarnessId | "all"> = {
  agent: "agents",
  "agent-skills": "agents",
  "agent skills": "agents",
  agents: "agents",
  all: "all",
  amp: "amp",
  "amp-code": "amp",
  "amp code": "amp",
  ampcode: "amp",
  claude: "claude",
  "claude-code": "claude",
  "claude code": "claude",
  claudecode: "claude",
  codex: "codex",
  cursor: "cursor",
  "cursor-agent": "cursor",
  "cursor agent": "cursor",
  "cursor-cli": "cursor",
  "cursor-cli-agent": "cursor",
  "cursor cli": "cursor",
  "cursor cli agent": "cursor",
  generic: "agents",
  "generic-agent-skills": "agents",
  "generic agent skills": "agents",
  "open-code": "opencode",
  "open code": "opencode",
  opencode: "opencode",
  pi: "pi",
};

export function globalHarnessSkillsRoot(harness: GlobalHarness, homeDir = homedir()): string {
  return join(homeDir, ...harness.relativeSkillsRoot);
}

export function formatHomePath(path: string, homeDir = homedir()): string {
  const rel = relative(homeDir, path);
  return rel && !rel.startsWith("..") && rel !== path ? join("~", rel) : path;
}

export async function globalHarnessSkillsRootExists(
  harness: GlobalHarness,
  homeDir = homedir(),
): Promise<boolean> {
  try {
    return (await stat(globalHarnessSkillsRoot(harness, homeDir))).isDirectory();
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function installedGlobalHarnesses(homeDir = homedir()): Promise<GlobalHarness[]> {
  const installed: GlobalHarness[] = [];
  for (const harness of GLOBAL_HARNESSES) {
    if (await globalHarnessSkillsRootExists(harness, homeDir)) {
      installed.push(harness);
    }
  }
  return installed;
}

export function parseGlobalHarnessIds(
  spec: string,
  options: { allHarnesses?: GlobalHarness[] } = {},
): GlobalHarnessId[] {
  const selected = new Set<GlobalHarnessId>();
  const allHarnesses = options.allHarnesses ?? GLOBAL_HARNESSES;
  const parts = spec
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);

  if (parts.length === 0) {
    throw new Error("--harness must name at least one harness");
  }

  for (const part of parts) {
    const harness = GLOBAL_HARNESS_ALIASES[part];
    if (!harness) {
      throw new Error(
        `unknown harness: ${part}. Expected one of: ${GLOBAL_HARNESSES.map((h) => h.id).join(", ")}, all`,
      );
    }
    if (harness === "all") {
      for (const h of allHarnesses) selected.add(h.id);
    } else {
      selected.add(harness);
    }
  }

  return GLOBAL_HARNESSES.map((h) => h.id).filter((id) => selected.has(id));
}

export async function installProject(
  cwd: string,
  log: (line: string) => void = console.log,
  options: { skillNames?: readonly StaffSkillName[] } = {},
): Promise<{ skillCount: number; gitignoreAdded: string[] }> {
  const skillNames = options.skillNames ?? STAFF_SKILL_NAMES;
  if (skillNames.length === 0) {
    throw new Error("choose at least one skill to install");
  }

  // Skills: canonical copies under .agents/skills/<name>/SKILL.md, symlinked
  // into .claude/skills/<name> so both Claude Code and other agents resolve
  // them.
  const agentsRoot = join(cwd, ".agents", "skills");
  const claudeRoot = join(cwd, ".claude", "skills");
  await mkdir(claudeRoot, { recursive: true });
  const selectedSkills = new Set(skillNames);

  for (const name of STAFF_SKILL_NAMES) {
    if (selectedSkills.has(name)) continue;
    await rm(join(agentsRoot, name), { recursive: true, force: true });
    await rm(join(claudeRoot, name), { recursive: true, force: true });
  }

  let count = 0;
  for (const name of skillNames) {
    const canonicalDir = join(agentsRoot, name);
    await mkdir(canonicalDir, { recursive: true });
    await Bun.write(join(canonicalDir, "SKILL.md"), SKILLS[name]);
    await writeSkillReferences(canonicalDir, name);

    const link = join(claudeRoot, name);
    // Replace whatever's there (a prior real dir or a stale symlink) with a
    // relative symlink to the canonical copy.
    await rm(link, { recursive: true, force: true });
    await symlink(join("..", "..", ".agents", "skills", name), link, "dir");
    log(`  ${join(".agents", "skills", name)}/SKILL.md  <-  .claude/skills/${name}`);
    count++;
  }

  // Store: create the .staffreview directory tree.
  await store.ensureDirs(cwd);
  log("  created .staffreview/");

  // Gitignore the per-machine review data: diffs (review sessions),
  // attachments (pasted images), the active-diff pointer, and the
  // /staff-section progress cache. The docs (documented examples) and the
  // skills are meant to be committed.
  const ignoreEntries = [
    ".staffreview/diffs/",
    ".staffreview/attachments/",
    ".staffreview/active.json",
    ".staffreview/section-cache.json",
  ];
  const giPath = join(cwd, ".gitignore");
  const giFile = Bun.file(giPath);
  let existing = (await giFile.exists()) ? await giFile.text() : "";
  const present = new Set(existing.split("\n").map((l) => l.trim().replace(/\/$/, "")));
  const missing = ignoreEntries.filter((e) => !present.has(e.replace(/\/$/, "")));
  if (missing.length > 0) {
    const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
    existing = `${existing}${prefix}${missing.join("\n")}\n`;
    await Bun.write(giPath, existing);
    for (const e of missing) log(`  added ${e} to .gitignore`);
  } else {
    log("  .gitignore already up to date");
  }

  log(`\nInstalled ${count} skills + initialized the store.`);
  return { skillCount: count, gitignoreAdded: missing };
}

export async function installGlobal(
  harnessIds: GlobalHarnessId[],
  options: {
    homeDir?: string;
    log?: (line: string) => void;
    skillNames?: readonly StaffSkillName[];
  } = {},
): Promise<{ skillCount: number; targets: { harness: GlobalHarness; root: string }[] }> {
  const homeDir = options.homeDir ?? homedir();
  const log = options.log ?? console.log;
  const skillNames = options.skillNames ?? STAFF_SKILL_NAMES;
  const selected = GLOBAL_HARNESSES.filter((h) => harnessIds.includes(h.id));

  if (selected.length === 0) {
    throw new Error("choose at least one global harness");
  }
  if (skillNames.length === 0) {
    throw new Error("choose at least one skill to install");
  }

  // A global install only ever targets harnesses the user already has — we
  // never create a brand-new harness skills root they didn't ask for.
  const missing: string[] = [];
  for (const harness of selected) {
    const root = globalHarnessSkillsRoot(harness, homeDir);
    if (!(await globalHarnessSkillsRootExists(harness, homeDir))) {
      missing.push(`${harness.label} (${formatHomePath(root, homeDir)})`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `global harness skill directory does not exist: ${missing.join(", ")}. Install the agent first or create its skills directory.`,
    );
  }

  for (const harness of selected) {
    const root = globalHarnessSkillsRoot(harness, homeDir);
    log(`  ${harness.label}: ${formatHomePath(root, homeDir)}`);
    const selectedSkills = new Set(skillNames);
    for (const name of STAFF_SKILL_NAMES) {
      if (selectedSkills.has(name)) continue;
      await rm(join(root, name), { recursive: true, force: true });
    }
    for (const name of skillNames) {
      const skillDir = join(root, name);
      // Mirror installProject (install.ts:199): clear any prior entry so a
      // pre-existing file or broken symlink colliding with the skill name
      // doesn't make mkdir throw EEXIST and abort a multi-harness install
      // mid-run. A real skill directory is recreated below either way.
      await rm(skillDir, { recursive: true, force: true });
      await mkdir(skillDir, { recursive: true });
      await Bun.write(join(skillDir, "SKILL.md"), SKILLS[name]);
      await writeSkillReferences(skillDir, name);
    }
  }

  const skillCount = skillNames.length;
  const installCount = skillCount * selected.length;
  log(`\nInstalled ${installCount} skill copies across ${selected.length} harness(es).`);
  return {
    skillCount,
    targets: selected.map((harness) => ({
      harness,
      root: globalHarnessSkillsRoot(harness, homeDir),
    })),
  };
}
