import { dimmedOpacity, fc, type Lod } from "./grammar";
import { project, round, uprightTransform, type Vec3 } from "./projection";
import type { Variant } from "./machines";

/**
 * Two marks the plant needs beside its machines: the findings flag a reviewer or verifier plants on
 * the thing it found a problem in, and the red/green task board that stands by the build machine and
 * shows the plan's tasks going red (test seen failing) then green (suite passing).
 */

/* ------------------------------------------------------------------------------------------------ */

export interface FindingsFlagProps {
  /** Atlas: plan point the flag stands on. Blueprint: screen point of the flag's foot. */
  at: Vec3;
  /** blocker: a solid pennant with a bar; note: an outlined pennant. */
  severity: "blocker" | "note";
  /** How many findings it stands for, when more than one. */
  count?: number;
  /** The rule or spec ID the finding cites (e.g. "INV-02"), lettered beside the flag at near zoom. */
  rule?: string;
  variant?: Variant;
  lod?: Lod;
  dimmed?: boolean;
}

/**
 * A findings flag: a pole with a pennant. A blocker is a solid pennant in the fail ink with a light
 * bar; a non-blocking note is an outlined pennant in the waiting ink. The count sits on the pennant;
 * the cited rule is lettered beside it at near zoom.
 */
export function FindingsFlag({ at, severity, count, rule, variant = "atlas", lod = "mid", dimmed }: FindingsFlagProps) {
  const blocker = severity === "blocker";
  const ink = blocker ? fc("fail") : fc("wait");
  const name = `${count && count > 1 ? `${count} ` : ""}${blocker ? "blocking finding" : "note"}${count && count > 1 ? "s" : ""}${rule ? ` citing ${rule}` : ""}`;
  const foot = variant === "atlas" ? project(at) : { x: at.x, y: at.y };
  const pole = variant === "atlas" ? 22 : 16;
  return (
    <g role="img" aria-label={name} transform={`translate(${round(foot.x)} ${round(foot.y)})`} style={{ opacity: dimmed ? dimmedOpacity : 1 }}>
      {variant === "atlas" ? <ellipse rx={3.5} ry={1.6} aria-hidden="true" style={{ fill: fc("shadow") }} /> : null}
      <line x1={0} y1={0} x2={0} y2={-pole} aria-hidden="true" style={{ stroke: fc("ink"), strokeWidth: 1.2, strokeLinecap: "round" }} />
      <path d={`M0.6 ${-pole}L12 ${-pole + 4.5}L0.6 ${-pole + 9}Z`} aria-hidden="true" style={{ fill: blocker ? ink : fc("plate-top"), stroke: ink, strokeWidth: 1.1, strokeLinejoin: "round" }} />
      {blocker ? <line x1={2.6} y1={-pole + 4.5} x2={7.4} y2={-pole + 4.5} aria-hidden="true" style={{ stroke: fc("plate-top"), strokeWidth: 1.3, strokeLinecap: "round" }} /> : null}
      {count && count > 1 ? (
        <text x={14} y={-pole + 7.5} aria-hidden="true" className="tabular" style={{ fill: ink, fontSize: 9, fontWeight: 700 }}>
          {count}
        </text>
      ) : null}
      {rule && (lod === "near" || variant === "blueprint") ? (
        <text x={count && count > 1 ? 22 : 15} y={-pole + 7.5} aria-hidden="true" className="notranslate" style={{ fill: ink, fontFamily: "var(--mach-font-mono)", fontSize: 8.5 }}>
          {rule}
        </text>
      ) : null}
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ */

/**
 * A plan task's state on the board. red: its test was seen failing (red before green); green: the suite
 * passes with it; active: the builder is on it; overridden: a gate override was recorded for it.
 */
export type TaskCell = "pending" | "active" | "red" | "green" | "overridden";

export interface TaskBoardProps {
  tasks: readonly TaskCell[];
  /** Atlas: plan point at the board's left foot (it stands along plan x). Blueprint: screen top-left. */
  at: Vec3;
  /** Cells per row. Default 8. */
  columns?: number;
  variant?: Variant;
  lod?: Lod;
  dimmed?: boolean;
}

const CELL = 4.4;
const GAP = 1.4;

function Cell({ state, x, y }: { state: TaskCell; x: number; y: number }) {
  const r = { x, y, width: CELL, height: CELL };
  switch (state) {
    case "pending":
      return <rect {...r} style={{ fill: "none", stroke: fc("ink-soft"), strokeWidth: 0.6, strokeDasharray: "1 0.8" }} />;
    case "active":
      return <rect {...r} style={{ fill: fc("live-soft"), stroke: fc("live"), strokeWidth: 1 }} />;
    case "red":
      // Half filled from the bottom: the test exists and was seen failing.
      return (
        <g>
          <rect {...r} style={{ fill: fc("fail-soft"), stroke: fc("fail"), strokeWidth: 0.8 }} />
          <rect x={x} y={y + CELL / 2} width={CELL} height={CELL / 2} style={{ fill: fc("fail") }} />
        </g>
      );
    case "green":
      return <rect {...r} style={{ fill: fc("pass"), stroke: fc("pass"), strokeWidth: 0.8 }} />;
    case "overridden":
      return (
        <g>
          <rect {...r} style={{ fill: fc("wait-soft"), stroke: fc("wait"), strokeWidth: 0.8 }} />
          <path d={`M${x} ${y + CELL}L${x + CELL} ${y}`} style={{ stroke: fc("wait"), strokeWidth: 0.8 }} />
        </g>
      );
  }
}

/**
 * The red/green task board: one cell per task in plan order. Shape carries the state as well as
 * colour: pending dashed, active outlined live, red half filled, green full, overridden slashed. In the
 * Atlas it is an upright board on two legs beside the build machine; in the Blueprint a flat strip.
 */
export function TaskBoard({ tasks, at, columns = 8, variant = "atlas", lod = "mid", dimmed }: TaskBoardProps) {
  const rows = Math.max(1, Math.ceil(tasks.length / columns));
  const w = columns * (CELL + GAP) - GAP + 4;
  const h = rows * (CELL + GAP) - GAP + 4;
  const green = tasks.filter((t) => t === "green").length;
  const red = tasks.filter((t) => t === "red").length;
  const name = `Task board: ${green} of ${tasks.length} green${red ? `, ${red} red` : ""}`;
  const board = (
    <g aria-hidden="true">
      <rect x={0} y={0} width={w} height={h} rx={1} style={{ fill: fc("machine-top"), stroke: fc("plate-edge"), strokeWidth: 0.8 }} />
      {tasks.map((t, i) => (
        <Cell key={i} state={t} x={2 + (i % columns) * (CELL + GAP)} y={2 + Math.floor(i / columns) * (CELL + GAP)} />
      ))}
    </g>
  );
  if (variant === "blueprint") {
    return (
      <g role="img" aria-label={name} transform={`translate(${round(at.x)} ${round(at.y)})`} style={{ opacity: dimmed ? dimmedOpacity : 1 }}>
        {board}
      </g>
    );
  }
  const legs = 6;
  const z = at.z ?? 0;
  const footL = project(at);
  const footR = project({ ...at, x: at.x + w });
  const topL = project({ ...at, z: z + legs });
  const topR = project({ ...at, x: at.x + w, z: z + legs });
  return (
    <g role="img" aria-label={name} style={{ opacity: dimmed ? dimmedOpacity : 1 }}>
      <path d={`M${round(footL.x)} ${round(footL.y)}L${round(topL.x)} ${round(topL.y)}M${round(footR.x)} ${round(footR.y)}L${round(topR.x)} ${round(topR.y)}`} aria-hidden="true" style={{ stroke: fc("ink-soft"), strokeWidth: 1 }} />
      <g transform={uprightTransform(at, legs + h)}>{lod === "far" ? <rect width={w} height={h} style={{ fill: green === tasks.length ? fc("pass") : fc("machine-top"), stroke: fc("plate-edge"), strokeWidth: 0.8 }} /> : board}</g>
    </g>
  );
}
