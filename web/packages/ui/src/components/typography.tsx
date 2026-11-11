import { createElement, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/cn";

type HeadingLevel = 1 | 2 | 3 | 4;

export interface HeadingProps extends HTMLAttributes<HTMLHeadingElement> {
  /** The document level, for assistive technology. */
  level: HeadingLevel;
  /** The visual step. Defaults follow the level; change it only to keep the outline correct. */
  size?: "display" | "title-1" | "title-2" | "title-3";
}

const defaultSize: Record<HeadingLevel, NonNullable<HeadingProps["size"]>> = {
  1: "title-1",
  2: "title-2",
  3: "title-3",
  4: "title-3",
};

/**
 * Headings. Display and title steps use the display face (Newsreader in Product Studio,
 * Source Sans in Control Tower); title-3 is always the interface sans.
 */
export function Heading({ level, size, className, ...props }: HeadingProps) {
  const step = size ?? defaultSize[level];
  return createElement(`h${level}`, {
    className: cn(
      "text-ink text-balance",
      step === "display" && "font-display text-display font-[450]",
      step === "title-1" && "font-display text-title-1 font-[450]",
      step === "title-2" && "font-display text-title-2 font-medium",
      step === "title-3" && "font-sans text-title-3 font-semibold",
      className,
    ),
    ...props,
  });
}

export interface TextProps extends HTMLAttributes<HTMLElement> {
  as?: "p" | "span" | "div" | "dd" | "dt" | "li";
  size?: "body-lg" | "body" | "body-sm" | "caption";
  tone?: "default" | "muted" | "subtle" | "accent" | "danger" | "success" | "warning" | "info";
  /** Reading text: the serif, for product writing such as a vision or a why. */
  editorial?: boolean;
  weight?: "regular" | "semibold";
}

export function Text({
  as = "p",
  size = "body",
  tone = "default",
  editorial = false,
  weight = "regular",
  className,
  ...props
}: TextProps) {
  return createElement(as, {
    className: cn(
      editorial ? "font-serif" : "font-sans",
      size === "body-lg" && "text-body-lg",
      size === "body" && "text-body",
      size === "body-sm" && "text-body-sm",
      size === "caption" && "text-caption",
      tone === "default" && "text-ink",
      tone === "muted" && "text-ink-muted",
      tone === "subtle" && "text-ink-subtle",
      tone === "accent" && "text-accent-ink",
      tone === "danger" && "text-danger-ink",
      tone === "success" && "text-success-ink",
      tone === "warning" && "text-warning-ink",
      tone === "info" && "text-info-ink",
      weight === "semibold" && "font-semibold",
      className,
    ),
    ...props,
  });
}

/** Long-form reading: a slice's why, a spec section. Serif, a reading measure, generous leading. */
export function Prose({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "max-w-reading font-serif text-body-lg text-ink [&_p+p]:mt-4 [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_li+li]:mt-1",
        className,
      )}
      {...props}
    />
  );
}

export interface ArtifactIdProps extends HTMLAttributes<HTMLSpanElement> {
  /** An engine ID: SLICE-001, EPIC-001, WAVE-002, FR-01, INV-03. */
  children: ReactNode;
  /** Quiet: no background, for use inside dense rows. */
  plain?: boolean;
}

/** An identifier the engine owns. Mono, tabular, never translated or reformatted. */
export function ArtifactId({ plain = false, className, ...props }: ArtifactIdProps) {
  return (
    <span
      translate="no"
      className={cn(
        "inline-flex items-center whitespace-nowrap font-mono text-mono text-ink-muted tabular",
        !plain && "rounded-xs bg-surface-sunken px-1.5 py-px",
        className,
      )}
      {...props}
    />
  );
}

/** A keyboard key. */
export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-xs border border-line-strong bg-surface px-1 font-mono text-caption text-ink-muted",
        className,
      )}
      {...props}
    />
  );
}

export interface QuoteProps extends HTMLAttributes<HTMLElement> {
  /** Who said it: a reviewer's login, another product manager. */
  from: ReactNode;
  /** What kind of remark, in plain words ("asked for changes", "commented"). */
  kind?: ReactNode;
}

/**
 * Words written by someone else (reviewer remarks, another PM's text). Shown as a quotation with
 * attribution, never as an instruction or an action. The engine marks such text as data.
 */
export function Quote({ from, kind, className, children, ...props }: QuoteProps) {
  return (
    <figure className={cn("border-l-2 border-line-strong pl-4", className)} {...props}>
      <blockquote className="font-serif text-body-lg italic text-ink">{children}</blockquote>
      <figcaption className="mt-1 text-body-sm text-ink-muted">
        <span className="font-semibold text-ink">{from}</span>
        {kind ? <span> {kind}</span> : null}
      </figcaption>
    </figure>
  );
}
