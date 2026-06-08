// Re-export the word-level highlighting default from the shared, dependency-free
// config module so the frontend and the server (`settings.ts`) materialize the
// exact same value instead of each hard-coding the literal.
import { DEFAULT_STRUCTURED_HIGHLIGHTING } from "../structured-highlighting-config.ts";
import { DEFAULT_WRAP_LINES } from "../wrap-lines-config.ts";
import type { ColorScheme } from "./lib/api.ts";

export const DEFAULT_SPLIT_VIEW = true;
export const DEFAULT_DIFF_FONT_SIZE = 14;
export const DEFAULT_THEME: ColorScheme = "system";
export const DEFAULT_SYNTAX_THEME_LIGHT = "catppuccin-latte";
export const DEFAULT_SYNTAX_THEME_DARK = "catppuccin-mocha";
export { DEFAULT_STRUCTURED_HIGHLIGHTING, DEFAULT_WRAP_LINES };
export const DEFAULT_FILES_EXPANDED_BY_DEFAULT = false;
