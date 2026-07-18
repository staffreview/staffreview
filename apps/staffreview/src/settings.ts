import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
// `/staff-loop` round cap default + bounds live in a dependency-free module so
// the frontend can share them; re-export below so existing `settings.*` callers
// (e.g. cli.ts) keep working.
import { DEFAULT_LOOP_ROUNDS, MAX_LOOP_ROUNDS, MIN_LOOP_ROUNDS } from "./loop-config.ts";

export { DEFAULT_LOOP_ROUNDS, MAX_LOOP_ROUNDS, MIN_LOOP_ROUNDS };

// `/staff-review` agent fan-out default + bounds, likewise shared with the
// frontend; re-exported so `settings.*` callers (e.g. cli.ts) can reach them.
import { DEFAULT_REVIEW_AGENTS, MAX_REVIEW_AGENTS, MIN_REVIEW_AGENTS } from "./review-config.ts";

export { DEFAULT_REVIEW_AGENTS, MAX_REVIEW_AGENTS, MIN_REVIEW_AGENTS };

// `/staff-section` agent fan-out default + bounds (also sizes the per-run
// section), same dependency-free pattern so the frontend bundle shares them.
import {
  DEFAULT_SECTION_AGENTS,
  MAX_SECTION_AGENTS,
  MIN_SECTION_AGENTS,
} from "./section-config.ts";

export { DEFAULT_SECTION_AGENTS, MAX_SECTION_AGENTS, MIN_SECTION_AGENTS };

// `/staff-docs` scout fan-out default + bounds, same dependency-free pattern
// so the frontend bundle can share them with the server.
import { DEFAULT_DOCS_AGENTS, MAX_DOCS_AGENTS, MIN_DOCS_AGENTS } from "./docs-config.ts";

export { DEFAULT_DOCS_AGENTS, MAX_DOCS_AGENTS, MIN_DOCS_AGENTS };

import {
  DEFAULT_FILES_EXPANDED_BY_DEFAULT,
  DEFAULT_SPLIT_VIEW,
} from "./display-settings-config.ts";

export { DEFAULT_FILES_EXPANDED_BY_DEFAULT, DEFAULT_SPLIT_VIEW };

import { DEFAULT_OPEN_BROWSER } from "./open-browser-config.ts";

export { DEFAULT_OPEN_BROWSER };

import { parseBooleanSetting } from "./boolean-setting.ts";

// Word-level diff highlighting default lives in a dependency-free module so the
// frontend bundle shares one source of truth; re-exported so existing
// `settings.*` callers (e.g. cli.ts) keep working.
import { DEFAULT_STRUCTURED_HIGHLIGHTING } from "./structured-highlighting-config.ts";

export { DEFAULT_STRUCTURED_HIGHLIGHTING };

// Line-wrap default lives in a dependency-free module so the frontend bundle
// shares one source of truth; re-exported so existing `settings.*` callers keep
// working.
import { DEFAULT_WRAP_LINES } from "./wrap-lines-config.ts";

export { DEFAULT_WRAP_LINES };

export type ColorScheme = "system" | "light" | "dark";

export type WatchHarnessSettings = {
  /** Harness binary to launch for `staff watch`, e.g. `claude` or `codex`. */
  command: string;
  /** Flags passed to the harness before Staff Review appends the review prompt. */
  args: string[];
};

