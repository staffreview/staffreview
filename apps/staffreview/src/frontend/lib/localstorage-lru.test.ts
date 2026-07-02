import { beforeEach, expect, test } from "bun:test";
import { pruneLru, writeLruEntry } from "./localstorage-lru.ts";

// The delicate, spec-dependent recency/eviction core shared by
// reviewed-files.ts and DiffView.tsx's collapse-override helpers. Tested once
// here so the two consumers can stay thin wrappers.

const PREFIX = "test:lru:";
const CAP = 5;
const key = (i: number) => `${PREFIX}${i}`;

function countStored(): number {
  let n = 0;
  for (let i = 0; i < localStorage.length; i++) {
    if (localStorage.key(i)?.startsWith(PREFIX)) n++;
  }
  return n;
}

beforeEach(() => {
  localStorage.clear();
});

// --- pruneLru --------------------------------------------------------------

test("pruneLru is a no-op at or under the cap", () => {
  for (let i = 0; i < CAP; i++) localStorage.setItem(key(i), "{}");
  pruneLru(PREFIX, CAP, key(0));
  expect(countStored()).toBe(CAP);
});

test("pruneLru evicts the oldest overflow and protects keepKey", () => {
  const over = 3;
  for (let i = 0; i < CAP + over; i++) localStorage.setItem(key(i), "{}");
  // Keep the oldest key: it must survive despite sorting first, so eviction
  // starts at the next-oldest and takes exactly `over` of them.
  pruneLru(PREFIX, CAP, key(0));
  expect(countStored()).toBe(CAP);
  expect(localStorage.getItem(key(0))).not.toBeNull(); // protected
  for (let i = 1; i <= over; i++) expect(localStorage.getItem(key(i))).toBeNull();
  for (let i = over + 1; i < CAP + over; i++) expect(localStorage.getItem(key(i))).not.toBeNull();
});

test("pruneLru ignores foreign keys (neither counted nor evicted)", () => {
  localStorage.setItem("other:thing", "x");
  for (let i = 0; i < CAP + 2; i++) localStorage.setItem(key(i), "{}");
  pruneLru(PREFIX, CAP, key(CAP + 1));
  expect(localStorage.getItem("other:thing")).toBe("x");
});

// --- writeLruEntry ---------------------------------------------------------

test("writeLruEntry persists the value and prunes over the cap", () => {
  for (let i = 0; i < CAP; i++) writeLruEntry(PREFIX, CAP, key(i), `v${i}`);
  writeLruEntry(PREFIX, CAP, key(CAP), "fresh"); // one over the cap
  expect(countStored()).toBe(CAP);
  expect(localStorage.getItem(key(CAP))).toBe("fresh"); // newest survives
  expect(localStorage.getItem(key(0))).toBeNull(); // oldest evicted
});

test("writeLruEntry re-appends an existing key (removeItem-before-setItem MRU)", () => {
  // Without the removeItem, a bare setItem on an existing key keeps its slot
  // (Web Storage spec) and eviction would degrade to FIFO-by-first-write.
  for (let i = 0; i < CAP; i++) writeLruEntry(PREFIX, CAP, key(i), `v${i}`);
  writeLruEntry(PREFIX, CAP, key(0), "touched"); // re-touch the oldest → newest
  writeLruEntry(PREFIX, CAP, key(CAP), "fresh"); // push over the cap
  expect(countStored()).toBe(CAP);
  expect(localStorage.getItem(key(0))).toBe("touched"); // survived: re-appended
  expect(localStorage.getItem(key(1))).toBeNull(); // now the oldest → evicted
});
