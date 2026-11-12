/** Time words for the drawing. All inputs are factory milliseconds from the scenario start. */

/** "03:38", "27:19": run time in factory mm:ss, the Shell timeline's format (its timecode without tenths). */
export function clock(t: number): string {
  const s = Math.max(0, Math.floor(t / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** "27:19.4": the playhead, to a tenth. */
export function clockTenths(t: number): string {
  const tenths = Math.max(0, Math.floor(t / 100));
  const s = Math.floor(tenths / 10);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}.${tenths % 10}`;
}

/** A duration: "4.2s", "38s", "4m 12s", "1h 02m". */
export function duration(ms: number): string {
  const v = Math.max(0, ms);
  if (v < 10_000) return `${(v / 1000).toFixed(1)}s`;
  const s = Math.round(v / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

const STEPS = [1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000];

/** A ruler step for a span, giving at most `max` divisions. */
export function rulerStep(span: number, max = 10): number {
  for (const step of STEPS) if (span / step <= max) return step;
  return STEPS[STEPS.length - 1] as number;
}

/**
 * The time axis of a span that may still be open. A finished span is drawn to its real length; an
 * open one to a window that grows in steps each time the playhead passes its end (1, 1.5, 2, 3 … min),
 * so the axis is stable for long stretches instead of rescaling every frame. A function of t only.
 */
export function axisEnd(start: number, end: number | null, t: number): number {
  if (end !== null && end <= t) return Math.max(end, start + 1000);
  const elapsed = Math.max(0, t - start) * 1.05;
  // 1, 1.5, 2, 3, 4, 6, 8, 12 … minutes: the axis rescales a dozen times over an hour, never per frame.
  let window = 60_000;
  let step = 0;
  while (window < elapsed) window = step++ % 2 === 0 ? window * 1.5 : (window / 1.5) * 2;
  return start + window;
}
