import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { bundledLanguages, bundledLanguagesInfo } from "shiki/langs";
import { bundledThemes, bundledThemesInfo } from "shiki/themes";
import wasm from "shiki/wasm";

export type ShikiTheme = string;
export type StaffHighlighter = HighlighterCore;
export type StaffLanguage = string;

type ThemeRegistration = Parameters<HighlighterCore["loadTheme"]>[number];
type LanguageRegistration = Parameters<HighlighterCore["loadLanguage"]>[number];
type ThemeLoader = () => Promise<{ default: ThemeRegistration }>;
type LanguageLoader = () => Promise<{ default: LanguageRegistration | LanguageRegistration[] }>;

const DEFAULT_THEMES: ShikiTheme[] = ["catppuccin-latte", "catppuccin-mocha"];
const themeLoaders = bundledThemes as Record<string, ThemeLoader>;
const languageLoaders = bundledLanguages as Record<string, LanguageLoader>;
const languageAliasToId = new Map<string, StaffLanguage>();

for (const info of bundledLanguagesInfo as { id: string; aliases?: string[] }[]) {
  languageAliasToId.set(info.id.toLowerCase(), info.id);
  for (const alias of info.aliases ?? []) {
    languageAliasToId.set(alias.toLowerCase(), info.id);
  }
}

export const LIGHT_SYNTAX_THEMES: string[] = bundledThemesInfo
  .filter((theme) => theme.type === "light")
  .map((theme) => theme.id);

export const DARK_SYNTAX_THEMES: string[] = bundledThemesInfo
  .filter((theme) => theme.type === "dark")
  .map((theme) => theme.id);

async function loadThemeData(name: ShikiTheme): Promise<ThemeRegistration | null> {
  const load = themeLoaders[name];
  if (!load) return null;
  return (await load()).default;
}

async function loadLanguageData(name: StaffLanguage): Promise<LanguageRegistration[]> {
  const normalize = (value: LanguageRegistration | LanguageRegistration[]) =>
    Array.isArray(value) ? value : [value];
  const resolved = resolveLanguageId(name);
  if (!resolved) return [];
  const load = languageLoaders[resolved] ?? languageLoaders[name.toLowerCase()];
  if (!load) return [];
  return normalize((await load()).default);
}

const FILENAME_LANGUAGE_OVERRIDES: Record<string, string> = {
  ".bashrc": "bash",
  ".zshrc": "bash",
  "brewfile": "ruby",
  "cmakelists.txt": "cmake",
  "dockerfile": "docker",
  "gemfile": "ruby",
  "jenkinsfile": "groovy",
  "justfile": "just",
  "makefile": "make",
  "rakefile": "ruby",
};

const EXTENSION_LANGUAGE_OVERRIDES: Record<string, string> = {
  cc: "cpp",
  cxx: "cpp",
  ex: "elixir",
  exs: "elixir",
  h: "c",
  hpp: "cpp",
  hrl: "erlang",
  htm: "html",
  m: "objective-c",
  mm: "objective-cpp",
  pl: "perl",
  pm: "perl",
  pyi: "python",
};

function resolveLanguageId(raw: string): StaffLanguage | null {
  const key = raw.toLowerCase();
  return languageAliasToId.get(key) ?? (languageLoaders[key] ? key : null);
}

let highlighterPromise: Promise<HighlighterCore> | null = null;
const loadedThemes = new Set<ShikiTheme>();
const loadedLanguages = new Set<StaffLanguage>();
const themePromises = new Map<ShikiTheme, Promise<void>>();
const languagePromises = new Map<StaffLanguage, Promise<void>>();

export function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const themes = (await Promise.all(DEFAULT_THEMES.map(loadThemeData))).filter(
        Boolean,
      ) as ThemeRegistration[];
      const highlighter = await createHighlighterCore({
        engine: await createOnigurumaEngine(wasm),
        themes,
        langs: [],
      });
      for (const theme of DEFAULT_THEMES) loadedThemes.add(theme);
      return highlighter;
    })();
  }
  return highlighterPromise;
}

export async function ensureShikiTheme(name: string): Promise<void> {
  if (loadedThemes.has(name)) return;
  let promise = themePromises.get(name);
  if (!promise) {
    promise = (async () => {
      const theme = await loadThemeData(name);
      if (!theme) return;
      const highlighter = await getHighlighter();
      await highlighter.loadTheme(theme);
      loadedThemes.add(name);
      tokenCache.clear();
    })();
    themePromises.set(name, promise);
  }
  await promise;
}

export async function ensureShikiLanguage(lang: StaffLanguage): Promise<void> {
  const resolved = resolveLanguageId(lang);
  if (!resolved || loadedLanguages.has(resolved)) return;
  let promise = languagePromises.get(resolved);
  if (!promise) {
    promise = (async () => {
      const registrations = await loadLanguageData(resolved);
      if (registrations.length === 0) return;
      const highlighter = await getHighlighter();
      await highlighter.loadLanguage(...registrations);
      loadedLanguages.add(resolved);
      tokenCache.clear();
    })();
    languagePromises.set(resolved, promise);
  }
  await promise;
}

export function shikiThemeFor(mode: "light" | "dark"): ShikiTheme {
  return mode === "dark" ? "catppuccin-mocha" : "catppuccin-latte";
}

export function langForPath(path: string): StaffLanguage | "text" {
  const filename = path.split("/").pop() ?? path;
  const lowerFilename = filename.toLowerCase();
  const filenameOverride = FILENAME_LANGUAGE_OVERRIDES[lowerFilename];
  if (filenameOverride) return resolveLanguageId(filenameOverride) ?? "text";

  const ext = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
  if (!ext) return resolveLanguageId(lowerFilename) ?? "text";

  const extOverride = EXTENSION_LANGUAGE_OVERRIDES[ext];
  if (extOverride) return resolveLanguageId(extOverride) ?? "text";
  return resolveLanguageId(ext) ?? "text";
}

/**
 * Tokenize a single line and return per-token color spans. Memoized with a
 * bounded LRU so a long-lived UI tab (scrolling through many files/diffs)
 * can't grow this cache without limit — tokenization is cheap to recompute on
 * a miss. Map preserves insertion order, so the first key is the oldest;
 * touching a key re-inserts it to mark it most-recently-used.
 */
export const TOKEN_CACHE_MAX = 5000;
export const tokenCache = new Map<string, { content: string; color?: string }[]>();

export function tokenizeLine(
  highlighter: HighlighterCore,
  line: string,
  lang: StaffLanguage | "text",
  theme: ShikiTheme,
): { content: string; color?: string }[] {
  if (lang === "text" || line === "") return [{ content: line }];
  const resolvedLang = resolveLanguageId(lang);
  if (!resolvedLang) return [{ content: line }];
  const cacheKey = `${theme}::${lang}::${line}`;
  const cached = tokenCache.get(cacheKey);
  if (cached) {
    // Touch: re-insert to move to the most-recently-used end.
    tokenCache.delete(cacheKey);
    tokenCache.set(cacheKey, cached);
    return cached;
  }

  try {
    const result = highlighter.codeToTokens(line, { lang: resolvedLang, theme });
    const tokens = (result.tokens[0] ?? []).map((t) => ({
      content: t.content,
      color: t.color,
    }));
    tokenCache.set(cacheKey, tokens);
    if (tokenCache.size > TOKEN_CACHE_MAX) {
      // Evict the least-recently-used entry (first key in insertion order).
      const oldest = tokenCache.keys().next().value;
      if (oldest !== undefined) tokenCache.delete(oldest);
    }
    return tokens;
  } catch {
    return [{ content: line }];
  }
}
