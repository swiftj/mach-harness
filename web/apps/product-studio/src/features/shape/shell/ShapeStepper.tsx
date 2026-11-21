import { Fragment } from "react";
import { Link } from "react-router";
import { Check } from "lucide-react";
import { cn } from "@mach/ui";
import type { IdeaRow } from "@mach/ui/api";
import { ideaPath, shapeHome, shapeSteps, stepCaption, stepForNext, type ShapeStep } from "./steps";

/**
 * Shape's six steps as one idea's navigation (style guide 7.10, Stepper): numbered 24px circles joined by 1px
 * connectors, each a link to that step's page. The page you are on is the current step (`aria-current="step"`,
 * accent). The step that holds the engine's next step for this idea is named "Next" in words; the steps before it are
 * shown done. Nothing here decides anything: the next step is the engine's (`row.next`), each caption a reported field.
 * Shell-owned: screens render it through IdeaStepFrame and never change it.
 */
export function ShapeStepper({ row, here, ideasOnBoard }: { row: IdeaRow; here: ShapeStep; ideasOnBoard: number }) {
  const next = stepForNext(row.next.kind, row.stage);
  const nextIndex = shapeSteps.findIndex((s) => s.step === next);
  return (
    <nav aria-label={`Shape steps for ${row.idea_id}`} className="min-w-0">
      <ol className="flex items-start">
        {shapeSteps.map(({ step, name }, index) => {
          const current = step === here;
          const done = index < nextIndex && row.next.kind !== "none";
          const isNext = step === next && row.next.kind !== "none";
          const caption = stepCaption(step, row, ideasOnBoard);
          return (
            <Fragment key={step}>
              {index > 0 ? <li aria-hidden="true" className={cn("mt-[22px] h-px min-w-8 flex-1", index <= nextIndex ? "bg-ink-subtle" : "bg-line-strong")} /> : null}
              <li className="flex min-w-0 shrink-0 basis-28 justify-center">
                <Link
                  to={step === "ideas" ? shapeHome : ideaPath(row.idea_id, step)}
                  aria-current={current ? "step" : undefined}
                  className="group flex w-full flex-col items-center gap-1.5 rounded-sm px-1 py-2.5 text-center hover:bg-surface-sunken"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "inline-flex size-6 items-center justify-center rounded-full border text-caption font-semibold tabular",
                      current && "border-accent bg-accent-soft text-accent-ink",
                      !current && done && "border-line-strong bg-surface-sunken text-ink-muted",
                      !current && !done && "border-line-strong text-ink-subtle",
                    )}
                  >
                    {done && !current ? <Check className="size-3.5" strokeWidth={2.5} /> : index + 1}
                  </span>
                  <span className={cn("text-body-sm", current ? "font-semibold text-ink" : "text-ink-muted")}>{name}</span>
                  {caption ? <span className="text-caption text-ink-subtle">{caption}</span> : null}
                  {isNext ? <span className="text-caption font-semibold text-accent-ink">Next</span> : null}
                  <span className="sr-only">{current ? ", this page" : ""}{isNext ? ", the next step" : done ? ", done" : ""}</span>
                </Link>
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
