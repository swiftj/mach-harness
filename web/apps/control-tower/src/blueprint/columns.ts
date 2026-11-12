/**
 * The Blueprint's columns: one per station or gate of the belt, at a fixed x for the whole run
 * (M6_0_VISUAL_SPEC.md c.2), so the drawing never re-lays out as time passes.
 *
 * The template is laid out once with ELK's layered algorithm: its nodes are the columns the fixture
 * actually uses (every cell's visits and gates), in belt order, with the review column as three seat
 * nodes between the verification verdict (fan-out) and the consensus gate (join). ELK decides the
 * spacing from each node's drawn width and the seats' vertical offsets. It runs off the frame path,
 * once per fixture, and the result is cached; the per-cell rows are arithmetic on top of it.
 */
import { useEffect, useState } from "react";
import type { ELK as ElkInstance, ElkNode } from "elkjs/lib/elk-api";
import { finalScene, type Fixture } from "../sim";

export const COLUMN_ORDER = [
  "start",
  "plan",
  "plan-check",
  "audit",
  "build",
  "red-before-green",
  "verify",
  "verification",
  "review",
  "consensus",
  "human-approval",
  "merge-revalidation",
  "merge",
  "cleanup",
  "end",
] as const;
export type ColumnKey = (typeof COLUMN_ORDER)[number];

export interface ColumnTemplate {
  /** Centre x of each column used by the fixture, from the start of the drawing area. */
  readonly x: Readonly<Partial<Record<ColumnKey, number>>>;
  /** Vertical offsets of the three review seats from the row's line (architecture, security, product). */
  readonly seats: readonly [number, number, number];
  /** Width of the drawing area the columns use. */
  readonly width: number;
  /** What the layout cost, measured once (ms): loading ELK, and the layout itself. */
  readonly cost: { readonly load: number; readonly layout: number };
}

const WIDTH: Record<ColumnKey, number> = {
  start: 78,
  plan: 58,
  "plan-check": 46,
  audit: 46,
  build: 58,
  "red-before-green": 50,
  verify: 58,
  verification: 50,
  review: 40,
  consensus: 64,
  "human-approval": 56,
  "merge-revalidation": 60,
  merge: 58,
  cleanup: 58,
  end: 78,
};

/** The column a station visit or a gate belongs to. */
export function columnOfStation(station: string): ColumnKey | null {
  return (COLUMN_ORDER as readonly string[]).includes(station) ? (station as ColumnKey) : null;
}
export function columnOfGate(gate: string): ColumnKey {
  return gate === "review" ? "consensus" : (gate as ColumnKey);
}

/** The columns the fixture uses, in belt order. */
function usedColumns(fixture: Fixture): ColumnKey[] {
  const used = new Set<ColumnKey>(["start", "end"]);
  const scene = finalScene(fixture);
  for (const cell of Object.values(scene.cells)) for (const v of cell.visits) {
    const c = columnOfStation(v.station);
    if (c) used.add(c);
  }
  for (const gate of Object.values(scene.gates)) used.add(columnOfGate(gate.gate));
  return COLUMN_ORDER.filter((c) => used.has(c));
}

let elk: Promise<ElkInstance> | null = null;
const cache = new WeakMap<Fixture, Promise<ColumnTemplate>>();
const ready = new WeakMap<Fixture, ColumnTemplate>();

export function loadColumns(fixture: Fixture): Promise<ColumnTemplate> {
  const cached = cache.get(fixture);
  if (cached) return cached;
  const promise = (async () => {
    const t0 = performance.now();
    elk ??= import("elkjs/lib/elk.bundled.js").then(({ default: ELK }) => new ELK());
    const engine = await elk;
    const t1 = performance.now();
    const cols = usedColumns(fixture);
    const seatIds = ["seat-architecture", "seat-security", "seat-product"];
    const children: ElkNode[] = [];
    const edges: { id: string; sources: string[]; targets: string[] }[] = [];
    for (const c of cols) {
      if (c === "review") for (const s of seatIds) children.push({ id: s, width: WIDTH.review, height: 22 });
      else children.push({ id: c, width: WIDTH[c], height: 30 });
    }
    // Belt order as edges; the review column is a fan-out and a join through the three seats.
    for (let i = 0; i < cols.length - 1; i++) {
      const a = cols[i] as ColumnKey;
      const b = cols[i + 1] as ColumnKey;
      const from = a === "review" ? seatIds : [a];
      const to = b === "review" ? seatIds : [b];
      for (const f of from) for (const t of to) edges.push({ id: `${f}->${t}`, sources: [f], targets: [t] });
    }
    const graph: ElkNode = {
      id: "belt",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.spacing.nodeNode": "14",
        "elk.layered.spacing.nodeNodeBetweenLayers": "22",
        "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
        "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
        "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.padding": "[top=0,left=0,bottom=0,right=0]",
      },
      children,
      edges,
    };
    const out = await engine.layout(graph);
    const t2 = performance.now();
    const x: Partial<Record<ColumnKey, number>> = {};
    const seatY: number[] = [];
    for (const n of out.children ?? []) {
      const cx = (n.x ?? 0) + (n.width ?? 0) / 2;
      const cy = (n.y ?? 0) + (n.height ?? 0) / 2;
      if (n.id.startsWith("seat-")) {
        x.review = cx;
        seatY.push(cy);
      } else x[n.id as ColumnKey] = cx;
    }
    const mid = seatY.length === 3 ? (seatY[0]! + seatY[2]!) / 2 : 0;
    const seats = (seatY.length === 3 ? seatY.map((y) => Math.round(y - mid)) : [-28, 0, 28]) as [number, number, number];
    const template: ColumnTemplate = { x, seats, width: out.width ?? 0, cost: { load: t1 - t0, layout: t2 - t1 } };
    ready.set(fixture, template);
    return template;
  })();
  cache.set(fixture, promise);
  return promise;
}

/** The template once ELK has laid it out (null for the first few milliseconds). */
export function useColumns(fixture: Fixture): ColumnTemplate | null {
  const [template, setTemplate] = useState<ColumnTemplate | null>(() => ready.get(fixture) ?? null);
  useEffect(() => {
    let live = true;
    void loadColumns(fixture).then((t) => {
      if (live) setTemplate(t);
    });
    return () => {
      live = false;
    };
  }, [fixture]);
  return template && ready.get(fixture) === template ? template : (ready.get(fixture) ?? template);
}
