/**
 * One time axis per execution, drawn as a broken scale. Each station visit of the execution gets a
 * segment of the axis whose width grows with the square root of its duration (a 16-second merge stays
 * legible beside an 18-minute build); the pauses between visits, where the belt's clerks ask run.py
 * what is next, get short segments marked with a break. Every visit row, agent lane and tool-call
 * tick under the execution is placed on this one axis, so they align, and the ruler is drawn once,
 * in the execution's header. Within a segment the scale is linear and exact.
 *
 * A visit that is still open is given a window that grows in steps (see `axisEnd`), so the segments
 * change a dozen times over an hour, never per frame. A pure function of the playhead.
 *
 * Times are the records' own: the execution from its process's start and end records, a visit from
 * its entry plus the duration the station measured. A visit whose start or end was placed rather than
 * measured (an inference, or no record) is flagged `placed`, and the ruler draws it so.
 */
import type { ExecutionState, StationVisit } from "../sim";
import { execSpan, placed as isPlaced, visitEnd } from "./facts";
import { visitRound } from "./flow";
import { axisEnd } from "./time";

export interface Segment {
  readonly kind: "visit" | "gap";
  readonly start: number;
  readonly end: number;
  readonly x0: number;
  readonly w: number;
  /** The visit's station, for the ruler's segment label. */
  readonly station?: string;
  readonly round?: number;
  readonly open?: boolean;
  /** The visit's start or end was placed (inferred or not recorded), not measured. */
  readonly placed?: boolean;
}

export interface ExecAxis {
  readonly key: string;
  readonly x0: number;
  readonly w: number;
  readonly start: number;
  readonly end: number;
  readonly segments: readonly Segment[];
}

const cache = new Map<string, ExecAxis>();

function gapWidth(ms: number): number {
  return Math.max(10, Math.min(26, 6 + Math.sqrt(ms / 1000) * 2));
}

/** The execution's axis at playhead t. The same object is returned while its segments are unchanged. */
export function execAxis(x0: number, w: number, exec: ExecutionState, visits: readonly StationVisit[], t: number): ExecAxis {
  const span = execSpan(exec);
  const start = span.start;
  const sorted = [...visits].sort((a, b) => a.enteredAt - b.enteredAt);
  type Raw = { kind: "visit" | "gap"; start: number; end: number; station?: string; round?: number; open?: boolean; placed?: boolean };
  const raw: Raw[] = [];
  let cursor = start;
  for (const v of sorted) {
    if (v.enteredAt > cursor) raw.push({ kind: "gap", start: cursor, end: v.enteredAt });
    const left = visitEnd(v);
    const open = left === null || left > t;
    const end = open ? axisEnd(v.enteredAt, null, t) : Math.max(left, v.enteredAt + 1000);
    raw.push({ kind: "visit", start: v.enteredAt, end, station: v.station, round: visitRound(v), open, placed: isPlaced(v.meta.start) || (!open && isPlaced(v.meta.end)) });
    cursor = Math.max(cursor, end);
  }
  // The tail: to the execution's end, or (while it runs) a stepped window past the last visit.
  const tailEnd = span.end !== null && span.end <= t ? Math.max(span.end, cursor + 1000) : Math.max(cursor + 1000, axisEnd(cursor, null, t));
  if (!sorted.length) raw.push({ kind: "gap", start: cursor, end: tailEnd });
  else if (tailEnd > cursor) raw.push({ kind: "gap", start: cursor, end: tailEnd });
  const key = `${x0}|${w}|${raw.map((r) => `${r.kind[0]}${r.start}-${r.end}${r.placed ? "p" : ""}`).join(",")}`;
  const hit = cache.get(key);
  if (hit) return hit;
  // Gaps get short fixed segments; visits share the rest by the square root of their duration.
  const onlyGap = raw.length === 1;
  const gapsW = onlyGap ? 0 : raw.filter((r) => r.kind === "gap").reduce((s, r) => s + gapWidth(r.end - r.start), 0);
  const weights = raw.map((r) => (r.kind === "visit" ? Math.sqrt(Math.max(1, r.end - r.start)) : 0));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const visitW = w - gapsW;
  let x = x0;
  const segments: Segment[] = raw.map((r, i) => {
    const sw = onlyGap ? w : r.kind === "gap" ? gapWidth(r.end - r.start) : (visitW * (weights[i] as number)) / total;
    const seg: Segment = { ...r, x0: x, w: sw };
    x += sw;
    return seg;
  });
  const axis: ExecAxis = { key, x0, w, start, end: tailEnd, segments };
  if (cache.size > 200) cache.clear();
  cache.set(key, axis);
  return axis;
}

/** x of time t on the axis (clamped to its ends). */
export function xOn(axis: ExecAxis, t: number): number {
  const segs = axis.segments;
  if (!segs.length) return axis.x0;
  if (t <= axis.start) return axis.x0;
  for (const s of segs) {
    if (t <= s.end) return s.x0 + ((Math.max(t, s.start) - s.start) / Math.max(1, s.end - s.start)) * s.w;
  }
  const last = segs[segs.length - 1] as Segment;
  return last.x0 + last.w;
}
