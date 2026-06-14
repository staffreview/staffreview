import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  globalHarnessesFromSpec,
  globalHarnessSpecFromFlags,
  installScopeFromFlags,
  resolveInstallFlags,
} from "./cli.ts";
import {
  formatHomePath,
  GLOBAL_HARNESSES,
  globalHarnessSkillsRoot,
  installedGlobalHarnesses,
  installGlobal,
  installProject,
  parseGlobalHarnessIds,
  SKILL_REFERENCES,
  SKILLS,
} from "./install.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "staffreview-install-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("installProject writes project skills, claude symlinks, store dirs, and gitignore entries", async () => {
  const logs: string[] = [];

  const result = await installProject(tmp, (line) => logs.push(line));

  expect(result.skillCount).toBe(Object.keys(SKILLS).length);
  expect(await readFile(join(tmp, ".agents", "skills", "staff-review", "SKILL.md"), "utf8")).toBe(
    SKILLS["staff-review"],
  );
  expect(await readFile(join(tmp, ".agents", "skills", "staff-section", "SKILL.md"), "utf8")).toBe(
    SKILLS["staff-section"],
  );

  const claudeLink = await lstat(join(tmp, ".claude", "skills", "staff-review"));
  expect(claudeLink.isSymbolicLink()).toBe(true);
  const sectionLink = await lstat(join(tmp, ".claude", "skills", "staff-section"));
  expect(sectionLink.isSymbolicLink()).toBe(true);
  expect(await lstat(join(tmp, ".staffreview", "diffs"))).toBeTruthy();
  expect(await lstat(join(tmp, ".staffreview", "docs"))).toBeTruthy();
  expect(await lstat(join(tmp, ".staffreview", "attachments"))).toBeTruthy();

  const gitignore = await readFile(join(tmp, ".gitignore"), "utf8");
  expect(gitignore).toContain(".staffreview/diffs/");
  expect(gitignore).toContain(".staffreview/attachments/");
  expect(gitignore).toContain(".staffreview/active.json");
  expect(gitignore).toContain(".staffreview/section-cache.json");
  expect(logs.some((line) => line.includes(`Installed ${Object.keys(SKILLS).length} skills`))).toBe(
    true,
  );
});

test("installProject writes each skill's reference files next to its SKILL.md", async () => {
  await installProject(tmp, () => {});

  // Every reference a thin SKILL.md points at must actually land on disk —
  // otherwise the installed skill is a dangling pointer (the bug behind #6).
  for (const [name, references] of Object.entries(SKILL_REFERENCES)) {
    for (const ref of references) {
      const written = await readFile(join(tmp, ".agents", "skills", name, ref.path), "utf8");
      expect(written).toBe(ref.body);
    }
  }
  // Spot-check the review find guide specifically, since it drives the eval.
  expect(
    await Bun.file(
      join(tmp, ".agents", "skills", "staff-review-find", "references", "find-guide.md"),
    ).exists(),
  ).toBe(true);
});

test("installGlobal writes each skill's reference files next to its SKILL.md", async () => {
  const codexHarness = GLOBAL_HARNESSES.find((h) => h.id === "codex")!;
  const codexRoot = globalHarnessSkillsRoot(codexHarness, tmp);
  await mkdir(codexRoot, { recursive: true });

  await installGlobal(["codex"], { homeDir: tmp, log: () => {} });

  for (const ref of SKILL_REFERENCES["staff-review-find"] ?? []) {
    expect(await readFile(join(codexRoot, "staff-review-find", ref.path), "utf8")).toBe(ref.body);
  }
});

