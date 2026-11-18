import { Check } from "lucide-react";
import { Fragment } from "react";
import type { EpicStatus, SliceGithub, SliceStatus } from "../api/types";
import { StatusPill } from "../components/badge";
import { toneClasses } from "../components/tone";
import { cn } from "../lib/cn";
import { StateGlyph } from "./glyph";
import { builderStates, epicStates, githubMarks, githubMarksOf, sliceLifecycle, sliceStates } from "./states";

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

/**
 * Where a slice is with the builders, and anything about its GitHub issue the PM must know, each
 * as a word and a shape. Shows only what the engine reported in `github`; nothing when it reported nothing.
 */
export function SliceGithubPills({ github, size }: { github: SliceGithub; size?: "sm" | "md" }) {
  const builder = github.state_label ? builderStates[github.state_label] : undefined;
  const marks = githubMarksOf(github).map((mark) => githubMarks[mark]);
  return (
    <>
      {builder ? (
        <StatusPill tone={builder.tone} size={size} icon={<StateGlyph shape={builder.glyph} />} title={builder.description}>
          {builder.label}
        </StatusPill>
      ) : null}
      {marks.map((d) => (
        <StatusPill key={d.label} tone={d.tone} size={size} icon={<StateGlyph shape={d.glyph} />} title={d.description}>
          {d.label}
        </StatusPill>
      ))}
    </>
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
