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
  /** Whether file diffs start expanded (default true). Per-file toggles
   * in the UI override this. */
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
  /** How many scout sub-agents `/staff-docs` fans out across the local
   * diffs + PRs it mines. A sweep covers far more ground than a single diff
   * review, so this defaults higher — {@link DEFAULT_DOCS_AGENTS}. */
  docsAgents?: number;
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

// Server-side subset of the default set. Kept in sync with the two frontend
// default enumerations: `DEFAULT_SETTINGS` (SettingsMenu.tsx, persisted on
// reset) and `resetDisplaySettings` (App.tsx, applied to live React state). A
// new setting whose materialized default the server must surface goes here too.
export function settingsWithDefaults(settings: GlobalSettings): GlobalSettings {
  return {
    openBrowser: DEFAULT_OPEN_BROWSER,
    loopMaxRounds: DEFAULT_LOOP_ROUNDS,
    reviewAgents: DEFAULT_REVIEW_AGENTS,
    docsAgents: DEFAULT_DOCS_AGENTS,
    structuredHighlighting: DEFAULT_STRUCTURED_HIGHLIGHTING,
    wrapLines: DEFAULT_WRAP_LINES,
    ...settings,
  };
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

export async function writeSettings(partial: GlobalSettings): Promise<GlobalSettings> {
  const current = await readSettings();
  const next = { ...current, ...partial };
  // Defensively clamp the loop cap regardless of caller (UI or a future CLI
  // writer) so a bad value can never make `/staff-loop` run forever or zero.
  if (typeof next.loopMaxRounds === "number") {
    next.loopMaxRounds = Math.min(
      MAX_LOOP_ROUNDS,
      Math.max(MIN_LOOP_ROUNDS, Math.round(next.loopMaxRounds)),
    );
  }
  // Same defensive clamp for the review fan-out so a bad value can't spawn a
  // runaway number of sub-agents (or zero).
  if (typeof next.reviewAgents === "number") {
    next.reviewAgents = Math.min(
      MAX_REVIEW_AGENTS,
      Math.max(MIN_REVIEW_AGENTS, Math.round(next.reviewAgents)),
    );
  }
  // Same defensive clamp for the docs scout fan-out.
  if (typeof next.docsAgents === "number") {
    next.docsAgents = Math.min(
      MAX_DOCS_AGENTS,
      Math.max(MIN_DOCS_AGENTS, Math.round(next.docsAgents)),
    );
  }
  // Coerce boolean settings regardless of caller (the server's
  // `POST /api/settings` casts the request body straight to `GlobalSettings`).
  // Route through the shared parser so server and CLI agree on stringy
  // spellings like `"false"`/`"no"`/`"off"`/`"0"`, and normalize unrecognized
  // values to each setting's default instead of crashing the server.
  coerceBooleanSettings(next);
  await mkdir(settingsDir(), { recursive: true });
  await Bun.write(settingsPath(), JSON.stringify(next, null, 2));
  return next;
}
