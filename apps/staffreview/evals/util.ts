import { dirname, relative, resolve, sep } from "node:path";

/**
 * Grace period between SIGTERM and the SIGKILL escalation used by the eval
 * subprocess timeouts (`runShell`, `runJudgeShell`). A subprocess that traps or
 * ignores SIGTERM must still be force-killed so a single hung run cannot stall
 * the whole eval matrix past its configured timeout.
 */
export const TIMEOUT_KILL_GRACE_MS = 5_000;

/** Single-quote a string for safe interpolation into a `zsh -lc` command. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Render a number compactly: integers as-is, otherwise one decimal place. */
export function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** The deepest directory that contains every given path. */
export function commonAncestor(paths: string[]): string {
  if (paths.length === 0) return process.cwd();
  const resolved = paths.map((path) => resolve(path));
  let candidate = resolved[0]!;
  for (;;) {
    if (resolved.every((path) => path === candidate || path.startsWith(`${candidate}${sep}`))) {
      return candidate;
    }
    const parent = dirname(candidate);
    if (parent === candidate) return parent;
    candidate = parent;
  }
}

/**
 * Render `path` relative to the current working directory when it sits inside
 * it; otherwise return the path unchanged. A path equal to the cwd renders as
 * `"."`. Used for human-readable display of suite/report locations.
 */
export function relativeFromCwd(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel.startsWith("..") ? path : rel || ".";
}
