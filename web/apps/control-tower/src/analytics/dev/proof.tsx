/**
 * Development only, never built: the Factory Analytics workspace on the seeded, simulated fixture, at
 * /src/analytics/dev/proof.html on the dev server. No production code path knows about it (vite
 * builds index.html alone). Everything shown is labelled Simulated.
 *
 *   ?area=pulse|flow|quality|economics|reliability|compare|opportunities
 *   ?theme=light|dark                    pins the theme
 *   ?window=7d|14d|28d|all|<from>-<to>   (default: the whole history; a chosen interval is not served by the fixture)
 *   ?risk= ?app_type=                     shared filters
 *   ?model=                               Economics' model
 *   ?station=build                        Flow's selection
 *   ?pick=<dim>:<value>                   a cross-filter (outcome:failed, target_kind:web-trace, rule:…)
 *   ?cmp=<by>:<a>:<b>                     Compare's cohorts (by: risk|app_type|period|config)
 *   ?drill=<contributor key>              opens the Rows drawer (e.g. K1, C1|station=build)
 *   ?mode=empty|one|sparse|many|nolog     density: nothing recorded, one run, two runs, about 340 tickets, no lifecycle logs
 *   ?state=loading|error|unavailable|stale
 *   ?seed=<n>                             another simulated history
 */
import { StrictMode, useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, TooltipProvider, type ThemePreference } from "@mach/ui";
import "../../index.css";
import type { AnalyticsFilters, AnalyticsSnapshot, AppType, Risk, Station, WindowKey } from "../contract";
import type { InsightsReply } from "../data/types";
import { simulatedSnapshot } from "../fixtures";
import type { CohortBy } from "../model/cohorts";
import type { AreaId } from "../model/findings";
import { clockText } from "../model/format";
import { simulatedInsights } from "../model/insights";
import type { AreaData, RowsRequest, WindowChoice } from "../ui/types";
import { AnalyticsView, type AnalyticsUiView } from "../ui/Workspace";
import { emptySnapshot, ONE_RUN_RISK, repeatSnapshot, simulatedConfigs } from "./density";

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme");
const mode = params.get("mode");
const forced = params.get("state");
const seed = params.get("seed") ? Number(params.get("seed")) : undefined;
const opts = { seed, size: mode === "sparse" || mode === "one" || mode === "empty" ? ("sparse" as const) : ("full" as const), coverage: mode === "nolog" ? ("lifecycle-missing" as const) : ("normal" as const) };

function parseWindow(v: string | null): WindowChoice {
  if (!v) return "all";
  if (v === "7d" || v === "14d" || v === "28d" || v === "all") return v;
  const m = /^(\d+)-(\d+)$/.exec(v);
  return m ? { from: Number(m[1]), to: Number(m[2]) } : "all";
}
const winParam = (w: WindowChoice) => (typeof w === "string" ? w : `${w.from}-${w.to}`);

const pickOf = (v: string | null) => {
  const m = v ? /^([a-z_]+):(.+)$/.exec(v) : null;
  return m ? { dim: m[1] as "station", value: m[2]! } : null;
};
const cmpOf = (v: string | null) => {
  const m = v ? /^(risk|app_type|period|config):([^:]*):([^:]*)$/.exec(v) : null;
  return m ? { by: m[1] as CohortBy, a: m[2] || null, b: m[3] || null } : null;
};

const initial: AnalyticsUiView = {
  area: (params.get("area") as AreaId | null) ?? "pulse",
  window: parseWindow(params.get("window")),
  risk: params.get("risk"),
  appType: params.get("app_type"),
  model: params.get("model"),
  station: (params.get("station") as Station | null) ?? null,
  pick: pickOf(params.get("pick")),
  compare: cmpOf(params.get("cmp")),
  rows: params.get("drill") ? { key: params.get("drill")!, title: params.get("drill_title") ?? `Rows behind ${params.get("drill")}`, unit: (params.get("drill_unit") as RowsRequest["unit"] | null) ?? "count" } : null,
};

const LABELS: Readonly<Record<string, string>> = {
  empty: "Simulated project with nothing recorded",
  one: "Simulated project, one finished run",
  sparse: "Simulated project, two finished runs",
  many: "Simulated history, the seeded fixture repeated six times",
  nolog: "Simulated history without lifecycle logs",
};

