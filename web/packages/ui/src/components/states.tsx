import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { Spinner } from "./spinner";
import { HintAction } from "./hint";
import type { ApiErrorHint } from "../api/errors";

export interface EmptyStateProps {
  /** What would be here, in plain words: "No slices yet". */
  title: ReactNode;
  /** What to do about it, one sentence. */
  description?: ReactNode;
  /** The one action that fills the space. */
  action?: ReactNode;
  /** A 20px Lucide icon that names the kind of thing, not decoration. */
  icon?: ReactNode;
  className?: string;
  /** "inline" sits inside a panel; "page" centres in the content area. */
  layout?: "inline" | "page";
  /** Heading level of the title. Use 1 when the empty state is the whole page. Default 2. */
  headingLevel?: 1 | 2 | 3;
}

/** An empty space is an invitation to act: say what belongs here and offer the action. */
export function EmptyState({ title, description, action, icon, className, layout = "inline", headingLevel = 2 }: EmptyStateProps) {
  const Title = `h${headingLevel}` as const;
  return (
    <div
      className={cn(
        "flex flex-col items-start gap-3 rounded-md border border-dashed border-line-strong px-6 py-6",
        layout === "page" && "mx-auto my-16 max-w-md items-center border-none text-center",
        className,
      )}
    >
      {icon ? <span className="text-ink-subtle [&_svg]:size-5" aria-hidden="true">{icon}</span> : null}
      <div className="flex flex-col gap-1">
        <Title className="font-display text-title-2 text-ink">{title}</Title>
        {description ? <p className="max-w-reading text-body text-ink-muted">{description}</p> : null}
      </div>
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}

export interface ErrorStateProps {
  /** A refusal's hint: the action that would resolve it, rendered by the app's HintProvider. */
  hint?: ApiErrorHint | null;
  /** What went wrong, specifically. */
  title: ReactNode;
  /** The engine's or host's message, shown as is. */
  message?: ReactNode;
  /** What the person can do: "Try again", "Reload". */
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}

/** A region that could not load or an operation that failed outright. Announced to screen readers. */
export function ErrorState({ title, message, action, icon, className, hint }: ErrorStateProps) {
  return (
    <div role="alert" className={cn("flex flex-col items-start gap-3 rounded-md border border-danger-line bg-danger-soft px-6 py-5", className)}>
      <div className="flex items-start gap-3">
        {icon ? <span className="mt-0.5 text-danger-ink [&_svg]:size-5" aria-hidden="true">{icon}</span> : null}
        <div className="flex flex-col gap-1">
          <p className="text-title-3 font-semibold text-danger-ink">{title}</p>
          {message ? <p className="whitespace-pre-line text-body text-ink">{message}</p> : null}
        </div>
      </div>
      {action || hint ? (
        <div className={cn("flex flex-wrap items-center gap-2", icon && "pl-8")}>
          <HintAction hint={hint} />
          {action}
        </div>
      ) : null}
    </div>
  );
}

export interface LoadingStateProps {
  /** What is loading, as a sentence: "Reading your workspace". */
  label: string;
  className?: string;
}

/** A short wait with words. For a layout-shaped wait, use Skeleton instead. */
export function LoadingState({ label, className }: LoadingStateProps) {
  return (
    <div role="status" aria-live="polite" className={cn("flex items-center gap-2.5 py-6 text-body text-ink-muted", className)}>
      <Spinner />
      <span>{label}</span>
    </div>
  );
}
