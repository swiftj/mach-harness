import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";
import { toneClasses, type Tone } from "./tone";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  /** Outline instead of a filled tint: for secondary facts such as "draft" or a risk tier. */
  outline?: boolean;
}

/** A small rectangular tag for a fact: a count, a risk tier, where an artifact came from. */
export function Badge({ tone = "neutral", outline = false, className, ...props }: BadgeProps) {
  const t = toneClasses[tone];
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-xs border px-1.5 text-caption font-semibold tabular",
        t.ink,
        outline ? cn("bg-transparent", t.line) : cn(t.soft, "border-transparent"),
        className,
      )}
      {...props}
    />
  );
}

export interface StatusPillProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  /** A shape that carries the state without colour (a StateGlyph or a Lucide icon at 14px). */
  icon?: ReactNode;
  children: ReactNode;
  size?: "sm" | "md";
}

/**
 * The state of something, in words, with a shape. Never colour alone: the label is always visible,
 * and the icon differs per state so the pill reads in greyscale and for colour-blind people.
 */
export function StatusPill({ tone = "neutral", icon, size = "md", className, children, ...props }: StatusPillProps) {
  const t = toneClasses[tone];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border font-semibold",
        size === "md" ? "h-6 pl-2 pr-2.5 text-caption" : "h-5 pl-1.5 pr-2 text-caption",
        t.soft,
        t.ink,
        t.line,
        "[&_svg]:size-3.5 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </span>
  );
}
