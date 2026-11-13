/**
 * Development proof for the temporal overview alone: /dev/timeline-overview.html (development server
 * only; not part of any build). ?theme=light|dark pins the theme.
 *
 * Draws the overview against deterministic fake `TimelineData`, each instance laid out as the
 * workspace lays it out (total width, the tracks' label gutter):
 * - six hours with two busy periods, a gap, failures (one dense cluster), a person wait that ended and
 *   one still open, gate refusals and an override; four recorded limits of which only `max_parallel`
 *   bounds what the band counts, and it changed from 2 to 3 to 4;
 * - a real-shaped run: 73 minutes of activity, then seven idle hours to the live edge, with a person
 *   wait still open;
 * - 20,000 marks;
 * - the scale case (?perf): 200,000 events over 30 hours with 20,000 marks, with
 *   `window.__overviewBench()` timing the first draw and React renders counted in `window.__renders`;
 * - narrow widths (no legend, with and without a gutter), compact, stale, not available, empty, loading.
 */
import { Profiler, StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, TooltipProvider, type ThemePreference } from "@mach/ui";
import "../../index.css";
import { INITIAL_CONNECTION, SceneStoreProvider, type ConnectionStatus, type SceneStore, type SceneStoreState } from "../../scene";
import { setTimeBase } from "../../shell/time";
import { LABEL_GUTTER, NO_FILTERS, OVERVIEW_HEIGHT, type ConcurrencyBucket, type ConcurrencySeries, type DensitySeries, type MarkKind, type SpanKind, type TimelineData, type TimelineMark, type TimeWindow } from "../contract";
import { TemporalOverview } from "../overview";
import { activityY, drawOverview, overviewLayout, readOverviewPalette } from "../overview/draw";
import { aggregateMarks, chooseTicks, concurrencySteps, densityColumns, idleTail, lastRecorded, limitSegments, placeLimitLabels, trimTrailingZero } from "../overview/model";

setTimeBase("wall");

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

