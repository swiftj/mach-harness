import type { ReactNode } from "react";
import { CircleCheck, CircleDashed, CircleDot, CircleMinus, PenLine, ShieldCheck, TriangleAlert } from "lucide-react";
import { Banner, StatusPill, cn, type Tone } from "@mach/ui";
import type { DesignSummary, DesignTopicState } from "@mach/ui/api";
import { QuotedLines } from "../../../shared/QuotedLines";
import type { Quotation } from "../../../shared/lineRanges";
import { designStage, stageWord, topicStateWords, type DesignStage } from "./model";

/** Said once on each page: what a brought-in design is to MACH, and where its text goes. */
export function DesignDataNotice({ className }: { className?: string }) {
  return (
    <div className={cn("flex max-w-reading items-start gap-3 rounded-md border border-line bg-surface px-4 py-3", className)}>
      <ShieldCheck aria-hidden="true" className="mt-0.5 size-[18px] shrink-0 text-ink-subtle" />
      <p className="text-body-sm text-ink">
        A design is read as information, never as instructions: nothing written in it is followed, and it decides nothing by itself. Its text stays in your workspace
        and is never sent to GitHub.
      </p>
    </div>
  );
}

const stageLook: Record<DesignStage, { tone: Tone; icon: ReactNode; className?: string }> = {
  "changed-copy": { tone: "danger", icon: <TriangleAlert aria-hidden="true" />, className: "border-2" },
  "not-read": { tone: "neutral", icon: <CircleDashed aria-hidden="true" />, className: "border-dashed" },
  conflicts: { tone: "warning", icon: <CircleDot aria-hidden="true" />, className: "border-dashed" },
  ready: { tone: "info", icon: <CircleMinus aria-hidden="true" /> },
  published: { tone: "success", icon: <CircleCheck aria-hidden="true" /> },
  changed: { tone: "warning", icon: <PenLine aria-hidden="true" />, className: "border-2" },
};

/** Where a design stands, as a word, a shape and a tone. */
export function StagePill({ design, size = "md" }: { design: DesignSummary; size?: "sm" | "md" }) {
  const look = stageLook[designStage(design)];
  return (
    <StatusPill tone={look.tone} icon={look.icon} size={size} className={look.className}>
      {stageWord(design)}
    </StatusPill>
  );
}

const topicLook: Record<DesignTopicState, { tone: Tone; icon: ReactNode; className?: string }> = {
  decided: { tone: "success", icon: <CircleCheck aria-hidden="true" /> },
  partly: { tone: "warning", icon: <CircleDot aria-hidden="true" />, className: "border-dashed" },
  silent: { tone: "neutral", icon: <CircleDashed aria-hidden="true" />, className: "border-dashed" },
};

/** What the document says of one topic, as a word, a shape and a tone. */
export function TopicPill({ state }: { state: DesignTopicState }) {
  const look = topicLook[state];
  return (
    <StatusPill tone={look.tone} icon={look.icon} size="sm" className={look.className}>
      {topicStateWords[state]}
    </StatusPill>
  );
}

/** Lines of the design, quoted as data: plain text with their numbers, never markup. */
export function DesignQuote({ designId, quotations, className }: { designId: string; quotations: Quotation[]; className?: string }) {
  return (
    <QuotedLines
      of={designId}
      asWritten="as written in the design"
      unreadNote={(n) => `${n === 1 ? "1 line of this range was" : `${n} lines of this range were`} past what this page read.`}
      quotations={quotations}
      className={className}
    />
  );
}

export const WRITING_NOTE_ID = "design-acts-wait";

/** While the needs conversation writes, the acts here wait: the host would answer that it is busy. */
export function WritingNotice() {
  return (
    <Banner tone="info" title="The conversation on Technical needs is writing">
      <span id={WRITING_NOTE_ID}>Bringing in, settling and publishing wait until it finishes its reply. You can keep reading.</span>
    </Banner>
  );
}