test("installProject does not duplicate existing gitignore entries", async () => {
  await Bun.write(join(tmp, ".gitignore"), "dist/\n.staffreview/diffs/\n");

  await installProject(tmp, () => {});
  await installProject(tmp, () => {});

  const gitignore = await readFile(join(tmp, ".gitignore"), "utf8");
  expect(gitignore.match(/\.staffreview\/diffs\//g)?.length).toBe(1);
  expect(gitignore.match(/\.staffreview\/attachments\//g)?.length).toBe(1);
  expect(gitignore.match(/\.staffreview\/active\.json/g)?.length).toBe(1);
  expect(gitignore.match(/\.staffreview\/section-cache\.json/g)?.length).toBe(1);
});

test("installGlobal writes selected harness skills under a custom home", async () => {
  const logs: string[] = [];
  const codexHarness = GLOBAL_HARNESSES.find((h) => h.id === "codex")!;
  await mkdir(globalHarnessSkillsRoot(codexHarness, tmp), { recursive: true });

  const result = await installGlobal(["codex"], {
    homeDir: tmp,
    log: (line) => logs.push(line),
  });

  const codexRoot = globalHarnessSkillsRoot(codexHarness, tmp);
  expect(result.skillCount).toBe(Object.keys(SKILLS).length);
  expect(result.targets.map((target) => target.harness.id)).toEqual(["codex"]);
  expect(await readFile(join(codexRoot, "staff-loop", "SKILL.md"), "utf8")).toBe(
    SKILLS["staff-loop"],
  );
  expect(await readFile(join(codexRoot, "staff-section", "SKILL.md"), "utf8")).toBe(
    SKILLS["staff-section"],
  );
  expect(await Bun.file(join(tmp, ".claude", "skills", "staff-loop", "SKILL.md")).exists()).toBe(
    false,
  );
  expect(logs.some((line) => line.includes("~/.codex/skills"))).toBe(true);
});

test("installGlobal supports Cursor, OpenCode, Pi, Amp, and shared agent skill roots", async () => {
  for (const id of ["cursor", "opencode", "pi", "amp", "agents"] as const) {
    const harness = GLOBAL_HARNESSES.find((h) => h.id === id)!;
    await mkdir(globalHarnessSkillsRoot(harness, tmp), { recursive: true });
  }

  await installGlobal(["cursor", "opencode", "pi", "amp", "agents"], {
    homeDir: tmp,
    log: () => {},
  });

  for (const id of ["cursor", "opencode", "pi", "amp", "agents"] as const) {
    const harness = GLOBAL_HARNESSES.find((h) => h.id === id);
    expect(harness).toBeDefined();
    const root = globalHarnessSkillsRoot(harness!, tmp);
    expect(await readFile(join(root, "staff-review", "SKILL.md"), "utf8")).toBe(
      SKILLS["staff-review"],
    );
  }
});

test("installGlobal overwrites a colliding non-directory entry instead of throwing EEXIST", async () => {
  const codexHarness = GLOBAL_HARNESSES.find((h) => h.id === "codex")!;
  const codexRoot = globalHarnessSkillsRoot(codexHarness, tmp);
  await mkdir(codexRoot, { recursive: true });
  // A pre-existing *file* named like one of the skills would make a naive
  // mkdir(skillDir) throw EEXIST. installGlobal must clear it first, mirroring
  // installProject's rm before symlinking.
  await Bun.write(join(codexRoot, "staff-review"), "stale collision");

  const result = await installGlobal(["codex"], { homeDir: tmp, log: () => {} });

  expect(result.targets.map((target) => target.harness.id)).toEqual(["codex"]);
  expect(await readFile(join(codexRoot, "staff-review", "SKILL.md"), "utf8")).toBe(
    SKILLS["staff-review"],
  );
});

test("installGlobal rejects missing harness skill roots", async () => {
  await expect(
    installGlobal(["codex"], {
      homeDir: tmp,
      log: () => {},
    }),
  ).rejects.toThrow("global harness skill directory does not exist");
});

test("installedGlobalHarnesses returns only existing skill directories", async () => {
  const codexHarness = GLOBAL_HARNESSES.find((h) => h.id === "codex")!;
  const claudeHarness = GLOBAL_HARNESSES.find((h) => h.id === "claude")!;
  await mkdir(globalHarnessSkillsRoot(codexHarness, tmp), { recursive: true });
  await mkdir(join(tmp, ".claude"), { recursive: true });
  await Bun.write(globalHarnessSkillsRoot(claudeHarness, tmp), "not a directory");

  expect((await installedGlobalHarnesses(tmp)).map((h) => h.id)).toEqual(["codex"]);
});

test("installedGlobalHarnesses returns harnesses in GLOBAL_HARNESSES declaration order", async () => {
  // Create the roots out of declaration order; the result must still come back
  // in GLOBAL_HARNESSES order, since promptGlobalHarnesses renders that order.
  const declarationOrder = GLOBAL_HARNESSES.map((h) => h.id);
  const createOrder = ["agents", "claude", "amp", "codex", "pi"] as const;
  // Sanity-check the fixture exercises a non-trivial reorder.
  expect([...createOrder]).not.toEqual(
    declarationOrder.filter((id) => createOrder.includes(id as (typeof createOrder)[number])),
  );

  for (const id of createOrder) {
    const harness = GLOBAL_HARNESSES.find((h) => h.id === id)!;
    await mkdir(globalHarnessSkillsRoot(harness, tmp), { recursive: true });
  }

  const expected = declarationOrder.filter((id) =>
    createOrder.includes(id as (typeof createOrder)[number]),
  );
  expect((await installedGlobalHarnesses(tmp)).map((h) => h.id)).toEqual(expected);
});

test("installGlobal preserves GLOBAL_HARNESSES order in its targets regardless of input order", async () => {
  for (const id of ["codex", "claude", "agents"] as const) {
    const harness = GLOBAL_HARNESSES.find((h) => h.id === id)!;
    await mkdir(globalHarnessSkillsRoot(harness, tmp), { recursive: true });
  }

  // Pass the ids in reverse declaration order; targets must come back ordered.
  const result = await installGlobal(["agents", "claude", "codex"], {
    homeDir: tmp,
    log: () => {},
  });

  expect(result.targets.map((target) => target.harness.id)).toEqual(["codex", "claude", "agents"]);
});

test("parseGlobalHarnessIds accepts aliases, all, and removes duplicates", () => {
  expect(parseGlobalHarnessIds("codex,claude-code,cursor-cli,open-code,pi,ampcode,agents")).toEqual(
    ["codex", "claude", "cursor", "opencode", "pi", "amp", "agents"],
  );
  expect(parseGlobalHarnessIds("all")).toEqual(GLOBAL_HARNESSES.map((h) => h.id));
  expect(
    parseGlobalHarnessIds("all", {
      allHarnesses: GLOBAL_HARNESSES.filter((h) => h.id === "codex" || h.id === "cursor"),
    }),
  ).toEqual(["codex", "cursor"]);
  expect(() => parseGlobalHarnessIds("unknown")).toThrow("unknown harness");
});

test("installScopeFromFlags resolves explicit scope flags and shorthands", () => {
  expect(installScopeFromFlags({})).toBeUndefined();
  expect(installScopeFromFlags({ project: true })).toBe("project");
  expect(installScopeFromFlags({ global: true })).toBe("global");
  expect(installScopeFromFlags({ scope: "project" })).toBe("project");
  expect(installScopeFromFlags({ scope: "global" })).toBe("global");
  // Trimmed / mixed-case scope values are normalized.
  expect(installScopeFromFlags({ scope: " GLOBAL " })).toBe("global");
});

test("installScopeFromFlags rejects conflicting or malformed scope flags", () => {
  expect(() => installScopeFromFlags({ scope: true })).toThrow(
    "--scope requires a value: project or global",
  );
  expect(() => installScopeFromFlags({ project: true, global: true })).toThrow(
    "choose only one of --project or --global",
  );
  expect(() => installScopeFromFlags({ scope: "project", project: true })).toThrow(
    "use either --scope or --project/--global, not both",
  );
  expect(() => installScopeFromFlags({ scope: "global", global: true })).toThrow(
    "use either --scope or --project/--global, not both",
  );
  expect(() => installScopeFromFlags({ scope: "nonsense" })).toThrow(
    "--scope must be one of: project, global",
  );
});

test("globalHarnessSpecFromFlags reads --harness/--harnesses and rejects valueless --harness", () => {
  expect(globalHarnessSpecFromFlags({})).toBeUndefined();
  expect(globalHarnessSpecFromFlags({ harness: "codex,claude" })).toBe("codex,claude");
  expect(globalHarnessSpecFromFlags({ harnesses: "all" })).toBe("all");
  // --harness wins over --harnesses when both are present and a string.
  expect(globalHarnessSpecFromFlags({ harness: "codex", harnesses: "claude" })).toBe("codex");
  // A real value supplied via one alias is honoured even when the *other* alias
  // parses as a valueless `true` (e.g. `--harness codex --harnesses`). The
  // valueless guard must only fire when no usable value was found at all.
  expect(globalHarnessSpecFromFlags({ harness: "codex", harnesses: true })).toBe("codex");
  expect(globalHarnessSpecFromFlags({ harness: true, harnesses: "claude" })).toBe("claude");
  expect(() => globalHarnessSpecFromFlags({ harness: true })).toThrow("--harness requires a value");
  expect(() => globalHarnessSpecFromFlags({ harnesses: true })).toThrow(
    "--harness requires a value",
  );
  // An empty or whitespace-only value (`--harness=` / `--harness " "`) is the
  // string analogue of the valueless flag and must be rejected the same way,
  // not swallowed into a falsy spec that downgrades to a project install.
  expect(() => globalHarnessSpecFromFlags({ harness: "" })).toThrow("--harness requires a value");
  expect(() => globalHarnessSpecFromFlags({ harness: "   " })).toThrow(
    "--harness requires a value",
  );
  expect(() => globalHarnessSpecFromFlags({ harnesses: "" })).toThrow("--harness requires a value");
});

test("resolveInstallFlags applies scope precedence and surfaces the harness spec", () => {
  // No flags → scope is left for the prompt / project default to fill in.
  expect(resolveInstallFlags({})).toEqual({ scope: undefined, harnessSpec: undefined });
  // A bare --harness implies a global install.
  expect(resolveInstallFlags({ harness: "codex" })).toEqual({
    scope: "global",
    harnessSpec: "codex",
  });
  // An explicit scope is honoured, and the harness spec passes through.
  expect(resolveInstallFlags({ global: true, harness: "codex,claude" })).toEqual({
    scope: "global",
    harnessSpec: "codex,claude",
  });
  expect(resolveInstallFlags({ project: true })).toEqual({
    scope: "project",
    harnessSpec: undefined,
  });
});

test("resolveInstallFlags rejects --harness on a project install", () => {
  // The real dispatch guard: --project (or --scope project) + --harness is an error.
  expect(() => resolveInstallFlags({ project: true, harness: "codex" })).toThrow(
    "--harness only applies to global installs",
  );
  expect(() => resolveInstallFlags({ scope: "project", harness: "codex" })).toThrow(
    "--harness only applies to global installs",
  );
});

test("resolveInstallFlags propagates the underlying flag-resolution errors", () => {
  // Conflicting scope flags surface through the combined resolver too.
  expect(() => resolveInstallFlags({ project: true, global: true })).toThrow(
    "choose only one of --project or --global",
  );
  // A valueless --harness is rejected before any scope/harness reconciliation.
  expect(() => resolveInstallFlags({ harness: true })).toThrow("--harness requires a value");
  // An empty `--harness=` must surface the same error rather than slipping
  // through as a falsy spec that quietly resolves to a project install.
  expect(() => resolveInstallFlags({ harness: "" })).toThrow("--harness requires a value");
});

test("formatHomePath renders in-home paths as ~ and leaves others absolute", () => {
  const home = join(tmpdir(), "staffreview-home");

  // In-home paths are rewritten with a leading ~.
  expect(formatHomePath(join(home, ".codex", "skills"), home)).toBe(join("~", ".codex", "skills"));
  // The home directory itself (rel === "") is returned unchanged, not bare "~".
  expect(formatHomePath(home, home)).toBe(home);
  // A path outside home (rel starts with "..") is returned absolute, untouched.
  const outside = join(tmpdir(), "elsewhere", ".codex", "skills");
  expect(formatHomePath(outside, home)).toBe(outside);
});

test("globalHarnessesFromSpec resolves against installed roots and throws when none match", async () => {
  const codexHarness = GLOBAL_HARNESSES.find((h) => h.id === "codex")!;
  const claudeHarness = GLOBAL_HARNESSES.find((h) => h.id === "claude")!;
  await mkdir(globalHarnessSkillsRoot(codexHarness, tmp), { recursive: true });
  await mkdir(globalHarnessSkillsRoot(claudeHarness, tmp), { recursive: true });

  // "all" expands to only the installed harnesses, in declaration order.
  expect(await globalHarnessesFromSpec("all", tmp)).toEqual(["codex", "claude"]);
  expect(await globalHarnessesFromSpec("claude,codex", tmp)).toEqual(["codex", "claude"]);

  // No installed roots under this home → "all" yields nothing → explicit throw.
  const emptyHome = mkdtempSync(join(tmpdir(), "staffreview-install-empty-"));
  try {
    await expect(globalHarnessesFromSpec("all", emptyHome)).rejects.toThrow(
      "no installed global harness skill directories found",
    );
  } finally {
    rmSync(emptyHome, { recursive: true, force: true });
  }
});
