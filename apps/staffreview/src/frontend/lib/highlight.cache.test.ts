import { beforeEach, expect, test } from "bun:test";
import {
	ensureShikiLanguage,
	ensureShikiTheme,
	getHighlighter,
	TOKEN_CACHE_MAX,
	tokenCache,
	tokenizeLine,
} from "./highlight.ts";

const THEME = "github-light";
const LANG = "typescript";

beforeEach(async () => {
	// `ensureShikiTheme`/`ensureShikiLanguage` clear the cache on first load, so
	// load before clearing to keep each test's cache state deterministic.
	await ensureShikiTheme(THEME);
	await ensureShikiLanguage(LANG);
	tokenCache.clear();
});

test("a cache hit returns the same array reference (no re-tokenize)", async () => {
	const highlighter = await getHighlighter();
	const line = "const answer = 42";

	const first = tokenizeLine(highlighter, line, LANG, THEME);
	const second = tokenizeLine(highlighter, line, LANG, THEME);

	// Same reference, not just deep-equal: proves the second call hit the cache.
	expect(second).toBe(first);
	expect(tokenCache.size).toBe(1);
});

test("the cache key is theme::lang::line (distinct keys don't collide)", async () => {
	await ensureShikiTheme("catppuccin-latte");
	const highlighter = await getHighlighter();
	const line = "const answer = 42";

	tokenizeLine(highlighter, line, LANG, THEME);
	tokenizeLine(highlighter, line, LANG, "catppuccin-latte");
	tokenizeLine(highlighter, "const other = 1", LANG, THEME);

	expect(tokenCache.size).toBe(3);
	expect(tokenCache.has(`${THEME}::${LANG}::${line}`)).toBe(true);
	expect(tokenCache.has(`catppuccin-latte::${LANG}::${line}`)).toBe(true);
});

test("touch-on-hit moves a key to most-recently-used so it survives eviction", async () => {
	const highlighter = await getHighlighter();

	// Fill the cache to exactly the cap with synthetic entries. Driving > 5000
	// real tokenizations would be slow; the LRU bookkeeping under test
	// (insertion order + touch re-insertion + evict-oldest) is independent of
	// the token contents, so synthetic Map entries exercise the same code paths.
	const sentinel = [{ content: "x" }];
	for (let i = 0; i < TOKEN_CACHE_MAX; i++) {
		tokenCache.set(`${THEME}::${LANG}::filler-${i}`, sentinel);
	}
	expect(tokenCache.size).toBe(TOKEN_CACHE_MAX);

	const oldestKey = `${THEME}::${LANG}::filler-0`;
	const secondOldestKey = `${THEME}::${LANG}::filler-1`;

	// Touch the OLDEST key via a real cache hit. tokenizeLine re-inserts it at
	// the MRU end, so it should now be safe and `filler-1` becomes the LRU.
	tokenCache.set(oldestKey, sentinel); // ensure the value the lookup returns
	const touched = tokenizeLine(highlighter, "filler-0", LANG, THEME);
	expect(touched).toBe(sentinel); // it was a hit (touched, not re-tokenized)

	// Now insert one NEW line via a real miss, pushing size over the cap and
	// forcing exactly one eviction of the current LRU entry.
	tokenizeLine(highlighter, "const brand_new = 1", LANG, THEME);

	expect(tokenCache.size).toBe(TOKEN_CACHE_MAX);
	// The touched (recently-used) key survived...
	expect(tokenCache.has(oldestKey)).toBe(true);
	// ...while the least-recently-used key was evicted.
	expect(tokenCache.has(secondOldestKey)).toBe(false);
});

test("eviction keeps the cache bounded at TOKEN_CACHE_MAX", async () => {
	const highlighter = await getHighlighter();
	const sentinel = [{ content: "x" }];
	// Prefill to one below the cap so a couple of real inserts cross it.
	for (let i = 0; i < TOKEN_CACHE_MAX - 1; i++) {
		tokenCache.set(`${THEME}::${LANG}::filler-${i}`, sentinel);
	}

	tokenizeLine(highlighter, "const a = 1", LANG, THEME); // size -> cap
	expect(tokenCache.size).toBe(TOKEN_CACHE_MAX);
	tokenizeLine(highlighter, "const b = 2", LANG, THEME); // over cap -> evict
	tokenizeLine(highlighter, "const c = 3", LANG, THEME); // over cap -> evict

	// Never grows past the cap, no matter how many distinct lines arrive.
	expect(tokenCache.size).toBe(TOKEN_CACHE_MAX);
});
