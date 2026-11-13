/** What every lens body is given by the investigation band. */
import type { ConcurrencySeries, TimelineMark, TimelineSpan, TimelineViewport } from "../contract";

export interface BodyProps {
  readonly spans: readonly TimelineSpan[];
  readonly marks: readonly TimelineMark[];
  readonly series: ConcurrencySeries | null;
  readonly status: "loading" | "ready" | "unavailable";
  readonly viewport: TimelineViewport;
  readonly width: number;
  /** The ticket of the store's selection, if the selection is about a cell. */
  readonly selectedTicket: string | null;
  onReveal(ref: string, at?: number): void;
  /** Widen the window to the whole history. */
  onWiden(): void;
}
