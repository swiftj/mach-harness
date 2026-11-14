/**
 * The address's hash, both ways (M6.3 design section 7). Pure: no window, no store.
 *
 *   #atlas?sel=<ref>&at=<event id | ms>&theater=1
 *   #blueprint?sel=<ref>&at=<event id | ms>&theater=1
 *   #timeline?sel=<ref>&at=<event id | ms>&win=<fromMs>-<toMs>|all&group=product|execution&lens=<id>&table=1
 *   #analytics?area=<area>&win=<preset>|<fromMs>-<toMs>&risk=&app=&model=&station=&sel=<ref>&at=&cmp=<cohort>~<cohort>&focus=<metric>[,<dim>:<value>]&pick=<dim>:<value>
 *
 * - `sel` uses the store's ref grammar (`<kind>:<id>`); anything else is ignored.
 * - `at`: all digits is a time in ms (the simulation's scenario ms, or Unix ms for real history);
 *   anything else is an event id (event ids always hold a letter or a colon: `sim:12`, `<key>:<line>`).
 * - `win`: two whole non-negative ms, the first before the second; or `all`, all of the history held
 *   (following the live edge); or `live-<ms>`, the last <ms> up to the live edge, following it (a lens
 *   chosen while following). Absent: the recorded activity (the default window). Timeline only.
 * - `group`: `product` or `execution`. Timeline only.
 * - `lens`: an investigation lens (`retries`, `concurrency`, `waits`, `review`, `recovery`). Timeline only.
 * - `table=1`: the Timeline as a table (the structured alternative). Timeline only.
 * - `theater=1`: the floor only (read, never written: as before M6.3).
 *
 * Analytics (M6.5 design section 4), its interface state (scene/analytics.ts) and nothing else:
 * - `area`: `pulse` (left out), `flow`, `quality`, `economics`, `reliability`, `compare`, `opportunities`.
 * - `win`: `7d`, `14d`, `28d`, `all` (left out: the whole recorded history), or `<fromMs>-<toMs>`.
 * - `risk`, `app`, `model`, `station`: one known value each (scene/analytics.ts lists them).
 * - `cmp`: two cohorts separated by `~`; a cohort is `*` (not narrowed) or comma-separated
 *   `risk:<v>`, `app:<v>`, `model:<v>`, `station:<v>`, `win:<preset | from-to>`, `by:<risk|app_type|period|config>`,
 *   `key:<code>` (a Compare cohort no filter names: `by:config,key:<config_id>`). An unknown member is
 *   dropped alone; a `cmp` without exactly two cohorts is dropped.
 * - `focus`: the metric whose rows are open (`K1`), or one group of it (`C1,station:build`); with
 *   `,insight:<id>` the rows of that Improvement Opportunity, over its own population.
 * - `pick`: a cross-filter picked inside an area, `<dim>:<value>` (`target_kind:browser`).
 * The address describes the whole view: a parameter left out is its default. `sel` and `at` are shared
 * with every route.
 * Unknown parameters are ignored; a malformed one is dropped on its own and never throws.
 */
import type { EntityRef } from "../../sim";
import type { LensId } from "../../timeline/contract";
import {
  INITIAL_ANALYTICS_VIEW,
  NO_ANALYTICS_FILTERS,
  isAnalyticsAppType,
  isAnalyticsArea,
  isAnalyticsCohortBy,
  isAnalyticsCohortKey,
  isAnalyticsFocus,
  isAnalyticsModel,
  isAnalyticsPick,
  isAnalyticsRisk,
  isAnalyticsStation,
  isAnalyticsWindow,
  ANALYTICS_WINDOW_PRESETS,
  type AnalyticsCohort,
  type AnalyticsCompare,
  type AnalyticsFocus,
  type AnalyticsPick,
  type AnalyticsViewState,
  type AnalyticsWindow,
} from "../../scene/analytics";

/** The lens ids the address accepts (the contract's LensId). */
export const HASH_LENSES: readonly LensId[] = ["retries", "concurrency", "waits", "review", "recovery"];
/** `win=all`: the whole history held, following the live edge (the store keeps it as an unbounded window). */
export const WIN_ALL = { from: Number.NEGATIVE_INFINITY, to: Number.POSITIVE_INFINITY } as const;

