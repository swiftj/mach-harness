/**
 * The address's hash, both ways (M6.3 design section 7). Pure: no window, no store.
 *
 *   #atlas?sel=<ref>&at=<event id | ms>&theater=1
 *   #blueprint?sel=<ref>&at=<event id | ms>&theater=1
 *   #timeline?sel=<ref>&at=<event id | ms>&win=<fromMs>-<toMs>&group=product|execution
 *
 * - `sel` uses the store's ref grammar (`<kind>:<id>`); anything else is ignored.
 * - `at`: all digits is a time in ms (the simulation's scenario ms, or Unix ms for real history);
 *   anything else is an event id (event ids always hold a letter or a colon: `sim:12`, `<key>:<line>`).
 * - `win`: two whole non-negative ms, the first before the second. Timeline only.
 * - `group`: `product` or `execution`. Timeline only.
 * - `theater=1`: the floor only (read, never written: as before M6.3).
 * Unknown parameters are ignored; a malformed one is dropped on its own and never throws.
 */
import type { EntityRef } from "../../sim";

export type HashRoute = "atlas" | "blueprint" | "timeline";
export type HashAt = { readonly kind: "event"; readonly id: string } | { readonly kind: "ms"; readonly ms: number };

export interface HashState {
  /** Null when the hash names no known route (the app keeps what it has). */
  readonly route: HashRoute | null;
  readonly sel: EntityRef | null;
  readonly at: HashAt | null;
  readonly win: { readonly from: number; readonly to: number } | null;
  readonly group: "product" | "execution" | null;
  readonly theater: boolean;
}

const REF = /^[a-z]+:.+/;
const MS = /^\d{1,16}$/;
const WIN = /^(\d{1,16})-(\d{1,16})$/;
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
  const route: HashRoute | null = head === "atlas" || head === "blueprint" || head === "timeline" ? head : null;
  const p = params(query);
  const selRaw = p.get("sel") ?? null;
  const sel = selRaw && REF.test(selRaw) && selRaw.length <= MAX_ID ? (selRaw as EntityRef) : null;
  const timeline = route === "timeline";
  const group = p.get("group");
  return {
    route,
    sel,
    at: parseAt(p.get("at")),
    win: timeline ? parseWin(p.get("win")) : null,
    group: timeline && (group === "product" || group === "execution") ? group : null,
    theater: !timeline && p.get("theater") === "1",
  };
}

export interface HashWrite {
  readonly route: HashRoute;
  readonly sel: EntityRef | null;
  /** Already settled by the caller: written only while the playhead is held still. */
  readonly at: HashAt | null;
  readonly win: { readonly from: number; readonly to: number } | null;
  readonly group: "product" | "execution";
}

export function formatAt(at: HashAt): string {
  return at.kind === "ms" ? String(Math.round(at.ms)) : encodeURIComponent(at.id);
}

/** The hash for a state. Parameters in a fixed order; the default grouping is left out. */
export function formatHash(w: HashWrite): string {
  const parts: string[] = [];
  if (w.sel) parts.push(`sel=${encodeURIComponent(w.sel)}`);
  if (w.at) parts.push(`at=${formatAt(w.at)}`);
  if (w.route === "timeline") {
    if (w.win) parts.push(`win=${Math.round(w.win.from)}-${Math.round(w.win.to)}`);
    if (w.group !== "product") parts.push(`group=${w.group}`);
  }
  return `#${w.route}${parts.length ? `?${parts.join("&")}` : ""}`;
}
