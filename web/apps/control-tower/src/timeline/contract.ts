/**
 * The Execution Timeline's shared contract (docs/mach-next/M6_3_DESIGN.md in TypeScript).
 *
 * Every part of src/timeline is built against these types and imports nothing from a sibling part
 * except through them. The span shape is the observer's (`/api/v1/spans`, apps/observer/internal/
 * project/spans.go) with times parsed to epoch milliseconds; the simulation derives the same shape
 * from its scene. Nothing here holds time, selection or playback: those are the scene store's.
 */
import type { EntityRef } from "../sim";

// ---------------------------------------------------------------- spans

/** How a duration is known (M6_1_SHARED_CONTRACTS.md section 1). "not-recorded" is never a span: it is said in words. */
export type DurationBasis = "measured" | "bounded" | "inferred" | "open" | "unknown";
export type SpanAuthority = "authoritative" | "observed" | "reconstructed" | "simulated";
export type SpanPrecision = "ms" | "s" | "arrival" | "bounded" | "unknown" | "simulated";
export type SpanEndReason = "completed" | "failed" | "refused" | "interrupted" | "superseded" | "unknown";

/** The observer's span kinds, plus the M6.3 `capacity-wait`. */
export type SpanKind =
  | "wave"
  | "slice-wait"
  | "slice-eligible"
  | "capacity-wait"
  | "cell"
  | "round"
  | "visit"
  | "task"
  | "seat"
  | "gate-wait"
  | "person-wait"
  | "claim"
  | "execution"
  | "workflow"
  | "agent-queue"
  | "agent"
  | "tool";

/** One end of a span. `at` is null when nothing records it; the bounds are present when it is only bounded. */
export interface SpanEnd {
  readonly eventId: string | null;
  readonly at: number | null;
  readonly precision: SpanPrecision;
  readonly notBefore: number | null;
  readonly notAfter: number | null;
  /** "recorded": a record says so. "inferred": placed by `rule`. */
  readonly basis: "recorded" | "inferred";
  readonly rule: string | null;
  /** End only. */
  readonly reason: SpanEndReason | null;
}

/** Facts about a span that other observer routes already serve. Every field is optional: absent means not recorded. */
export interface SpanAttrs {
  readonly label?: string;
  readonly model?: string;
  readonly agentType?: string;
  readonly toolCalls?: number;
  /** True when only a count of tool calls is observable for this agent (a Dynamic Workflow agent). */
  readonly toolsCountOnly?: boolean;
  readonly lastTool?: string;
  readonly tokens?: number;
  readonly action?: string;
  readonly round?: number;
  readonly attempt?: number;
  readonly state?: string;
  readonly costUsd?: number;
  readonly vote?: string;
  readonly reasons?: readonly string[];
  readonly dependsOn?: readonly string[];
  /** The scene marked this visit as stopped and taken up again: when it stopped. */
  readonly interruptedAt?: number;
}

export interface TimelineSpan {
  /** Stable: `<kind>:<entity>`. */
  readonly id: string;
  readonly kind: SpanKind;
  /** The entity ref this span is about (the store's selection grammar where one exists). */
  readonly entity: string;
  /** The parent's ENTITY ref (not a span id): `cell:…`, `workflow:…`, `gate:…`. A visit's parent is its execution when one is recorded. */
  readonly parent: string | null;
  readonly ids: Readonly<Record<string, string>>;
  /** Null when only the end is recorded. */
  readonly start: SpanEnd | null;
  /** Null while open. */
  readonly end: SpanEnd | null;
  readonly duration: { readonly ms: number | null; readonly minMs: number | null; readonly maxMs: number | null; readonly basis: DurationBasis };
  /** Null until an event established it; never shown before that event. */
  readonly outcome: string | null;
  readonly authority: SpanAuthority;
  readonly attrs: SpanAttrs;
}

/** The earliest and latest a span can touch, for overlap tests and layout. An open span's `to` is +Infinity. */
export interface SpanExtent {
  readonly from: number;
  readonly to: number;
}

// ---------------------------------------------------------------- marks, concurrency, density

