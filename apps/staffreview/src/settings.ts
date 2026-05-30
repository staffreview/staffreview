import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
// `/staff-loop` round cap default + bounds live in a dependency-free module so
// the frontend can share them; re-export below so existing `settings.*` callers
// (e.g. cli.ts) keep working.
import { DEFAULT_LOOP_ROUNDS, MIN_LOOP_ROUNDS, MAX_LOOP_ROUNDS } from "./loop-config.ts";
export { DEFAULT_LOOP_ROUNDS, MIN_LOOP_ROUNDS, MAX_LOOP_ROUNDS };

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
  await mkdir(settingsDir(), { recursive: true });
  await Bun.write(settingsPath(), JSON.stringify(next, null, 2));
  return next;
}
