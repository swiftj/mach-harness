/**
 * The store's Analytics state (scene/analytics.ts `AnalyticsViewState`, which the address carries)
 * and the workspace's view (ui/Workspace.tsx `AnalyticsUiView`), both ways. Pure, erasable syntax
 * only: the unit tests load it directly (test/analytics-wire.test.mjs).
 *
 * - The period, the shared filters and the area are the same values under other names.
 * - The Rows drawer is the store's `focus` (a metric and at most one group): its title and unit are
 *   words the areas chose, so they are kept beside the store (`RowsMemo`), never in the address; a
 *   drawer restored from the address alone gets words derived from the catalog row.
 * - Compare's cohorts: a risk or an app type is written as the existing filter members; any other
 *   cohort (a recorded `config_id`, "not recorded", "mixed", a half of the period) as `by` and `key`.
 * - A pick is kept only for the dimensions the areas pick by.
 */
import {
  isAnalyticsAppType,
  isAnalyticsCohortBy,
  isAnalyticsCohortKey,
  isAnalyticsModel,
  isAnalyticsRisk,
  isAnalyticsStation,
  type AnalyticsCohort,
  type AnalyticsCompare,
  type AnalyticsFocus,
  type AnalyticsPick,
  type AnalyticsViewPatch,
  type AnalyticsViewState,
} from "../../scene/analytics";
import type { MetricRow } from "../contract";
import type { AnalyticsUiView } from "../ui/Workspace";
import type { CompareChoice, Pick, RowsRequest } from "../ui/types";

/** The dimensions an area picks by (ui/types.ts `Pick`). */
export const PICK_DIMS: readonly Pick["dim"][] = ["station", "model", "outcome", "target_kind", "rule"];

/** The Rows drawer's words for each key the areas opened, per store (the address never holds them). */
export type RowsMemo = Map<string, RowsRequest>;

// ------------------------------------------------------------------------------------ rows / focus

/** A contributors key (`C1`, `C1|station=build`, an insight's `R2|rule=x|risk=High`) as metric and groups. Null when malformed. */
export function parseRowsKey(key: string): { readonly metric: string; readonly group: Readonly<Record<string, string>> } | null {
  const [metric, ...parts] = key.split("|");
  if (!metric || !/^[A-Z][0-9]{1,2}[a-z]?$/.test(metric)) return null;
  const group: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq <= 0) return null;
    const dim = p.slice(0, eq);
    const value = p.slice(eq + 1);
    if (!/^[a-z][a-z_]{0,31}$/.test(dim) || !/^(?=.{1,128}$)[^\s\p{Cc},|]+(?: [^\s\p{Cc},|]+)*$/u.test(value) || dim in group) return null;
    group[dim] = value;
  }
  return { metric, group };
}

export function rowsKeyOf(focus: AnalyticsFocus): string {
  return focus.group ? `${focus.metric}|${focus.group.dim}=${focus.group.value}` : focus.metric;
}

/** The store's focus for a rows key; null when the store cannot hold it (more than one group: then the drawer is not in the address). */
export function focusOfRowsKey(key: string): AnalyticsFocus | null {
  const k = parseRowsKey(key);
  if (!k) return null;
  const groups = Object.entries(k.group);
  if (groups.length > 1) return null;
  const g = groups[0];
  return { metric: k.metric, group: g ? { dim: g[0], value: g[1] } : null };
}

/** The unit a contributor's value is shown in, from its catalog row. */
export function rowsUnitOf(row: Pick2<MetricRow, "kind" | "unit"> | undefined): RowsRequest["unit"] {
  if (!row) return "count";
  const unit = row.unit.toLowerCase();
  if (row.kind === "duration" || unit === "ms") return "ms";
  if (unit.includes("usd")) return "usd";
  if (unit.includes("token")) return "tokens";
  return "count";
}
type Pick2<T, K extends keyof T> = { readonly [P in K]: T[P] };

/** The drawer's request for the store's focus: the words the area chose (memo), else words from the catalog row. */
export function rowsOfFocus(focus: AnalyticsFocus | null, memo: RowsMemo | null, row: MetricRow | undefined): RowsRequest | null {
  if (!focus) return null;
  const key = rowsKeyOf(focus);
  const known = memo?.get(key);
  if (known) return known;
  const name = row?.name ?? focus.metric;
  return { key, title: focus.group ? `${name}: ${focus.group.dim.replace(/_/g, " ")} ${focus.group.value}` : name, unit: rowsUnitOf(row) };
}

