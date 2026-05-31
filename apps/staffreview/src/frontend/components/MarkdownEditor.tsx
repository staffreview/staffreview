import { useEffect, useRef, useState, type ReactNode } from "react";
import { ImagePlus, Loader2 } from "lucide-react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { api } from "../lib/api.ts";
import { saveDraft } from "../lib/draft.ts";
import { cn } from "../lib/utils.ts";

/**
 * WYSIWYG markdown comment editor shared by the new-comment, reply, and
 * edit forms. Built on TipTap (ProseMirror) + tiptap-markdown:
 * - Formatting renders inline as you type — `**bold**`, `# heading`,
 *   `- list`, `> quote`, ``` fences, etc. all apply live via markdown
 *   input rules. There is no separate preview.
 * - The document round-trips to/from markdown, so `value` (what we
 *   store and what the CLI/agent read) is always plain markdown.
 * - Image attachments: paste from clipboard, drag-and-drop, or the
 *   attach button. Each upload inserts an inline image node pointing at
 *   `/attachments/…`.
 * - Draft autosave: every change is written to localStorage under
 *   `draftKey`. The parent clears the draft on successful submit.
 */
export function MarkdownEditor({
  value,
  onChange,
  draftKey,
  placeholder,
  autoFocus,
  onSubmit,
  className,
  minHeightClass = "min-h-[80px]",
  actions,
}: {
  value: string;
  onChange: (v: string) => void;
  draftKey: string;
  placeholder?: string;
  autoFocus?: boolean;
  onSubmit?: () => void;
  className?: string;
  minHeightClass?: string;
  /** Submit/cancel buttons rendered in the footer, to the right of the
   * attach-image control. */
  actions?: ReactNode;
}) {
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Keep the latest onSubmit in a ref so the editor's keymap (created
  // once) always calls the current handler.
  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;

  const editor = useEditor({
    extensions: [
      // Disable auto-linking: StarterKit bundles the Link extension whose
      // `autolink` (and tiptap-markdown's `linkify`) use linkifyjs, which
      // treats things like `scripts/test-desktop-e2e.sh` as a URL because
      // `.sh` is a TLD. Explicit markdown links still work, and genuine
      // http(s) URLs still render as links in the posted comment via
      // remark-gfm.
      StarterKit.configure({ link: { autolink: false, openOnClick: false } }),
      Image.configure({ inline: false, allowBase64: false }),
      Placeholder.configure({ placeholder: placeholder ?? "" }),
      Markdown.configure({ html: false, linkify: false, transformPastedText: true }),
    ],
    // tiptap-markdown parses a string `content` as markdown.
    content: value,
    autofocus: autoFocus ? "end" : false,
    editorProps: {
      attributes: {
        class: cn("staff-md focus:outline-none px-3 py-2", minHeightClass),
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": placeholder ?? "Comment editor",
        "data-testid": "comment-editor",
      },
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          submitRef.current?.();
          return true;
        }
        return false;
      },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (files.some((f) => f.type.startsWith("image/"))) {
          event.preventDefault();
          void uploadFiles(files);
          return true;
        }
        return false;
      },
      handleDrop: (_view, event) => {
        const files = Array.from((event as DragEvent).dataTransfer?.files ?? []);
        if (files.some((f) => f.type.startsWith("image/"))) {
          event.preventDefault();
          setDragging(false);
          void uploadFiles(files);
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor }) => {
      const md = (editor as Editor).storage.markdown.getMarkdown() as string;
      onChange(md);
    },
  });

  // Persist the draft on every change.
  useEffect(() => {
    saveDraft(draftKey, value);
  }, [draftKey, value]);

  async function uploadFiles(files: File[]) {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0 || !editor) return;
    setUploading(true);
    try {
      for (const file of images) {
        try {
          const { url, name } = await api.uploadAttachment(file);
          editor
            .chain()
            .focus()
            .setImage({ src: url, alt: file.name || name })
            .run();
        } catch (e) {
          editor
            .chain()
            .focus()
            .insertContent(`\n*(upload failed: ${(e as Error).message})*\n`)
            .run();
        }
      }
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className={className}>
      <div
        className="relative rounded-md border border-input bg-background"
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer?.items ?? []).some((i) => i.kind === "file")) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false);
        }}
      >
        <EditorContent editor={editor} />

        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md border-2 border-dashed border-ring bg-background/80 text-xs font-medium text-muted-foreground">
            Drop image to attach
          </div>
        )}
      </div>

      {/* Footer: the attach control lives here (out of the text area, so it
          can't overlap the comment text), with submit/cancel on the right. */}
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          data-testid="md-attach"
          title="Attach image"
          aria-label="Attach image"
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            void uploadFiles(files);
            e.target.value = "";
          }}
        />
        <div className="flex-1" />
        {actions}
      </div>
    </div>
  );
}
