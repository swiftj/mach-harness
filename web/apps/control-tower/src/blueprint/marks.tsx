/**
 * Marks the live history needs that the grammar has no primitive for, drawn here from the grammar's
 * own inks and strokes (M6.2): a state mark for "not recorded" and for "as last seen" (the two
 * activity states that are not one of the grammar's seven), a dimension line that says whether its
 * duration was measured or placed, and the open, dashed form a reconstructed mark takes.
 *
 * - Not recorded: a dashed ring in ink-soft with a short bar across it. Silence is never drawn as a
 *   state (contract D16); this mark says the record does not say.
 * - As last seen (the connection is stale or lost while the thing was executing): a dashed ring in
 *   ink-soft with two short uprights, a held frame. Never the working mark.
 * - Inferred duration: open arrowheads at both ends and "≈" before the value, where a measured one has
 *   the architectural slash ticks.
 */
import { fc, StateMark, type FactoryState } from "@mach/ui";
import type { ActivityState } from "../sim";
import { activityMark } from "./facts";

export function ActivityMark({ state, r = 4.5, mark }: { state: ActivityState | FactoryState | "unknown" | "stale"; r?: number; mark?: "double-ring" }) {
  const drawn = isActivity(state) ? activityMark(state) : state;
  if (drawn === "unknown") return <NotRecordedMark r={r} />;
  if (drawn === "stale") return <LastSeenMark r={r} />;
  return <StateMark state={drawn} r={r} progress={0} mark={mark} />;
}

const ACTIVITIES = new Set<string>(["executing", "waiting-dependency", "waiting-resources", "waiting-person", "completed", "failed", "interrupted", "stale", "unknown"]);
function isActivity(s: string): s is ActivityState {
  return ACTIVITIES.has(s);
}

/** "Not recorded": a dashed ring with a bar, in ink-soft. */
export function NotRecordedMark({ r = 4.5 }: { r?: number }) {
  return (
    <g aria-hidden="true">
      <circle r={r} style={{ fill: fc("ground"), stroke: fc("ink-soft"), strokeWidth: Math.max(0.9, r / 4.5), strokeDasharray: `${r * 0.55} ${r * 0.45}` }} />
      <line x1={-r * 0.5} y1={0} x2={r * 0.5} y2={0} style={{ stroke: fc("ink-soft"), strokeWidth: Math.max(0.9, r / 4) }} />
    </g>
  );
}

/** "As last seen": a dashed ring with two uprights (a held frame), in ink-soft. */
export function LastSeenMark({ r = 4.5 }: { r?: number }) {
  return (
    <g aria-hidden="true">
      <circle r={r} style={{ fill: fc("ground"), stroke: fc("ink-soft"), strokeWidth: Math.max(0.9, r / 4.5), strokeDasharray: `${r * 0.55} ${r * 0.45}` }} />
      <path d={`M${-r * 0.28} ${-r * 0.42}v${r * 0.84}M${r * 0.28} ${-r * 0.42}v${r * 0.84}`} style={{ stroke: fc("ink-soft"), strokeWidth: Math.max(0.9, r / 4) }} />
    </g>
  );
}

/**
 * A duration as a dimension line. Measured: the grammar's form (extension lines, slash ticks, the value
 * above). Placed (an inferred start or end, or one bounded rather than recorded): open arrowheads and
 * "≈" before the value.
 */
export function DimLine({ x1, x2, y, label, inferred, extend = 5 }: { x1: number; x2: number; y: number; label: string; inferred: boolean; extend?: number }) {
  const ink = "var(--mach-ink-muted)";
  const text = inferred ? `≈ ${label}` : label;
  return (
    <g aria-label={`Duration ${inferred ? "about " : ""}${label}${inferred ? ", placed, not measured" : ""}`} role="img">
      <path d={`M${x1} ${y - extend}V${y + 3}M${x2} ${y - extend}V${y + 3}`} aria-hidden="true" style={{ stroke: fc("plate-edge"), strokeWidth: 0.75 }} />
      <line x1={x1} y1={y} x2={x2} y2={y} aria-hidden="true" style={{ stroke: ink, strokeWidth: 0.75, strokeDasharray: inferred ? "3 2" : undefined }} />
      {inferred ? (
        <path d={`M${x1 + 4.5} ${y - 2.6}L${x1 + 0.6} ${y}L${x1 + 4.5} ${y + 2.6}M${x2 - 4.5} ${y - 2.6}L${x2 - 0.6} ${y}L${x2 - 4.5} ${y + 2.6}`} aria-hidden="true" style={{ fill: "none", stroke: ink, strokeWidth: 0.75 }} />
      ) : (
        <path d={`M${x1 - 2.5} ${y + 2.5}l5 -5M${x2 - 2.5} ${y + 2.5}l5 -5`} aria-hidden="true" style={{ stroke: ink, strokeWidth: 0.9 }} />
      )}
      <text x={Math.round((x1 + x2) / 2)} y={y - 4} textAnchor="middle" aria-hidden="true" style={{ fill: ink, fontFamily: "var(--mach-font-mono)", fontSize: 9.5 }} className="tabular">
        {text}
      </text>
    </g>
  );
}

/** "not recorded", set in the subtle ink, for a placeholder field. */
export const NOT_RECORDED = "not recorded";

export type { FactoryState };