export type MarkKind = "failure" | "retry" | "gate" | "review" | "human" | "recovery" | "interruption" | "gap" | "wave" | "merge";

/** A moment (or, with `until`, an interval) worth jumping to. */
export interface TimelineMark {
  readonly id: string;
  readonly kind: MarkKind;
  readonly at: number;
  readonly until: number | null;
  readonly eventId: string | null;
  readonly entity: string | null;
  /** One plain sentence, role names only. */
  readonly label: string;
  /** gate: passed | refused | overridden; review: approved | rejected | escalated; human: required | approved. */
  readonly verdict: string | null;
  readonly authority: SpanAuthority;
}

export interface ConcurrencyBucket {
  readonly from: number;
  /** Per span kind: the most and the mean active in the bucket. */
  readonly active: Readonly<Partial<Record<SpanKind, { readonly max: number; readonly mean: number }>>>;
}

export interface ConcurrencySeries {
  readonly from: number;
  readonly to: number;
  readonly bucketMs: number;
  readonly buckets: readonly ConcurrencyBucket[];
  /** Recorded limits and when each applied; empty when the Factory's limits record none. */
  readonly limits: ReadonlyArray<{ readonly name: string; readonly value: number; readonly from: number; readonly to: number | null }>;
  readonly complete: boolean;
}

export interface DensitySeries {
  readonly from: number;
  readonly to: number;
  readonly bucketMs: number;
  /** Events recorded per bucket (never load or utilisation). Sparse: empty buckets are absent. */
  readonly buckets: ReadonlyArray<{ readonly from: number; readonly count: number }>;
  readonly complete: boolean;
}

// ---------------------------------------------------------------- data providers

export interface TimeWindow {
  readonly from: number;
  readonly to: number;
}

export interface SpanQuery {
  readonly window: TimeWindow;
  readonly kinds?: readonly SpanKind[];
  readonly ticket?: string;
  readonly execution?: string;
  readonly wave?: string;
}

export interface SpanPage {
  readonly spans: readonly TimelineSpan[];
  /** True when the provider had more spans in the window than it may return: the view must say so. */
  readonly truncated: boolean;
  readonly total: number;
  /** The provider's version of the truth these came from (projection position, or log version). */
  readonly version: string;
}

/**
 * Where the Timeline's data comes from. Two implementations: the observer (live and replay) and the
 * simulation's scene. Both are read-only. `subscribe` fires when anything a previous answer depended on
 * may have changed (new events); callers re-query, they are never pushed data.
 */
export interface TimelineData {
  readonly source: "live" | "replay" | "simulation";
  /** The whole history held: for the overview. Null until known. */
  extent(): TimeWindow | null;
  spans(query: SpanQuery, signal?: AbortSignal): Promise<SpanPage>;
  span(id: string, signal?: AbortSignal): Promise<TimelineSpan | null>;
  marks(window: TimeWindow, kinds?: readonly MarkKind[], signal?: AbortSignal): Promise<readonly TimelineMark[]>;
  /** The nearest mark of `kinds` strictly after (direction 1) or before (-1) `t`, or null. */
  nextMark(t: number, direction: 1 | -1, kinds: readonly MarkKind[], signal?: AbortSignal): Promise<TimelineMark | null>;
  density(window: TimeWindow, buckets: number, filter?: { ticket?: string; execution?: string }, signal?: AbortSignal): Promise<DensitySeries>;
  concurrency(window: TimeWindow, buckets: number, signal?: AbortSignal): Promise<ConcurrencySeries>;
  /** Whether each kind of answer is served at all: "none recorded" and "not served by this observer" are different things to say. */
  availability(): TimelineAvailability;
  subscribe(listener: () => void): () => void;
}

export type Served = "ok" | "unavailable" | "unknown";
export interface TimelineAvailability {
  readonly spans: Served;
  readonly marks: Served;
  readonly concurrency: Served;
  readonly density: Served;
  /** True when the observer answered spans without a time window (an older observer): the view must say the window is not applied. */
  readonly unwindowed: boolean;
}

