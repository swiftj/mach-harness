/**
 * The Factory Analytics workspace's interface state (M6.5 design section 4), kept in the scene store
 * (`state.analytics`) so it survives a workspace switch and is written to the address. Interface state
 * only: the area on screen, the period, the shared filters, a comparison and the metric whose rows are
 * open. Selection, hover, the camera's focus and the playhead stay the store's own; nothing here is a
 * second selection, and nothing here changes what another workspace shows.
 *
 * Every value is checked here (`applyAnalyticsPatch`): an unknown area, filter value or malformed
 * window is ignored, never thrown on and never stored. Plain `.ts` with erasable syntax only, so the
 * unit tests load it directly.
 */

export const ANALYTICS_AREAS = ["pulse", "flow", "quality", "economics", "reliability", "compare", "opportunities"] as const;
export type AnalyticsArea = (typeof ANALYTICS_AREAS)[number];

/** The areas' names as the chrome and the announcer say them. */
export const ANALYTICS_AREA_WORDS: Readonly<Record<AnalyticsArea, string>> = {
  pulse: "Factory Pulse",
  flow: "Flow and bottlenecks",
  quality: "Quality and remediation",
  economics: "Agent and model economics",
  reliability: "Reliability and autonomy",
  compare: "Compare",
  opportunities: "Improvement opportunities",
};

/** A period ending at the newest record the source holds (or at the playhead: see the shell's `analyticsAsOf`). `all`: the whole recorded history. */
export const ANALYTICS_WINDOW_PRESETS = ["7d", "14d", "28d", "all"] as const;
export type AnalyticsWindowPreset = (typeof ANALYTICS_WINDOW_PRESETS)[number];
/** A chosen interval, in the source's own time (the simulation's scenario ms; Unix ms for real history), `from < to`. */
export interface AnalyticsRange {
  readonly from: number;
  readonly to: number;
}
export type AnalyticsWindow = AnalyticsWindowPreset | AnalyticsRange;

export const ANALYTICS_RISKS = ["low", "medium", "high"] as const;
export type AnalyticsRisk = (typeof ANALYTICS_RISKS)[number];
/** The app types a cell records (`cell.json` `app_type`). */
export const ANALYTICS_APP_TYPES = ["web", "cli", "api", "grpc", "rest", "desktop", "mobile", "library"] as const;
export type AnalyticsAppType = (typeof ANALYTICS_APP_TYPES)[number];
/** Model tiers (the family a recorded model id belongs to). */
export const ANALYTICS_MODELS = ["fable", "opus", "sonnet", "haiku"] as const;
export type AnalyticsModel = (typeof ANALYTICS_MODELS)[number];
/** The stations MACH records visits for, in belt order. `human` is the approval wait between review and merge. */
export const ANALYTICS_STATIONS = ["groom", "plan", "audit", "build", "verify", "review", "human", "merge", "cleanup"] as const;
export type AnalyticsStation = (typeof ANALYTICS_STATIONS)[number];

/** The shared filters. Null: not narrowed. One value each. */
export interface AnalyticsFilters {
  readonly risk: AnalyticsRisk | null;
  readonly appType: AnalyticsAppType | null;
  readonly model: AnalyticsModel | null;
  readonly station: AnalyticsStation | null;
}

/** How Compare groups finished tickets when a cohort is not a plain filter: by risk, app type, time period or recorded execution configuration. */
export const ANALYTICS_COHORT_BYS = ["risk", "app_type", "period", "config"] as const;
export type AnalyticsCohortBy = (typeof ANALYTICS_COHORT_BYS)[number];

/**
 * One side of a comparison: the filters and period that define the group. Absent: not narrowed (the shared value is not inherited).
 * `by` and `key` name a cohort no filter can (a recorded `config_id`, "configuration not recorded", "more than one configuration",
 * the earlier or later half of the period, a risk or app type that was not recorded): a code, never prose.
 */
export interface AnalyticsCohort {
  readonly risk?: AnalyticsRisk;
  readonly appType?: AnalyticsAppType;
  readonly model?: AnalyticsModel;
  readonly station?: AnalyticsStation;
  readonly window?: AnalyticsWindow;
  readonly by?: AnalyticsCohortBy;
  readonly key?: string;
}
export interface AnalyticsCompare {
  readonly a: AnalyticsCohort;
  readonly b: AnalyticsCohort;
}

/** The figure whose rows the drill-down panel lists: a catalog metric id, optionally one group of it (`C1` by `station` = `build`). */
export interface AnalyticsFocus {
  readonly metric: string;
  readonly group: { readonly dim: string; readonly value: string } | null;
}

/** A cross-filter picked inside an area (a Reliability outcome, a Q4 failure category, an R2 rule): one dimension and value. */
export interface AnalyticsPick {
  readonly dim: string;
  readonly value: string;
}

export interface AnalyticsViewState {
  readonly area: AnalyticsArea;
  readonly window: AnalyticsWindow;
  readonly filters: AnalyticsFilters;
  readonly compare: AnalyticsCompare | null;
  readonly focus: AnalyticsFocus | null;
  readonly pick: AnalyticsPick | null;
}

