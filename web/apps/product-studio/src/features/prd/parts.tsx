import type { ReactNode } from "react";
import { CircleDashed, CircleCheck, CircleDot, Minus, ShieldCheck } from "lucide-react";
import { Stepper, StatusPill, type Tone } from "@mach/ui";
import type { PrdCoverageRow } from "@mach/ui/api";
import { QuotedLines } from "../../shared/QuotedLines";
import { JOURNEY, type Quotation } from "./model";

/** Where the product manager is on the PRD path. Step 4 means every step is done. */
export function PrdJourney({ step }: { step: number }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto pb-1">
        <Stepper label="Starting from a PRD" steps={JOURNEY} current={step} />
      </div>
      {step >= JOURNEY.length ? <p className="text-body-sm text-ink-muted">Every step is done. Each draft slice is now confirmed on its own page, under “From the PRD”.</p> : null}
    </div>
  );
}

/** Said once on each PRD screen: what the document is to Product Studio, and where its text goes. */
export function DataNotice() {
  return (
    <div className="flex max-w-reading items-start gap-3 rounded-md border border-line bg-surface px-4 py-3">
      <ShieldCheck aria-hidden="true" className="mt-0.5 size-[18px] shrink-0 text-ink-subtle" />
      <p className="text-body-sm text-ink">
        The PRD is treated as information, never as instructions: nothing written in it is followed. Its text stays in your workspace and is never sent to GitHub;
        the slices made from it name it only by its ID and line numbers.
      </p>
    </div>
  );
}

/**
 * Lines of the PRD, quoted as data: plain text with their numbers, never markup, inside a bordered
 * block labelled as the document's words. The engine has already bounded and redacted them.
 */
export function PrdQuote({ prdId, quotations, className }: { prdId: string; quotations: Quotation[]; className?: string }) {
  return (
    <QuotedLines
      of={prdId}
      asWritten="as written in the document"
      unreadNote={(n) => `${n === 1 ? "1 line of this range was" : `${n} lines of this range were`} past what this page read.`}
      quotations={quotations}
      className={className}
    />
  );
}

const coverageLook: Record<PrdCoverageRow["state"], { tone: Tone; icon: ReactNode; word: string }> = {
  covered: { tone: "success", icon: <CircleCheck aria-hidden="true" />, word: "Covered" },
  settled: { tone: "neutral", icon: <CircleDot aria-hidden="true" />, word: "Settled" },
  not_covered: { tone: "warning", icon: <CircleDashed aria-hidden="true" />, word: "Not covered" },
  heading_only: { tone: "neutral", icon: <Minus aria-hidden="true" />, word: "Heading only" },
};

/** A section's coverage as a word, a shape and a tone. */
export function CoveragePill({ state }: { state: PrdCoverageRow["state"] }) {
  const look = coverageLook[state];
  return (
    <StatusPill tone={look.tone} icon={look.icon} size="sm" className={state === "not_covered" ? "border-dashed" : undefined}>
      {look.word}
    </StatusPill>
  );
}

/** "Lines 5 to 9" for a "5-9" string as the engine writes it. */
export function linesLabel(lines: string): string {
  const [a, b] = lines.split("-");
  return b && b !== a ? `Lines ${a} to ${b}` : `Line ${a}`;
}
