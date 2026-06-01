import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
// `/staff-loop` round cap default + bounds live in a dependency-free module so
// the frontend can share them; re-export below so existing `settings.*` callers
// (e.g. cli.ts) keep working.
import { DEFAULT_LOOP_ROUNDS, MIN_LOOP_ROUNDS, MAX_LOOP_ROUNDS } from "./loop-config.ts";
export { DEFAULT_LOOP_ROUNDS, MIN_LOOP_ROUNDS, MAX_LOOP_ROUNDS };
// `/staff-review` agent fan-out default + bounds, likewise shared with the
// frontend; re-exported so `settings.*` callers (e.g. cli.ts) can reach them.
import {
  DEFAULT_REVIEW_AGENTS,
  MIN_REVIEW_AGENTS,
  MAX_REVIEW_AGENTS,
} from "./review-config.ts";
export { DEFAULT_REVIEW_AGENTS, MIN_REVIEW_AGENTS, MAX_REVIEW_AGENTS };
// `/staff-docs` scout fan-out default + bounds, same dependency-free pattern
// so the frontend bundle can share them with the server.
import {
  DEFAULT_DOCS_AGENTS,
  MIN_DOCS_AGENTS,
  MAX_DOCS_AGENTS,
} from "./docs-config.ts";
export { DEFAULT_DOCS_AGENTS, MIN_DOCS_AGENTS, MAX_DOCS_AGENTS };

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
  /** Whether file diffs start expanded (default true). Per-file toggles
   * in the UI override this. */
  filesExpandedByDefault?: boolean;
  /** Hard cap on review→resolve rounds for the `/staff-loop` skill.
   * Defaults to {@link DEFAULT_LOOP_ROUNDS} when unset. */
  loopMaxRounds?: number;
  /** How many sub-agents `/staff-review` fans out per phase (find, then
   * verify). Defaults to {@link DEFAULT_REVIEW_AGENTS} when unset. */
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
  await mkdir(settingsDir(), { recursive: true });
  await Bun.write(settingsPath(), JSON.stringify(next, null, 2));
  return next;
}