// ---------------------------------------------------------------- tracks

export type Grouping = "product" | "execution";

export type TrackKind = "wave" | "slice" | "cell" | "rounds" | "station" | "waits" | "review" | "seat" | "verification" | "executions" | "execution" | "claim" | "workflow" | "agents" | "agent" | "tools" | "factory";

export interface TimelineFilters {
  readonly tickets: readonly string[];
  readonly executions: readonly string[];
  readonly slices: readonly string[];
  readonly stations: readonly string[];
  readonly kinds: readonly SpanKind[];
  /** Only tracks holding a span that failed, was interrupted, refused or waits on a person. */
  readonly attentionOnly: boolean;
}

export const NO_FILTERS: TimelineFilters = { tickets: [], executions: [], slices: [], stations: [], kinds: [], attentionOnly: false };

/** One row's worth of spans laid out without overlap. */
export interface TrackLane {
  readonly spans: readonly TimelineSpan[];
}

export interface TrackNode {
  /** Stable (design section 4): an entity ref, or `<group>/<kind>` for a synthetic row. Never positional. */
  readonly id: string;
  readonly kind: TrackKind;
  /** What selecting the row's label selects in the store, if anything. */
  readonly ref: EntityRef | null;
  readonly label: string;
  /** A second, quieter line: the slice of a cell, the attempt of an execution, the model of an agent. */
  readonly detail: string | null;
  readonly depth: number;
  readonly parentId: string | null;
  readonly children: readonly TrackNode[];
  /** The node's own spans, in lanes (parallel agents take several). Empty for pure groups. */
  readonly lanes: readonly TrackLane[];
  /** Thin linked ribbons from the other hierarchy (executions on a cell row, visits on an execution row). */
  readonly ribbons: readonly TimelineSpan[];
  /** Spans in the subtree, for the collapsed summary and the count in the label. */
  readonly spanCount: number;
  /** The worst condition in the subtree, so a collapsed group still shows that something failed. */
  readonly attention: "none" | "open" | "person" | "interrupted" | "failed";
  /** Something that applies to this row but is not recorded ("tool calls are not observable one by one"). */
  readonly note: string | null;
}

export interface TrackTree {
  readonly grouping: Grouping;
  readonly roots: readonly TrackNode[];
  /** Every node by id. */
  readonly byId: ReadonlyMap<string, TrackNode>;
  /** The track (and lane) a span sits on in this grouping; ribbons are not listed. */
  readonly ofSpan: ReadonlyMap<string, { readonly trackId: string; readonly lane: number }>;
  /** Tracks holding spans about an entity ref (the store's selection), most specific first. */
  tracksOf(ref: string): readonly string[];
}

/** A visible row after expansion and virtualisation. */
export interface FlatRow {
  readonly node: TrackNode;
  /** 0 for the node's first lane; a node with n lanes is n rows, the label on the first. */
  readonly lane: number;
  readonly y: number;
  readonly height: number;
  readonly expanded: boolean;
  readonly hasChildren: boolean;
}

export interface RowLayout {
  readonly rows: readonly FlatRow[];
  readonly totalHeight: number;
  /** Rows intersecting [top, bottom), by binary search. */
  slice(top: number, bottom: number): readonly FlatRow[];
  rowOf(trackId: string, lane?: number): FlatRow | null;
}

/** Row heights in CSS px (design section 3B). */
export const ROW_HEIGHT: Readonly<Record<TrackKind, number>> = {
  factory: 28,
  wave: 28,
  slice: 28,
  cell: 32,
  rounds: 18,
  station: 26,
  waits: 18,
  review: 22,
  seat: 18,
  verification: 22,
  executions: 22,
  execution: 26,
  claim: 18,
  workflow: 22,
  agents: 22,
  agent: 18,
  tools: 12,
};

// ---------------------------------------------------------------- rendering

/** What the pointer or keyboard is on. */
export interface TimelineHit {
  readonly trackId: string;
  readonly lane: number;
  /** A span, a mark, or an aggregate of `count` spans too small to draw one by one. */
  readonly span: TimelineSpan | null;
  readonly mark: TimelineMark | null;
  readonly count: number;
  readonly from: number;
  readonly to: number;
}

