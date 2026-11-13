/**
 * The five investigation lenses as definitions: a label, one sentence about what each shows and from
 * which records, and a preset over the tracks (grouping, filters, which rows are expanded). Pure, so
 * the presets are tested in node. A preset only adds to what the person has expanded; they may change
 * any of it afterwards.
 */
import { type LensDefinition, type SpanKind, type TimelineFilters, type TimelineSpan, type TimelineViewState, type TimeWindow, type TrackNode, type TrackTree } from "../contract";
import { buildTrackTree } from "../tracks/build";
import { frameOf, ladderOf, hasRetries, recoveryItems, sliceOf, ticketOf } from "./model";

export { frameOf };

/** The preset's window: the frame of what the lens shows, or the person's window when it shows nothing. */
const windowFor = (spans: readonly TimelineSpan[], view: TimelineViewState): { window?: TimeWindow | null } => {
  const w = frameOf(spans);
  void view;
  return w ? { window: w } : {};
};

/** Every span on the tree's rows (lanes and ribbons), once. */
export function spansOfTree(tree: TrackTree): TimelineSpan[] {
  const seen = new Map<string, TimelineSpan>();
  const walk = (n: TrackNode) => {
    for (const lane of n.lanes) for (const s of lane.spans) seen.set(s.id, s);
    for (const s of n.ribbons) seen.set(s.id, s);
    n.children.forEach(walk);
  };
  tree.roots.forEach(walk);
  return [...seen.values()];
}

/** The product grouping's rows above a cell: its wave and slice (or the unplanned group), then the cell. */
function cellPath(ticket: string, spans: readonly TimelineSpan[]): string[] {
  let slice: string | null = null;
  let wave: string | null = null;
  for (const s of spans) {
    if (ticketOf(s) !== ticket) continue;
    slice ??= s.ids.slice_id ?? null;
    wave ??= s.ids.wave_id ?? null;
  }
  const out: string[] = [];
  if (wave) out.push(`wave:${wave}`);
  else out.push("factory/unplanned");
  if (slice) out.push(`slice:${slice}`);
  out.push(`cell:${ticket}`);
  return out;
}

function slicePath(slice: string, spans: readonly TimelineSpan[]): string[] {
  const wave = spans.find((s) => sliceOf(s) === slice && s.ids.wave_id)?.ids.wave_id ?? null;
  return [wave ? `wave:${wave}` : "factory/unplanned", `slice:${slice}`];
}

const merge = (view: TimelineViewState, add: readonly string[]): string[] => [...new Set([...view.expanded, ...add])];

/**
 * Of `ids`, the product rows that exist under `filters` (attention aside: it changes with the live edge,
 * and a row it hides now is shown when the person clears it): a preset never stores a row that cannot be.
 */
function productRows(spans: readonly TimelineSpan[], filters: TimelineFilters, ids: readonly string[]): string[] {
  const tree = buildTrackTree(spans, "product", { ...filters, attentionOnly: false }, Number.MAX_SAFE_INTEGER);
  return ids.filter((id) => tree.byId.has(id));
}

function ticketsWith(spans: readonly TimelineSpan[], kind: SpanKind): string[] {
  const out: string[] = [];
  for (const s of spans) {
    if (s.kind !== kind) continue;
    const t = ticketOf(s);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

const WAIT_KINDS: readonly SpanKind[] = ["slice-wait", "slice-eligible", "capacity-wait", "cell"];

export const LENSES: readonly LensDefinition[] = [
  {
    id: "retries",
    label: "Why did it retry?",
    about: "Each pass through build and verify for a cell, with the gate verdict and what followed, from the station visits and the gate and failure marks.",
    preset(tree, view) {
      const spans = spansOfTree(tree);
      const focus = view.filters.tickets.length ? view.filters.tickets : ticketsWith(spans, "visit").filter((t) => hasRetries(ladderOf(t, spans, [], Number.POSITIVE_INFINITY)));
      const add = focus.flatMap((t) => [...cellPath(t, spans), `station:${t}/build`, `station:${t}/verify`, `cell:${t}/review`]);
      const shown = spans.filter((s) => s.kind === "visit" && focus.includes(ticketOf(s) ?? ""));
      return { grouping: "product", expanded: merge(view, productRows(spans, view.filters, add)), ...windowFor(shown, view) };
    },
  },
  {
    id: "concurrency",
    label: "What ran at once?",
    about: "How many executions, cells in a station and agents were active at once against the recorded limit, from the concurrency series and the wait, eligibility and claim spans.",
    preset(tree, view) {
      const shown = spansOfTree(tree).filter((s) => s.kind === "execution" || s.kind === "claim" || s.kind === "capacity-wait" || s.kind === "slice-eligible");
      return { grouping: "execution", filters: { ...view.filters, attentionOnly: false }, ...windowFor(shown, view) };
    },
  },
  {
    id: "waits",
    label: "What was it waiting on?",
    about: "Each time a slice waited on a dependency or for a free place, the slices it named and when those were integrated, from the scheduler's wait spans, the capacity waits and the merge records.",
    preset(tree, view) {
      const spans = spansOfTree(tree);
      const add: string[] = [];
      for (const s of spans) {
        if (s.kind !== "slice-wait" && s.kind !== "capacity-wait" && s.kind !== "slice-eligible") continue;
        const t = s.ids.ticket_id ?? null;
        const sl = sliceOf(s);
        if (t) add.push(...cellPath(t, spans), `cell:${t}/waits`);
        else if (sl) add.push(...slicePath(sl, spans), `slice:${sl}/waits`);
      }
      const filters = { ...view.filters, kinds: WAIT_KINDS };
      const shown = spans.filter((s) => s.kind === "slice-wait" || s.kind === "capacity-wait" || s.kind === "slice-eligible");
      return { grouping: "product", expanded: merge(view, productRows(spans, filters, add)), filters, ...windowFor(shown, view) };
    },
  },
  {
    id: "review",
    label: "Who decided what?",
    about: "Each review round's seats and votes, the panel's decision, a person's approval of the code and the authorization to merge, from the seat spans and the review, human and merge marks.",
    preset(tree, view) {
      const spans = spansOfTree(tree);
      const add = ticketsWith(spans, "seat").flatMap((t) => [...cellPath(t, spans), `cell:${t}/review`]);
      const shown = spans.filter((s) => s.kind === "seat" || s.kind === "gate-wait" || (s.kind === "visit" && (s.ids.station === "review" || s.ids.station === "merge")));
      return { grouping: "product", expanded: merge(view, productRows(spans, view.filters, add)), ...windowFor(shown, view) };
    },
  },
  {
    id: "recovery",
    label: "What was interrupted?",
    about: "Executions interrupted or with an outcome not known, visits ended without an exit record, the supervisor's recoveries and what took the work up again, from execution and visit spans and recovery marks.",
    // Every execution, not only those needing attention: what was interrupted reads against what took
    // the work up again (and failures elsewhere, rounds and seats, have no row in this grouping).
    preset(tree, view) {
      const shown = recoveryItems(spansOfTree(tree), [], Number.MAX_SAFE_INTEGER).items.map((i) => i.span);
      return { grouping: "execution", filters: { ...view.filters, attentionOnly: false }, ...windowFor(shown, view) };
    },
  },
];

export function lensOf(id: string): LensDefinition | null {
  return LENSES.find((l) => l.id === id) ?? null;
}
