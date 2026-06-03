import { expect, test } from "bun:test";
import { parseBooleanSetting } from "./boolean-setting.ts";

// Truthy spellings — all should parse to `true`, case- and whitespace-insensitive.
const TRUTHY = ["true", "1", "yes", "on", "TRUE", "Yes", "  on  "];
for (const value of TRUTHY) {
	test(`parseBooleanSetting parses ${JSON.stringify(value)} as true`, () => {
		expect(parseBooleanSetting(value, "openBrowser")).toBe(true);
	});
}

// Falsy spellings — all should parse to `false`.
const FALSY = ["false", "0", "no", "off", "FALSE", "No", "  off  "];
for (const value of FALSY) {
	test(`parseBooleanSetting parses ${JSON.stringify(value)} as false`, () => {
		expect(parseBooleanSetting(value, "openBrowser")).toBe(false);
	});
}

// Anything else must be rejected with a usage error rather than silently
// coerced — this is the branch the e2e happy path never exercises.
const REJECTED = ["maybe", "", "2", "tru", "yep", undefined];
for (const value of REJECTED) {
	test(`parseBooleanSetting rejects ${JSON.stringify(value)} with a usage error`, () => {
		expect(() => parseBooleanSetting(value, "openBrowser")).toThrow(/usage/);
	});
}

test("parseBooleanSetting names the key in the usage error", () => {
	expect(() => parseBooleanSetting("garbage", "openBrowser")).toThrow(
		/staff settings set openBrowser <true\|false>/,
	);
});
