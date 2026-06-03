import type {
  Diff,
  DiffTarget,
  Comment,
  FileDiff,
  GitRefInfo,
} from "../../types.ts";

export type ColorScheme = "system" | "light" | "dark";

export type GlobalSettings = {
  splitView?: boolean;
  diffFontSize?: number;
  theme?: ColorScheme;
  syntaxThemeLight?: string;
  syntaxThemeDark?: string;
  filesExpandedByDefault?: boolean;
  openBrowser?: boolean;
  loopMaxRounds?: number;
  reviewAgents?: number;
  docsAgents?: number;
};

async function jfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`${res.status}: ${txt}`);
  }
  return (await res.json()) as T;
}

export const api = {
  info: () => jfetch<{ cwd: string; root: string; branch: string | null }>("/api/info"),
  refs: () => jfetch<{ refs: GitRefInfo[] }>("/api/refs"),
  diffs: () => jfetch<{ diffs: Diff[] }>("/api/diffs"),
  diff: (slug: string) =>
    jfetch<{ diff: Diff }>(`/api/diff?slug=${encodeURIComponent(slug)}`),
  createDiff: (base: DiffTarget, head: DiffTarget, setActive = true) =>
    jfetch<{ diff: Diff }>("/api/diff", {
      method: "POST",
      body: JSON.stringify({ base, head, setActive }),
    }),
  files: (base: DiffTarget, head: DiffTarget) =>
    jfetch<{ files: FileDiff[] }>("/api/files", {
      method: "POST",
      body: JSON.stringify({ base, head }),
    }),
  settings: () => jfetch<{ settings: GlobalSettings }>("/api/settings"),
  setSettings: (partial: Partial<GlobalSettings>) =>
    jfetch<{ settings: GlobalSettings }>("/api/settings", {
      method: "POST",
      body: JSON.stringify(partial),
    }),
  active: () => jfetch<{ slug: string | null }>("/api/active"),
  setActive: (slug: string) =>
    jfetch<{ ok: true }>("/api/active", { method: "POST", body: JSON.stringify({ slug }) }),
  addComment: (input: {
    slug: string;
    file?: string;
    line?: number;
    endLine?: number;
    side?: "old" | "new";
    body: string;
    parentId?: string;
    threadId?: string;
    author?: string;
  }) =>
    jfetch<{ comment: Comment }>("/api/comment", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  deleteComment: (slug: string, id: string) =>
    jfetch<{ diff: Diff }>("/api/comment", {
      method: "DELETE",
      body: JSON.stringify({ slug, id }),
    }),
  updateComment: (slug: string, id: string, body: string) =>
    jfetch<{ diff: Diff }>("/api/comment", {
      method: "PATCH",
      body: JSON.stringify({ slug, id, body }),
    }),
  resolve: (input: {
    slug: string;
    threadId: string;
    status: "fixed" | "skipped" | "documented";
    body: string;
    author?: string;
    documentedAs?: string;
  }) =>
    jfetch<{ diff: Diff }>("/api/resolve", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  unresolve: (slug: string, threadId: string) =>
    jfetch<{ diff: Diff }>("/api/resolve", {
      method: "DELETE",
      body: JSON.stringify({ slug, threadId }),
    }),
  requestDocument: (slug: string, threadId: string, requested: boolean) =>
    jfetch<{ diff: Diff }>("/api/document", {
      method: "POST",
      body: JSON.stringify({ slug, threadId, requested }),
    }),
  uploadAttachment: async (file: File): Promise<{ url: string; name: string }> => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/attachment", { method: "POST", body: form });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`${res.status}: ${txt}`);
    }
    return (await res.json()) as { url: string; name: string };
  },
};

export type WSEvent =
  | { type: "hello"; id: string }
  | { type: "diff:changed"; file?: string }
  | { type: "repo:changed" }
  | { type: "diff:created"; slug: string }
  | { type: "active:changed"; slug?: string }
  | { type: "comment:added"; slug: string; comment: Comment }
  | { type: "comment:deleted"; slug: string; id: string }
  | { type: "thread:resolved"; slug: string; threadId: string }
  | { type: "thread:unresolved"; slug: string; threadId: string }
  // Synthetic client-side event emitted by `openSocket` when the WebSocket
  // closes (server quit, network drop) — used by the UI to flip the "Live"
  // badge back to "Connecting…" while the reconnect loop runs.
  | { type: "disconnected" };

export function openSocket(onEvent: (e: WSEvent) => void): () => void {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/api/ws`;
  let ws: WebSocket | null = null;
  let closed = false;
  let backoff = 500;

  const connect = () => {
    ws = new WebSocket(url);
    ws.onopen = () => {
      backoff = 500;
    };
    ws.onmessage = (ev) => {
      try {
        onEvent(JSON.parse(ev.data) as WSEvent);
      } catch {}
    };
    ws.onclose = () => {
      try {
        onEvent({ type: "disconnected" });
      } catch {}
      if (closed) return;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 5000);
    };
    ws.onerror = () => ws?.close();
  };
  connect();

  return () => {
    closed = true;
    ws?.close();
  };
}
