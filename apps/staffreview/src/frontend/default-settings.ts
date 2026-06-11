// Re-export defaults from shared, dependency-free config modules so the
// frontend and the server (`settings.ts`) materialize the same values instead
// of each hard-coding literals.
export {
  DEFAULT_FILES_EXPANDED_BY_DEFAULT,
  DEFAULT_SPLIT_VIEW,
} from "../display-settings-config.ts";

import { DEFAULT_STRUCTURED_HIGHLIGHTING } from "../structured-highlighting-config.ts";
import { DEFAULT_WRAP_LINES } from "../wrap-lines-config.ts";
import type { ColorScheme } from "./lib/api.ts";

export const DEFAULT_DIFF_FONT_SIZE = 14;
export const DEFAULT_THEME: ColorScheme = "system";
export const DEFAULT_SYNTAX_THEME_LIGHT = "catppuccin-latte";
export const DEFAULT_SYNTAX_THEME_DARK = "catppuccin-mocha";
export { DEFAULT_STRUCTURED_HIGHLIGHTING, DEFAULT_WRAP_LINES };
