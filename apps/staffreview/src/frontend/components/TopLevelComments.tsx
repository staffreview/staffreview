import { MessageSquarePlus } from "lucide-react";
import { memo, type ReactNode, useMemo, useState } from "react";
import type { Comment, FileDiff } from "../../types.ts";
import { CommentThread, NewCommentEditor } from "./CommentThread.tsx";
import { setLineHash } from "./DiffView.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.tsx";

function groupByThread(comments: Comment[]) {
  const map = new Map<string, Comment[]>();
  for (const c of comments) {
    const list = map.get(c.threadId) ?? [];
    list.push(c);
    map.set(c.threadId, list);
  }
  return Array.from(map.values()).map((cs) =>
    cs.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  );
}

function scrollToThread(
  threadId: string,
  file?: string,
  side?: "old" | "new",
  line?: number,
  endLine?: number,
) {
  if (file) {
    window.dispatchEvent(new CustomEvent("staff:expand-file", { detail: { path: file } }));
  }
  // Reflect the thread's anchor in the URL so the address bar is a shareable
  // deep-link to the line (or range), just like clicking the line number
  // directly. `setLineHash` also dispatches `staff:hashchange` so the
  // diff repaints its line highlight.
  if (file && side && line) {
    setLineHash(file, side, line, endLine);
  }
  const start = performance.now();
  const tick = () => {
    const el = document.querySelector(`[data-thread-id="${threadId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (performance.now() - start < 1500) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function scrollToFile(path: string) {
  // Expand the file first in case it's collapsed, then scroll its card
  // into view. Poll briefly because the expand triggers a re-render.
  window.dispatchEvent(new CustomEvent("staff:expand-file", { detail: { path } }));
  const selector = `[data-testid="file-card-${path.replace(/"/g, '\\"')}"]`;
  const start = performance.now();
  const tick = () => {
    const el = document.querySelector(selector);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (performance.now() - start < 1500) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export const TopLevelComments = memo(function TopLevelComments({
  slug,
  comments,
  files,
  onChange,
  headerLeft,
  composing,
  onComposingChange,
}: {
  slug: string;
  comments: Comment[];
  files: FileDiff[];
  onChange?: () => void;
  headerLeft?: ReactNode;
  composing: boolean;
  onComposingChange: (v: boolean) => void;
}) {
  const setComposing = onComposingChange;
  const [tab, setTab] = useState<"comments" | "files">("comments");
  // Single chronological list of all threads, sorted by the root comment's
  // createdAt. Inline-anchored threads get a clickable file:line header.
  const threads = useMemo(() => {
    const all = groupByThread(comments);
    return all.sort((a, b) => {
      const aRoot = a.find((c) => !c.parentId);
      const bRoot = b.find((c) => !c.parentId);
      return (aRoot?.createdAt ?? "").localeCompare(bRoot?.createdAt ?? "");
    });
  }, [comments]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center">{headerLeft}</div>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={tab}
          onValueChange={(v) => {
            if (v === "comments" || v === "files") setTab(v);
          }}
          aria-label="Sidebar view"
          className="flex-1"
        >
          {/* `bg-foreground/15` is darker than both the default tab
           * background and the `bg-accent` selected state, so the count
           * badges stay visible in either tab state. */}
          <ToggleGroupItem
            value="comments"
            className="flex-1 gap-1.5"
            data-testid="sidebar-tab-comments"
          >
            Comments
            <Badge className="bg-foreground/15 text-foreground border-transparent px-1.5 py-0 text-[10px] leading-4">
              {threads.length}
            </Badge>
          </ToggleGroupItem>
          <ToggleGroupItem value="files" className="flex-1 gap-1.5" data-testid="sidebar-tab-files">
            Files
            <Badge className="bg-foreground/15 text-foreground border-transparent px-1.5 py-0 text-[10px] leading-4">
              {files.length}
            </Badge>
          </ToggleGroupItem>
        </ToggleGroup>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="New comment"
          title="New comment"
          data-testid="sidebar-new-comment-icon"
          onClick={() => {
            if (tab !== "comments") setTab("comments");
            setComposing(!composing);
          }}
        >
          <MessageSquarePlus />
        </Button>
      </div>

      {tab === "comments" && (
        <>
          {composing && (
            <NewCommentEditor
              slug={slug}
              onPosted={() => {
                setComposing(false);
                onChange?.();
              }}
              onCancel={() => setComposing(false)}
            />
          )}

          {threads.length === 0 && !composing && (
            <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No review comments yet. Click <em>New comment</em>, click any line in the diff, or run{" "}
              <code className="font-mono">/staff-review</code> in your coding agent.
            </div>
          )}

          {threads.map((thread) => {
            const root = thread.find((c) => !c.parentId)!;
            const filePath = root.file ?? "";
            const lineSuffix = root.line
              ? root.endLine && root.endLine !== root.line
                ? `:${root.line}-${root.endLine}`
                : `:${root.line}`
              : "";
            const fullLocation = `${filePath}${lineSuffix}`;
            return (
              <div key={root.threadId} className="space-y-1">
                {filePath && (
                  <button
                    type="button"
                    onClick={() =>
                      scrollToThread(root.threadId, root.file, root.side, root.line, root.endLine)
                    }
                    data-testid={`sidebar-inline-thread-${root.threadId}`}
                    title={fullLocation}
                    className="flex w-full items-center text-left font-mono text-[11px] text-muted-foreground hover:text-foreground transition-colors px-1 focus-visible:outline-none focus-visible:underline"
                  >
                    {/* Left-truncate the whole `path:line` (ellipsis on the
                     * left via rtl, plaintext bdi to keep natural reading
                     * order). The end — base filename + line — stays visible,
                     * and a long path OR a long filename can never overflow the
                     * sidebar and force a horizontal scrollbar. */}
                    <span
                      className="min-w-0 overflow-hidden whitespace-nowrap text-ellipsis"
                      style={{ direction: "rtl" }}
                    >
                      <bdi style={{ unicodeBidi: "plaintext" }}>{fullLocation}</bdi>
                    </span>
                  </button>
                )}
                <CommentThread slug={slug} comments={thread} onChange={onChange} />
              </div>
            );
          })}
        </>
      )}

      {tab === "files" && (
        <div
          className="rounded-md border border-border bg-muted/30"
          data-testid="sidebar-files-list"
        >
          {files.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              No files in this diff.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {files.map((f) => (
                <li key={f.path}>
                  <button
                    type="button"
                    onClick={() => scrollToFile(f.path)}
                    title={f.path}
                    data-testid={`sidebar-file-${f.path}`}
                    className="flex w-full items-center px-2 py-1.5 text-left font-mono text-xs hover:bg-muted transition-colors focus-visible:outline-none focus-visible:bg-muted"
                  >
                    {/* Left-truncate the whole path in one span (ellipsis on
                     * the left via rtl, plaintext bdi to keep natural reading
                     * order), matching the inline-comment header above. The
                     * base filename stays visible and a long dir OR a long
                     * filename can never overflow the sidebar. */}
                    <span
                      className="min-w-0 overflow-hidden whitespace-nowrap text-ellipsis text-foreground"
                      style={{ direction: "rtl" }}
                    >
                      <bdi style={{ unicodeBidi: "plaintext" }}>{f.path}</bdi>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
});