function load(view: AnalyticsUiView, withModel: boolean): AreaData<AnalyticsSnapshot> {
  if (typeof view.window !== "string") return { state: "unavailable", reason: "The simulated fixture serves 7, 14 and 28 days and the whole history. A chosen interval is answered by the observer; use Undo or a preset to return." };
  if (mode === "many" && view.window !== "all") return { state: "unavailable", reason: "The repeated proof history serves the whole history only." };
  const filters: AnalyticsFilters = { window: view.window as WindowKey, risk: (mode === "one" ? ONE_RUN_RISK : view.risk) as Risk | null, app_type: view.appType as AppType | null, model: (withModel ? view.model : null) as AnalyticsFilters["model"] };
  const base = simulatedSnapshot(filters, opts);
  const value = mode === "empty" ? emptySnapshot(base) : mode === "many" ? repeatSnapshot(base, 6) : base;
  return { state: "ready", value, stale: forced === "stale" ? { reason: "The observer has stopped answering; the last figures it served are shown." } : null };
}

function App() {
  const [view, setView] = useState<AnalyticsUiView>(initial);
  const onView = useCallback((p: Partial<AnalyticsUiView>) => {
    setView((v) => {
      const next = { ...v, ...p };
      const q = new URLSearchParams(window.location.search);
      const put = (k: string, val: string | null) => (val ? q.set(k, val) : q.delete(k));
      put("area", next.area);
      put("window", winParam(next.window));
      put("risk", next.risk);
      put("app_type", next.appType);
      put("model", next.model);
      put("station", next.station);
      put("pick", next.pick ? `${next.pick.dim}:${next.pick.value}` : null);
      put("cmp", next.compare ? `${next.compare.by}:${next.compare.a ?? ""}:${next.compare.b ?? ""}` : null);
      put("drill", next.rows?.key ?? null);
      put("drill_title", next.rows?.title ?? null);
      put("drill_unit", next.rows?.unit ?? null);
      window.history.replaceState(null, "", `?${q.toString()}`);
      return next;
    });
  }, []);
  const data = useMemo<AreaData<AnalyticsSnapshot>>(() => {
    if (forced === "loading") return { state: "loading" };
    if (forced === "error") return { state: "error", status: 400, reason: "from_ms must be before to_ms." };
    if (forced === "unavailable") return { state: "unavailable", reason: "This observer is older than M6.5 and serves no analytics." };
    return load(view, view.area === "economics");
  }, [view]);
  const plain = useMemo(() => (view.area === "economics" ? load(view, false) : data), [view, data]);
  const insights = useMemo<AreaData<InsightsReply> | undefined>(() => (plain.state === "ready" ? { state: "ready", value: simulatedInsights(plain.value) } : undefined), [plain]);
  const configs = useMemo(() => (plain.state === "ready" ? simulatedConfigs(plain.value.runs) : undefined), [plain]);
  const generated = plain.state === "ready" ? plain.value.generated_at_ms : null;
  const [opened, setOpened] = useState<string | null>(null);
  return (
    <div className="flex h-screen flex-col">
      <div className="min-h-0 flex-1">
        <AnalyticsView
          data={data}
          {...(insights ? { insights } : {})}
          {...(configs ? { configs } : {})}
          source="simulation"
          asOf={generated !== null ? `As of ${clockText(generated)}` : "As of the newest simulated record"}
          sourceLabel={LABELS[mode ?? ""] ?? `Simulated history, seed ${seed ?? 6502}`}
          view={view}
          onView={onView}
          onOpen={(ref, where, interval) => setOpened(`${where}: ${ref}${interval ? ` (${clockText(interval.from)} to ${clockText(interval.to)})` : ""}`)}
        />
      </div>
      {opened ? (
        <p className="border-t border-line bg-surface-sunken px-4 py-1 text-caption text-ink-muted" role="status" data-proof-opened="">
          The Shell would open {opened}. This page only records the request.
        </p>
      ) : null}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider product="control-tower" persist={false} defaultPreference={(theme as ThemePreference | null) ?? "dark"}>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