/** A change to the view. `filters` merges key by key (null clears a key); `compare` and `focus` replace (null clears). */
export interface AnalyticsViewPatch {
  readonly area?: AnalyticsArea;
  readonly window?: AnalyticsWindow;
  readonly filters?: Partial<AnalyticsFilters>;
  readonly compare?: AnalyticsCompare | null;
  readonly focus?: AnalyticsFocus | null;
  readonly pick?: AnalyticsPick | null;
}

export const NO_ANALYTICS_FILTERS: AnalyticsFilters = Object.freeze({ risk: null, appType: null, model: null, station: null });

/** The whole recorded history, Factory Pulse, nothing narrowed. */
export const INITIAL_ANALYTICS_VIEW: AnalyticsViewState = Object.freeze({
  area: "pulse",
  window: "all",
  filters: NO_ANALYTICS_FILTERS,
  compare: null,
  focus: null,
  pick: null,
});

// ---------------------------------------------------------------- checking values

const has = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

export const isAnalyticsArea = (v: unknown): v is AnalyticsArea => has(ANALYTICS_AREAS, v);
export const isAnalyticsRisk = (v: unknown): v is AnalyticsRisk => has(ANALYTICS_RISKS, v);
export const isAnalyticsAppType = (v: unknown): v is AnalyticsAppType => has(ANALYTICS_APP_TYPES, v);
export const isAnalyticsModel = (v: unknown): v is AnalyticsModel => has(ANALYTICS_MODELS, v);
export const isAnalyticsStation = (v: unknown): v is AnalyticsStation => has(ANALYTICS_STATIONS, v);

export function isAnalyticsWindow(v: unknown): v is AnalyticsWindow {
  if (has(ANALYTICS_WINDOW_PRESETS, v)) return true;
  if (!v || typeof v !== "object") return false;
  const { from, to } = v as { from?: unknown; to?: unknown };
  return typeof from === "number" && typeof to === "number" && Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 0 && to > from;
}

/** A catalog metric id's shape (`T1`, `W2b`, `K10`); the catalog itself is not known here. */
const METRIC = /^[A-Z][0-9]{1,2}[a-z]?$/;
const DIM = /^[a-z][a-z_]{0,31}$/;
/**
 * A group's value: a code as the observer serves it, at most 128 characters, with no control characters
 * or commas (the address's separator) and no whitespace but single inner spaces (the observer's failure
 * kinds are codes like `matrix rule`).
 */
const VALUE = /^(?=.{1,128}$)[^\s\p{Cc},]+(?: [^\s\p{Cc},]+)*$/u;

export function isAnalyticsFocus(v: unknown): v is AnalyticsFocus {
  if (!v || typeof v !== "object") return false;
  const { metric, group } = v as { metric?: unknown; group?: unknown };
  if (typeof metric !== "string" || !METRIC.test(metric)) return false;
  if (group === null || group === undefined) return true;
  if (typeof group !== "object") return false;
  const { dim, value } = group as { dim?: unknown; value?: unknown };
  return typeof dim === "string" && DIM.test(dim) && typeof value === "string" && VALUE.test(value);
}

export function isAnalyticsPick(v: unknown): v is AnalyticsPick {
  if (!v || typeof v !== "object") return false;
  const { dim, value } = v as { dim?: unknown; value?: unknown };
  return typeof dim === "string" && DIM.test(dim) && typeof value === "string" && VALUE.test(value);
}

export function sameAnalyticsPick(a: AnalyticsPick | null, b: AnalyticsPick | null): boolean {
  return a === b || (a !== null && b !== null && a.dim === b.dim && a.value === b.value);
}

/** A cohort key: a code (letters, digits, `-`, `_`, `.`), at most 64 characters. */
const COHORT_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const isAnalyticsCohortBy = (v: unknown): v is AnalyticsCohortBy => has(ANALYTICS_COHORT_BYS, v);
export const isAnalyticsCohortKey = (v: unknown): v is string => typeof v === "string" && COHORT_KEY.test(v);

const COHORT_KEYS = ["risk", "appType", "model", "station", "window", "by", "key"] as const;
const COHORT_CHECK: Readonly<Record<(typeof COHORT_KEYS)[number], (v: unknown) => boolean>> = {
  risk: isAnalyticsRisk,
  appType: isAnalyticsAppType,
  model: isAnalyticsModel,
  station: isAnalyticsStation,
  window: isAnalyticsWindow,
  by: isAnalyticsCohortBy,
  key: isAnalyticsCohortKey,
};

/** The cohort with only its valid members (unknown keys and values dropped). */
export function cleanAnalyticsCohort(v: unknown): AnalyticsCohort {
  const out: Record<string, unknown> = {};
  if (!v || typeof v !== "object") return out;
  for (const k of COHORT_KEYS) {
    const value = (v as Record<string, unknown>)[k];
    if (value !== undefined && COHORT_CHECK[k](value)) out[k] = typeof value === "object" ? { ...(value as AnalyticsRange) } : value;
  }
  return out;
}

