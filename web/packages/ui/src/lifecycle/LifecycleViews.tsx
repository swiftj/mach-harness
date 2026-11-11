import { Check } from "lucide-react";
import { Fragment } from "react";
import type { ArtifactSource, EpicStatus, SliceStatus, WaveReviewStatus, WaveStatus } from "../api/types";
import { Badge, StatusPill } from "../components/badge";
import { toneClasses } from "../components/tone";
import { cn } from "../lib/cn";
import { StateGlyph } from "./glyph";
import { epicStates, reviewDescriptor, sliceLifecycle, sliceStates, sourceStates, waveJourney, waveStates } from "./states";

export function SliceStatusPill({ status, size }: { status: SliceStatus; size?: "sm" | "md" }) {
  const d = sliceStates[status];
  return (
    <StatusPill tone={d.tone} size={size} icon={<StateGlyph shape={d.glyph} />} title={d.description}>
      {d.label}
    </StatusPill>
  );
}

export function EpicStatusPill({ status, size }: { status: EpicStatus; size?: "sm" | "md" }) {
  const d = epicStates[status];
  return (
    <StatusPill tone={d.tone} size={size} icon={<StateGlyph shape={d.glyph} />} title={d.description}>
      {d.label}
    </StatusPill>
  );
}

export function WaveStatusPill({ status, size }: { status: WaveStatus; size?: "sm" | "md" }) {
  const d = waveStates[status];
  return (
    <StatusPill tone={d.tone} size={size} icon={<StateGlyph shape={d.glyph} />} title={d.description}>
      {d.label}
    </StatusPill>
  );
}

export function ReviewStatusPill({ status, size }: { status: WaveReviewStatus; size?: "sm" | "md" }) {
  const d = reviewDescriptor(status);
  return (
    <StatusPill tone={d.tone} size={size} icon={<StateGlyph shape={d.glyph} />} title={d.description}>
      {d.label}
    </StatusPill>
  );
}

/** Where an artifact stands against the shared project. Hidden for plain drafts unless `showDraft`. */
export function SourceBadge({ source, showDraft = false }: { source: ArtifactSource; showDraft?: boolean }) {
  if (source === "draft" && !showDraft) return null;
  const d = sourceStates[source];
  return (
    <Badge tone={d.tone} outline={source === "draft" || source === "published"} title={d.description}>
      {d.label}
    </Badge>
  );
}

export interface SliceLifecycleProps {
  status: SliceStatus;
  /** From status (a count) or the check (a list's length). Shown on the interviewing step. */
  openQuestions?: number;
  className?: string;
}

/**
 * Where a slice is on its path: draft, interviewing, ready for approval, approved. Past steps are
 * ticked, the current step is marked and announced (aria-current="step"), later steps are quiet.
 * A superseded slice shows the path greyed with a note.
 */
export function SliceLifecycle({ status, openQuestions, className }: SliceLifecycleProps) {
  const superseded = status === "superseded";
  const current = superseded ? -1 : sliceLifecycle.indexOf(status);
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <ol className={cn("flex items-center", superseded && "opacity-60")} aria-label="Slice progress">
        {sliceLifecycle.map((step, index) => {
          const d = sliceStates[step];
          const done = index < current;
          const here = index === current;
          const t = toneClasses[d.tone];
          return (
            <Fragment key={step}>
              {index > 0 ? (
                <li aria-hidden="true" className={cn("mx-2 h-px min-w-6 flex-1", index <= current ? "bg-ink-subtle" : "bg-line-strong")} />
              ) : null}
              <li aria-current={here ? "step" : undefined} className="flex shrink-0 items-center gap-1.5">
                <span
                  className={cn(
                    "inline-flex size-5 items-center justify-center rounded-full",
                    here && cn(t.soft, t.ink, "ring-1 ring-current"),
                    done && "text-ink-muted",
                    !here && !done && "text-ink-subtle",
                  )}
                >
                  {done ? <Check aria-hidden="true" className="size-3.5" strokeWidth={2.5} /> : <StateGlyph shape={d.glyph} size={12} />}
                </span>
                <span className={cn("text-body-sm", here ? "font-semibold text-ink" : done ? "text-ink-muted" : "text-ink-subtle")}>
                  {d.label}
                  {here && step === "interviewing" && openQuestions ? (
                    <span className="ml-1.5 font-normal text-ink-muted">
                      ({openQuestions} open {openQuestions === 1 ? "question" : "questions"})
                    </span>
                  ) : null}
                  <span className="sr-only">{done ? ", done" : here ? ", current step" : ", not reached"}</span>
                </span>
              </li>
            </Fragment>
          );
        })}
      </ol>
      {superseded ? (
        <p className="flex items-center gap-1.5 text-body-sm text-ink-muted">
          <StateGlyph shape="superseded" /> {sliceStates.superseded.description}
        </p>
      ) : null}
    </div>
  );
}

export interface WaveJourneyProps {
  status: WaveReviewStatus;
  /** The engine's own explanation (`meaning` from feedback). Falls back to the descriptor's. */
  meaning?: string;
  className?: string;
}

/**
 * A sent wave's way through review: approved, sent, in review, accepted. The review state sits on
 * its stage with its own tone and glyph; states that need the PM are flagged in words.
 */
export function WaveJourney({ status, meaning, className }: WaveJourneyProps) {
  const d = reviewDescriptor(status);
  const t = toneClasses[d.tone];
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <ol className="grid grid-cols-4 gap-2" aria-label="Review progress">
        {waveJourney.map((stage, index) => {
          const done = index < d.stage || (index === d.stage && d.final && status === "Accepted");
          const here = index === d.stage;
          return (
            <li key={stage} aria-current={here ? "step" : undefined} className="flex flex-col gap-1.5">
              <span
                aria-hidden="true"
                className={cn("h-1 rounded-full", here ? t.fill : done ? "bg-ink-subtle" : "bg-line-strong")}
              />
              <span className={cn("text-caption", here ? cn("font-semibold", t.ink) : done ? "text-ink-muted" : "text-ink-subtle")}>
                {stage}
                <span className="sr-only">{done && !here ? ", done" : here ? `, now: ${d.label}` : ", not reached"}</span>
              </span>
            </li>
          );
        })}
      </ol>
      <div className="flex items-start gap-3">
        <ReviewStatusPill status={status} />
        <p className="pt-0.5 text-body-sm text-ink-muted">
          {meaning ?? d.description}
          {d.attention ? <span className="font-semibold text-ink"> Needs you.</span> : null}
        </p>
      </div>
    </div>
  );
}