export const LABEL_GUTTER = 176;
export const OVERVIEW_HEIGHT = 96;
export const RULER_HEIGHT = 24;
/** The narrowest window the detailed view will zoom to. */
export const MIN_WINDOW_MS = 10_000;

/** Timeline interface state kept in the scene store so it survives a workspace switch (design section 7). */
export interface TimelineViewState {
  readonly window: TimeWindow | null;
  readonly grouping: Grouping;
  readonly expanded: readonly string[];
  readonly filters: TimelineFilters;
  readonly table: boolean;
  /** The investigation lens in use (design section 4 of the brief: retries, concurrency, waits, review, recovery), or null. */
  readonly lens: LensId | null;
}

export type LensId = "retries" | "concurrency" | "waits" | "review" | "recovery";

export const INITIAL_TIMELINE_VIEW: TimelineViewState = { window: null, grouping: "product", expanded: [], filters: NO_FILTERS, table: false, lens: null };

// ---------------------------------------------------------------- pure helpers every part shares

/** The earliest and latest instants a span can touch, using bounds where an end is only bounded. Null when it has no time at all. */
export function extentOf(span: TimelineSpan): SpanExtent | null {
  const s = span.start;
  const e = span.end;
  const from = s ? (s.notBefore ?? s.at) : e ? (e.notBefore ?? e.at) : null;
  if (from === null) return null;
  const to = e ? (e.notAfter ?? e.at ?? from) : Number.POSITIVE_INFINITY;
  return { from, to: Math.max(from, to) };
}

export function overlaps(span: TimelineSpan, window: TimeWindow): boolean {
  const x = extentOf(span);
  return x !== null && x.from <= window.to && x.to >= window.from;
}

/**
 * Whether a span's outcome may be shown at `liveAt`: only once its end is recorded at or before what
 * is held. An open span, or one whose end lies after `liveAt`, has no outcome yet.
 */
export function outcomeKnownAt(span: TimelineSpan, liveAt: number): boolean {
  return span.end !== null && span.end.at !== null && span.end.at <= liveAt && span.outcome !== null;
}

/** The condition a span contributes to its track's `attention`. */
export function attentionOf(span: TimelineSpan, liveAt: number): TrackNode["attention"] {
  if (span.end === null) return span.kind === "person-wait" || span.kind === "gate-wait" ? "person" : "open";
  if (span.end.at !== null && span.end.at > liveAt) return "open";
  if (span.end.reason === "failed" || span.end.reason === "refused") return "failed";
  if (span.end.reason === "interrupted" || span.end.reason === "superseded" || span.end.reason === "unknown") return "interrupted";
  return "none";
}

// ---------------------------------------------------------------- module entry points
//
// Each part exports exactly these names from its index.ts. Parts import each other only through
// them, so the parts can be built at the same time.
//
// data/index.ts
//   createObserverTimelineData(client: ObserverClient, store: SceneStore): TimelineData
//   createSimulationTimelineData(store: SceneStore): TimelineData
//   useTimelineData(): TimelineData                       (picks by the store's source; one per app)
// tracks/index.ts
//   buildTrackTree(spans, grouping, filters, liveAt, previous?: TrackTree): TrackTree
//   layoutRows(tree: TrackTree, expanded: ReadonlySet<string>): RowLayout
//   defaultExpanded(tree: TrackTree): string[]
// render/index.ts
//   TrackCanvas(props: TrackCanvasProps), TrackLabels(props: TrackLabelsProps), WindowRuler(props: WindowRulerProps)
//   describeSpan(span, liveAt): string                    (the one sentence for tooltips and screen readers)
//   durationWords(span, liveAt): string                   (design section 5, "Words")
// overview/index.ts
//   TemporalOverview(props: TemporalOverviewProps)
// controls/index.ts
//   TimelineToolbar(props: TimelineToolbarProps)
// inspector/index.ts
//   InTimeSection(props: { entity: EntityRef })
// a11y/index.ts
//   TimelineTable(props: TimelineTableProps)
// Workspace.tsx
//   TimelineWorkspace()

