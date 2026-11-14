/**
 * Words and numbers for Factory Analytics. Pure; no clock, no locale surprises (fixed en-GB style
 * grouping so captures are stable).
 *
 * Rules: a null value is never printed as 0; a rate over fewer than five members is shown as
 * "k of n", never as a percentage (the observe station refuses reports on fewer than five tickets);
 * durations read as people say them; costs are recorded dollars, never estimates.
 */
import type { Basis, MetricGroup, MetricRow } from "../contract";
import { NO_VALUE, percentOf, recordedUsd, tokenWords } from "../data/format";

const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const D = 24 * H;

/** Fewer members than this and a rate is "k of n", and no trend or comparison is claimed. */
export const SMALL_SAMPLE = 5;

const group3 = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** 48 s, 4 min 12 s, 26 min, 1 h 12 min, 2 d 3 h. */
export function durationText(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "–";
  if (ms < S) return `${Math.max(0, Math.round(ms))} ms`;
  const s = Math.round(ms / S);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 10) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  if (m < 60) return `${Math.round(s / 60)} min`;
  const totalMin = Math.round(s / 60);
  const h = Math.floor(totalMin / 60);
  if (h < 24) return totalMin % 60 ? `${h} h ${totalMin % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/** Compact, for table columns: 51 s, 2.1 min, 27 min, 4.3 h, 2.1 d. */
export function durationCompact(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "–";
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 600_000) return `${(ms / 60_000).toFixed(1)} min`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)} h`;
  return `${(ms / 86_400_000).toFixed(1)} d`;
}

/** Short form for axes: 30 s, 5 min, 2 h, 3 d. */
export function durationTick(ms: number): string {
  if (ms < MIN) return `${Math.round(ms / S)} s`;
  if (ms < H) return `${Math.round(ms / MIN)} min`;
  if (ms < D) return `${Math.round(ms / H)} h`;
  return `${Math.round(ms / D)} d`;
}

/** A recorded cost: data/format.ts `recordedUsd` (the one cost wording of Analytics); "–" when not recorded. */
export function usd(v: number | null | undefined): string {
  return recordedUsd(v)?.text ?? NO_VALUE;
}

/** Tokens: data/format.ts `tokenWords` (812, 34.2k, 1.27M); "–" when not recorded. */
export function tokens(n: number | null | undefined): string {
  return tokenWords(n)?.text ?? NO_VALUE;
}

/** A share as a percentage: data/format.ts `percentOf` (under 10% one decimal); `digits` fixes the decimals. "–" when there is none. */
export function pct(share: number | null | undefined, digits?: number): string {
  if (share === null || share === undefined || !Number.isFinite(share)) return NO_VALUE;
  if (digits !== undefined) return `${(share * 100).toFixed(digits)}%`;
  return percentOf(share, 1) ?? NO_VALUE;
}

export function count(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  return Number.isInteger(n) ? group3(n) : n.toFixed(2);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}

type ValueLike = Pick<MetricRow, "kind" | "unit" | "value" | "numerator_value" | "denominator_value"> | (Pick<MetricGroup, "value" | "numerator" | "denominator"> & Pick<MetricRow, "kind" | "unit">);
const num = (r: ValueLike) => ("numerator_value" in r ? r.numerator_value : r.numerator);
const den = (r: ValueLike) => ("denominator_value" in r ? r.denominator_value : r.denominator);

/** A row's value in its unit, or null when there is no value (the caller says why). */
export function valueText(r: ValueLike): string | null {
  if (r.value === null) return null;
  if (r.kind === "rate") {
    const d = den(r);
    if (d !== null && d < SMALL_SAMPLE) return `${count(num(r))} of ${count(d)}`;
    // From the counts where both are served, so a share reads the same wherever it is shown (a served value may be rounded).
    const n = num(r);
    return pct(n !== null && d ? n / d : r.value);
  }
  if (r.kind === "duration" || r.unit === "ms") return durationText(r.value);
  if (r.unit === "usd") return usd(r.value);
  if (r.unit === "tokens") return tokens(r.value);
  if (r.kind === "mean") return r.value.toFixed(r.value >= 10 ? 1 : 2);
  return count(r.value);
}

const UNIT_NOUN: Readonly<Record<string, readonly [string, string]>> = {
  tickets: ["ticket", "tickets"], slices: ["slice", "slices"], visits: ["visit", "visits"], rounds: ["round", "rounds"], checks: ["failed check", "failed checks"],
  findings: ["finding", "findings"], events: ["event", "events"], refusals: ["refusal", "refusals"], calls: ["call", "calls"], deviations: ["deviation", "deviations"],
};

/** What the sample is, from the catalog's denominator words: "54 merged tickets", "432 visits". */
export function sampleText(r: Pick<MetricRow, "kind" | "unit" | "denominator" | "numerator_value" | "denominator_value">): string {
  if (r.kind === "count") {
    const n = r.numerator_value ?? 0;
    const [one, many] = UNIT_NOUN[r.unit] ?? ["event", "events"];
    return plural(n, one, many);
  }
  const n = r.denominator_value;
  if (n === null) return "no sample";
  const noun = r.denominator.replace(/^(tickets|visits|executions|rounds|slices|agents|waves)\b/, "$1");
  return `${count(n)} ${shortNoun(noun, n)}`;
}

function shortNoun(denominator: string, n: number): string {
  const words = denominator
    .replace(/ with a measured duration$/, "")
    .replace(/ plus .*$/, "")
    .replace(/^execution\.completed$/, "executions")
    .replace(/^tests_seen_failing_first$/, "tests");
  if (n === 1) return words.replace(/^(\w+?)s\b/, "$1");
  return words;
}

/** "29 of 33 cells (88%)" or the reason coverage is not tracked. */
export function coverageText(c: MetricRow["coverage"]): string {
  if (c.share === null || c.of === null || c.covered === null) return c.reason === "no value" ? "no value" : "not tracked";
  return `${count(c.covered)} of ${count(c.of)} (${pct(c.share)})`;
}

export const BASIS_WORDS: Readonly<Record<Basis, string>> = {
  measured: "measured",
  open: "still open",
  inferred: "reconstructed",
  bounded: "bounded",
  unknown: "unknown",
  "not-recorded": "not recorded",
};

/** "28 d", "14 d" and dates: "16 Oct – 13 Nov". */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function dayText(t: number): string {
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
export function windowText(from: number, to: number): string {
  return `${dayText(from)} – ${dayText(to - 1)}`;
}
export function clockText(t: number): string {
  const d = new Date(t);
  return `${dayText(t)}, ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/** The catalog's target in words: "> 0.85" → "above 85%", "< 1.3" → "below 1.3". */
export function targetText(target: string | undefined, kind: MetricRow["kind"]): string | null {
  if (!target) return null;
  const [op, lim] = target.split(" ");
  const v = Number(lim);
  const shown = kind === "rate" ? pct(v) : String(v);
  return `${op === "<" ? "below" : "above"} ${shown}`;
}
