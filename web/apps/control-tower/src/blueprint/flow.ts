/**
 * One cell's workflow as a drawing: which station and gate nodes stand where, in which round row,
 * and what remains to be built. A pure function of the cell's state at the playhead and the column
 * template; y is relative to the cell's main line (row 0).
 *
 * Rules (M6_0_VISUAL_SPEC.md c.2): columns are fixed; round 1 runs on the main line; a column that
 * runs again (build, verify, the verdict, review, consensus) drops one row per repetition, and the
 * line returns to the main row at the first column that has not run before. Columns the belt has
 * not reached yet are drawn unbuilt; outcomes are never drawn before their event.
 */
import type { CellState, GateState, SliceState, StationVisit } from "../sim";
import { COLUMN_ORDER, columnOfGate, columnOfStation, type ColumnKey, type ColumnTemplate } from "./columns";

export const ROW = 88;

export type FlowNodeKind = "start" | "visit" | "seats" | "gate" | "end" | "future";

export interface FlowNode {
  /** Stable within the cell: `start`, `v3` (visit index), `g:<gate id>`, `end`, `f:<column>`. */
  readonly key: string;
  readonly kind: FlowNodeKind;
  readonly col: ColumnKey;
  readonly row: number;
  readonly x: number;
  readonly y: number;
  /** Judging round (1..3) the node belongs to. */
  readonly round: number;
  readonly visit?: StationVisit;
  readonly visitIndex?: number;
  readonly gate?: GateState;
  /** Half width, for routes to meet the outline. */
  readonly r: number;
}

export interface FlowSegment {
  readonly from: FlowNode;
  readonly to: FlowNode;
  /** A return to build after a refused verdict or a rejected review. */
  readonly retry: boolean;
}

export interface Flow {
  readonly nodes: readonly FlowNode[];
  readonly segments: readonly FlowSegment[];
  readonly rows: number;
  /** Rows that hold a review panel (the seats need room above and below). */
  readonly seatRows: ReadonlySet<number>;
  readonly start: FlowNode;
  readonly end: FlowNode | null;
}

const REPEATS = new Set<ColumnKey>(["build", "verify", "verification", "review", "consensus"]);
const colIndex = (c: ColumnKey): number => COLUMN_ORDER.indexOf(c);

/** The judging round a visit belongs to: a revision starts the next round. */
export function visitRound(v: StationVisit): number {
  return v.action === "revise" ? v.round + 1 : v.round;
}

function roundAt(cell: CellState, t: number): number {
  let r = 1;
  for (const v of cell.visits) if (v.enteredAt <= t) r = visitRound(v);
  return r;
}

const RADIUS: Record<FlowNodeKind, number> = { start: 9, visit: 15, seats: 12, gate: 14, end: 11, future: 15 };

const cache = new WeakMap<CellState, { gates: readonly GateState[]; slice: SliceState; template: ColumnTemplate; flow: Flow }>();

export function flowOf(cell: CellState, gates: readonly GateState[], slice: SliceState, template: ColumnTemplate, needsHuman: boolean): Flow {
  const hit = cache.get(cell);
  if (hit && hit.slice === slice && hit.template === template && hit.gates.length === gates.length && hit.gates.every((g, i) => g === gates[i])) return hit.flow;
  const flow = computeFlow(cell, gates, slice, template, needsHuman);
  cache.set(cell, { gates, slice, template, flow });
  return flow;
}

function computeFlow(cell: CellState, gates: readonly GateState[], slice: SliceState, template: ColumnTemplate, needsHuman: boolean): Flow {
  const X = (c: ColumnKey): number => template.x[c] ?? 0;
  type Item = { col: ColumnKey; round: number; t: number; kind: FlowNodeKind; visit?: StationVisit; visitIndex?: number; gate?: GateState; key: string };
  const items: Item[] = [];
  cell.visits.forEach((v, i) => {
    // The human-approval visit is the wait at the human gate: the gate draws it.
    if (v.station === "human-approval") return;
    const col = columnOfStation(v.station);
    if (!col) return;
    items.push({ col, round: visitRound(v), t: v.enteredAt, kind: col === "review" ? "seats" : "visit", visit: v, visitIndex: i, key: `v${i}` });
  });
  for (const g of gates) items.push({ col: columnOfGate(g.gate), round: g.round ?? roundAt(cell, g.openedAt), t: g.openedAt, kind: "gate", gate: g, key: `g:${g.id}` });
  items.sort((a, b) => a.round - b.round || colIndex(a.col) - colIndex(b.col) || a.t - b.t);

  const seen = new Map<ColumnKey, number>();
  const nodes: FlowNode[] = [];
  const start: FlowNode = { key: "start", kind: "start", col: "start", row: 0, x: X("start"), y: 0, round: 1, r: RADIUS.start };
  nodes.push(start);
  for (const it of items) {
    const row = seen.get(it.col) ?? 0;
    seen.set(it.col, row + 1);
    nodes.push({ key: it.key, kind: it.kind, col: it.col, row, x: X(it.col), y: row * ROW, round: it.round, visit: it.visit, visitIndex: it.visitIndex, gate: it.gate, r: RADIUS[it.kind] });
  }

  // What the belt has not reached yet: the columns after the furthest one in the current round.
  let end: FlowNode | null = null;
  if (slice.scheduler === "integrated") {
    end = { key: "end", kind: "end", col: "end", row: 0, x: X("end"), y: 0, round: cell.round, r: RADIUS.end };
    nodes.push(end);
  } else if (cell.stage !== "blocked") {
    const last = nodes[nodes.length - 1] as FlowNode;
    const round = Math.max(cell.round, last.round);
    const failedLast = last.gate && (last.gate.state === "failed");
    const from = failedLast ? colIndex("build") - 1 : colIndex(last.col);
    for (const col of COLUMN_ORDER) {
      if (colIndex(col) <= from || col === "start" || template.x[col] === undefined) continue;
      if (col === "human-approval" && !needsHuman) continue;
      const done = seen.get(col) ?? 0;
      if (done > 0 && !REPEATS.has(col)) continue;
      // A gate that is still open in this round is not a future one.
      const row = done;
      nodes.push({ key: `f:${col}`, kind: col === "end" ? "end" : "future", col, row, x: X(col), y: row * ROW, round, r: col === "end" ? RADIUS.end : RADIUS.future });
      seen.set(col, done + 1);
    }
  }

  const segments: FlowSegment[] = [];
  for (let i = 1; i < nodes.length; i++) {
    const from = nodes[i - 1] as FlowNode;
    const to = nodes[i] as FlowNode;
    const retry = Boolean(from.gate && from.gate.state === "failed" && (from.gate.gate === "verification" || from.gate.gate === "review"));
    segments.push({ from, to, retry });
  }
  const rows = nodes.reduce((m, n) => Math.max(m, n.row + 1), 1);
  const seatRows = new Set(nodes.filter((n) => n.col === "review").map((n) => n.row));
  return { nodes, segments, rows, seatRows, start, end };
}
