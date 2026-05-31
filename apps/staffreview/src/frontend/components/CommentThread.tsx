import { useMemo, useState } from "react";
import { BookMarked, Check, CheckCircle2, ChevronDown, ChevronRight, MessageSquare, Pencil, SkipForward, Trash2, Undo2 } from "lucide-react";
import type { Comment, ResolutionStatus } from "../../types.ts";
import { Button } from "./ui/button.tsx";
import { Badge } from "./ui/badge.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { Markdown } from "./Markdown.tsx";
import { MarkdownEditor } from "./MarkdownEditor.tsx";
import { api } from "../lib/api.ts";
import { clearDraft, loadDraft } from "../lib/draft.ts";
import { cn, formatTime } from "../lib/utils.ts";

type Props = {
  slug: string;
  comments: Comment[];
  /** if true, this thread is unrooted (used to allow standalone editor) */
  showEditorByDefault?: boolean;
  className?: string;
  context?: string;
  onChange?: () => void;
};

function statusBadge(s: ResolutionStatus) {
  if (s === "fixed") return <Badge variant="success">Fixed</Badge>;
  if (s === "skipped") return <Badge variant="outline">Skipped</Badge>;
  return <Badge variant="warning">Documented</Badge>;
}

export function CommentThread({ slug, comments, className, context, onChange }: Props) {
  const root = comments.find((c) => !c.parentId)!;
  const replies = comments.filter((c) => c.parentId);
  const resolution = root.resolution;

  const replyDraftKey = `reply:${slug}:${root.threadId}`;
  // Local-only expand of a resolved (fixed/skipped) card — lets the user
  // read the content without reopening the thread.
  const [collapsedExpanded, setCollapsedExpanded] = useState(false);
  // Collapse for a non-resolved/documented card — defaults to expanded.
  // (Fixed/skipped cards have their own collapse below, via collapsedExpanded.)
  const [collapsed, setCollapsed] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState(() => loadDraft(replyDraftKey));
  const documentRequested = !!root.documentRequested;

  async function postReply() {
    if (!replyText.trim()) return;
    await api.addComment({
      slug,
      file: root.file,
      line: root.line,
      side: root.side,
      body: replyText.trim(),
      parentId: root.id,
      threadId: root.threadId,
    });
    clearDraft(replyDraftKey);
    setReplyText("");
    setReplyOpen(false);
    onChange?.();
  }

  async function resolveQuick(status: "fixed" | "skipped") {
    await api.resolve({
      slug,
      threadId: root.threadId,
      status,
      body: "",
    });
    onChange?.();
  }

  async function toggleDocument() {
    // The "Document" button is a non-terminal flag, not a resolution.
    // It marks the thread so `/staff-resolve` writes a library entry and
    // resolves it as `documented`. The thread stays open until then.
    await api.requestDocument(slug, root.threadId, !documentRequested);
    onChange?.();
  }

  async function unresolve() {
    await api.unresolve(slug, root.threadId);
    onChange?.();
  }


  // Fixed and Skipped threads collapse to a compact single-row card.
  // Clicking the row (but not the Reopen button) expands it in place to
  // show the comment content, so the user can read it without changing
  // the resolved state; clicking again collapses it. Documented threads
  // stay expanded so the documentedAs filename remains visible.
  if (resolution && (resolution.status === "fixed" || resolution.status === "skipped")) {
    return (
      <div
        className={cn("rounded-md border border-border bg-muted/40", className)}
        data-testid={`thread-collapsed-${resolution.status}`}
      >
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
          {/* The toggle is its own button (not wrapping Reopen) so the two
           * interactive controls stay siblings — clean a11y + no
           * accessible-name overlap. */}
          <button
            type="button"
            aria-expanded={collapsedExpanded}
            onClick={() => setCollapsedExpanded((v) => !v)}
            data-testid={`thread-collapsed-toggle-${resolution.status}`}
            className="flex flex-1 items-center gap-2 text-left text-muted-foreground"
          >
            {collapsedExpanded ? (
              <ChevronDown className="h-3 w-3 shrink-0" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0" />
            )}
            {statusBadge(resolution.status)}
            <span className="font-medium text-foreground ml-1">{root.author}</span>
            <span>·</span>
            <span>{formatTime(root.createdAt)}</span>
          </button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={unresolve}
            aria-label="Reopen"
            title="Reopen"
          >
            <Undo2 />
          </Button>
        </div>
        {collapsedExpanded && (
          <div className="divide-y divide-border border-t border-border">
            <CommentBubble comment={root} slug={slug} onChange={onChange} />
            {replies.map((r) => (
              <CommentBubble key={r.id} comment={r} slug={slug} indent onChange={onChange} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={cn("rounded-md border border-border bg-muted/40", className)}>
      {context && (
        <div className="px-3 pt-2 text-[10px] uppercase tracking-wider text-muted-foreground">{context}</div>
      )}
      <div className="divide-y divide-border">
        <CommentBubble
          comment={root}
          slug={slug}
          onChange={onChange}
          collapsible
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((v) => !v)}
        />
        {!collapsed &&
          replies.map((r) => (
            <CommentBubble key={r.id} comment={r} slug={slug} indent onChange={onChange} />
          ))}
      </div>

      {!collapsed && resolution && (
        <div className="border-t border-border bg-background px-3 py-2 flex items-center gap-2 text-xs">
          {statusBadge(resolution.status)}
          <span className="text-muted-foreground">— {resolution.body}</span>
          {resolution.documentedAs && (
            <code className="text-xs text-muted-foreground">{resolution.documentedAs}</code>
          )}
          <Button variant="outline" size="sm" onClick={unresolve} className="ml-auto">
            <Undo2 />
            Reopen
          </Button>
        </div>
      )}

      {!collapsed && !resolution && (
        <div className="border-t border-border px-3 py-2 flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" data-testid="thread-resolve">
                Resolve
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem
                onSelect={() => resolveQuick("fixed")}
                data-testid="thread-fixed"
              >
                <CheckCircle2 className="text-success" />
                Fixed
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => resolveQuick("skipped")}
                data-testid="thread-skip"
              >
                <SkipForward />
                Skip
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="flex-1" />
          <Button
            variant={documentRequested ? "ghost" : "secondary"}
            size="sm"
            onClick={toggleDocument}
            aria-pressed={documentRequested}
            title={
              documentRequested
                ? "Marked for documentation — click to unmark"
                : "Mark for documentation by /staff-resolve"
            }
            data-testid="thread-document"
          >
            {documentRequested ? <Check className="text-success" /> : <BookMarked />}
            Document
          </Button>
          <Button
            size="sm"
            onClick={() => setReplyOpen((v) => !v)}
            data-testid="thread-reply"
          >
            <MessageSquare />
            Reply
          </Button>
        </div>
      )}

      {!collapsed && replyOpen && !resolution && (
        <div className="border-t border-border bg-background p-2">
          <MarkdownEditor
            value={replyText}
            onChange={setReplyText}
            draftKey={replyDraftKey}
            onSubmit={() => { if (replyText.trim()) postReply(); }}
            placeholder="Reply… (⌘↩ to submit, paste or drop images)"
            minHeightClass="min-h-[60px]"
            actions={
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { setReplyOpen(false); clearDraft(replyDraftKey); setReplyText(""); }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={postReply}
                  disabled={!replyText.trim()}
                  data-testid="reply-submit"
                >
                  Reply
                </Button>
              </>
            }
          />
        </div>
      )}

    </div>
  );
}

function CommentBubble({
  comment,
  slug,
  indent,
  onChange,
  collapsible,
  collapsed,
  onToggleCollapse,
}: {
  comment: Comment;
  slug: string;
  indent?: boolean;
  onChange?: () => void;
  // When set, the author row gets a chevron that collapses/expands the whole
  // thread. Only the root bubble of a card is collapsible.
  collapsible?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const editDraftKey = `edit:${slug}:${comment.id}`;
  const [editing, setEditing] = useState(false);
  // A persisted edit draft (from a prior refresh) takes precedence over
  // the saved body so unsaved edits survive a reload.
  const [draft, setDraft] = useState(() => loadDraft(editDraftKey) || comment.body);
  const [saving, setSaving] = useState(false);

  async function saveEdit() {
    if (!draft.trim() || draft === comment.body) {
      clearDraft(editDraftKey);
      setEditing(false);
      setDraft(comment.body);
      return;
    }
    setSaving(true);
    try {
      await api.updateComment(slug, comment.id, draft.trim());
      clearDraft(editDraftKey);
      setEditing(false);
      onChange?.();
    } finally {
      setSaving(false);
    }
  }

  async function deleteSelf() {
    const isRoot = !comment.parentId;
    const ok = confirm(
      isRoot
        ? "Delete this thread? Replies will also be removed."
        : "Delete this comment?",
    );
    if (!ok) return;
    await api.deleteComment(slug, comment.id);
    onChange?.();
  }

  return (
    <div className={cn("p-3", indent && "pl-6 bg-background")}>
      {/* Fixed row height (matches the icon-xs action buttons) so collapsing —
          which hides those buttons — doesn't reflow the header and shift the
          chevron/author. */}
      <div className={cn("flex min-h-6 items-center gap-2 text-xs text-muted-foreground", !collapsed && "mb-1")}>
        {collapsible && (
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand thread" : "Collapse thread"}
            title={collapsed ? "Expand" : "Collapse"}
            onClick={onToggleCollapse}
            data-testid="thread-collapse-toggle"
            className="-ml-1 flex items-center text-muted-foreground hover:text-foreground"
          >
            {collapsed ? (
              <ChevronRight className="h-3 w-3 shrink-0" />
            ) : (
              <ChevronDown className="h-3 w-3 shrink-0" />
            )}
          </button>
        )}
        <span className="font-medium text-foreground">{comment.author}</span>
        <span>·</span>
        <span>{formatTime(comment.createdAt)}</span>
        <div className="ml-auto flex items-center gap-0.5">
          {!editing && !collapsed && (
            <>
              <Button
                variant="ghost"
                size="icon-xs"
                title="Edit comment"
                aria-label="Edit comment"
                onClick={() => {
                  setDraft(loadDraft(editDraftKey) || comment.body);
                  setEditing(true);
                }}
              >
                <Pencil className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                title="Delete"
                aria-label="Delete comment"
                onClick={deleteSelf}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </>
          )}
        </div>
      </div>
      {collapsed ? null : editing ? (
        <MarkdownEditor
          value={draft}
          onChange={setDraft}
          draftKey={editDraftKey}
          onSubmit={saveEdit}
          autoFocus
          minHeightClass="min-h-[60px]"
          actions={
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  clearDraft(editDraftKey);
                  setEditing(false);
                  setDraft(comment.body);
                }}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={saveEdit} disabled={saving || !draft.trim()}>
                Save
              </Button>
            </>
          }
        />
      ) : (
        <Markdown>{comment.body}</Markdown>
      )}
    </div>
  );
}

export function NewCommentEditor({
  slug,
  file,
  line,
  endLine,
  side,
  onPosted,
  onCancel,
}: {
  slug: string;
  file?: string;
  line?: number;
  endLine?: number;
  side?: "old" | "new";
  onPosted?: () => void;
  onCancel?: () => void;
}) {
  const rangeSuffix =
    line != null && endLine != null && endLine !== line
      ? `${line}-${endLine}`
      : line != null
        ? `${line}`
        : "";
  // Inline composers key the draft by location so two open at once don't
  // share text; the top-level composer is per-slug.
  const draftKey = file
    ? `new:${slug}:${file}:${side ?? "new"}:${line ?? ""}:${endLine ?? line ?? ""}`
    : `new:${slug}`;
  const [text, setText] = useState(() => loadDraft(draftKey));
  const [posting, setPosting] = useState(false);

  async function post() {
    if (!text.trim()) return;
    setPosting(true);
    try {
      await api.addComment({
        slug,
        file,
        line,
        endLine: endLine != null && endLine !== line ? endLine : undefined,
        side,
        body: text.trim(),
      });
      clearDraft(draftKey);
      setText("");
      onPosted?.();
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="space-y-2 p-2">
      <MarkdownEditor
        value={text}
        onChange={setText}
        draftKey={draftKey}
        onSubmit={() => { if (!posting && text.trim()) post(); }}
        autoFocus
        placeholder={
          file
            ? `Comment on ${file}:${rangeSuffix} — ⌘↩ to submit, paste or drop images`
            : "Top-level comment… ⌘↩ to submit, paste or drop images"
        }
        actions={
          <>
            {onCancel && (
              <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
            )}
            <Button size="sm" onClick={post} disabled={posting || !text.trim()}>
              Comment
            </Button>
          </>
        }
      />
    </div>
  );
}
