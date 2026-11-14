/**
 * Number words the Analytics areas share that `../model/format.ts` (the prototype's) does not give,
 * or gives with a rule this layer must keep. Pure; no clock, no locale (fixed "," grouping).
 *
 * Overlap, kept on purpose and listed for the lead: `durationWords` (model: `durationText`),
 * `recordedUsd` (model: `usd`, which prints a cost under half a cent as $0.00), `tokenWords` (model:
 * `tokens`, which gives no exact value), `percentOf` (model: `pct`, which takes a share and so cannot
 * see an empty denominator). The rest is new: sample and coverage phrases and observe's rounding.
 *
 * Rules: null and undefined print as the empty mark "–", never 0; a share with an empty denominator
 * has no number; a recorded cost that is not zero never prints as $0.00.
 */
import { duration } from "../../shell/time";

/** What a missing value prints as. */
export const NO_VALUE = "–";

const finite = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);
const group3 = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** 1,204,331 (whole numbers grouped; fractions to 2 places). */
export function countWords(n: number | null | undefined): string {
  if (!finite(n)) return NO_VALUE;
  if (Number.isInteger(n)) return (n < 0 ? "-" : "") + group3(String(Math.abs(n)));
  return n.toFixed(2);
}

/** A duration in the shell's words (48 s, 4 min 12 s, 1 h 3 min); a day or longer as days and hours; under a second in ms. */
export function durationWords(ms: number | null | undefined): string {
  if (!finite(ms)) return NO_VALUE;
  if (ms < 0) return NO_VALUE;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const h = Math.floor(Math.round(ms / 60_000) / 60);
  if (h >= 24) return h % 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${h / 24} d`;
  return duration(ms);
}

/**
 * numerator / denominator as a percentage, or null when there is no share to give: a missing part,
 * or an empty denominator (never 0%, never 100%). Under 10% one decimal; else whole.
 */
export function percentOf(numerator: number | null | undefined, denominator: number | null | undefined): string | null {
  if (!finite(numerator) || !finite(denominator) || denominator <= 0) return null;
  const p = (numerator / denominator) * 100;
  if (p !== 0 && Math.abs(p) < 10 && Math.round(p * 10) / 10 !== Math.round(p)) return `${(Math.round(p * 10) / 10).toFixed(1)}%`;
  return `${Math.round(p)}%`;
}

/**
 * A recorded cost in USD: $4.80, $1,204.31. A cost that is not zero is never shown as $0.00: under a
 * cent it reads "< $0.01" (and the exact value goes in `exact` for a title). Null: not recorded.
 */
export function recordedUsd(v: number | null | undefined): { readonly text: string; readonly exact: string } | null {
  if (!finite(v)) return null;
  const exact = `$${v}`;
  if (v === 0) return { text: "$0.00", exact };
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (a < 0.01) return { text: `${sign}< $0.01`, exact };
  const [whole, cents] = a.toFixed(2).split(".") as [string, string];
  return { text: `${sign}$${group3(whole)}.${cents}`, exact };
}

/** Tokens: 812, 34.2k, 3.5M, 2.41B, with the exact grouped count for a title. Null: not recorded. */
export function tokenWords(n: number | null | undefined): { readonly text: string; readonly exact: string } | null {
  if (!finite(n)) return null;
  const exact = `${countWords(Math.round(n))} tokens`;
  const a = Math.abs(n);
  const short = (x: number, unit: string) => {
    const fixed = x < 10 ? x.toFixed(2) : x < 100 ? x.toFixed(1) : x.toFixed(0);
    return `${fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed}${unit}`;
  };
  if (a < 1000) return { text: String(Math.round(n)), exact };
  if (a < 999_500) return { text: short(n / 1e3, "k"), exact };
  if (a < 999_500_000) return { text: short(n / 1e6, "M"), exact };
  return { text: short(n / 1e9, "B"), exact };
}

/** "n 45 merged tickets", "n 1 merged ticket"; null count: "n –". `noun` is the plural; `one` its singular. */
export function sampleWords(n: number | null | undefined, noun: string, one?: string): string {
  if (!finite(n)) return `n ${NO_VALUE}`;
  const singular = one ?? noun.replace(/s$/, "");
  return `n ${countWords(n)} ${n === 1 ? singular : noun}`;
}

/** "coverage 80 of 88 (91%)"; with nothing eligible "coverage 0 of 0"; untracked: null (say why instead). */
export function coverageWords(counted: number | null | undefined, eligible: number | null | undefined): string | null {
  if (!finite(counted) || !finite(eligible)) return null;
  const p = percentOf(counted, eligible);
  return `coverage ${countWords(counted)} of ${countWords(eligible)}${p === null ? "" : ` (${p})`}`;
}

/**
 * observe.py's `round(value, 3)`: Python rounds the exact binary value half to even, so 0.5625 (exact
 * in binary) is 0.562 while 0.0005 (stored a little above) is 0.001. The observer serves this as
 * `value_rounded`; use it only where that is absent. Null stays null.
 */
export function roundObserve(v: number | null | undefined): number | null {
  if (!finite(v)) return null;
  const exact = exactDecimal(Math.abs(v));
  const [whole, frac = ""] = exact.split(".") as [string, string?];
  const kept = frac.padEnd(3, "0").slice(0, 3);
  const rest = frac.slice(3);
  let n = BigInt(whole + kept); // in thousandths
  const up = rest.length > 0 && (rest[0]! > "5" || (rest[0] === "5" && /[1-9]/.test(rest.slice(1))));
  const tie = rest === "5";
  if (up || (tie && n % 2n === 1n)) n += 1n;
  const r = Number(n) / 1000;
  return v < 0 && r !== 0 ? -r : r;
}

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** The exact decimal expansion of a double (finite), via BigInt. */
function exactDecimal(v: number): string {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, v);
  const bits = buf.getBigUint64(0);
  const sign = bits >> 63n ? "-" : "";
  const exp = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & ((1n << 52n) - 1n);
  const mant = exp === 0 ? frac : frac | (1n << 52n);
  const e = (exp === 0 ? 1 : exp) - 1075; // value = mant * 2^e
  if (e >= 0) return sign + (mant << BigInt(e)).toString();
  // mant / 2^-e = mant * 5^-e / 10^-e
  const digits = (mant * 5n ** BigInt(-e)).toString().padStart(-e + 1, "0");
  return trimZeros(`${sign}${digits.slice(0, digits.length + e)}.${digits.slice(digits.length + e)}`);
}
