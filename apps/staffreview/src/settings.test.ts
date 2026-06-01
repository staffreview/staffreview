import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_DOCS_AGENTS, MIN_DOCS_AGENTS, writeSettings } from "./settings.ts";

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