export type GlobalSettings = {
  splitView?: boolean;
  /** Font size (px) for the diff content. */
  diffFontSize?: number;
  /** User-selected color scheme; "system" follows OS preference. */
  theme?: ColorScheme;
  /** Shiki syntax-highlighting theme used while the UI is in light mode. */
  syntaxThemeLight?: string;
  /** Shiki syntax-highlighting theme used while the UI is in dark mode. */
  syntaxThemeDark?: string;
  /** Whether intra-line (word-level) diff highlighting is enabled in rendered
   * diffs. Independent of Shiki syntax highlighting, which is always on. */
  structuredHighlighting?: boolean;
  /** Whether long diff lines wrap to fit the pane (default true). When off,
   * long lines extend past the pane and scroll horizontally instead. */
  wrapLines?: boolean;
  /** Whether file diffs start expanded (default false; see
   * DEFAULT_FILES_EXPANDED_BY_DEFAULT). Per-file toggles in the UI override
   * this. */
  filesExpandedByDefault?: boolean;
  /** Whether `staff serve` opens the browser automatically. */
  openBrowser?: boolean;
  /** Hard cap on review→resolve rounds for the `/staff-loop` skill.
   * Defaults to {@link DEFAULT_LOOP_ROUNDS} when unset. */
  loopMaxRounds?: number;
  /** Target number of live sub-agents `/staff-review` uses while it pipelines
   * find agents into per-find verification. Defaults to
   * {@link DEFAULT_REVIEW_AGENTS} when unset. */
  reviewAgents?: number;
  /** Find-agent fan-out width for `/staff-section`, which also sizes the slice
   * of the codebase reviewed each run (more agents → a bigger section).
   * Defaults to {@link DEFAULT_SECTION_AGENTS} when unset. */
  sectionAgents?: number;
  /** How many scout sub-agents `/staff-docs` fans out across GitHub PR review
   * comments. A docs sweep can cover more ground than a single diff review, so
   * this defaults higher — {@link DEFAULT_DOCS_AGENTS}. */
  docsAgents?: number;
  /** Optional TUI harness argv for `staff watch`; Staff Review appends the
   * generated `/staff-review` prompt as the final argument. */
  watchHarness?: WatchHarnessSettings;
};

export function settingsDir(): string {
  if (process.env.STAFF_CONFIG_DIR) return process.env.STAFF_CONFIG_DIR;
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, "staffreview") : join(homedir(), ".config", "staffreview");
}

export function settingsPath(): string {
  return join(settingsDir(), "settings.json");
}

export async function readSettings(): Promise<GlobalSettings> {
  const file = Bun.file(settingsPath());
  if (!(await file.exists())) return {};
  try {
    return JSON.parse(await file.text()) as GlobalSettings;
  } catch {
    return {};
  }
}

const BOOLEAN_SETTING_DEFAULTS = {
  filesExpandedByDefault: DEFAULT_FILES_EXPANDED_BY_DEFAULT,
  openBrowser: DEFAULT_OPEN_BROWSER,
  splitView: DEFAULT_SPLIT_VIEW,
  structuredHighlighting: DEFAULT_STRUCTURED_HIGHLIGHTING,
  wrapLines: DEFAULT_WRAP_LINES,
} satisfies Record<
  keyof Pick<
    GlobalSettings,
    "filesExpandedByDefault" | "openBrowser" | "splitView" | "structuredHighlighting" | "wrapLines"
  >,
  boolean
>;

type NumericSettingKey = keyof Pick<
  GlobalSettings,
  "docsAgents" | "loopMaxRounds" | "reviewAgents" | "sectionAgents"
>;

type NumericSettingConfig = {
  defaultValue: number;
  min: number;
  max: number;
};

const NUMERIC_SETTING_CONFIG = {
  loopMaxRounds: {
    defaultValue: DEFAULT_LOOP_ROUNDS,
    min: MIN_LOOP_ROUNDS,
    max: MAX_LOOP_ROUNDS,
  },
  reviewAgents: {
    defaultValue: DEFAULT_REVIEW_AGENTS,
    min: MIN_REVIEW_AGENTS,
    max: MAX_REVIEW_AGENTS,
  },
  sectionAgents: {
    defaultValue: DEFAULT_SECTION_AGENTS,
    min: MIN_SECTION_AGENTS,
    max: MAX_SECTION_AGENTS,
  },
  docsAgents: {
    defaultValue: DEFAULT_DOCS_AGENTS,
    min: MIN_DOCS_AGENTS,
    max: MAX_DOCS_AGENTS,
  },
} satisfies Record<NumericSettingKey, NumericSettingConfig>;

