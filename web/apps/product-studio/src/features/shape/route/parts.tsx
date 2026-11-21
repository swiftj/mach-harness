import type { ReactNode } from "react";
import { CircleCheck, CircleDashed, CircleDot } from "lucide-react";
import { StatusPill, type Tone } from "@mach/ui";
import { QuotedLines } from "../../../shared/QuotedLines";
import type { Quotation } from "./model";

/** Lines of the brief, quoted as data: the shared quotation (shared/QuotedLines.tsx) with the brief's words. */
export function BriefQuote({ ideaId, quotations, className }: { ideaId: string; quotations: Quotation[]; className?: string }) {
  return (
    <QuotedLines
      of={`The brief of ${ideaId}`}
      asWritten="as written"
      unreadNote={(n) => `${n === 1 ? "1 line of this range is" : `${n} lines of this range are`} past the end of the brief as it is now.`}
      quotations={quotations}
      className={className}
    />
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
