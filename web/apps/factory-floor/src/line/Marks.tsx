/**
 * The Line's marks: one shape per ticket state (never colour alone), the ticket marker on its belt,
 * the passed-station node, and the dashed arc for work sent back. Factory tokens only.
 */
import { cn } from "@mach/ui";
import { STATE_WORDS, type LineState } from "./model";

/** The tone classes of a state: border, soft ground, ink. */
export const STATE_TONE: Readonly<Record<LineState, string>> = {
  working: "border-factory-live bg-factory-live-soft text-factory-live",
  held: "border-dashed border-factory-wait bg-factory-wait-soft text-factory-wait",
  person: "border-factory-human bg-factory-human-soft text-factory-human",
  stopped: "border-factory-fail bg-factory-fail-soft text-factory-fail",
  landed: "border-factory-pass bg-factory-pass-soft text-factory-pass",
  // Finished without a merge: quiet, neither a pass nor a failure.
  closed: "border-line-strong bg-surface-sunken text-ink-muted",
};

/**
 * The state's own glyph: a filled dot (working), two bars (held), a diamond (a person), a square
 * stop (stopped), a tick (landed), a ring with a bar across (closed: abandoned). Drawn in the current colour.
 */
export function StateShape({ state, size = 12, className }: { state: LineState; size?: number; className?: string }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 12 12" className={cn("shrink-0", className)} data-state-shape={state}>
      {state === "working" ? (
        <circle cx="6" cy="6" r="4" style={{ fill: "currentColor" }} />
      ) : state === "held" ? (
        <>
          <rect x="2.5" y="2" width="2.4" height="8" rx="0.6" style={{ fill: "currentColor" }} />
          <rect x="7.1" y="2" width="2.4" height="8" rx="0.6" style={{ fill: "currentColor" }} />
        </>
      ) : state === "person" ? (
        <path d="M6 1L11 6L6 11L1 6Z" style={{ fill: "currentColor" }} />
      ) : state === "stopped" ? (
        <rect x="1.5" y="1.5" width="9" height="9" style={{ fill: "currentColor" }} />
      ) : state === "closed" ? (
        <>
          <circle cx="6" cy="6" r="4.4" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.4 }} />
          <path d="M3.4 6H8.6" style={{ stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" }} />
        </>
      ) : (
        <>
          <circle cx="6" cy="6" r="5" style={{ fill: "currentColor" }} />
          <path d="M3.6 6.2L5.3 7.9L8.6 4.4" style={{ fill: "none", stroke: "var(--mach-surface)", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" }} />
        </>
      )}
    </svg>
  );
}

/** A state as a pill: its shape and its word (the side panel and the full record). */
export function StatePill({ state, label }: { state: LineState; label?: string }) {
  return (
    <span className={cn("inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-caption font-semibold", STATE_TONE[state], state === "stopped" && "rounded-xs")} data-line-state={state}>
      <StateShape state={state} size={10} />
      {label ?? STATE_WORDS[state]}
    </span>
  );
}

/** The marker on the belt: the state's shape and words. Stopped is square-cornered; held is dashed; a person's wait leads with a diamond. */
export function Marker({ state, label }: { state: LineState; label: string }) {
  return (
    <span
      className={cn(
        "relative inline-flex h-7 max-w-[150px] items-center gap-1.5 whitespace-nowrap border-[1.5px] px-2.5 text-caption font-semibold",
        STATE_TONE[state],
        state === "stopped" ? "rounded-xs" : "rounded-full",
      )}
    >
      {state === "working" ? <span aria-hidden="true" className="mach-line-pulse pointer-events-none absolute -inset-[3px] rounded-full border-[1.5px] border-factory-live" /> : null}
      <StateShape state={state} size={11} />
      <span className="truncate">{label}</span>
    </span>
  );
}

/** A station passed: a filled node with a tick. */
export function PassedNode() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" className="shrink-0 text-factory-pass" data-passed-node="">
      <circle cx="8" cy="8" r="7" style={{ fill: "currentColor" }} />
      <path d="M4.8 8.2L7 10.4L11.2 5.8" style={{ fill: "none", stroke: "var(--mach-surface)", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" }} />
    </svg>
  );
}