/** Shared by every drawing part: where things are in time and what the pointer did. */
export interface TimelineViewport {
  /** The detailed window. */
  readonly window: TimeWindow;
  /** CSS px available for time (the gutter excluded). */
  readonly width: number;
  /** What is held: spans beyond it are not drawn; nothing is drawn after it. */
  readonly liveAt: number;
}

export interface TrackCanvasProps {
  readonly tree: TrackTree;
  readonly layout: RowLayout;
  readonly viewport: TimelineViewport;
  readonly marks: readonly TimelineMark[];
  readonly height: number;
  readonly scrollTop: number;
  /** True when the provider cut the spans of this window: the canvas says so in place. */
  readonly truncated: boolean;
  /** Keyboard position: the track and, when on a span, the span. The canvas is one tab stop; the caller owns the cursor. */
  readonly cursor: TimelineCursor | null;
  onCursor(next: TimelineCursor | null): void;
  /** The window the `0` key returns to (the workspace's default: the recorded activity). Absent: `0` frames the cursor's row. */
  readonly defaultWindow?: TimeWindow;
  onScroll(top: number): void;
  /** Pan or zoom asked for by wheel, drag or keys. */
  onWindow(next: TimeWindow): void;
  /** Hover and selection go to the scene store by the caller; the canvas only reports. */
  onHover(hit: TimelineHit | null): void;
  onSelect(hit: TimelineHit): void;
  onToggle(trackId: string): void;
}

export interface TimelineCursor {
  readonly trackId: string;
  readonly lane: number;
  readonly spanId: string | null;
}

export interface TrackLabelsProps {
  readonly layout: RowLayout;
  readonly height: number;
  readonly scrollTop: number;
  readonly width: number;
  onToggle(trackId: string): void;
  onSelect(node: TrackNode): void;
  onResize(width: number): void;
  /** The wheel over the labels scrolls the rows. */
  onScroll(top: number): void;
}

export interface WindowRulerProps {
  readonly viewport: TimelineViewport;
  onWindow(next: TimeWindow): void;
}

export interface TemporalOverviewProps {
  readonly data: TimelineData;
  readonly extent: TimeWindow;
  readonly window: TimeWindow;
  readonly liveAt: number;
  readonly width: number;
  readonly height: number;
  readonly filters: TimelineFilters;
  /** Width of the legend column, equal to the tracks' label gutter so the plots line up; the overview draws no second gutter. */
  readonly gutter: number;
  onWindow(next: TimeWindow | null): void;
}

export interface TimelineToolbarProps {
  readonly data: TimelineData;
  readonly tree: TrackTree;
  readonly view: TimelineViewState;
  onView(patch: Partial<TimelineViewState>): void;
}

export interface TimelineTableProps {
  readonly tree: TrackTree;
  readonly layout: RowLayout;
  readonly viewport: TimelineViewport;
  onSelect(span: TimelineSpan): void;
  onToggle(trackId: string): void;
}

// investigate/index.ts
//   LENSES: readonly LensDefinition[]
//   InvestigationPanel(props: InvestigationPanelProps)     (a band between the overview and the tracks; null when no lens)

export interface LensDefinition {
  readonly id: LensId;
  readonly label: string;
  /** One sentence: what the lens shows and from which records. */
  readonly about: string;
  /** What choosing the lens sets (grouping, filters, expansion); the person may change any of it afterwards. */
  preset(tree: TrackTree, view: TimelineViewState): Partial<TimelineViewState>;
}

export interface InvestigationPanelProps {
  readonly lens: LensId;
  readonly data: TimelineData;
  readonly tree: TrackTree;
  readonly spans: readonly TimelineSpan[];
  readonly viewport: TimelineViewport;
  readonly width: number;
  onView(patch: Partial<TimelineViewState>): void;
  /** Select in the store and frame in the Timeline. */
  onReveal(ref: string, at?: number): void;
}
