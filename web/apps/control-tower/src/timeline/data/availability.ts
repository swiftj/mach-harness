/**
 * The contract's `TimelineData.availability()`, kept by each provider. The contract's `marks` and
 * `concurrency` answers cannot tell "none recorded" from "not served by this observer"; this can, so
 * the view says "not available from this observer" instead of drawing an empty, confident overview.
 *
 * Internally a part can also be `failed` (the last request failed: the observer is down or erred);
 * the contract has no word for that, so it reads as `unknown` there: whether it is served is not known.
 */
import type { Served, TimelineAvailability } from "../contract";

export type { TimelineAvailability };

/** `unknown`: not asked yet; `unavailable`: the observer does not serve it (an older observer); `failed`: the last request failed. */
export type PartState = "unknown" | "available" | "unavailable" | "failed";
export type Part = "spans" | "marks" | "concurrency" | "density";

export const ALL_AVAILABLE: TimelineAvailability = Object.freeze({ spans: "ok", marks: "ok", concurrency: "ok", density: "ok", unwindowed: false });

const SERVED: Readonly<Record<PartState, Served>> = { available: "ok", unavailable: "unavailable", unknown: "unknown", failed: "unknown" };

/** The provider's own record of what it learned, and the contract's view of it. */
export interface AvailabilityState {
  readonly parts: Readonly<Record<Part, PartState>>;
  /** Whether the observer honours a span window: null until a reply says. */
  readonly windowed: boolean | null;
  set(part: Part, state: PartState): void;
  setWindowed(windowed: boolean): void;
  read(): TimelineAvailability;
}

export function availabilityState(initial: Partial<Record<Part, PartState>>): AvailabilityState {
  const parts: Record<Part, PartState> = { spans: "unknown", marks: "unknown", concurrency: "unknown", density: "unknown", ...initial };
  let windowed: boolean | null = null;
  let held: TimelineAvailability | null = null;
  return {
    get parts() {
      return parts;
    },
    get windowed() {
      return windowed;
    },
    set(part, state) {
      if (parts[part] === state) return;
      parts[part] = state;
      held = null;
    },
    setWindowed(next) {
      if (windowed === next) return;
      windowed = next;
      held = null;
    },
    // The same object while nothing changed, so a React selector over it stays stable.
    read() {
      return (held ??= { spans: SERVED[parts.spans], marks: SERVED[parts.marks], concurrency: SERVED[parts.concurrency], density: SERVED[parts.density], unwindowed: windowed === false });
    },
  };
}
