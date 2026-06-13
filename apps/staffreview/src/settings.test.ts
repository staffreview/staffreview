import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_DOCS_AGENTS,
  DEFAULT_FILES_EXPANDED_BY_DEFAULT,
  DEFAULT_LOOP_ROUNDS,
  DEFAULT_OPEN_BROWSER,
  DEFAULT_REVIEW_AGENTS,
  DEFAULT_SECTION_AGENTS,
  DEFAULT_SPLIT_VIEW,
  DEFAULT_STRUCTURED_HIGHLIGHTING,
  DEFAULT_WRAP_LINES,
  MAX_DOCS_AGENTS,
  MAX_SECTION_AGENTS,
  MIN_DOCS_AGENTS,
  MIN_SECTION_AGENTS,
  settingsWithDefaults,
  writeSettings,
} from "./settings.ts";

// `writeSettings` persists to `$STAFF_CONFIG_DIR/settings.json` (see
// `settingsDir`). Point it at a throwaway temp dir per test so it never reads
// or clobbers the real user config.
const ORIGINAL_CONFIG_DIR = process.env.STAFF_CONFIG_DIR;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "staffreview-settings-"));
  process.env.STAFF_CONFIG_DIR = tmp;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

afterAll(() => {
  if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.STAFF_CONFIG_DIR;
  else process.env.STAFF_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
});

test("writeSettings clamps an over-max docsAgents down to MAX_DOCS_AGENTS", async () => {
  const next = await writeSettings({ docsAgents: 25 });
  expect(next.docsAgents).toBe(MAX_DOCS_AGENTS); // 20
});

test("writeSettings clamps a below-min docsAgents up to MIN_DOCS_AGENTS", async () => {
  const next = await writeSettings({ docsAgents: 0 });
  expect(next.docsAgents).toBe(MIN_DOCS_AGENTS); // 1
});

test("writeSettings rounds a fractional docsAgents to the nearest integer", async () => {
  const next = await writeSettings({ docsAgents: 6.7 });
  expect(next.docsAgents).toBe(7);
});

test("writeSettings persists the clamped docsAgents to disk", async () => {
  await writeSettings({ docsAgents: 100 });
  const onDisk = JSON.parse(await Bun.file(join(tmp, "settings.json")).text());
  expect(onDisk.docsAgents).toBe(MAX_DOCS_AGENTS);
});

test("writeSettings clamps an over-max sectionAgents down to MAX_SECTION_AGENTS", async () => {
  const next = await writeSettings({ sectionAgents: 25 });
  expect(next.sectionAgents).toBe(MAX_SECTION_AGENTS); // 20
});

test("writeSettings clamps a below-min sectionAgents up to MIN_SECTION_AGENTS", async () => {
  const next = await writeSettings({ sectionAgents: 0 });
  expect(next.sectionAgents).toBe(MIN_SECTION_AGENTS); // 1
});

test("writeSettings rounds a fractional sectionAgents to the nearest integer", async () => {
  const next = await writeSettings({ sectionAgents: 3.4 });
  expect(next.sectionAgents).toBe(3);
});

test("writeSettings falls back to default sectionAgents for malformed values", async () => {
  const nullValue = await writeSettings({ sectionAgents: null as unknown as number });
  expect(nullValue.sectionAgents).toBe(DEFAULT_SECTION_AGENTS);

  const stringValue = await writeSettings({ sectionAgents: "foo" as unknown as number });
  expect(stringValue.sectionAgents).toBe(DEFAULT_SECTION_AGENTS);

  const onDisk = JSON.parse(await Bun.file(join(tmp, "settings.json")).text());
  expect(onDisk.sectionAgents).toBe(DEFAULT_SECTION_AGENTS);
});

test("settingsWithDefaults falls back to default sectionAgents for malformed values", () => {
  expect(settingsWithDefaults({ sectionAgents: null as unknown as number }).sectionAgents).toBe(
    DEFAULT_SECTION_AGENTS,
  );
  expect(settingsWithDefaults({ sectionAgents: "foo" as unknown as number }).sectionAgents).toBe(
    DEFAULT_SECTION_AGENTS,
  );
});

test("writeSettings persists openBrowser", async () => {
  const next = await writeSettings({ openBrowser: false });
  expect(next.openBrowser).toBe(false);
  const onDisk = JSON.parse(await Bun.file(join(tmp, "settings.json")).text());
  expect(onDisk.openBrowser).toBe(false);
});

test("writeSettings coerces a non-boolean openBrowser to a real boolean", async () => {
  // The server's `POST /api/settings` casts the request body straight to
  // `GlobalSettings`, so a stray `{"openBrowser":"yes"}` reaches writeSettings
  // untyped. It must be normalized rather than persisted verbatim.
  const next = await writeSettings({
    openBrowser: "yes" as unknown as boolean,
  });
  expect(next.openBrowser).toBe(true);
  const onDisk = JSON.parse(await Bun.file(join(tmp, "settings.json")).text());
  expect(onDisk.openBrowser).toBe(true);
});

test("writeSettings coerces a falsy non-boolean openBrowser to false", async () => {
  const next = await writeSettings({
    openBrowser: 0 as unknown as boolean,
  });
  expect(next.openBrowser).toBe(false);
});

