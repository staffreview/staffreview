import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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
  await mkdir(settingsDir(), { recursive: true });
  await Bun.write(settingsPath(), JSON.stringify(next, null, 2));
  return next;
}