/** A deterministic 0..1 from an integer. */
function noise(n: number): number {
  let x = (n ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

interface FakeSpan {
  kind: SpanKind;
  from: number;
  to: number;
}

type Limit = ConcurrencySeries["limits"][number] & { appliesTo?: SpanKind | null };

interface Scenario {
  readonly extent: TimeWindow;
  readonly liveAt: number;
  readonly source: TimelineData["source"];
  /** Event times, sorted. */
  readonly events: Float64Array;
  readonly spans: readonly FakeSpan[];
  readonly marks: readonly TimelineMark[];
  readonly limits: readonly Limit[];
}

function mark(id: string, kind: MarkKind, t: number, label: string, extra: Partial<TimelineMark> = {}): TimelineMark {
  return { id, kind, at: t, until: null, eventId: `e-${id}`, entity: null, label, verdict: null, authority: "observed", ...extra };
}

/** Events at a per-minute rate, spread evenly within each minute. */
function eventsFrom(from: number, to: number, rate: (t: number) => number): Float64Array {
  const out: number[] = [];
  for (let t = from; t < to; t += MIN) {
    const n = rate(t);
    for (let k = 0; k < n; k++) out.push(t + Math.floor(((k + noise(t / MIN + k)) / Math.max(1, n)) * MIN));
  }
  return Float64Array.from(out).sort();
}

// ---------------------------------------------------------------- six hours

const T0 = Date.UTC(2026, 10, 12, 8, 0, 0);
const at = (h: number, m: number, s = 0) => T0 + h * HOUR + m * MIN + s * SEC;

function sixHours(): Scenario {
  const extent = { from: T0, to: T0 + 6 * HOUR };
  const busy: ReadonlyArray<[number, number]> = [
    [at(0, 40), at(2, 10)],
    [at(3, 50), at(5, 25)],
  ];
  const gap: [number, number] = [at(2, 36), at(2, 58)];
  const rate = (t: number) => {
    if (t >= gap[0] && t < gap[1]) return 0;
    const m = Math.floor((t - T0) / MIN);
    const b = busy.some(([a, z]) => t >= a && t < z);
    return Math.round(b ? 180 + noise(m) * 900 + (noise(m * 7) > 0.96 ? 2400 : 0) : noise(m) < 0.35 ? 0 : 2 + noise(m * 3) * 30);
  };
  const spans: FakeSpan[] = [];
  let n = 0;
  for (const [a, b] of busy) {
    for (let lane = 0; lane < 3; lane++) {
      let t = a + lane * 4 * MIN + noise(++n) * 6 * MIN;
      while (t < b - 8 * MIN) {
        const end = Math.min(b, t + 12 * MIN + noise(++n) * 22 * MIN);
        spans.push({ kind: "execution", from: t, to: end });
        let v = t + MIN;
        for (let k = 0; k < 3 && v < end - 2 * MIN; k++) {
          const vl = 3 * MIN + noise(++n) * 8 * MIN;
          spans.push({ kind: "visit", from: v, to: Math.min(end, v + vl) });
          v += vl + 30_000;
        }
        const agents = 1 + Math.floor(noise(++n) * 4);
        for (let k = 0; k < agents; k++) {
          const s = t + noise(++n) * (end - t) * 0.6;
          spans.push({ kind: "agent", from: s, to: Math.min(end, s + 2 * MIN + noise(++n) * 9 * MIN) });
        }
        t = end + 2 * MIN + noise(++n) * 6 * MIN;
      }
    }
  }
  for (const [h, m, len] of [
    [0, 10, 14],
    [2, 20, 9],
    [3, 10, 25],
    [5, 40, 12],
  ] as const)
    spans.push({ kind: "visit", from: at(h, m), to: at(h, m) + len * MIN });
  const marks: TimelineMark[] = [
    mark("f1", "failure", at(0, 58), "Verification failed for LOCAL-031", { entity: "cell:LOCAL-031" }),
    ...[0, 4, 9, 13, 21].map((s, i) => mark(`f2-${i}`, "failure", at(1, 32, s), "Build refused: a test changed after it was committed", { entity: "cell:LOCAL-034" })),
    mark("f3", "failure", at(4, 21), "Review rejected LOCAL-040 in round 2", { entity: "cell:LOCAL-040" }),
    mark("f4", "failure", at(5, 12), "Execution ended with an error", { entity: "execution:x41" }),
    mark("i1", "interruption", at(2, 34), "The Factory Supervisor stopped; one execution was interrupted"),
    mark("r1", "recovery", at(3, 49), "The supervisor recovered the interrupted execution"),
    mark("g1", "gate", at(1, 5), "Merge gate refused LOCAL-032: the suite failed on main", { verdict: "refused" }),
    mark("g2", "gate", at(4, 2), "Build gate overridden for LOCAL-038, with a reason", { verdict: "overridden" }),
    mark("g3", "gate", at(4, 48), "Audit gate refused LOCAL-041: the report is stale", { verdict: "refused" }),
    // Passed gates are not drawn on the overview; many of them prove they are skipped cheaply.
    ...Array.from({ length: 4000 }, (_, i) => mark(`gp${i}`, "gate", T0 + Math.floor(noise(i + 99) * 6 * HOUR), "Gate passed", { verdict: "passed" })),
    mark("h1", "human", at(3, 2), "A person approved LOCAL-033 after a high-risk review", { until: at(3, 44), verdict: "approved", entity: "gate:LOCAL-033/human-approval" }),
    mark("h2", "human", at(5, 41), "A person is needed to approve LOCAL-042", { verdict: "required", entity: "gate:LOCAL-042/human-approval" }),
    mark("gap1", "gap", gap[0], "No history held for these 22 minutes", { until: gap[1], authority: "reconstructed" }),
  ];
  const limits: Limit[] = [
    // The one that bounds what the band counts, and it changed twice.
    { name: "max_parallel", value: 2, from: T0, to: at(1, 30), appliesTo: "execution" },
    { name: "max_parallel", value: 3, from: at(1, 30), to: at(4, 0), appliesTo: "execution" },
    { name: "max_parallel", value: 4, from: at(4, 0), to: null, appliesTo: "execution" },
    // Three kinds that bound nothing counted here: never drawn.
    { name: "poll_seconds", value: 300, from: T0, to: null, appliesTo: null },
    { name: "max_execution_minutes", value: 40, from: T0, to: null, appliesTo: null },
    { name: "max_runs_per_day", value: 4, from: T0, to: null },
  ];
  return { extent, liveAt: extent.to, source: "replay", events: eventsFrom(extent.from, extent.to, rate), spans, marks, limits };
}

// ---------------------------------------------------------------- a real-shaped run, viewed seven hours later

const R0 = Date.UTC(2026, 10, 13, 5, 29, 0);
const rt = (m: number, s = 0) => R0 + m * MIN + s * SEC;

function idleTailRun(): Scenario {
  // 05:29 to 06:42: one cell, three executions, two rejected review rounds. Viewed at 13:43 (live).
  const liveAt = rt(73 + 7 * 60 + 1);
  const extent = { from: R0, to: liveAt };
  const executions: Array<[number, number]> = [
    [rt(1), rt(24)],
    [rt(27), rt(49)],
    [rt(52), rt(72, 40)],
  ];
  const spans: FakeSpan[] = [];
  let n = 7;
  for (const [a, b] of executions) {
    spans.push({ kind: "execution", from: a, to: b });
    spans.push({ kind: "visit", from: a + MIN, to: b - MIN });
    for (let k = 0; k < 4; k++) {
      const s = a + noise(++n) * (b - a) * 0.7;
      spans.push({ kind: "agent", from: s, to: Math.min(b, s + 3 * MIN + noise(++n) * 6 * MIN) });
    }
  }
  const rate = (t: number) => (t < rt(73) && executions.some(([a, b]) => t >= a - MIN && t < b + MIN) ? Math.round(6 + noise(t / MIN) * 40) : 0);
  const marks: TimelineMark[] = [
    mark("rf1", "failure", rt(22), "Review rejected LOCAL-051 in round 1", { entity: "cell:LOCAL-051" }),
    mark("rf2", "failure", rt(47), "Review rejected LOCAL-051 in round 2", { entity: "cell:LOCAL-051" }),
    mark("rh1", "human", rt(25), "A person looked at the rejected review of LOCAL-051", { until: rt(26, 30), verdict: "approved" }),
    mark("rh2", "human", rt(72, 41), "A person is needed to approve LOCAL-051 after round 3", { verdict: "required", entity: "gate:LOCAL-051/human-approval" }),
  ];
  // An older observer: limits without what they apply to. Only max_parallel is drawn.
  const limits: Limit[] = [
    { name: "max_parallel", value: 1, from: R0, to: null },
    { name: "poll_seconds", value: 300, from: R0, to: null },
    { name: "max_execution_minutes", value: 40, from: R0, to: null },
    { name: "max_runs_per_day", value: 4, from: R0, to: null },
  ];
  return { extent, liveAt, source: "live", events: eventsFrom(extent.from, rt(74), rate), spans, marks, limits };
}

// ---------------------------------------------------------------- scale

const P0 = Date.UTC(2026, 10, 10, 0, 0, 0);

function denseMarks(count: number, from: number, len: number): TimelineMark[] {
  const kinds: MarkKind[] = ["failure", "gate", "interruption", "recovery", "human", "gate"];
  return Array.from({ length: count }, (_, i) => {
    const kind = kinds[i % kinds.length]!;
    const t = from + Math.floor(noise(i * 31 + 5) * len);
    if (kind === "human") return mark(`d${i}`, kind, t, "A person approved a high-risk change", { until: t + Math.floor(noise(i) * 20 * MIN), verdict: "approved" });
    if (kind === "gate") return mark(`d${i}`, kind, t, i % 12 === 1 ? "A gate refused the change" : "A gate was overridden, with a reason", { verdict: i % 12 === 1 ? "refused" : "overridden" });
    return mark(`d${i}`, kind, t, kind === "failure" ? "Verification failed" : kind === "interruption" ? "An execution was interrupted" : "The supervisor recovered an execution");
  });
}

function scale(): Scenario {
  const extent = { from: P0, to: P0 + 30 * HOUR };
  const events = new Float64Array(200_000);
  for (let i = 0; i < events.length; i++) {
    // Clustered: most events in a few busy hours.
    const u = noise(i * 3 + 1);
    const centre = [3, 9, 14, 22, 27][i % 5]! * HOUR;
    events[i] = P0 + Math.max(0, Math.min(30 * HOUR - 1, centre + (u - 0.5) * 4 * HOUR * noise(i * 7 + 2)));
  }
  events.sort();
  const spans: FakeSpan[] = [];
  for (let i = 0; i < 3000; i++) {
    const kind: SpanKind = i % 3 === 0 ? "execution" : i % 3 === 1 ? "visit" : "agent";
    const s = P0 + noise(i * 11) * 30 * HOUR;
    spans.push({ kind, from: s, to: s + (5 + noise(i * 13) * 40) * MIN });
  }
  return { extent, liveAt: extent.to, source: "replay", events, spans, marks: denseMarks(20_000, extent.from, 30 * HOUR), limits: [{ name: "max_parallel", value: 40, from: P0, to: null, appliesTo: "execution" }] };
}

// ---------------------------------------------------------------- the fake provider

function lowerBound(a: Float64Array, t: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function densityOf(s: Scenario, w: TimeWindow, buckets: number, scaleBy = 1): DensitySeries {
  const bucketMs = Math.max(SEC, Math.ceil((w.to - w.from) / Math.max(1, buckets) / SEC) * SEC);
  const out: Array<{ from: number; count: number }> = [];
  const start = Math.floor(w.from / bucketMs) * bucketMs;
  let i = lowerBound(s.events, start);
  for (let t = start; t < w.to; t += bucketMs) {
    let count = 0;
    while (i < s.events.length && s.events[i]! < t + bucketMs) {
      count++;
      i++;
    }
    count = Math.round(count * scaleBy);
    if (count > 0) out.push({ from: t, count });
  }
  return { from: w.from, to: w.to, bucketMs, buckets: out, complete: true };
}

function concurrencyOf(s: Scenario, w: TimeWindow, buckets: number): ConcurrencySeries {
  const bucketMs = Math.max(10 * SEC, Math.ceil((w.to - w.from) / Math.max(1, buckets) / SEC) * SEC);
  const step = Math.max(10 * SEC, Math.floor(bucketMs / 6));
  const samples = Math.ceil((w.to - w.from) / step) + 1;
  const kinds: SpanKind[] = ["execution", "visit", "agent"];
  const diff = new Map(kinds.map((k) => [k, new Int32Array(samples + 1)]));
  for (const sp of s.spans) {
    const d = diff.get(sp.kind);
    if (!d || sp.to <= w.from || sp.from >= w.to) continue;
    d[Math.max(0, Math.ceil((sp.from - w.from) / step))]!++;
    d[Math.min(samples, Math.ceil((sp.to - w.from) / step))]!--;
  }
  const level = new Map(kinds.map((k) => [k, new Int32Array(samples)]));
  for (const k of kinds) {
    const d = diff.get(k)!;
    const l = level.get(k)!;
    let run = 0;
    for (let i = 0; i < samples; i++) l[i] = run += d[i]!;
  }
  const out: ConcurrencyBucket[] = [];
  for (let t = w.from; t < w.to; t += bucketMs) {
    const active: Partial<Record<SpanKind, { max: number; mean: number }>> = {};
    const a = Math.floor((t - w.from) / step);
    const b = Math.min(samples, Math.floor((t + bucketMs - w.from) / step));
    for (const k of kinds) {
      const l = level.get(k)!;
      let max = 0;
      let sum = 0;
      for (let i = a; i < b; i++) {
        max = Math.max(max, l[i]!);
        sum += l[i]!;
      }
      if (max > 0) active[k] = { max, mean: sum / Math.max(1, b - a) };
    }
    out.push({ from: t, active });
  }
  return { from: w.from, to: w.to, bucketMs, buckets: out, limits: s.limits, complete: true };
}

const wait = (signal?: AbortSignal) =>
  new Promise<void>((ok, fail) => {
    const id = setTimeout(ok, 30);
    signal?.addEventListener("abort", () => {
      clearTimeout(id);
      fail(new DOMException("aborted", "AbortError"));
    });
  });

type Mode = "full" | "loading" | "empty" | "no-activity";

function fakeData(s: Scenario, mode: Mode): TimelineData {
  const never = new Promise<never>(() => {});
  return {
    source: s.source,
    extent: () => s.extent,
    spans: () => Promise.reject(new Error("not used by the overview")),
    span: () => Promise.resolve(null),
    async marks(w, kinds, signal) {
      if (mode === "loading") return never;
      await wait(signal);
      if (mode === "empty") return [];
      return s.marks.filter((m) => (!kinds || kinds.includes(m.kind)) && m.at <= w.to && (m.until ?? m.at) >= w.from);
    },
    nextMark: () => Promise.resolve(null),
    async density(w, buckets, filter, signal) {
      if (mode === "loading") return never;
      await wait(signal);
      if (mode === "empty") return { from: w.from, to: w.to, bucketMs: MIN, buckets: [], complete: true };
      return densityOf(s, w, buckets, filter?.ticket ? 0.3 : 1);
    },
    async concurrency(w, buckets, signal) {
      if (mode === "loading") return never;
      await wait(signal);
      if (mode === "no-activity") return { from: w.from, to: w.to, bucketMs: 0, buckets: [], limits: [], complete: false };
      if (mode === "empty") return { from: w.from, to: w.to, bucketMs: MIN, buckets: [], limits: [], complete: true };
      return concurrencyOf(s, w, buckets);
    },
    availability: () => ({ spans: "ok", marks: "ok", concurrency: mode === "no-activity" ? "unavailable" : "ok", density: "ok", unwindowed: false }),
    subscribe: () => () => {},
  };
}

/** A stand-in for the scene store: only what the overview reads (playhead, live edge, source, connection) and seek. */
function proofStore(extent: TimeWindow, playhead: number, liveAt: number, connection: ConnectionStatus | null): SceneStore {
  let state = { source: "live", playhead, liveAt, following: false, connection } as unknown as SceneStoreState;
  const listeners = new Set<() => void>();
  const store = {
    getState: () => state,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    seek(t: number) {
      state = { ...state, playhead: Math.max(extent.from, Math.min(state.liveAt, t)) };
      for (const l of [...listeners]) l();
    },
  };
  return store as unknown as SceneStore;
}

const SIX = sixHours();
const IDLE = idleTailRun();
const DENSE: Scenario = { ...SIX, marks: denseMarks(20_000, SIX.extent.from, 6 * HOUR) };

declare global {
  interface Window {
    __renders?: Array<{ id: string; phase: string; ms: number }>;
    __windows?: number;
    __overviewBench?: () => Record<string, number>;
  }
}

function Instance(props: { title: string; scenario: Scenario; width: number; gutter?: number; height?: number; mode?: Mode; initial?: TimeWindow | null; stale?: boolean; playhead?: number; id?: string }) {
  const { title, scenario: s, width, gutter = LABEL_GUTTER, height = OVERVIEW_HEIGHT, mode = "full", initial = null, stale = false } = props;
  const playhead = props.playhead ?? s.extent.from + (s.extent.to - s.extent.from) * 0.78;
  const data = useMemo(() => fakeData(s, mode), [s, mode]);
  const store = useMemo(
    () => proofStore(s.extent, playhead, s.liveAt, stale ? { ...INITIAL_CONNECTION, state: "stale", staleSince: s.liveAt - 8 * MIN, confirmedAt: s.liveAt - 8 * MIN } : null),
    [s, playhead, stale],
  );
  const [win, setWin] = useState<TimeWindow | null>(initial);
  const onWindow = (w: TimeWindow | null) => {
    window.__windows = (window.__windows ?? 0) + 1;
    setWin(w);
  };
  return (
    <section style={{ marginBottom: 20 }} data-proof={props.id ?? title}>
      <p style={{ font: "11px/16px var(--mach-font-mono)", color: "var(--mach-ink-subtle)", margin: "0 0 4px" }}>
        {title} · {width}×{height}, gutter {gutter} · window {win ? `${new Date(win.from).toISOString().slice(11, 19)}–${new Date(win.to).toISOString().slice(11, 19)}` : "all"}
      </p>
      <div style={{ border: "1px solid var(--mach-line)", width: width + 2 }}>
        <SceneStoreProvider store={store}>
          <Profiler id={props.id ?? title} onRender={(id, phase, ms) => window.__renders?.push({ id, phase, ms })}>
            <TemporalOverview data={data} extent={s.extent} window={win ?? s.extent} liveAt={s.liveAt} width={width} height={height} gutter={gutter} filters={NO_FILTERS} onWindow={onWindow} />
          </Profiler>
        </SceneStoreProvider>
      </div>
    </section>
  );
}

/** Times the overview's whole first draw for the scale case: pixel aggregation, label placement and the canvas. */
function bench(): Record<string, number> {
  const s = scale();
  const width = 1512;
  const pw = width - LABEL_GUTTER - 12;
  const t0 = performance.now();
  const density = densityOf(s, s.extent, pw);
  const concurrency = concurrencyOf(s, s.extent, Math.floor(pw / 2));
  const provider = performance.now() - t0;
  const canvas = document.createElement("canvas");
  canvas.width = pw * 2;
  canvas.height = OVERVIEW_HEIGHT * 2;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d")!;
  const L = overviewLayout(OVERVIEW_HEIGHT);
  const runs: number[] = [];
  const model: number[] = [];
  const draw: number[] = [];
  const flush: number[] = [];
  for (let r = 0; r < 25; r++) {
    const a = performance.now();
    const cols = densityColumns(density, s.extent, pw);
    const marks = aggregateMarks(s.marks, s.extent, pw, s.liveAt);
    const ticks = chooseTicks(s.extent, pw, true).ticks;
    const last = lastRecorded(density, s.marks, s.liveAt);
    const tail = idleTail(last, s.liveAt, s.extent, pw);
    const ex = concurrencySteps(concurrency, "execution", s.extent, pw);
    const vi = concurrencySteps(concurrency, "visit", s.extent, pw);
    const ag = concurrencySteps(concurrency, "agent", s.extent, pw);
    const limits = limitSegments(concurrency.limits, s.extent, pw, s.liveAt);
    const vmax = Math.max(1, ex.peak, vi.peak, ag.peak, ...limits.map((l) => l.value)) * 1.08;
    const placed = placeLimitLabels(limits, activityY(L, vmax), (t) => ctx.measureText(t).width, { top: L.plotTop, bottom: L.plotBottom, width: pw });
    const b = performance.now();
    model.push(b - a);
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    drawOverview(
      ctx,
      {
        width: pw,
        height: OVERVIEW_HEIGHT,
        layout: L,
        density: cols,
        activity: { executions: trimTrailingZero(ex.steps), visits: trimTrailingZero(vi.steps), agents: trimTrailingZero(ag.steps), limits, limitLabels: placed.placed, vmax },
        points: marks.points,
        bars: marks.bars,
        ticks,
        tail: tail ? { ...tail, label: "last recorded", labelX: tail.x + 4, idle: "nothing recorded" } : null,
      },
      readOverviewPalette(document.documentElement),
    );
    // Force the canvas work to finish inside the measurement.
    const c = performance.now();
    ctx.getImageData(0, 0, 1, 1);
    draw.push(c - b);
    flush.push(performance.now() - c);
    runs.push(performance.now() - a);
  }
  canvas.remove();
  const first = runs[0]!;
  runs.sort((p, q) => p - q);
  return { events: s.events.length, marks: s.marks.length, providerBucketingMs: provider, firstDrawMedianMs: runs[Math.floor(runs.length / 2)]!, firstDrawMaxMs: runs[runs.length - 1]!, firstDrawFirstRunMs: first, firstRunModelMs: model[0]!, firstRunCanvasMs: draw[0]!, firstRunFlushMs: flush[0]! };
}

const PERF_MODE = new URLSearchParams(window.location.search).has("perf");
if (PERF_MODE) {
  window.__renders = [];
  window.__overviewBench = bench;
}

function Proof() {
  const PERF = useMemo(() => (PERF_MODE ? scale() : null), []);
  if (PERF) {
    return (
      <main style={{ padding: 16, background: "var(--mach-ground, var(--mach-surface))", minHeight: "100vh" }}>
        <Instance id="perf" title="Scale: 200,000 events over 30 hours, 20,000 marks" scenario={PERF} width={1512} initial={{ from: P0 + 8 * HOUR, to: P0 + 12 * HOUR }} />
      </main>
    );
  }
  return (
    <main style={{ padding: 16, background: "var(--mach-ground, var(--mach-surface))", minHeight: "100vh" }}>
      <Instance id="idle" title="Real-shaped run, viewed seven hours later (live)" scenario={IDLE} width={1512} />
      <Instance id="six" title="Six hours: max_parallel changed 2, 3, 4; three other limits not drawn" scenario={SIX} width={1512} initial={{ from: at(0, 35), to: at(2, 20) }} />
      <Instance id="dense" title="20,000 marks" scenario={DENSE} width={1512} />
      <Instance id="idle-1100" title="Real-shaped run at 1100" scenario={IDLE} width={1100} />
      <Instance id="six-1100" title="Six hours at 1100, window on the gap and the person wait" scenario={SIX} width={1100} initial={{ from: at(2, 25), to: at(3, 55) }} />
      <Instance id="compact" title="Compact" scenario={SIX} width={1100} height={72} initial={{ from: at(3, 45), to: at(5, 30) }} />
      <Instance id="narrow" title="700 wide: no legend, plot still starts at the gutter" scenario={SIX} width={700} />
      <Instance id="narrow-0" title="700 wide, no gutter: the plot is the whole width" scenario={SIX} width={700} gutter={0} />
      <Instance id="stale" title="Stale connection" scenario={SIX} width={1100} stale />
      <Instance id="no-activity" title="Activity not available" scenario={SIX} width={1100} mode="no-activity" />
      <Instance id="empty" title="No history yet" scenario={SIX} width={1100} mode="empty" />
      <Instance id="loading" title="First load" scenario={SIX} width={1100} mode="loading" />
    </main>
  );
}

const theme = new URLSearchParams(window.location.search).get("theme");
const root = document.getElementById("root");
if (!root) throw new Error("No #root element");
createRoot(root).render(
  <StrictMode>
    <ThemeProvider product="control-tower" persist={false} defaultPreference={theme === "light" || theme === "dark" ? (theme as ThemePreference) : "system"}>
      <TooltipProvider>
        <Proof />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
