/**
 * Lane packing: greedy interval partitioning on extentOf(span), deterministic.
 *
 * Units are placed in order of their earliest instant (ties by id) on the lowest-numbered lane that is
 * free at that instant. A lane is free once its last unit has ended; a unit with no length holds its lane
 * for half a millisecond, so two instants at the same moment never share a lane while a visit that
 * starts exactly when the previous one ended does. An agent and its queue are one unit: the queue sits
 * on the same lane immediately before its agent. O(n log n) with two heaps.
 *
 * Only units started by `liveAt` open lanes: a unit that starts after the live edge is not drawn yet
 * (lod.spanTimes), so a lane opened for it would be an empty band (round 6, defect 5). Such units go
 * on lane 0 until they start, when the tree is built again. Packing is prefix-stable: the lanes of the
 * units started by an earlier liveAt are the same with a later one.
 */
import { extentOf, type TimelineSpan, type TrackLane } from "../contract";

interface Unit {
  readonly id: string;
  readonly from: number;
  readonly to: number;
  readonly spans: TimelineSpan[];
}

/** A minimal binary heap; `less` decides the top. */
class Heap<T> {
  private readonly items: T[] = [];
  private readonly less: (a: T, b: T) => boolean;
  constructor(less: (a: T, b: T) => boolean) {
    this.less = less;
  }
  get size(): number {
    return this.items.length;
  }
  peek(): T | undefined {
    return this.items[0];
  }
  push(item: T): void {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i] as T, a[p] as T)) break;
      [a[i], a[p]] = [a[p] as T, a[i] as T];
      i = p;
    }
  }
  pop(): T | undefined {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0 && last !== undefined) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l] as T, a[m] as T)) m = l;
        if (r < a.length && this.less(a[r] as T, a[m] as T)) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m] as T, a[i] as T];
        i = m;
      }
    }
    return top;
  }
}

/** How long a unit holds its lane: a unit with no length holds it for half a millisecond. */
export function laneEnd(from: number, to: number): number {
  return to > from ? to : from + 0.5;
}

const QUEUE_FIRST: Partial<Record<TimelineSpan["kind"], number>> = { "agent-queue": 0, agent: 1 };

function unitsOf(spans: readonly TimelineSpan[]): Unit[] {
  const units: Unit[] = [];
  let byAgent: Map<string, Unit> | null = null;
  for (const span of spans) {
    const x = extentOf(span);
    const from = x ? x.from : Number.NEGATIVE_INFINITY;
    const to = x ? x.to : Number.NEGATIVE_INFINITY;
    if (span.kind === "agent" || span.kind === "agent-queue") {
      byAgent ??= new Map();
      const unit = byAgent.get(span.entity);
      if (unit) {
        // Mutable only while packing: the unit is private to this call.
        (unit as { from: number }).from = Math.min(unit.from, from);
        (unit as { to: number }).to = Math.max(unit.to, to);
        unit.spans.push(span);
        unit.spans.sort((a, b) => (QUEUE_FIRST[a.kind] ?? 0) - (QUEUE_FIRST[b.kind] ?? 0));
        continue;
      }
      const created: Unit = { id: span.entity, from, to, spans: [span] };
      byAgent.set(span.entity, created);
      units.push(created);
      continue;
    }
    units.push({ id: span.id, from, to, spans: [span] });
  }
  return units;
}

/** How many of these spans have started by `liveAt` (or have no time at all); the lanes depend on it. */
export function startedBy(spans: readonly TimelineSpan[], liveAt: number): number {
  let n = 0;
  for (const span of spans) {
    const x = extentOf(span);
    if (!x || x.from <= liveAt) n++;
  }
  return n;
}

/**
 * Packs spans into lanes without overlap. Spans with no time at all, and spans not started by
 * `liveAt`, go on lane 0.
 */
export function packLanes(spans: readonly TimelineSpan[], liveAt = Number.POSITIVE_INFINITY): TrackLane[] {
  if (spans.length === 0) return [];
  if (spans.length === 1) return [{ spans: [spans[0] as TimelineSpan] }];
  const units = unitsOf(spans);
  units.sort((a, b) => a.from - b.from || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const lanes: TimelineSpan[][] = [];
  const busy = new Heap<{ end: number; lane: number }>((a, b) => a.end < b.end || (a.end === b.end && a.lane < b.lane));
  const free = new Heap<number>((a, b) => a < b);
  const timeless: TimelineSpan[] = [];
  for (const unit of units) {
    if (unit.from === Number.NEGATIVE_INFINITY || unit.from > liveAt) {
      timeless.push(...unit.spans);
      continue;
    }
    for (let top = busy.peek(); top !== undefined && top.end <= unit.from; top = busy.peek()) {
      busy.pop();
      free.push(top.lane);
    }
    let lane = free.pop();
    if (lane === undefined) {
      lane = lanes.length;
      lanes.push([]);
    }
    (lanes[lane] as TimelineSpan[]).push(...unit.spans);
    busy.push({ end: laneEnd(unit.from, unit.to), lane });
  }
  if (timeless.length > 0) {
    if (lanes.length === 0) lanes.push([]);
    (lanes[0] as TimelineSpan[]).push(...timeless);
  }
  return lanes.map((s) => ({ spans: s }));
}

const NOUNS: Partial<Record<TimelineSpan["kind"], readonly [string, string]>> = {
  agent: ["agent", "agents"],
  tool: ["tool call", "tool calls"],
  task: ["task", "tasks"],
  visit: ["visit", "visits"],
  seat: ["seat", "seats"],
  // Every kind of wait (person, gate, capacity, dependency, eligible) reads as a wait.
  "person-wait": ["wait", "waits"],
};

/**
 * What a lane after the first holds, for the label column: "lane 2 · 4 agents", "lane 2 · 6 tasks"
 * (round 6, defect 5: such a lane had a blank label). An agent and its queue are one agent. Lanes of
 * mixed kinds say only their number.
 */
export function laneWords(node: { readonly lanes: readonly TrackLane[] }, lane: number): string {
  const spans = node.lanes[lane]?.spans ?? [];
  const head = `lane ${lane + 1}`;
  let kind: TimelineSpan["kind"] | null = null;
  const units = new Set<string>();
  for (const span of spans) {
    const k = span.kind === "agent-queue" ? "agent" : span.kind.endsWith("-wait") || span.kind === "slice-eligible" ? "person-wait" : span.kind;
    if (kind === null) kind = k;
    else if (kind !== k) return head;
    units.add(k === "agent" ? span.entity : span.id);
  }
  const noun = kind ? NOUNS[kind] : undefined;
  if (!noun) return head;
  return `${head} · ${units.size} ${units.size === 1 ? noun[0] : noun[1]}`;
}
