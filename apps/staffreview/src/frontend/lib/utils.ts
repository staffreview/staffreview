import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function shortId(id: string) {
  return id.slice(0, 8);
}

/** Abbreviate a 40-char hex SHA to 7 chars for display; leave anything else
 * (branch names, `WT`/`STAGED`, refs like `HEAD`) untouched. */
export function shortSha(ref: string): string {
  return /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 7) : ref;
}

/** Shorten the SHA(s) in a `base..head` slug for display. The full slug is
 * still what gets copied / put in the URL — this is display-only. */
export function shortenSlug(slug: string): string {
  const i = slug.indexOf("..");
  if (i < 0) return shortSha(slug);
  return `${shortSha(slug.slice(0, i))}..${shortSha(slug.slice(i + 2))}`;
}

/** Last path segment of a directory, e.g. `/a/b/repo` → `repo`. */
export function baseName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

export function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
