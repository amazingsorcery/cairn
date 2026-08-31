import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * Markdown renderer for playbook bodies, tool descriptions and user notes.
 *
 * react-markdown builds a React tree rather than injecting HTML, so raw HTML in the
 * source is inert by default — we never enable `rehype-raw`. That matters because note
 * bodies are user input, and because catalogue copy is edited through an admin form.
 *
 * External links are rendered with rel="noopener noreferrer nofollow ugc" and are marked
 * for screen readers, so a user always knows when a link leaves the site.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div
      className={cn(
        "text-sm leading-relaxed text-foreground",
        "[&>*+*]:mt-4",
        "[&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:tracking-tight",
        "[&_h3]:mt-6 [&_h3]:text-base [&_h3]:font-semibold",
        "[&_p]:text-foreground/90",
        "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5",
        "[&_li]:mt-1.5",
        "[&_a]:font-medium [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4",
        "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-xs",
        "[&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border",
        "[&_pre]:bg-muted [&_pre]:p-4 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
        "[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4",
        "[&_blockquote]:text-muted-foreground",
        "[&_table]:w-full [&_table]:text-left [&_th]:border-b [&_th]:border-border [&_th]:py-2",
        "[&_td]:border-b [&_td]:border-border [&_td]:py-2 [&_td]:pr-4",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children: linkChildren, ...props }) {
            const isExternal = Boolean(href && /^https?:\/\//i.test(href));
            if (!isExternal) {
              return (
                <a href={href} {...props}>
                  {linkChildren}
                </a>
              );
            }
            return (
              <a href={href} target="_blank" rel="noopener noreferrer nofollow ugc" {...props}>
                {linkChildren}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            );
          },
          // Markdown bodies live inside a page that already has an h1; demote so the
          // document outline stays legal.
          h1({ children: headingChildren, ...props }) {
            return <h2 {...props}>{headingChildren}</h2>;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
