/**
 * What a provider could and could not answer, beside the contract's answers. The contract's
 * `marks` and `concurrency` cannot tell "none" from "not served by this observer"; the view asks here
 * so it can say "not available from this observer" instead of drawing an empty, confident overview.
 */
import type { TimelineData } from "../contract";

/** `unknown`: not asked yet; `unavailable`: the observer does not serve it (an older observer); `failed`: the last request failed. */
export type PartState = "unknown" | "available" | "unavailable" | "failed";

export interface TimelineAvailability {
  readonly spans: PartState;
  readonly marks: PartState;
  readonly concurrency: PartState;
  readonly density: PartState;
  /** Whether the observer honours a span window (an M6.3 observer); null until a reply says, always true for the simulation. */
  readonly windowed: boolean | null;
  /** Plain sentences for the parts that are not available, when there is something to say. */
  readonly messages: Readonly<Partial<Record<"spans" | "marks" | "concurrency" | "density", string>>>;
}

const ALL_AVAILABLE: TimelineAvailability = { spans: "available", marks: "available", concurrency: "available", density: "available", windowed: true, messages: {} };
const readers = new WeakMap<TimelineData, () => TimelineAvailability>();

export function setAvailability(data: TimelineData, read: () => TimelineAvailability): void {
  readers.set(data, read);
}

/** The provider's availability now. A provider that records none (the simulation, a test double) answers everything. */
export function timelineAvailability(data: TimelineData): TimelineAvailability {
  return readers.get(data)?.() ?? ALL_AVAILABLE;
}
