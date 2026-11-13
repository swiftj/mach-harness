/**
 * Development proof for the temporal overview alone: /dev/timeline-overview.html (development server
 * only; not part of any build). ?theme=light|dark pins the theme.
 *
 * Draws the overview against a deterministic fake `TimelineData`: a 6-hour history with two busy
 * periods, a gap, failures (one dense cluster), a long person wait and one still open, gate refusals
 * and an override, and a recorded parallel limit of 3; at 1512 and 1100 px, tall and compact, and in
 * its loading, empty, not-available and stale states. Each instance has a small stand-in store
 * (playhead, live edge, connection), so Alt-click seeking can be tried.
 */
import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, TooltipProvider, type ThemePreference } from "@mach/ui";
import "../../index.css";
import { INITIAL_CONNECTION, SceneStoreProvider, type ConnectionStatus, type SceneStore, type SceneStoreState } from "../../scene";
import { setTimeBase } from "../../shell/time";
import { NO_FILTERS, OVERVIEW_HEIGHT, type ConcurrencyBucket, type ConcurrencySeries, type DensitySeries, type MarkKind, type SpanKind, type TimelineData, type TimelineMark, type TimeWindow } from "../contract";
import { TemporalOverview } from "../overview";

setTimeBase("wall");

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 10, 12, 8, 0, 0);
const EXTENT: TimeWindow = { from: T0, to: T0 + 6 * HOUR };
const at = (h: number, m: number, s = 0) => T0 + h * HOUR + m * MIN + s * 1000;

/** A deterministic 0..1 from an integer. */
function noise(n: number): number {
  let x = (n ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

const BUSY: ReadonlyArray<[number, number]> = [
  [at(0, 40), at(2, 10)],
  [at(3, 50), at(5, 25)],
];
const GAP: [number, number] = [at(2, 36), at(2, 58)];

/** Events recorded per minute: quiet, two busy periods, nothing in the gap. */
function rate(t: number): number {
  if (t >= GAP[0] && t < GAP[1]) return 0;
  const m = Math.floor((t - T0) / MIN);
  const busy = BUSY.some(([a, b]) => t >= a && t < b);
  return Math.round(busy ? 180 + noise(m) * 900 + (noise(m * 7) > 0.96 ? 2400 : 0) : noise(m) < 0.35 ? 0 : 2 + noise(m * 3) * 30);
}

interface FakeSpan {
  kind: SpanKind;
  from: number;
  to: number;
}

/** Executions (never more than 3 at once), the cells' station visits, and agents inside executions. */
function spans(): FakeSpan[] {
  const out: FakeSpan[] = [];
  let n = 0;
  for (const [a, b] of BUSY) {
    for (let lane = 0; lane < 3; lane++) {
      let t = a + lane * 4 * MIN + noise(++n) * 6 * MIN;
      while (t < b - 8 * MIN) {
        const len = 12 * MIN + noise(++n) * 22 * MIN;
        const end = Math.min(b, t + len);
        out.push({ kind: "execution", from: t, to: end });
        // Visits within the execution: build, verify, review.
        let v = t + MIN;
        for (let k = 0; k < 3 && v < end - 2 * MIN; k++) {
          const vl = 3 * MIN + noise(++n) * 8 * MIN;
          out.push({ kind: "visit", from: v, to: Math.min(end, v + vl) });
          v += vl + 30_000;
        }
        // Agents: one to four at once.
        const agents = 1 + Math.floor(noise(++n) * 4);
        for (let k = 0; k < agents; k++) {
          const s = t + noise(++n) * (end - t) * 0.6;
          out.push({ kind: "agent", from: s, to: Math.min(end, s + 2 * MIN + noise(++n) * 9 * MIN) });
        }
        t = end + 2 * MIN + noise(++n) * 6 * MIN;
      }
    }
  }
  // A few quiet visits outside the busy periods (cells waiting in a station).
  for (const [h, m, len] of [
    [0, 10, 14],
    [2, 20, 9],
    [3, 10, 25],
    [5, 40, 12],
  ] as const)
    out.push({ kind: "visit", from: at(h, m), to: at(h, m) + len * MIN });
  return out;
}
const SPANS = spans();

function mark(id: string, kind: MarkKind, t: number, label: string, extra: Partial<TimelineMark> = {}): TimelineMark {
  return { id, kind, at: t, until: null, eventId: `e-${id}`, entity: null, label, verdict: null, authority: "observed", ...extra };
}

const MARKS: TimelineMark[] = [
  mark("f1", "failure", at(0, 58), "Verification failed for LOCAL-031", { entity: "cell:LOCAL-031" }),
  // A dense cluster: five failures within seconds, drawn as one glyph with a count.
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
  mark("gap1", "gap", GAP[0], "No history held for these 22 minutes", { until: GAP[1], authority: "reconstructed" }),
];

const wait = (signal?: AbortSignal) =>
  new Promise<void>((ok, fail) => {
    const id = setTimeout(ok, 30);
    signal?.addEventListener("abort", () => {
      clearTimeout(id);
      fail(new DOMException("aborted", "AbortError"));
    });
  });

type Mode = "full" | "loading" | "empty" | "no-activity";

function fakeData(mode: Mode): TimelineData {
  const never = new Promise<never>(() => {});
  return {
    source: "replay",
    extent: () => EXTENT,
    spans: () => Promise.reject(new Error("not used by the overview")),
    span: () => Promise.resolve(null),
    async marks(w, kinds, signal) {
      if (mode === "loading") return never;
      await wait(signal);
      if (mode === "empty") return [];
      return MARKS.filter((m) => (!kinds || kinds.includes(m.kind)) && m.at <= w.to && (m.until ?? m.at) >= w.from);
    },
    nextMark: () => Promise.resolve(null),
    async density(w, buckets, filter, signal): Promise<DensitySeries> {
      if (mode === "loading") return never;
      await wait(signal);
      const bucketMs = Math.max(MIN, Math.ceil((w.to - w.from) / Math.max(1, buckets) / MIN) * MIN);
      const out: Array<{ from: number; count: number }> = [];
      if (mode !== "empty") {
        for (let t = Math.floor(w.from / bucketMs) * bucketMs; t < w.to; t += bucketMs) {
          let count = 0;
          for (let m = t; m < t + bucketMs; m += MIN) count += rate(m);
          if (filter?.ticket) count = Math.round(count * 0.3);
          if (count > 0) out.push({ from: t, count });
        }
      }
      return { from: w.from, to: w.to, bucketMs, buckets: out, complete: true };
    },
    async concurrency(w, buckets, signal): Promise<ConcurrencySeries> {
      if (mode === "loading") return never;
      await wait(signal);
      if (mode === "no-activity") return { from: w.from, to: w.to, bucketMs: 0, buckets: [], limits: [], complete: false };
      const bucketMs = Math.max(10_000, Math.ceil((w.to - w.from) / Math.max(1, buckets) / 1000) * 1000);
      const out: ConcurrencyBucket[] = [];
      const kinds: SpanKind[] = ["execution", "visit", "agent"];
      for (let t = w.from; t < w.to; t += bucketMs) {
        const active: Partial<Record<SpanKind, { max: number; mean: number }>> = {};
        if (mode !== "empty") {
          for (const k of kinds) {
            let max = 0;
            let sum = 0;
            let samples = 0;
            for (let s = t; s < t + bucketMs; s += 10_000, samples++) {
              let n = 0;
              for (const sp of SPANS) if (sp.kind === k && sp.from <= s && sp.to > s) n++;
              max = Math.max(max, n);
              sum += n;
            }
            if (max > 0) active[k] = { max, mean: sum / Math.max(1, samples) };
          }
        }
        out.push({ from: t, active });
      }
      return { from: w.from, to: w.to, bucketMs, buckets: out, limits: mode === "empty" ? [] : [{ name: "max_parallel", value: 3, from: T0, to: null }], complete: true };
    },
    subscribe: () => () => {},
  };
}

/** A stand-in for the scene store: only what the overview reads (playhead, live edge, source, connection) and seek. */
function proofStore(playhead: number, liveAt: number, connection: ConnectionStatus | null): SceneStore {
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
      state = { ...state, playhead: Math.max(EXTENT.from, Math.min(state.liveAt, t)) };
      for (const l of [...listeners]) l();
    },
  };
  return store as unknown as SceneStore;
}

