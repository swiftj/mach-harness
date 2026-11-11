import { cn } from "../lib/cn";

export interface SpinnerProps {
  size?: "sm" | "md";
  /** Read by screen readers. Leave empty when a visible label already says what is happening. */
  label?: string;
  className?: string;
}

/** An indeterminate activity mark. Under reduced motion it stops rotating and stays visible. */
export function Spinner({ size = "md", label, className }: SpinnerProps) {
  const px = size === "sm" ? 14 : 18;
  return (
    <span role={label ? "status" : undefined} className={cn("inline-flex", className)}>
      <svg
        width={px}
        height={px}
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        className="animate-spin motion-reduce:animate-none"
      >
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
        <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}
