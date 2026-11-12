/**
 * Development only, never built: the Factory Atlas on a live store fed by the store's test fixture
 * generator (test/fixtures/v3.mjs, through make-live-fixture.mjs), at /src/atlas/dev/live.html.
 * No production code path knows about it.
 *
 *   ?scenario=twelve|three   which history (default twelve)
 *   ?at=0.3                  where the live edge starts, as a fraction of the history
 *   ?speed=1                 how fast the edge then moves (factory ms per wall ms); 0 holds it
 *   ?stale=1                 the connection goes quiet (reconnecting) after the first feed
 *   ?theme=light|dark  ?meter
 *
 * window.__atlasLive: { store, log, feedTo(t), stale(on), count() } for a Playwright script.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, TooltipProvider, type ThemePreference } from "@mach/ui";
import "../../index.css";
import { AtlasView } from "..";
import { INITIAL_CONNECTION, SceneStoreProvider, browserClock, createSceneStore } from "../../scene";
import { createSceneLog, provenance, type EngineEvent } from "../../sim";

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme");
const scenario = params.get("scenario") === "three" ? "three" : "twelve";

const response = await fetch("/node_modules/.cache/atlas-live/fixture.json");
if (!response.ok) throw new Error("Run node src/atlas/dev/make-live-fixture.mjs first.");
const all = ((await response.json()) as Record<string, EngineEvent[]>)[scenario] ?? [];
const timeOf = (e: EngineEvent) => (e as unknown as { time: { order_ms: number } }).time.order_ms;
const t0 = Math.min(...all.map(timeOf));
const t1 = Math.max(...all.map(timeOf));

const log = createSceneLog({ definitions: { project: { id: "dev", name: "Atlas live dev", integrationBranch: "main" }, waves: {}, slices: {} }, provenance: provenance("live", "test fixture") });
const store = createSceneStore({ source: "live", log, clock: browserClock() });
let fed = 0;
let edge = t0;
function feedTo(t: number) {
  const batch: EngineEvent[] = [];
  while (fed < all.length && timeOf(all[fed]!) <= t) batch.push(all[fed++]!);
  if (batch.length) {
    log.ingest(batch);
    store.logChanged();
  }
  edge = Math.max(edge, t);
  store.setLiveEdge(edge);
}
function stale(on: boolean) {
  const conn = store.getState().connection ?? INITIAL_CONNECTION;
  store.setConnection({ ...conn, state: on ? "reconnecting" : "live", staleSince: on ? edge : null, attempts: on ? 2 : 0 });
}
store.setConnection({ ...INITIAL_CONNECTION, state: "live" });
feedTo(t0 + (t1 - t0) * Number(params.get("at") ?? 0.3));
if (params.get("stale") === "1") stale(true);

const speed = Number(params.get("speed") ?? 1);
let last = performance.now();
function tick(now: number) {
  const dt = now - last;
  last = now;
  if (speed > 0 && store.getState().connection?.state === "live") feedTo(edge + dt * speed);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

Object.defineProperty(window, "__atlasLive", {
  value: { store, log, feedTo, stale, count: () => document.querySelectorAll(".atlas-camera svg *").length, t0, t1 },
  configurable: true,
});

function Stamp() {
  return (
    <div style={{ position: "fixed", left: 16, top: 16, padding: "3px 8px", borderRadius: 4, background: "var(--mach-info-soft)", border: "1px solid var(--mach-info-line)", color: "var(--mach-info-ink)", font: "700 11px/1.4 var(--mach-font-sans)", letterSpacing: "0.04em", pointerEvents: "none" }}>
      LIVE STORE · TEST FIXTURE ({scenario}) · Factory Atlas dev page
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("No #root element");
createRoot(root).render(
  <StrictMode>
    <ThemeProvider product="control-tower" persist={false} defaultPreference={theme === "light" || theme === "dark" ? (theme as ThemePreference) : "system"}>
      <TooltipProvider>
        <SceneStoreProvider store={store}>
          <main style={{ position: "fixed", inset: 0 }}>
            <AtlasView meter={params.has("meter")} />
            <Stamp />
          </main>
        </SceneStoreProvider>
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