export type HashRoute = "atlas" | "blueprint" | "timeline" | "analytics";
export type HashAt = { readonly kind: "event"; readonly id: string } | { readonly kind: "ms"; readonly ms: number };

export interface HashState {
  /** Null when the hash names no known route (the app keeps what it has). */
  readonly route: HashRoute | null;
  readonly sel: EntityRef | null;
  readonly at: HashAt | null;
  readonly win: { readonly from: number; readonly to: number } | null;
  readonly group: "product" | "execution" | null;
  readonly lens: LensId | null;
  readonly table: boolean;
  readonly theater: boolean;
  /** Analytics' whole interface state, defaults filled in. Null unless the route is `analytics`. */
  readonly analytics: AnalyticsViewState | null;
}

const REF = /^[a-z]+:.+/;
const MS = /^\d{1,16}$/;
const WIN = /^(\d{1,16})-(\d{1,16})$/;
const WIN_LIVE = /^live-(\d{1,16})$/;
/** Longer than any event id the observer writes, short enough that a pasted essay is not one. */
const MAX_ID = 512;

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return null;
  }
}

/** Query parameters, first value wins, each decoded on its own (one bad escape spoils only itself). */
function params(query: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of query.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = safeDecode(eq < 0 ? part : part.slice(0, eq));
    const value = safeDecode(eq < 0 ? "" : part.slice(eq + 1));
    if (key === null || value === null || out.has(key)) continue;
    out.set(key, value);
  }
  return out;
}

export function parseAt(value: string | null | undefined): HashAt | null {
  if (!value) return null;
  const v = value.trim();
  if (!v || v.length > MAX_ID) return null;
  if (MS.test(v)) {
    const ms = Number(v);
    return Number.isSafeInteger(ms) ? { kind: "ms", ms } : null;
  }
  // No whitespace or control characters in an id.
  if (/[\s\p{Cc}]/u.test(v)) return null;
  return { kind: "event", id: v };
}

export function parseWin(value: string | null | undefined): { from: number; to: number } | null {
  if (value && value.trim() === "all") return { ...WIN_ALL };
  const live = value ? WIN_LIVE.exec(value.trim()) : null;
  if (live) {
    const length = Number(live[1]);
    // The store's following window (timeline/controls followWindow): `{ from: -length, to: +Infinity }`.
    return Number.isSafeInteger(length) && length > 0 ? { from: -length, to: Number.POSITIVE_INFINITY } : null;
  }
  const m = value ? WIN.exec(value.trim()) : null;
  if (!m) return null;
  const from = Number(m[1]);
  const to = Number(m[2]);
  return Number.isSafeInteger(from) && Number.isSafeInteger(to) && to > from ? { from, to } : null;
}

