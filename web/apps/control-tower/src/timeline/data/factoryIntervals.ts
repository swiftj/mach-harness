/**
 * M6.6 (reliability defect 3): the stretches in which the Factory was disabled or paused on this
 * machine, from the recorded `factory.disabled` / `factory.paused` / `factory.resumed` /
 * `factory.activated` events, drawn as a band on the Timeline's ruler with words.
 *
 * - A disabled stretch ends only at a recorded `factory.activated`; a paused one at a recorded
 *   `factory.resumed` (or `factory.activated`, or a disable, which starts a disabled stretch).
 * - With no recorded end it is open (`to: null`), said in the Timeline's open-end words: "no end
 *   recorded".
 * - Held at the playhead (`heldAt`), nothing recorded after it is read: a stretch that ended later is
 *   open at the playhead, and one that began later is not there (the I-04 cut).
 *
 * Pure; one pass over the entries, no allocation beyond the result.
 */
import { utcClock } from "../../shell/time";

export type FactoryIntervalKind = "disabled" | "paused";

export interface FactoryInterval {
  readonly kind: FactoryIntervalKind;
  readonly from: number;
  /** Null: no end recorded (by the playhead, when held). */
  readonly to: number | null;
}

interface Entry {
  readonly t: number;
  readonly event: { readonly type: string };
}

export function factoryIntervals(entries: readonly Entry[], heldAt: number | null = null): FactoryInterval[] {
  const out: FactoryInterval[] = [];
  let open: { kind: FactoryIntervalKind; from: number } | null = null;
  const close = (t: number) => {
    if (open) out.push({ kind: open.kind, from: open.from, to: t });
    open = null;
  };
  for (const e of entries) {
    if (heldAt !== null && e.t > heldAt) break;
    const type = e.event.type;
    if (type.charCodeAt(0) !== 102 /* f */ || !type.startsWith("factory.")) continue;
    if (type === "factory.disabled") {
      if (open?.kind === "disabled") continue;
      close(e.t);
      open = { kind: "disabled", from: e.t };
    } else if (type === "factory.paused") {
      if (open) continue;
      open = { kind: "paused", from: e.t };
    } else if (type === "factory.activated") {
      close(e.t);
    } else if (type === "factory.resumed") {
      if (open?.kind === "paused") close(e.t);
    }
  }
  const last = open as { kind: FactoryIntervalKind; from: number } | null;
  if (last) out.push({ kind: last.kind, from: last.from, to: null });
  return out;
}

/** "Factory disabled 05:42–06:31"; open: "Factory paused from 05:42, no end recorded". UTC clock, minutes. */
export function factoryIntervalWords(iv: FactoryInterval): string {
  const hm = (t: number) => utcClock(t).slice(0, 5);
  const what = iv.kind === "disabled" ? "Factory disabled" : "Factory paused";
  return iv.to === null ? `${what} from ${hm(iv.from)}, no end recorded` : `${what} ${hm(iv.from)}–${hm(iv.to)}`;
}
