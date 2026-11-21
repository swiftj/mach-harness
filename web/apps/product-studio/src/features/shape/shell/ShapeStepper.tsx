import { Fragment } from "react";
import { Link } from "react-router";
import { Check } from "lucide-react";
import { Tooltip, cn } from "@mach/ui";
import type { IdeaRow } from "@mach/ui/api";
import { ideaPath, shapeHome, shapeSteps, stepCaption, stepForNext, type ShapeStep } from "./steps";

/**
 * Shape's six steps as one idea's navigation, drawn as one line for the context row (M16 layout; style guide 7.10,
 * Stepper): six small numbered nodes joined by short connectors, each with its name and each a link to that step's
 * page. The page you are on is the current step (`aria-current="step"`, accent) and shows its status line beside its
 * name; the other steps show theirs on hover or focus, and always to assistive technology. The step that holds the
 * engine's next step for this idea says "Next" in words and has a dashed ring; the steps before it are shown done.
 * Nothing here decides anything: the next step is the engine's (`row.next`), each caption a reported field.
 * Shell-owned: screens render it through IdeaStepFrame and never change it.
 */
export function ShapeStepper({ row, here, ideasOnBoard }: { row: IdeaRow; here: ShapeStep; ideasOnBoard: number }) {
  const next = stepForNext(row.next.kind, row.stage);
  const nextIndex = shapeSteps.findIndex((s) => s.step === next);
  return (
    <nav aria-label={`Shape steps for ${row.idea_id}`} className="min-w-0">
      <ol className="flex flex-wrap items-center gap-y-1">
        {shapeSteps.map(({ step, name }, index) => {
          const current = step === here;
          const done = index < nextIndex && row.next.kind !== "none";
          const isNext = step === next && row.next.kind !== "none";
          const caption = stepCaption(step, row, ideasOnBoard);
          const link = (
            <Link
              to={step === "ideas" ? shapeHome : ideaPath(row.idea_id, step)}
              aria-current={current ? "step" : undefined}
              className="flex min-h-8 items-center gap-1.5 rounded-sm px-1.5 py-1 hover:bg-surface-sunken"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-caption font-semibold tabular",
                  current && "border-accent bg-accent-soft text-accent-ink",
                  !current && done && "border-line-strong bg-surface-sunken text-ink-muted",
                  !current && !done && "border-line-strong text-ink-subtle",
                  !current && isNext && "border-dashed border-accent-ink text-accent-ink",
                )}
              >
                {done && !current ? <Check className="size-3" strokeWidth={2.5} /> : index + 1}
              </span>
              <span className={cn("whitespace-nowrap text-body-sm", current ? "font-semibold text-ink" : "text-ink-muted")}>{name}</span>
              {current && caption ? <span className="whitespace-nowrap text-caption text-ink-subtle">{caption}</span> : null}
              {isNext ? <span className="text-caption font-semibold text-accent-ink">Next</span> : null}
              <span className="sr-only">
                {!current && caption ? `, ${caption}` : ""}
                {current ? ", this page" : ""}
                {isNext ? ", the next step" : done ? ", done" : ""}
              </span>
            </Link>
          );
          return (
            <Fragment key={step}>
              {index > 0 ? <li aria-hidden="true" className={cn("h-px w-4 shrink-0", index <= nextIndex ? "bg-ink-subtle" : "bg-line-strong")} /> : null}
              <li className="flex shrink-0">{!current && caption ? <Tooltip content={caption} side="bottom">{link}</Tooltip> : link}</li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