function Instance({ title, width, height = OVERVIEW_HEIGHT, mode = "full", initial = null, stale = false, liveAt = EXTENT.to, playhead = at(4, 40) }: { title: string; width: number; height?: number; mode?: Mode; initial?: TimeWindow | null; stale?: boolean; liveAt?: number; playhead?: number }) {
  const data = useMemo(() => fakeData(mode), [mode]);
  const store = useMemo(() => proofStore(playhead, liveAt, stale ? { ...INITIAL_CONNECTION, state: "stale", staleSince: at(5, 52, 10), confirmedAt: at(5, 52, 10) } : null), [playhead, liveAt, stale]);
  const [win, setWin] = useState<TimeWindow | null>(initial);
  return (
    <section style={{ marginBottom: 20 }} data-proof={title}>
      <p style={{ font: "11px/16px var(--mach-font-mono)", color: "var(--mach-ink-subtle)", margin: "0 0 4px" }}>
        {title} · {width}×{height} · window {win ? `${new Date(win.from).toISOString().slice(11, 19)}–${new Date(win.to).toISOString().slice(11, 19)}` : "all"}
      </p>
      <div style={{ border: "1px solid var(--mach-line)", width: width + 2 }}>
        <SceneStoreProvider store={store}>
          <TemporalOverview data={data} extent={EXTENT} window={win ?? EXTENT} liveAt={liveAt} width={width} height={height} filters={NO_FILTERS} onWindow={setWin} />
        </SceneStoreProvider>
      </div>
    </section>
  );
}

function Proof() {
  return (
    <main style={{ padding: 16, background: "var(--mach-ground, var(--mach-surface))", minHeight: "100vh" }}>
      <Instance title="1512, window on the first busy period" width={1512} initial={{ from: at(0, 35), to: at(2, 20) }} />
      <Instance title="1512, everything" width={1512} />
      <Instance title="1100, window on the gap and the person wait" width={1100} initial={{ from: at(2, 25), to: at(3, 55) }} />
      <Instance title="1100, compact" width={1100} height={72} initial={{ from: at(3, 45), to: at(5, 30) }} />
      <Instance title="1100, stale connection" width={1100} stale liveAt={at(5, 52, 10)} />
      <Instance title="1100, activity not available" width={1100} mode="no-activity" />
      <Instance title="1100, no history yet" width={1100} mode="empty" />
      <Instance title="1100, first load" width={1100} mode="loading" />
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
