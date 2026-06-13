import { mkdir, rm, stat, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
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
import skillSectionFind from "../skills/staff-section-find.md" with { type: "text" };
import skillSectionVerify from "../skills/staff-section-verify.md" with { type: "text" };
import * as store from "./store.ts";

export const SKILLS: Record<string, string> = {
  "staff-review": skillReview,
  "staff-review-find": skillReviewFind,
  "staff-review-verify": skillReviewVerify,
  "staff-section": skillSection,
  "staff-section-find": skillSectionFind,
  "staff-section-verify": skillSectionVerify,
  "staff-comment": skillComment,
  "staff-copy": skillCopy,
  "staff-document": skillDocument,
  "staff-resolve": skillResolve,
  "staff-loop": skillLoop,
  "staff-docs": skillDocs,
  "staff-docs-scout": skillDocsScout,
};

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
): Promise<{ skillCount: number; gitignoreAdded: string[] }> {
  // Skills: canonical copies under .agents/skills/<name>/SKILL.md, symlinked
  // into .claude/skills/<name> so both Claude Code and other agents resolve
  // them.
  const agentsRoot = join(cwd, ".agents", "skills");
  const claudeRoot = join(cwd, ".claude", "skills");
  await mkdir(claudeRoot, { recursive: true });
  let count = 0;
  for (const [name, body] of Object.entries(SKILLS)) {
    const canonicalDir = join(agentsRoot, name);
    await mkdir(canonicalDir, { recursive: true });
    await Bun.write(join(canonicalDir, "SKILL.md"), body);

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
  options: { homeDir?: string; log?: (line: string) => void } = {},
): Promise<{ skillCount: number; targets: { harness: GlobalHarness; root: string }[] }> {
  const homeDir = options.homeDir ?? homedir();
  const log = options.log ?? console.log;
  const selected = GLOBAL_HARNESSES.filter((h) => harnessIds.includes(h.id));

  if (selected.length === 0) {
    throw new Error("choose at least one global harness");
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
    for (const [name, body] of Object.entries(SKILLS)) {
      const skillDir = join(root, name);
      // Mirror installProject (install.ts:199): clear any prior entry so a
      // pre-existing file or broken symlink colliding with the skill name
      // doesn't make mkdir throw EEXIST and abort a multi-harness install
      // mid-run. A real skill directory is recreated below either way.
      await rm(skillDir, { recursive: true, force: true });
      await mkdir(skillDir, { recursive: true });
      await Bun.write(join(skillDir, "SKILL.md"), body);
    }
  }

  const skillCount = Object.keys(SKILLS).length;
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
