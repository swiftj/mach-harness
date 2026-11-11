/**
 * Small presentation pieces shared by the inbox, waves and shared-project screens.
 * PROMOTION CANDIDATES for @mach/ui: Disclosure, IdText, Stepper, failureText.
 */
import { ChevronRight } from "lucide-react";
import { Fragment, type HTMLAttributes, type ReactNode } from "react";
import { ArtifactId, cn, describeError, type MachApiError } from "@mach/ui";

/**
 * The words for a failed act, for an ErrorState or a ConfirmDialog's `error`. A refusal is the
 * engine's own message, under a title that names what did not happen ("WAVE-001 was not sent").
 */
export function failureText(error: MachApiError, whatDidNotHappen: string): { title: string; message: string } {
  if (error.kind === "refused") return { title: whatDidNotHappen, message: error.message };
  return describeError(error);
}

/** Text from the engine with its IDs (SLICE-001, FR-01) set as identifiers. */
export function IdText({ text }: { text: string }) {
  const parts = text.split(/([A-Z]{2,}-\d{2,})/g);
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <ArtifactId key={index} plain className="text-ink">
            {part}
          </ArtifactId>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}

/**
 * A collapsed section for technical detail an engineer may ask for (a link, a branch name, the
 * shared repository's own message). Closed by default; the only place engineering words appear.
 */
export function Disclosure({ summary, children, className }: { summary: string; children: ReactNode; className?: string }) {
  return (
    <details className={cn("group rounded-md border border-line bg-surface", className)}>
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-4 py-2.5 text-body-sm font-semibold text-ink-muted hover:text-ink [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="size-4 transition-transform duration-[var(--mach-duration-fast)] group-open:rotate-90" />
        {summary}
      </summary>
      <div className="border-t border-line px-4 py-3 text-body-sm text-ink">{children}</div>
    </details>
  );
}

/** Term and value rows for diagnostics. */
export function FactList({ facts }: { facts: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5">
      {facts.map(([term, value]) => (
        <Fragment key={term}>
          <dt className="text-ink-muted">{term}</dt>
          <dd className="min-w-0 break-words text-ink">{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

export interface Step {
  label: string;
}

/** Where a person is in a short guided flow. The current step is announced with aria-current. */
export function Stepper({ steps, current, label }: { steps: Step[]; current: number; label: string }) {
  return (
    <ol aria-label={label} className="flex items-center gap-3">
      {steps.map((step, index) => {
        const done = index < current;
        const here = index === current;
        return (
          <Fragment key={step.label}>
            {index > 0 ? <li aria-hidden="true" className={cn("h-px w-8 shrink-0 sm:w-12", done || here ? "bg-ink-subtle" : "bg-line-strong")} /> : null}
            <li aria-current={here ? "step" : undefined} className="flex shrink-0 items-center gap-2">
              <span
                className={cn(
                  "inline-flex size-6 items-center justify-center rounded-full border text-caption font-semibold tabular",
                  here && "border-accent bg-accent-soft text-accent-ink",
                  done && "border-line-strong bg-surface-sunken text-ink-muted",
                  !here && !done && "border-line-strong text-ink-subtle",
                )}
              >
                {index + 1}
              </span>
              <span className={cn("text-body-sm", here ? "font-semibold text-ink" : done ? "text-ink-muted" : "text-ink-subtle")}>
                {step.label}
                <span className="sr-only">{done ? ", done" : here ? ", current step" : ", not reached"}</span>
              </span>
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}

/** A titled panel. */
export function Panel({ children, className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <section className={cn("rounded-md border border-line bg-surface", className)} {...props}>
      {children}
    </section>
  );
}
