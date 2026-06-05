import { expect, test } from "bun:test";
import { bundledThemesInfo } from "shiki/themes";
import {
  DARK_SYNTAX_THEMES,
  ensureShikiLanguage,
  ensureShikiTheme,
  getHighlighter,
  LIGHT_SYNTAX_THEMES,
  langForPath,
  tokenizeLine,
} from "./highlight.ts";

function colorOf(
  tokens: { content: string; color?: string }[],
  content: string,
): string | undefined {
  return tokens.find((token) => token.content === content)?.color;
}

test("token colors come from the selected syntax theme", async () => {
  await ensureShikiTheme("github-light");
  await ensureShikiTheme("catppuccin-latte");
  await ensureShikiLanguage("typescript");

  const highlighter = await getHighlighter();
  const source = "const answer = 42";
  const github = tokenizeLine(highlighter, source, "typescript", "github-light");
  const latte = tokenizeLine(highlighter, source, "typescript", "catppuccin-latte");

  expect(colorOf(github, "const")?.toLowerCase()).toBe("#d73a49");
  expect(colorOf(latte, "const")).not.toBe(colorOf(github, "const"));
  expect(colorOf(latte, "42")).not.toBe(colorOf(github, "42"));
});

test("tsx uses Shiki tokenization for JSX tags and attributes", async () => {
  await ensureShikiTheme("github-light");
  await ensureShikiLanguage("tsx");

  const highlighter = await getHighlighter();
  const tokens = tokenizeLine(
    highlighter,
    'const button = <Button disabled title="Save">{label}</Button>;',
    "tsx",
    "github-light",
  );

  expect(colorOf(tokens, "Button")).toBeTruthy();
  expect(colorOf(tokens, "disabled")).toBeTruthy();
  expect(colorOf(tokens, "Button")).not.toBe(colorOf(tokens, "disabled"));
});

test("language detection uses Shiki bundled languages beyond the old subset", async () => {
  expect(langForPath("src/App.vue")).toBe("vue");
  expect(langForPath("infra/main.tf")).toBe("terraform");
  expect(langForPath("flake.nix")).toBe("nix");

  await ensureShikiTheme("github-light");
  await ensureShikiLanguage("vue");
  const highlighter = await getHighlighter();
  const tokens = tokenizeLine(highlighter, "<template><App /></template>", "vue", "github-light");

  expect(colorOf(tokens, "template")).toBeTruthy();
  expect(colorOf(tokens, "App")).toBeTruthy();
});

test("extension overrides keep C/C++/HTML/Python variants highlighted", () => {
  expect(langForPath("src/util.h")).toBe("c");
  expect(langForPath("src/widget.hpp")).toBe("cpp");
  expect(langForPath("src/widget.cc")).toBe("cpp");
  expect(langForPath("src/widget.cxx")).toBe("cpp");
  expect(langForPath("page.htm")).toBe("html");
  expect(langForPath("stub.pyi")).toBe("python");
});

test("syntax theme lists include every Shiki bundled theme by type", () => {
  expect(LIGHT_SYNTAX_THEMES).toEqual(
    bundledThemesInfo.filter((theme) => theme.type === "light").map((theme) => theme.id),
  );
  expect(DARK_SYNTAX_THEMES).toEqual(
    bundledThemesInfo.filter((theme) => theme.type === "dark").map((theme) => theme.id),
  );
});
