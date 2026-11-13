/**
 * Development only, never built: the whole Timeline workspace over a fake TimelineData, to provoke
 * each of its states (X23), at /src/timeline/dev/timeline-states.html on the dev server.
 *
 *   ?state=ready         the hand-built fixture, answered at once (the reference)
 *   ?state=loading       the first answer never comes
 *   ?state=refreshing    answered once, then every later read hangs (window moved: previous answer stays)
 *   ?state=empty         nothing recorded yet (live)
 *   ?state=filtered      held spans, filters that match none of them
 *   ?state=nothing       a chosen window with nothing in it
 *   ?state=error         the window's read fails (Try again)
 *   ?state=unserved      the observer does not serve spans
 *   ?state=stale | reconnecting | disconnected | no-session   the observer link
 *   ?state=behind        the playhead scrubbed an hour back (the caption)
 *   ?theme=light|dark
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, TooltipProvider, type ThemePreference } from "@mach/ui";
import "../../index.css";
import { browserClock, createSceneStore, INITIAL_CONNECTION, SceneStoreProvider } from "../../scene";
import { createSceneLog, provenance } from "../../sim";
import { setTimeBase } from "../../shell/time";
import { NO_FILTERS, type SpanPage, type TimelineData, type TimelineSpan } from "../contract";
import { TimelineWorkspace } from "../Workspace";
import { LIVE_AT, proofFixture, T0 } from "./fixture";

const params = new URLSearchParams(window.location.search);
const state = params.get("state") ?? "ready";
const theme = params.get("theme");
setTimeBase("wall");

const fx = proofFixture();
const ALL: TimelineSpan[] = [];
const seen = new Set<string>();
for (const node of fx.tree.byId.values()) {
  for (const lane of node.lanes) {
    for (const s of lane.spans) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      ALL.push(s);
    }
  }
}
const SPANS = state === "empty" ? [] : ALL;

const never = <T,>(): Promise<T> => new Promise<T>(() => undefined);
const loaded = performance.now();
const page = (spans: readonly TimelineSpan[]): SpanPage => ({ spans, truncated: false, total: spans.length, version: "states" });
const overlaps = (s: TimelineSpan, w: { from: number; to: number }) => (s.start?.at ?? 0) <= w.to && (s.end?.at ?? LIVE_AT) >= w.from;

const data: TimelineData = {
  source: "live",
  extent: () => (state === "empty" ? null : { from: T0, to: LIVE_AT }),
  spans: async (q) => {
    if (state === "loading" || (state === "refreshing" && performance.now() - loaded > 1500)) return never();
    if (state === "error") throw new Error("the observer answered 503 (catching up)");
    return page(SPANS.filter((s) => overlaps(s, q.window)));
  },
  span: async (id) => SPANS.find((s) => s.id === id) ?? null,
  structure: async () => {
    if (state === "loading") return never();
    return page(SPANS.filter((s) => ["wave", "cell", "round", "execution", "workflow"].includes(s.kind)));
  },
  marks: async (w) => (state === "empty" ? [] : fx.marks.filter((m) => m.at <= w.to && (m.until ?? m.at) >= w.from)),
  nextMark: async () => null,
  density: async (w) => ({ from: w.from, to: w.to, bucketMs: 60_000, buckets: [], complete: true }),
  concurrency: async (w) => ({ from: w.from, to: w.to, bucketMs: 60_000, buckets: [], limits: [], complete: true }),
  availability: () => ({ spans: state === "unserved" ? "unavailable" : "ok", marks: "ok", concurrency: "ok", density: "ok", unwindowed: false }),
  subscribe: () => () => undefined,
};

const log = createSceneLog({ definitions: { project: { id: "states", name: "Timeline states proof", integrationBranch: "main" }, waves: {}, slices: {} }, provenance: provenance("live", "hand-built fixture") });
const whole = { log, from: T0, to: Number.POSITIVE_INFINITY };
const store = createSceneStore({ source: "live", log, clock: browserClock(), windows: { start: () => T0, peek: () => whole, load: async () => whole } });
store.setLiveEdge(state === "empty" ? T0 + 60_000 : LIVE_AT);
store.setConnection({ ...INITIAL_CONNECTION, state: ["stale", "reconnecting", "disconnected", "no-session"].includes(state) ? (state as "stale") : "live" });
store.setWorkspace("timeline");
if (state === "behind") store.seek(LIVE_AT - 45 * 60_000);
if (state === "filtered") store.setTimelineView({ filters: { ...NO_FILTERS, tickets: ["LOCAL-999"] } });
if (state === "nothing") store.setTimelineView({ window: { from: T0 - 40 * 60_000, to: T0 - 20 * 60_000 } });

const root = document.getElementById("root");
if (!root) throw new Error("No #root element");
createRoot(root).render(
  <StrictMode>
    <ThemeProvider product="control-tower" persist={false} defaultPreference={theme === "light" || theme === "dark" ? (theme as ThemePreference) : "system"}>
      <TooltipProvider>
        <SceneStoreProvider store={store}>
          <div style={{ height: "100vh" }} data-states-proof={state}>
            <TimelineWorkspace data={data} />
          </div>
        </SceneStoreProvider>
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
