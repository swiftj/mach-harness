/** What every lens body is given by the investigation band. */
import type { ConcurrencySeries, TimelineMark, TimelineSpan, TimelineViewport, TimeWindow } from "../contract";

export interface BodyProps {
  readonly spans: readonly TimelineSpan[];
  readonly marks: readonly TimelineMark[];
  readonly series: ConcurrencySeries | null;
  readonly status: "loading" | "ready" | "unavailable";
  readonly viewport: TimelineViewport;
  readonly width: number;
  /** The ticket of the store's selection, if the selection is about a cell. */
  readonly selectedTicket: string | null;
  /** Each row's position among the tracks' rows, by id: the lens shows things in the tracks' order. */
  readonly rowOrder: ReadonlyMap<string, number>;
  onReveal(ref: string, at?: number): void;
  /** Widen the window to the whole history. */
  onWiden(): void;
  /** Set the Timeline's window to one item's padded extent (X15), and bring the rows of `about` (entity refs) into view. */
  onFrame(window: TimeWindow, about: readonly string[]): void;
}