// Server-side subset of the default set. Kept in sync with the two frontend
// default enumerations: `DEFAULT_SETTINGS` (SettingsMenu.tsx, persisted on
// reset) and `resetDisplaySettings` (App.tsx, applied to live React state). A
// new setting whose materialized default the server must surface goes here too.
export function settingsWithDefaults(settings: GlobalSettings): GlobalSettings {
  const withDefaults = {
    openBrowser: DEFAULT_OPEN_BROWSER,
    loopMaxRounds: DEFAULT_LOOP_ROUNDS,
    reviewAgents: DEFAULT_REVIEW_AGENTS,
    sectionAgents: DEFAULT_SECTION_AGENTS,
    docsAgents: DEFAULT_DOCS_AGENTS,
    structuredHighlighting: DEFAULT_STRUCTURED_HIGHLIGHTING,
    wrapLines: DEFAULT_WRAP_LINES,
    ...settings,
  };
  coerceNumericSettings(withDefaults);
  coerceWatchHarness(withDefaults);
  return withDefaults;
}

export function normalizeWatchHarness(value: unknown): WatchHarnessSettings | undefined {
  if (value === undefined || value === null) return undefined;

  if (Array.isArray(value)) {
    const [command, ...args] = value;
    return normalizeWatchHarness({ command, args });
  }

  if (typeof value !== "object") return undefined;
  const raw = value as { command?: unknown; args?: unknown };
  if (typeof raw.command !== "string") return undefined;
  const command = raw.command.trim();
  if (!command) return undefined;
  if (raw.args !== undefined && !Array.isArray(raw.args)) return undefined;
  const args: string[] = [];
  for (const arg of raw.args ?? []) {
    if (typeof arg !== "string") return undefined;
    args.push(arg);
  }
  return { command, args };
}

function coerceBooleanSettings(settings: GlobalSettings) {
  for (const [key, defaultValue] of Object.entries(BOOLEAN_SETTING_DEFAULTS) as Array<
    [keyof typeof BOOLEAN_SETTING_DEFAULTS, boolean]
  >) {
    if (key in settings && typeof settings[key] !== "boolean") {
      try {
        settings[key] = parseBooleanSetting(String(settings[key]), key);
      } catch {
        settings[key] = defaultValue;
      }
    }
  }
}

function parseNumericSetting(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function coerceNumericSettings(settings: GlobalSettings) {
  for (const [key, config] of Object.entries(NUMERIC_SETTING_CONFIG) as Array<
    [NumericSettingKey, NumericSettingConfig]
  >) {
    if (!(key in settings)) continue;
    const parsed = parseNumericSetting(settings[key]);
    const value = parsed ?? config.defaultValue;
    settings[key] = Math.min(config.max, Math.max(config.min, Math.round(value)));
  }
}

function coerceWatchHarness(settings: GlobalSettings) {
  if (!("watchHarness" in settings)) return;
  const harness = normalizeWatchHarness(settings.watchHarness);
  if (harness) {
    settings.watchHarness = harness;
  } else {
    delete settings.watchHarness;
  }
}

export async function writeSettings(partial: GlobalSettings): Promise<GlobalSettings> {
  const current = await readSettings();
  const next = { ...current, ...partial };
  // Defensively normalize numeric settings regardless of caller (UI or API)
  // so malformed payloads cannot persist values that override defaults.
  coerceNumericSettings(next);
  // Coerce boolean settings regardless of caller (the server's
  // `POST /api/settings` casts the request body straight to `GlobalSettings`).
  // Route through the shared parser so server and CLI agree on stringy
  // spellings like `"false"`/`"no"`/`"off"`/`"0"`, and normalize unrecognized
  // values to each setting's default instead of crashing the server.
  coerceBooleanSettings(next);
  coerceWatchHarness(next);
  await mkdir(settingsDir(), { recursive: true });
  await Bun.write(settingsPath(), JSON.stringify(next, null, 2));
  return next;
}
