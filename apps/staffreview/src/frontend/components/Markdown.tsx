import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../lib/utils.ts";

/**
 * Renders a comment body as GitHub-flavored markdown. Styling lives in
 * `globals.css` under `.staff-md`. Links open in a new tab; images
 * (including pasted/dropped attachments served from /attachments/…)
 * are constrained to the container width.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("staff-md", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener" />
          ),
          img: ({ node, ...props }) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img {...props} loading="lazy" />
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