export function sameAnalyticsWindow(a: AnalyticsWindow | undefined, b: AnalyticsWindow | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || typeof a === "string" || typeof b === "string") return false;
  return a.from === b.from && a.to === b.to;
}

export function sameAnalyticsCohort(a: AnalyticsCohort, b: AnalyticsCohort): boolean {
  return COHORT_KEYS.every((k) => (k === "window" ? sameAnalyticsWindow(a.window, b.window) : a[k] === b[k]));
}

export function sameAnalyticsFocus(a: AnalyticsFocus | null, b: AnalyticsFocus | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.metric !== b.metric) return false;
  return a.group === b.group || (a.group !== null && b.group !== null && a.group.dim === b.group.dim && a.group.value === b.group.value);
}

export function sameAnalyticsCompare(a: AnalyticsCompare | null, b: AnalyticsCompare | null): boolean {
  return a === b || (a !== null && b !== null && sameAnalyticsCohort(a.a, b.a) && sameAnalyticsCohort(a.b, b.b));
}

export function sameAnalyticsView(a: AnalyticsViewState, b: AnalyticsViewState): boolean {
  return (
    a.area === b.area &&
    sameAnalyticsWindow(a.window, b.window) &&
    a.filters.risk === b.filters.risk &&
    a.filters.appType === b.filters.appType &&
    a.filters.model === b.filters.model &&
    a.filters.station === b.filters.station &&
    sameAnalyticsCompare(a.compare, b.compare) &&
    sameAnalyticsFocus(a.focus, b.focus) &&
    sameAnalyticsPick(a.pick, b.pick)
  );
}

const FILTER_CHECK: Readonly<Record<keyof AnalyticsFilters, (v: unknown) => boolean>> = {
  risk: isAnalyticsRisk,
  appType: isAnalyticsAppType,
  model: isAnalyticsModel,
  station: isAnalyticsStation,
};

/**
 * `current` with `patch` applied. Invalid members of the patch are ignored one by one (the rest still
 * applies). Returns `current` itself when nothing changes, so the store can skip the notification.
 */
export function applyAnalyticsPatch(current: AnalyticsViewState, patch: AnalyticsViewPatch | null | undefined): AnalyticsViewState {
  if (!patch || typeof patch !== "object") return current;
  let area = current.area;
  let window = current.window;
  let filters = current.filters;
  let compare = current.compare;
  let focus = current.focus;
  let pick = current.pick;
  if (patch.area !== undefined && isAnalyticsArea(patch.area)) area = patch.area;
  if (patch.window !== undefined && isAnalyticsWindow(patch.window) && !sameAnalyticsWindow(patch.window, current.window)) window = typeof patch.window === "string" ? patch.window : { from: patch.window.from, to: patch.window.to };
  if (patch.filters && typeof patch.filters === "object") {
    const next: Record<string, unknown> = { ...current.filters };
    for (const k of Object.keys(FILTER_CHECK) as Array<keyof AnalyticsFilters>) {
      const v = (patch.filters as Record<string, unknown>)[k];
      if (v === undefined) continue;
      if (v === null || FILTER_CHECK[k](v)) next[k] = v;
    }
    const changed = (Object.keys(FILTER_CHECK) as Array<keyof AnalyticsFilters>).some((k) => next[k] !== current.filters[k]);
    if (changed) filters = Object.freeze(next) as unknown as AnalyticsFilters;
  }
  if (patch.compare !== undefined) {
    if (patch.compare === null) compare = null;
    else if (typeof patch.compare === "object") {
      const next = { a: cleanAnalyticsCohort(patch.compare.a), b: cleanAnalyticsCohort(patch.compare.b) };
      if (!sameAnalyticsCompare(next, current.compare)) compare = next;
    }
  }
  if (patch.focus !== undefined) {
    if (patch.focus === null) focus = null;
    else if (isAnalyticsFocus(patch.focus) && !sameAnalyticsFocus(patch.focus, current.focus)) focus = { metric: patch.focus.metric, group: patch.focus.group ? { dim: patch.focus.group.dim, value: patch.focus.group.value } : null };
  }
  if (patch.pick !== undefined) {
    if (patch.pick === null) pick = null;
    else if (isAnalyticsPick(patch.pick) && !sameAnalyticsPick(patch.pick, current.pick)) pick = { dim: patch.pick.dim, value: patch.pick.value };
  }
  if (area === current.area && window === current.window && filters === current.filters && compare === current.compare && focus === current.focus && pick === current.pick) return current;
  return { area, window, filters, compare, focus, pick };
}

/**
 * The Analytics station for one of the floor's station kinds (`@mach/ui` StationKind): `human-approval`
 * is the approval wait (`human`); the intake and observe stations record no visits, so they have none.
 */
export function analyticsStationOf(kind: string): AnalyticsStation | null {
  if (kind === "human-approval") return "human";
  return isAnalyticsStation(kind) ? kind : null;
}