test('writeSettings coerces the string "false" openBrowser to false', async () => {
  // Regression: a naive `Boolean("false")` is `true` (every non-empty string
  // is truthy), which would flip a crafted `POST /api/settings` with
  // `{"openBrowser":"false"}` to `true` — the opposite of intent. Routing
  // through `parseBooleanSetting` keeps the server in agreement with the CLI
  // `set` path, which already maps "false" → false.
  const next = await writeSettings({
    openBrowser: "false" as unknown as boolean,
  });
  expect(next.openBrowser).toBe(false);
  const onDisk = JSON.parse(await Bun.file(join(tmp, "settings.json")).text());
  expect(onDisk.openBrowser).toBe(false);
});

test('writeSettings coerces "no"/"off" openBrowser to false', async () => {
  expect((await writeSettings({ openBrowser: "no" as unknown as boolean })).openBrowser).toBe(
    false,
  );
  expect((await writeSettings({ openBrowser: "off" as unknown as boolean })).openBrowser).toBe(
    false,
  );
});

test("writeSettings coerces a non-boolean structuredHighlighting to a real boolean", async () => {
  const next = await writeSettings({
    structuredHighlighting: "on" as unknown as boolean,
  });
  expect(next.structuredHighlighting).toBe(true);
  const onDisk = JSON.parse(await Bun.file(join(tmp, "settings.json")).text());
  expect(onDisk.structuredHighlighting).toBe(true);
});

test('writeSettings coerces the string "false" structuredHighlighting to false', async () => {
  // Regression: like openBrowser, a naive `Boolean("false")` is `true` (every
  // non-empty string is truthy), so a crafted `POST /api/settings` with
  // `{"structuredHighlighting":"false"}` would flip to `true` — the opposite
  // of intent. Routing through `parseBooleanSetting` keeps the falsy-string
  // path correct and the server in agreement with the CLI `set` path.
  const next = await writeSettings({
    structuredHighlighting: "false" as unknown as boolean,
  });
  expect(next.structuredHighlighting).toBe(false);
  const onDisk = JSON.parse(await Bun.file(join(tmp, "settings.json")).text());
  expect(onDisk.structuredHighlighting).toBe(false);
  expect(
    (
      await writeSettings({
        structuredHighlighting: "off" as unknown as boolean,
      })
    ).structuredHighlighting,
  ).toBe(false);
});

test("writeSettings coerces a non-boolean wrapLines to a real boolean", async () => {
  const next = await writeSettings({
    wrapLines: "on" as unknown as boolean,
  });
  expect(next.wrapLines).toBe(true);
  const onDisk = JSON.parse(await Bun.file(join(tmp, "settings.json")).text());
  expect(onDisk.wrapLines).toBe(true);
});

test('writeSettings coerces the string "false" wrapLines to false', async () => {
  // Regression: like openBrowser/structuredHighlighting, a naive
  // `Boolean("false")` is `true`, so a crafted `POST /api/settings` with
  // `{"wrapLines":"false"}` would flip to `true` — the opposite of intent.
  const next = await writeSettings({
    wrapLines: "false" as unknown as boolean,
  });
  expect(next.wrapLines).toBe(false);
  const onDisk = JSON.parse(await Bun.file(join(tmp, "settings.json")).text());
  expect(onDisk.wrapLines).toBe(false);
  expect((await writeSettings({ wrapLines: "off" as unknown as boolean })).wrapLines).toBe(false);
});

test("writeSettings coerces display booleans to real booleans", async () => {
  const next = await writeSettings({
    filesExpandedByDefault: "true" as unknown as boolean,
    splitView: "off" as unknown as boolean,
  });
  expect(next.filesExpandedByDefault).toBe(true);
  expect(next.splitView).toBe(false);

  const onDisk = JSON.parse(await Bun.file(join(tmp, "settings.json")).text());
  expect(onDisk.filesExpandedByDefault).toBe(true);
  expect(onDisk.splitView).toBe(false);
});

test("writeSettings falls back to display boolean defaults for invalid values", async () => {
  const next = await writeSettings({
    filesExpandedByDefault: "maybe" as unknown as boolean,
    splitView: "maybe" as unknown as boolean,
  });

  expect(next.filesExpandedByDefault).toBe(DEFAULT_FILES_EXPANDED_BY_DEFAULT);
  expect(next.splitView).toBe(DEFAULT_SPLIT_VIEW);
});

test("settingsWithDefaults includes openBrowser, highlighting, wrap, and agent defaults", () => {
  expect(settingsWithDefaults({})).toEqual({
    openBrowser: DEFAULT_OPEN_BROWSER,
    loopMaxRounds: DEFAULT_LOOP_ROUNDS,
    reviewAgents: DEFAULT_REVIEW_AGENTS,
    sectionAgents: DEFAULT_SECTION_AGENTS,
    docsAgents: DEFAULT_DOCS_AGENTS,
    structuredHighlighting: DEFAULT_STRUCTURED_HIGHLIGHTING,
    wrapLines: DEFAULT_WRAP_LINES,
  });
});
