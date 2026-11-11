import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check, Minus } from "lucide-react";
import { forwardRef, useId, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { cn } from "../lib/cn";

export interface CheckboxProps extends ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root> {
  /** Visible label. When omitted, pass aria-label. */
  label?: ReactNode;
  description?: ReactNode;
}

export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(function Checkbox(
  { label, description, className, id, ...props },
  ref,
) {
  const auto = useId();
  const controlId = id ?? auto;
  const descriptionId = description ? `${controlId}-description` : undefined;
  const box = (
    <CheckboxPrimitive.Root
      ref={ref}
      id={controlId}
      aria-describedby={descriptionId}
      className={cn(
        "peer mt-0.5 inline-flex size-[18px] shrink-0 items-center justify-center rounded-xs border border-line-control bg-surface",
        "data-[state=checked]:border-accent-fill data-[state=checked]:bg-accent-fill data-[state=checked]:text-ink-on-accent",
        "data-[state=indeterminate]:border-accent-fill data-[state=indeterminate]:bg-accent-fill data-[state=indeterminate]:text-ink-on-accent",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator>
        {props.checked === "indeterminate" ? (
          <Minus aria-hidden="true" className="size-3.5" strokeWidth={3} />
        ) : (
          <Check aria-hidden="true" className="size-3.5" strokeWidth={3} />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
  if (!label) return box;
  return (
    <div className="flex items-start gap-2.5">
      {box}
      <div className="flex flex-col">
        <label htmlFor={controlId} className="text-body text-ink peer-disabled:opacity-50">
          {label}
        </label>
        {description ? (
          <span id={descriptionId} className="text-body-sm text-ink-muted">
            {description}
          </span>
        ) : null}
      </div>
    </div>
  );
});
