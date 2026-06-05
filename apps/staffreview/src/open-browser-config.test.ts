import { expect, test } from "bun:test";
import { shouldOpenBrowser } from "./open-browser-config.ts";

// Lock down the `staff serve` browser-open precedence so a future refactor of
// the boolean expression can't silently invert it.

test("falls back to the setting when neither flag is passed", () => {
  expect(shouldOpenBrowser({ noOpen: false, open: false, setting: true })).toBe(true);
  expect(shouldOpenBrowser({ noOpen: false, open: false, setting: false })).toBe(false);
});

test("--open forces open even when the setting is false", () => {
  expect(shouldOpenBrowser({ noOpen: false, open: true, setting: false })).toBe(true);
});

test("--no-open overrides a true setting", () => {
  expect(shouldOpenBrowser({ noOpen: true, open: false, setting: true })).toBe(false);
});

test("--no-open wins when both flags are passed", () => {
  expect(shouldOpenBrowser({ noOpen: true, open: true, setting: false })).toBe(false);
  expect(shouldOpenBrowser({ noOpen: true, open: true, setting: true })).toBe(false);
});

test("--open is redundant but harmless when the setting is already true", () => {
  expect(shouldOpenBrowser({ noOpen: false, open: true, setting: true })).toBe(true);
});
