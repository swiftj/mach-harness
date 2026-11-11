import { cn } from "../lib/cn";

/**
 * The shape vocabulary for state. Every lifecycle and graph state has a glyph that differs in
 * shape, not only colour, so state reads in greyscale, for colour-blind people and in print.
 *
 *   open (dashed ring)      proposed, draft: nothing settled yet
 *   half (half-filled)      interviewing: being worked out
 *   ready (ring with dot)   ready for approval: settled, waiting for a person
 *   approved (solid, tick)  approved by a person
 *   submitted (solid, arrow) sent to engineering, under review
 *   accepted (double ring)  accepted into the shared project
 *   blocked (octagon, bar)  cannot move until something is fixed
 *   superseded (ring, slash) replaced; kept for history
 */
export type GlyphShape = "open" | "half" | "ready" | "approved" | "submitted" | "accepted" | "blocked" | "superseded";

export interface StateGlyphProps {
  shape: GlyphShape;
  size?: number;
  className?: string;
  /** Glyphs are decorative next to a visible label; give a title only when they stand alone. */
  title?: string;
}

export function StateGlyph({ shape, size = 14, className, title }: StateGlyphProps) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    className: cn("shrink-0", className),
    role: title ? "img" : undefined,
    "aria-hidden": title ? undefined : true,
    "aria-label": title,
  } as const;
  switch (shape) {
    case "open":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2.6 2.1" />
        </svg>
      );
    case "half":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.6" />
          <path d="M8 2a6 6 0 0 0 0 12z" fill="currentColor" />
        </svg>
      );
    case "ready":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="8" cy="8" r="2.4" fill="currentColor" />
        </svg>
      );
    case "approved":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path d="M4.9 8.2l2.1 2.1 4.1-4.4" stroke="var(--mach-surface)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "submitted":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path d="M5 8h5.5M8.4 5.4L11 8l-2.6 2.6" stroke="var(--mach-surface)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "accepted":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.6" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="8" cy="8" r="4.2" fill="currentColor" />
        </svg>
      );
    case "blocked":
      return (
        <svg {...common}>
          <path d="M5.4 1.5h5.2l3.9 3.9v5.2l-3.9 3.9H5.4l-3.9-3.9V5.4z" fill="currentColor" />
          <path d="M5 8h6" stroke="var(--mach-surface)" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case "superseded":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.6" />
          <path d="M3.8 12.2l8.4-8.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
  }
}
