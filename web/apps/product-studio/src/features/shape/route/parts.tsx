import type { ReactNode } from "react";
import { CircleCheck, CircleDashed, CircleDot } from "lucide-react";
import { StatusPill, cn, type Tone } from "@mach/ui";
import { rangeWords, type Quotation } from "./model";

/**
 * Lines of the brief, quoted as data: plain text with their numbers, never markup, inside a bordered block labelled as
 * the brief's words. The same treatment as the PRD on-ramp's quotations (features/prd/parts.tsx, PrdQuote), so the two
 * read alike; named for promotion to a shared quotation component.
 */
export function BriefQuote({ ideaId, quotations, className }: { ideaId: string; quotations: Quotation[]; className?: string }) {
  if (!quotations.length) return null;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {quotations.map((q) => (
        <figure key={`${q.range[0]}-${q.range[1]}`} className="flex flex-col gap-1">
          <figcaption className="text-caption text-ink-muted">
            The brief of {ideaId}, {rangeWords(q.range)}
          </figcaption>
          {q.lines.length ? (
            // A long quotation scrolls inside its own region, which keyboard users can reach.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            <pre tabIndex={0} aria-label={`The brief of ${ideaId}, ${rangeWords(q.range)}, as written`} className="max-h-64 overflow-auto rounded-sm border-l-2 border-line-strong bg-surface-sunken py-2 pl-3 pr-3 font-sans text-body-sm whitespace-pre-wrap text-ink">
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
          {q.unread ? <p className="text-caption text-ink-muted">{q.unread === 1 ? "1 line of this range is" : `${q.unread} lines of this range are`} past the end of the brief as it is now.</p> : null}
        </figure>
      ))}
    </div>
  );
}

const coverageLook: Record<string, { tone: Tone; icon: ReactNode; word: string }> = {
  covered: { tone: "success", icon: <CircleCheck aria-hidden="true" />, word: "Carried" },
  settled: { tone: "neutral", icon: <CircleDot aria-hidden="true" />, word: "Settled" },
  not_covered: { tone: "warning", icon: <CircleDashed aria-hidden="true" />, word: "Not carried" },
};

/** An outcome's coverage as a word, a shape and a tone; dashed while it waits for the product manager's word. */
export function CoveragePill({ state }: { state: string }) {
  const look = coverageLook[state] ?? { tone: "neutral" as Tone, icon: <CircleDot aria-hidden="true" />, word: state };
  return (
    <StatusPill tone={look.tone} icon={look.icon} size="sm" className={state === "not_covered" ? "border-dashed" : undefined}>
      {look.word}
    </StatusPill>
  );
}
