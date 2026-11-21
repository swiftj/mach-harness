import { CircleAlert } from "lucide-react";
import { useId, type ReactNode, type Ref } from "react";
import { cn } from "../lib/cn";

export interface RadioOption<V extends string> {
  value: V;
  /** The choice's word. */
  label: ReactNode;
  /** What it means, on a second line (cards only). */
  description?: ReactNode;
  /** A state glyph or icon before the word (chips only). */
  icon?: ReactNode;
}

export interface RadioGroupProps<V extends string> {
  /** The question the choices answer; the fieldset's legend. */
  legend: ReactNode;
  /** Text under the legend, before the choices: why the choice matters. */
  hint?: ReactNode;
  options: ReadonlyArray<RadioOption<V>>;
  /** Null until the person chooses: nothing is chosen for them. */
  value: V | null;
  onValueChange: (value: V) => void;
  /**
   * `cards`: each choice a bordered card with its meaning under the word. `chips`: a row of compact choices with a glyph.
   * Every choice looks alike until chosen.
   */
  layout?: "cards" | "chips";
  /** `neutral` (default) marks the chosen one in ink; `accent` in the accent (a setting, not a person's decision). */
  tone?: "neutral" | "accent";
  /** Cards per row from the small breakpoint up (one per row below it). */
  columns?: 1 | 2 | 3;
  /** Shown on the chosen card beside its word ("Chosen"), so the choice reads in words as well as in its border. */
  chosenWord?: string;
  /** A problem with the choice, in words; linked to the group. */
  error?: string;
  /** Another element that describes the group (its id). */
  describedBy?: string;
  /** The first choice's input, to move focus to the group when a problem is found. */
  firstRef?: Ref<HTMLInputElement>;
  className?: string;
}

const columnClass = { 1: "", 2: "sm:grid-cols-2", 3: "sm:grid-cols-3" } as const;

/**
 * One choice from a few, as a `fieldset` with a legend and real radio inputs (style guide 7.5): arrow keys move, the
 * choice is announced, and a problem is said in words under the choices.
 */
export function RadioGroup<V extends string>({
  legend,
  hint,
  options,
  value,
  onValueChange,
  layout = "cards",
  tone = "neutral",
  columns = 2,
  chosenWord,
  error,
  describedBy,
  firstRef,
  className,
}: RadioGroupProps<V>) {
  const name = useId();
  const errorId = useId();
  const described = [error ? errorId : null, describedBy ?? null].filter(Boolean).join(" ") || undefined;
  const focus = "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus";
  return (
    <fieldset className={cn("flex flex-col gap-2", className)} aria-describedby={described}>
      <legend className="pb-1 text-label text-ink">{legend}</legend>
      {hint ? <div className="max-w-reading text-body-sm text-ink-muted">{hint}</div> : null}
      <div className={layout === "chips" ? "flex flex-wrap gap-2 pt-1" : cn("grid gap-3 pt-1", columnClass[columns])}>
        {options.map((option, index) => {
          const chosen = value === option.value;
          const input = (
            <input
              ref={index === 0 ? firstRef : undefined}
              type="radio"
              name={name}
              value={option.value}
              checked={chosen}
              onChange={() => onValueChange(option.value)}
              className={cn(
                "size-4 shrink-0 focus-visible:outline-none",
                tone === "accent" ? "accent-accent-fill" : "accent-ink",
                layout === "cards" && "row-span-2 mt-1",
              )}
            />
          );
          if (layout === "chips") {
            return (
              <label
                key={option.value}
                className={cn(
                  "flex min-h-9 cursor-pointer items-center gap-2 rounded-md border border-line bg-surface px-3 py-1.5 text-body-sm text-ink",
                  "hover:border-line-strong has-[:checked]:border-line-strong has-[:checked]:bg-surface-sunken has-[:checked]:font-semibold",
                  focus,
                )}
              >
                {input}
                {option.icon}
                {option.label}
              </label>
            );
          }
          return (
            <label
              key={option.value}
              className={cn(
                "grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1 rounded-md border bg-surface px-4 py-3",
                tone === "accent"
                  ? "border-line hover:border-line-strong has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
                  : "border-line-control hover:bg-surface-sunken has-[:checked]:border-ink has-[:checked]:ring-1 has-[:checked]:ring-inset has-[:checked]:ring-ink",
                focus,
              )}
            >
              {input}
              <span className="flex items-baseline justify-between gap-2">
                <span className="text-body font-semibold text-ink">{option.label}</span>
                {chosen && chosenWord ? <span className="text-caption font-semibold text-ink">{chosenWord}</span> : null}
              </span>
              {option.description ? <span className="text-body-sm text-ink-muted">{option.description}</span> : null}
            </label>
          );
        })}
      </div>
      {error ? (
        <p id={errorId} className="flex items-start gap-1.5 text-body-sm text-danger-ink">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
    </fieldset>
  );
}
