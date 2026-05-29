import { createHighlighter, type Highlighter, type BundledLanguage } from "shiki";

export type ShikiTheme = string;
const DEFAULT_THEMES: ShikiTheme[] = ["catppuccin-latte", "catppuccin-mocha"];

/** Curated subset of bundled Shiki themes, grouped by background mode. */
export const LIGHT_SYNTAX_THEMES: string[] = [
  "github-light",
  "github-light-default",
  "github-light-high-contrast",
  "catppuccin-latte",
  "rose-pine-dawn",
  "one-light",
  "min-light",
  "solarized-light",
  "vitesse-light",
  "everforest-light",
  "gruvbox-light-hard",
  "gruvbox-light-medium",
  "gruvbox-light-soft",
  "snazzy-light",
  "slack-ochin",
  "material-theme-lighter",
  "kanagawa-lotus",
];

export const DARK_SYNTAX_THEMES: string[] = [
  "one-dark-pro",
  "github-dark",
  "github-dark-default",
  "github-dark-dimmed",
  "github-dark-high-contrast",
  "dracula",
  "tokyo-night",
  "night-owl",
  "monokai",
  "material-theme",
  "material-theme-ocean",
  "material-theme-palenight",
  "material-theme-darker",
  "nord",
  "gruvbox-dark-hard",
  "gruvbox-dark-medium",
  "gruvbox-dark-soft",
  "catppuccin-mocha",
  "catppuccin-macchiato",
  "catppuccin-frappe",
  "vitesse-dark",
  "vitesse-black",
  "synthwave-84",
  "laserwave",
  "kanagawa-wave",
  "kanagawa-dragon",
  "rose-pine",
  "rose-pine-moon",
  "ayu-dark",
  "solarized-dark",
  "everforest-dark",
  "min-dark",
  "plastic",
  "poimandres",
  "slack-dark",
  "vesper",
  "houston",
];

const LANGS: BundledLanguage[] = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "python",
  "go",
  "rust",
  "shellscript",
  "bash",
  "css",
  "html",
  "markdown",
  "sql",
  "yaml",
  "toml",
  "ruby",
  "java",
  "c",
  "cpp",
  "csharp",
  "php",
  "swift",
  "kotlin",
];

let highlighterPromise: Promise<Highlighter> | null = null;

export function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: DEFAULT_THEMES,
      langs: LANGS,
    });
  }
  return highlighterPromise;
}

/**
 * Lazy-load a Shiki theme by name. The bundled themes are dynamically
 * imported by Shiki when first requested, so this is a one-time cost
 * per theme.
 */
export async function ensureShikiTheme(name: string): Promise<void> {
  const h = await getHighlighter();
  if (h.getLoadedThemes().includes(name as any)) return;
  await h.loadTheme(name as any);
}

export function shikiThemeFor(mode: "light" | "dark"): ShikiTheme {
  return mode === "dark" ? "catppuccin-mocha" : "catppuccin-latte";
}

export function langForPath(path: string): BundledLanguage | "text" {
  const filename = path.split("/").pop() ?? path;
  const ext = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";

  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return "typescript";
    case "tsx":
      return "tsx";
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "jsx":
      return "jsx";
    case "json":
    case "jsonc":
      return "json";
    case "py":
    case "pyi":
      return "python";
    case "go":
      return "go";
    case "rs":
      return "rust";
    case "sh":
    case "bash":
    case "zsh":
      return "bash";
    case "css":
      return "css";
    case "html":
    case "htm":
      return "html";
    case "md":
    case "mdx":
    case "markdown":
      return "markdown";
    case "sql":
      return "sql";
    case "yml":
    case "yaml":
      return "yaml";
    case "toml":
      return "toml";
    case "rb":
      return "ruby";
    case "java":
      return "java";
    case "c":
    case "h":
      return "c";
    case "cpp":
    case "cc":
    case "cxx":
    case "hpp":
      return "cpp";
    case "cs":
      return "csharp";
    case "php":
      return "php";
    case "swift":
      return "swift";
    case "kt":
    case "kts":
      return "kotlin";
    default:
      // Filename-based fallbacks
      if (filename === "Dockerfile") return "bash";
      if (filename === "Makefile") return "bash";
      return "text";
  }
}

/** Tokenize a single line and return per-token color spans. Memoized. */
const tokenCache = new Map<string, { content: string; color?: string }[]>();

export function tokenizeLine(
  highlighter: Highlighter,
  line: string,
  lang: BundledLanguage | "text",
  theme: ShikiTheme,
): { content: string; color?: string }[] {
  if (lang === "text" || line === "") return [{ content: line }];
  const cacheKey = `${theme}::${lang}::${line}`;
  const cached = tokenCache.get(cacheKey);
  if (cached) return cached;

  try {
    const result = highlighter.codeToTokens(line, { lang, theme: theme as any });
    const tokens = (result.tokens[0] ?? []).map((t) => ({
      content: t.content,
      color: t.color,
    }));
    tokenCache.set(cacheKey, tokens);
    return tokens;
  } catch {
    return [{ content: line }];
  }
}
