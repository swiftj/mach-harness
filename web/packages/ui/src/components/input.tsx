import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "../lib/cn";
import { fieldControlProps, useField } from "./field";

export const controlClass = cn(
  "w-full rounded-sm border border-line-control bg-surface text-ink placeholder:text-ink-subtle",
  "transition-[border-color,box-shadow] duration-[var(--mach-duration-fast)]",
  "hover:border-ink-subtle",
  "focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus focus-visible:border-focus",
  "aria-[invalid=true]:border-danger-ink",
  "disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-ink-subtle",
  "read-only:bg-surface-sunken",
);

export type InputProps = InputHTMLAttributes<HTMLInputElement> & { size?: "sm" | "md" | "lg" };

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, size = "md", ...props }, ref) {
  const field = useField();
  return (
    <input
      ref={ref}
      className={cn(
        controlClass,
        size === "sm" && "h-control-sm px-2 text-body-sm",
        size === "md" && "h-control-md px-3 text-body",
        size === "lg" && "h-control-lg px-3.5 text-body",
        className,
      )}
      {...props}
      {...fieldControlProps(field, props)}
    />
  );
});

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  /** Long-form product writing (a vision, a why) reads at the larger reading size. */
  editorial?: boolean;
};

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, editorial = false, rows = 4, ...props },
  ref,
) {
  const field = useField();
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(
        controlClass,
        "min-h-20 resize-y px-3 py-2",
        editorial ? "text-body-lg" : "text-body",
        className,
      )}
      {...props}
      {...fieldControlProps(field, props)}
    />
  );
});