// ------------------------------------------------------------------------------------------- compare

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/** One side as the area's cohort key. Risk as the observer and the simulation serve it ("High"). */
function sideKey(by: CompareChoice["by"], side: AnalyticsCohort): string | null {
  if (side.key !== undefined) return side.key;
  if (by === "risk" && side.risk) return capital(side.risk);
  if (by === "app_type" && side.appType) return side.appType;
  return null;
}

export function toUiCompare(c: AnalyticsCompare | null): CompareChoice | null {
  if (!c) return null;
  const by = c.a.by ?? c.b.by ?? (c.a.risk || c.b.risk ? "risk" : c.a.appType || c.b.appType ? "app_type" : null);
  if (!by) return null;
  return { by, a: sideKey(by, c.a), b: sideKey(by, c.b) };
}

function sideOf(by: CompareChoice["by"], key: string | null): AnalyticsCohort {
  if (key === null) return { by };
  if (by === "risk" && isAnalyticsRisk(key.toLowerCase()) && key === capital(key)) return { risk: key.toLowerCase() as AnalyticsCohort["risk"] & string };
  if (by === "app_type" && isAnalyticsAppType(key)) return { appType: key };
  if (isAnalyticsCohortKey(key)) return { by, key };
  return { by };
}

export function fromUiCompare(c: CompareChoice | null): AnalyticsCompare | null {
  if (!c || !isAnalyticsCohortBy(c.by)) return null;
  return { a: sideOf(c.by, c.a), b: sideOf(c.by, c.b) };
}

// ------------------------------------------------------------------------------------------- view

function pickOf(p: AnalyticsPick | null): Pick | null {
  return p && (PICK_DIMS as readonly string[]).includes(p.dim) ? { dim: p.dim as Pick["dim"], value: p.value } : null;
}

/** The workspace's view for the store's state. `rows` is the drawer of the store's focus (or an override the store cannot hold). */
export function toUiView(s: AnalyticsViewState, rows: RowsRequest | null): AnalyticsUiView {
  return {
    area: s.area,
    window: s.window,
    risk: s.filters.risk,
    appType: s.filters.appType,
    model: s.filters.model,
    station: s.filters.station,
    pick: pickOf(s.pick),
    compare: toUiCompare(s.compare),
    rows,
  };
}

/**
 * The store's patch for a change the workspace asked for. Invalid values are left out (the store
 * would ignore them anyway). `memo` learns the words of a drawer opened.
 */
export function fromUiPatch(p: Partial<AnalyticsUiView>, memo: RowsMemo | null): AnalyticsViewPatch {
  const filters: Record<string, string | null> = {};
  if (p.risk !== undefined) {
    const v = p.risk === null ? null : p.risk.toLowerCase();
    if (v === null || isAnalyticsRisk(v)) filters.risk = v;
  }
  if (p.appType !== undefined && (p.appType === null || isAnalyticsAppType(p.appType))) filters.appType = p.appType;
  if (p.model !== undefined && (p.model === null || isAnalyticsModel(p.model))) filters.model = p.model;
  if (p.station !== undefined && (p.station === null || isAnalyticsStation(p.station))) filters.station = p.station;
  let focus: AnalyticsFocus | null | undefined;
  if (p.rows !== undefined) {
    if (p.rows === null) focus = null;
    else {
      memo?.set(p.rows.key, p.rows);
      const k = parseRowsKey(p.rows.key);
      const g = k ? Object.entries(k.group)[0] : undefined;
      // An opportunity's rows: its id names them (and their population); the first group stays as a hint.
      focus = p.rows.insight !== undefined && k ? { metric: k.metric, group: g ? { dim: g[0], value: g[1] } : null, insight: p.rows.insight } : focusOfRowsKey(p.rows.key);
    }
  }
  return {
    ...(p.area !== undefined ? { area: p.area } : {}),
    ...(p.window !== undefined ? { window: p.window } : {}),
    ...(Object.keys(filters).length ? { filters: filters as AnalyticsViewPatch["filters"] } : {}),
    ...(p.pick !== undefined ? { pick: p.pick } : {}),
    ...(p.compare !== undefined ? { compare: fromUiCompare(p.compare) } : {}),
    ...(focus !== undefined ? { focus } : {}),
  };
}
