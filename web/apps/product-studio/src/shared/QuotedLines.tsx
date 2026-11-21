import { cn } from "@mach/ui";
import { rangeWords, type Quotation } from "./lineRanges";

/**
 * Lines of a document someone else wrote (a PRD, an idea's brief), quoted as data: plain text with their numbers, never
 * markup, inside a bordered block captioned with whose document it is and which lines. A long quotation scrolls inside
 * its own region, which keyboard users can reach.
 */
export function QuotedLines({
  of,
  asWritten,
  unreadNote,
  quotations,
  className,
}: {
  /** Whose document, for the caption: "PRD-01", "The brief of IDEA-003". */
  of: string;
  /** How the quotation is named for assistive technology, after the lines: "as written in the document". */
  asWritten: string;
  /** What to say when lines of a range are not shown, given how many. */
  unreadNote: (count: number) => string;
  quotations: Quotation[];
  className?: string;
}) {
  if (!quotations.length) return null;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {quotations.map((q) => (
        <figure key={`${q.range[0]}-${q.range[1]}`} className="flex flex-col gap-1">
          <figcaption className="text-caption text-ink-muted">
            {of}, {rangeWords(q.range)}
          </figcaption>
          {q.lines.length ? (
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            <pre tabIndex={0} aria-label={`${of}, ${rangeWords(q.range)}, ${asWritten}`} className="max-h-64 overflow-auto rounded-sm border-l-2 border-line-strong bg-surface-sunken py-2 pl-3 pr-3 font-sans text-body-sm whitespace-pre-wrap text-ink">
              {q.lines.map((line) => (
                <span key={line.n} className="flex gap-3">
                  <span className="w-7 shrink-0 text-right text-caption leading-6 text-ink-subtle tabular select-none" aria-hidden="true">
                    {line.n}
                  </span>
                  <span className="min-w-0 break-words">{line.text || " "}</span>
                </span>
              ))}
            </pre>
          ) : null}
          {q.unread ? <p className="text-caption text-ink-muted">{unreadNote(q.unread)}</p> : null}
        </figure>
      ))}
    </div>
  );
}
