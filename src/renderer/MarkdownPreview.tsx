import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export default function MarkdownPreview({ text, compact = false }: { text: string; compact?: boolean }) {
  return (
    <div className={`markdown ${compact ? "chat-preview" : ""}`}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Provider content never navigates the app, loads images, or creates
          // active HTML. Markdown structure is rendered as safe React elements.
          a: ({ children, href }) => <span className="markdown-link" title={href}>{children}</span>,
          img: ({ alt }) => <span className="muted">[Image{alt ? `: ${alt}` : ""}]</span>,
        }}
      >{text}</Markdown>
    </div>
  );
}
