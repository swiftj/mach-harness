import { Fragment, type ReactNode } from "react";
import { cn } from "../lib/cn";

/** `**bold**` and `code` inside a line. No HTML is ever interpreted. */
export function inline(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={index} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code key={index} className="rounded-xs bg-surface-sunken px-1 font-mono text-mono">
          {part.slice(1, -1)}
        </code>
      );
    }
    return <Fragment key={index}>{part}</Fragment>;
  });
}

type Block = { type: "p"; lines: string[] } | { type: "ol" | "ul"; items: string[] };

function blocks(text: string): Block[] {
  const out: Block[] = [];
  for (const chunk of text.replace(/\r\n/g, "\n").split(/\n{2,}/)) {
    const lines = chunk.split("\n").filter((line) => line.trim() !== "");
    if (!lines.length) continue;
    if (lines.every((line) => /^\s*\d+[.)]\s/.test(line))) {
      out.push({ type: "ol", items: lines.map((line) => line.replace(/^\s*\d+[.)]\s+/, "")) });
    } else if (lines.every((line) => /^\s*[-*]\s/.test(line))) {
      out.push({ type: "ul", items: lines.map((line) => line.replace(/^\s*[-*]\s+/, "")) });
    } else {
      out.push({ type: "p", lines });
    }
  }
  return out;
}

/**
 * Light Markdown written by the interviewer or the engine: paragraphs, numbered and bulleted lists,
 * bold, code. Rendered as text, never as HTML, so nothing in it can run or style the page.
 */
export function RichText({ text, className, editorial = false }: { text: string; className?: string; editorial?: boolean }) {
  return (
    <div className={cn("flex flex-col gap-3 break-words", editorial ? "text-body-lg" : "text-body", className)}>
      {blocks(text).map((block, index) => {
        if (block.type === "p") {
          return (
            <p key={index}>
              {block.lines.map((line, i) => (
                <Fragment key={i}>
                  {i > 0 ? <br /> : null}
                  {inline(line)}
                </Fragment>
              ))}
            </p>
          );
        }
        const List = block.type;
        return (
          <List key={index} className={cn("flex flex-col gap-1.5 pl-5", block.type === "ol" ? "list-decimal" : "list-disc")}>
            {block.items.map((item, i) => (
              <li key={i}>{inline(item)}</li>
            ))}
          </List>
        );
      })}
    </div>
  );
}