export function parseHash(hash: string): HashState {
  const raw = typeof hash === "string" ? hash.replace(/^#/, "") : "";
  const q = raw.indexOf("?");
  const head = q < 0 ? raw : raw.slice(0, q);
  const query = q < 0 ? "" : raw.slice(q + 1);
  const route: HashRoute | null = head === "atlas" || head === "blueprint" || head === "timeline" || head === "analytics" ? head : null;
  const p = params(query);
  const selRaw = p.get("sel") ?? null;
  const sel = selRaw && REF.test(selRaw) && selRaw.length <= MAX_ID ? (selRaw as EntityRef) : null;
  const timeline = route === "timeline";
  const group = p.get("group");
  const lens = p.get("lens") as LensId | undefined;
  return {
    route,
    sel,
    at: parseAt(p.get("at")),
    win: timeline ? parseWin(p.get("win")) : null,
    group: timeline && (group === "product" || group === "execution") ? group : null,
    lens: timeline && lens && HASH_LENSES.includes(lens) ? lens : null,
    table: timeline && p.get("table") === "1",
    theater: !timeline && route !== "analytics" && p.get("theater") === "1",
    analytics: route === "analytics" ? parseAnalytics(p) : null,
  };
}

// ---------------------------------------------------------------- Analytics

const COHORT_KEYS: Readonly<Record<string, keyof AnalyticsCohort>> = { risk: "risk", app: "appType", model: "model", station: "station", win: "window", by: "by", key: "key" };

export function parseAnalyticsWindow(value: string | null | undefined): AnalyticsWindow | null {
  if (!value) return null;
  const v = value.trim();
  if ((ANALYTICS_WINDOW_PRESETS as readonly string[]).includes(v)) return v as AnalyticsWindow;
  const m = WIN.exec(v);
  if (!m) return null;
  const w = { from: Number(m[1]), to: Number(m[2]) };
  return isAnalyticsWindow(w) ? w : null;
}

function formatAnalyticsWindow(w: AnalyticsWindow): string {
  return typeof w === "string" ? w : `${Math.round(w.from)}-${Math.round(w.to)}`;
}

/** One cohort: `*` or `key:value,...`. Unknown keys and values dropped alone. */
function parseCohort(text: string): AnalyticsCohort {
  const out: Record<string, unknown> = {};
  const t = text.trim();
  if (t === "*" || t === "") return out;
  for (const part of t.split(",")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const key = COHORT_KEYS[part.slice(0, colon).trim()];
    const value = part.slice(colon + 1).trim();
    if (!key || key in out) continue;
    if (key === "window") {
      const w = parseAnalyticsWindow(value);
      if (w !== null) out.window = w;
    } else if (key === "risk" ? isAnalyticsRisk(value) : key === "appType" ? isAnalyticsAppType(value) : key === "model" ? isAnalyticsModel(value) : key === "by" ? isAnalyticsCohortBy(value) : key === "key" ? isAnalyticsCohortKey(value) : isAnalyticsStation(value)) out[key] = value;
  }
  return out;
}

function formatCohort(c: AnalyticsCohort): string {
  const parts: string[] = [];
  for (const [word, key] of Object.entries(COHORT_KEYS)) {
    const v = c[key];
    if (v === undefined) continue;
    parts.push(`${word}:${key === "window" ? formatAnalyticsWindow(v as AnalyticsWindow) : (v as string)}`);
  }
  return parts.length ? parts.join(",") : "*";
}

export function parseAnalyticsCompare(value: string | null | undefined): AnalyticsCompare | null {
  if (!value || value.length > MAX_ID) return null;
  const sides = value.split("~");
  if (sides.length !== 2) return null;
  return { a: parseCohort(sides[0] as string), b: parseCohort(sides[1] as string) };
}

export function parseAnalyticsFocus(value: string | null | undefined): AnalyticsFocus | null {
  if (!value || value.length > MAX_ID) return null;
  const parts = value.split(",");
  const metric = (parts[0] ?? "").trim();
  let group: AnalyticsFocus["group"] = null;
  let insight: string | undefined;
  for (const part of parts.slice(1)) {
    // `insight:<id>`: the opportunity whose rows these are (its id may itself hold colons).
    if (part.startsWith("insight:") && insight === undefined) {
      insight = part.slice(8);
      continue;
    }
    const colon = part.indexOf(":");
    if (colon < 0 || group) return null;
    group = { dim: part.slice(0, colon), value: part.slice(colon + 1) };
  }
  const focus = { metric, group, ...(insight !== undefined ? { insight } : {}) };
  return isAnalyticsFocus(focus) ? focus : null;
}

export function parseAnalyticsPick(value: string | null | undefined): AnalyticsPick | null {
  if (!value || value.length > MAX_ID) return null;
  const colon = value.indexOf(":");
  if (colon < 0) return null;
  const pick = { dim: value.slice(0, colon), value: value.slice(colon + 1) };
  return isAnalyticsPick(pick) ? pick : null;
}

function formatAnalyticsFocus(f: AnalyticsFocus): string {
  return `${f.group ? `${f.metric},${f.group.dim}:${f.group.value}` : f.metric}${f.insight !== undefined ? `,insight:${f.insight}` : ""}`;
}

/** The Analytics view an address describes: every parameter left out (or malformed) is its default. */
function parseAnalytics(p: Map<string, string>): AnalyticsViewState {
  const area = p.get("area");
  const risk = p.get("risk");
  const app = p.get("app");
  const model = p.get("model");
  const station = p.get("station");
  return {
    area: isAnalyticsArea(area) ? area : INITIAL_ANALYTICS_VIEW.area,
    window: parseAnalyticsWindow(p.get("win")) ?? INITIAL_ANALYTICS_VIEW.window,
    filters: {
      ...NO_ANALYTICS_FILTERS,
      risk: isAnalyticsRisk(risk) ? risk : null,
      appType: isAnalyticsAppType(app) ? app : null,
      model: isAnalyticsModel(model) ? model : null,
      station: isAnalyticsStation(station) ? station : null,
    },
    compare: parseAnalyticsCompare(p.get("cmp")),
    focus: parseAnalyticsFocus(p.get("focus")),
    pick: parseAnalyticsPick(p.get("pick")),
  };
}

/** A value written into the address: escaped, except the grammar's own `:` and `,` (kept readable). */
const enc = (v: string): string => encodeURIComponent(v).replace(/%3A/gi, ":").replace(/%2C/gi, ",");

/** Analytics' parameters before `sel` and `at` (the design's order), defaults left out. */
function formatAnalyticsHead(a: AnalyticsViewState): string[] {
  const parts: string[] = [];
  if (a.area !== INITIAL_ANALYTICS_VIEW.area) parts.push(`area=${a.area}`);
  if (a.window !== INITIAL_ANALYTICS_VIEW.window) parts.push(`win=${formatAnalyticsWindow(a.window)}`);
  if (a.filters.risk) parts.push(`risk=${a.filters.risk}`);
  if (a.filters.appType) parts.push(`app=${a.filters.appType}`);
  if (a.filters.model) parts.push(`model=${a.filters.model}`);
  if (a.filters.station) parts.push(`station=${a.filters.station}`);
  return parts;
}

/** Analytics' parameters after `sel` and `at`. */
function formatAnalyticsTail(a: AnalyticsViewState): string[] {
  const parts: string[] = [];
  if (a.compare) parts.push(`cmp=${enc(`${formatCohort(a.compare.a)}~${formatCohort(a.compare.b)}`)}`);
  if (a.focus) parts.push(`focus=${enc(formatAnalyticsFocus(a.focus))}`);
  if (a.pick) parts.push(`pick=${enc(`${a.pick.dim}:${a.pick.value}`)}`);
  return parts;
}

export interface HashWrite {
  readonly route: HashRoute;
  readonly sel: EntityRef | null;
  /** Already settled by the caller: written only while the playhead is held still. */
  readonly at: HashAt | null;
  readonly win: { readonly from: number; readonly to: number } | null;
  readonly group: "product" | "execution";
  readonly lens?: LensId | null;
  readonly table?: boolean;
  /** Written when the route is `analytics`. */
  readonly analytics?: AnalyticsViewState;
}

export function formatAt(at: HashAt): string {
  return at.kind === "ms" ? String(Math.round(at.ms)) : encodeURIComponent(at.id);
}

/** The hash for a state. Parameters in a fixed order; the default grouping is left out. */
export function formatHash(w: HashWrite): string {
  const parts: string[] = [];
  const analytics = w.route === "analytics" ? (w.analytics ?? INITIAL_ANALYTICS_VIEW) : null;
  if (analytics) parts.push(...formatAnalyticsHead(analytics));
  if (w.sel) parts.push(`sel=${encodeURIComponent(w.sel)}`);
  if (w.at) parts.push(`at=${formatAt(w.at)}`);
  if (analytics) parts.push(...formatAnalyticsTail(analytics));
  if (w.route === "timeline") {
    if (w.win) parts.push(Number.isFinite(w.win.from) && Number.isFinite(w.win.to) ? `win=${Math.round(w.win.from)}-${Math.round(w.win.to)}` : Number.isFinite(w.win.from) && w.win.from < 0 ? `win=live-${Math.round(-w.win.from)}` : "win=all");
    if (w.group !== "product") parts.push(`group=${w.group}`);
    if (w.lens) parts.push(`lens=${w.lens}`);
    if (w.table) parts.push("table=1");
  }
  return `#${w.route}${parts.length ? `?${parts.join("&")}` : ""}`;
}
