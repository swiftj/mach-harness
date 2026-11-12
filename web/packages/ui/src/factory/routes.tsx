import type { ReactNode } from "react";
import { factoryTokens } from "../tokens/tokens";
import { dimmedOpacity, factoryStates, fc, type FactoryState, type Lod } from "./grammar";
import { liftedArc, marksAlong, offsetPolyline, pointAlong, roundedPath, slicePolyline } from "./geometry";
import { clamp01, segment } from "./motion";
import { planeStroke, planeTransform, project, round, type Vec2, type Vec3 } from "./projection";
import { arrowFor, useFactoryIds } from "./scene";
import { StateMark, StationSymbol } from "./symbols";
import type { Variant } from "./machines";

/**
 * Everything that connects: workflow routes (conveyor track), artifact handoffs, the retry loop,
 * fan-out and join, dependency links and escalation. Every one takes a `progress` (draw) 0..1 and a
 * direction (the order of its points), so the caller draws it from the playhead.
 *
 * Atlas points are plan points; Blueprint points are screen points.
 */

const S = factoryTokens.stroke;

function inkOf(state: FactoryState): string {
  return state === "idle" ? fc("route") : fc(factoryStates[state].ink);
}

function screen(points: readonly Vec3[], variant: Variant): Vec2[] {
  return variant === "atlas" ? points.map(project) : points.map((p) => ({ x: p.x, y: p.y }));
}

function chevronAt(point: Vec3, angle: number, size: number, variant: Variant): string {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const local = [
    [-size, -size * 1.1],
    [size * 0.8, 0],
    [-size, size * 1.1],
  ];
  const pts = local.map(([u, v]) => ({ x: point.x + u! * c - v! * s, y: point.y + u! * s + v! * c, z: point.z ?? 0 }));
  const sp = screen(pts, variant);
  return `M${round(sp[0]!.x)} ${round(sp[0]!.y)}L${round(sp[1]!.x)} ${round(sp[1]!.y)}L${round(sp[2]!.x)} ${round(sp[2]!.y)}`;
}

/* ------------------------------------------------------------------------------------------------ */

export interface RoutePathProps {
  points: readonly Vec3[];
  variant?: Variant;
  /** route: conveyor track. handoff: an artifact passing between stations (dotted). */
  kind?: "route" | "handoff";
  state?: FactoryState;
  /** 0..1 of the path drawn from its first point (pathDraw). */
  progress?: number;
  /** Direction chevrons along the route. Default: on at mid and near zoom. */
  chevrons?: boolean;
  /** Arrowhead at the end. */
  arrow?: boolean;
  lod?: Lod;
  dimmed?: boolean;
  label?: string;
  /** Not travelled yet in this run (Blueprint "unbuilt"): a dashed hairline in the route ink, whatever the state. */
  planned?: boolean;
}

/**
 * A workflow route. In the Atlas it is a conveyor track: two rails 6 plan units apart, sleepers every
 * 12 at near zoom, chevrons every 48 pointing the way. While work travels it the rails take the live
 * ink and weight. In the Blueprint it is one precise line with rounded corners and an arrowhead.
 */
export function RoutePath({ points, variant = "atlas", kind = "route", state = "idle", progress = 1, chevrons, arrow, lod = "mid", dimmed, label, planned }: RoutePathProps) {
  const ids = useFactoryIds();
  const p = clamp01(progress);
  if (points.length < 2 || p <= 0) return null;
  const drawn = p >= 1 ? [...points] : slicePolyline(points, 0, p);
  const ink = inkOf(state);
  const live = state === "active";
  const weight = live ? S.routeLive : S.route;
  const showChevrons = chevrons ?? lod !== "far";
  const style = { fill: "none", stroke: ink, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const groupProps = label ? { role: "img" as const, "aria-label": label } : { "aria-hidden": true as const };

  if (kind === "handoff") {
    return (
      <g {...groupProps} style={{ opacity: dimmed ? dimmedOpacity : 1 }}>
        <path d={roundedPath(screen(drawn, variant), 6)} style={{ ...style, strokeWidth: 1.4, strokeDasharray: "0.1 4" }} markerEnd={arrow ? `url(#${arrowFor(ids, live ? "live" : "route")})` : undefined} />
      </g>
    );
  }

  if (planned) {
    return (
      <g {...groupProps} style={{ opacity: dimmed ? dimmedOpacity : 1 }}>
        <path
          d={roundedPath(screen(drawn, variant), variant === "blueprint" ? 8 : 5)}
          style={{ ...style, stroke: fc("route"), strokeWidth: 1, strokeDasharray: "3 3" }}
          markerEnd={variant === "blueprint" && (arrow ?? true) ? `url(#${ids.arrow})` : undefined}
        />
      </g>
    );
  }

  if (variant === "blueprint") {
    return (
      <g {...groupProps} style={{ opacity: dimmed ? dimmedOpacity : 1 }}>
        <path
          d={roundedPath(screen(drawn, variant), 8)}
          style={{ ...style, strokeWidth: live ? 2 : 1.25, strokeDasharray: state === "idle" && p >= 1 ? undefined : undefined }}
          markerEnd={arrow ?? true ? `url(#${arrowFor(ids, factoryStates[state].ink === "ink-soft" ? "route" : factoryStates[state].ink)})` : undefined}
        />
      </g>
    );
  }

  const gauge = 3;
  const left = offsetPolyline(drawn, gauge);
  const right = offsetPolyline(drawn, -gauge);
  const sleepers = lod === "near" ? marksAlong(drawn, 12, 6) : [];
  const marks = showChevrons ? marksAlong(drawn, 48, 24) : [];
  return (
    <g {...groupProps} style={{ opacity: dimmed ? dimmedOpacity : 1 }}>
      {sleepers.map((m, i) => {
        const a = project({ x: m.point.x - Math.sin(m.angle) * (gauge + 2), y: m.point.y + Math.cos(m.angle) * (gauge + 2), z: m.point.z });
        const b = project({ x: m.point.x + Math.sin(m.angle) * (gauge + 2), y: m.point.y - Math.cos(m.angle) * (gauge + 2), z: m.point.z });
        return <line key={i} x1={round(a.x)} y1={round(a.y)} x2={round(b.x)} y2={round(b.y)} style={{ stroke: fc("grid-major"), strokeWidth: 1.4 }} />;
      })}
      <path d={roundedPath(screen(left, variant), 5)} style={{ ...style, strokeWidth: weight * 0.8 }} />
      <path d={roundedPath(screen(right, variant), 5)} style={{ ...style, strokeWidth: weight * 0.8 }} />
      {marks.map((m, i) => (
        <path key={i} d={chevronAt(m.point, m.angle, 1.8, variant)} style={{ ...style, strokeWidth: 1.2 }} />
      ))}
      {arrow ? <path d={chevronAt(pointAlong(drawn, 1).point, pointAlong(drawn, 1).angle, 3.2, variant)} style={{ ...style, strokeWidth: 1.6 }} /> : null}
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ */

export interface RetryLoopProps {
  /** Where the loop leaves (the station that failed). */
  from: Vec3;
  /** Where it returns (the build station). */
  to: Vec3;
  /** The judging round this return starts (2 or 3); used rounds are filled pips. */
  round: number;
  maxRounds?: number;
  /** 0..1 draw (verifyReturn). */
  progress?: number;
  variant?: Variant;
  /** Height of the arc (Atlas: elevation; Blueprint: pixels above the line). */
  lift?: number;
  /** Blueprint only: the y of the loop's horizontal run, when it should pass below or between rows. */
  crestY?: number;
  lod?: Lod;
  dimmed?: boolean;
}

/**
 * The return-to-build loop: a dashed arc in the fail ink, lifted above the floor (Atlas) or above the
 * lane (Blueprint), arrowed back to the build station. At its crest, three pips count the judging
 * rounds: filled for rounds used, open for rounds left. The third is the escalation limit.
 */
export function RetryLoop({ from, to, round: judging, maxRounds = 3, progress = 1, variant = "atlas", lift, crestY, lod = "mid", dimmed }: RetryLoopProps) {
  const ids = useFactoryIds();
  const p = clamp01(progress);
  if (p <= 0) return null;
  const path3: Vec3[] =
    variant === "atlas"
      ? liftedArc(from, to, lift ?? 34, 28)
      : (() => {
          const cy = crestY ?? Math.min(from.y, to.y) - (lift ?? 34);
          return [from, { x: from.x, y: cy }, { x: to.x, y: cy }, to];
        })();
  const drawn = slicePolyline(path3, 0, p);
  const crest = variant === "atlas" ? project(pointAlong(path3, 0.5).point) : { x: (from.x + to.x) / 2, y: path3[1]!.y };
  const pipsOn = segment(p, 0.5, 0.8);
  return (
    <g role="img" aria-label={`Returned to build: round ${judging} of ${maxRounds}`} style={{ opacity: dimmed ? dimmedOpacity : 1 }}>
      <path
        d={variant === "atlas" ? roundedPath(screen(drawn, variant), 0) : roundedPath(screen(drawn, variant), 10)}
        markerEnd={p >= 1 ? `url(#${ids.arrowFail})` : undefined}
        aria-hidden="true"
        style={{ fill: "none", stroke: fc("fail"), strokeWidth: 1.6, strokeDasharray: "5 3", strokeLinecap: "round" }}
      />
      <g transform={`translate(${round(crest.x)} ${round(crest.y - 9)})`} style={{ opacity: pipsOn }} aria-hidden="true">
        <rect x={-((maxRounds * 9) / 2) - 3} y={-6} width={maxRounds * 9 + 6} height={12} rx={6} style={{ fill: fc("plate-top"), stroke: fc("fail"), strokeWidth: 1 }} />
        {Array.from({ length: maxRounds }, (_, i) => (
          <circle key={i} cx={-((maxRounds - 1) * 9) / 2 + i * 9} cy={0} r={2.6} style={{ fill: i < judging ? fc("fail") : fc("plate-top"), stroke: fc("fail"), strokeWidth: 1 }} />
        ))}
        {lod === "near" || variant === "blueprint" ? (
          <text x={(maxRounds * 9) / 2 + 8} y={3.5} style={{ fill: fc("fail"), fontSize: 10, fontWeight: 600 }}>
            Round {judging} of {maxRounds}
          </text>
        ) : null}
      </g>
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ */

export interface BranchesProps {
  /** The single end: where the fan-out starts or the join ends. */
  origin: Vec3;
  /** The many ends: the seats. */
  targets: readonly Vec3[];
  mode: "fan-out" | "join";
  /** 0..1 for each branch (fanOut with stagger, voteConverge). One number applies to all. */
  progress?: number | readonly number[];
  /** State per branch: a vote's outcome on a join, a seat's state on a fan-out. */
  states?: readonly FactoryState[];
  variant?: Variant;
  dimmed?: boolean;
  label?: string;
}

/**
 * Fan-out and join. Branches leave the origin together along the flow and splay to their targets in
 * smooth curves (a reviewer panel fanning out from the chamber's door); a join is the same drawing
 * in reverse with arrowheads at the origin (votes converging on consensus). Each branch carries its
 * own state, and a settled branch shows its state mark at the seat.
 */
export function Branches({ origin, targets, mode, progress = 1, states, variant = "atlas", dimmed, label }: BranchesProps) {
  const ids = useFactoryIds();
  const z = origin.z ?? 0;
  const branchPaths = targets.map((t) => {
    const dx = (t.x - origin.x) * 0.55;
    const a = mode === "fan-out" ? origin : t;
    const b = mode === "fan-out" ? t : origin;
    const c1 = mode === "fan-out" ? { x: a.x + dx, y: a.y } : { x: a.x - dx, y: a.y };
    const c2 = mode === "fan-out" ? { x: b.x - dx, y: b.y } : { x: b.x + dx, y: b.y };
    return `M${round(a.x)} ${round(a.y)}C${round(c1.x)} ${round(c1.y)} ${round(c2.x)} ${round(c2.y)} ${round(b.x)} ${round(b.y)}`;
  });
  const sw = variant === "atlas" ? planeStroke : 1;
  const body: ReactNode = targets.map((t, i) => {
    const p = clamp01(typeof progress === "number" ? progress : (progress[i] ?? 0));
    const st = states?.[i] ?? "active";
    const ink = inkOf(st);
    const settled = st === "succeeded" || st === "failed";
    if (p <= 0) return null;
    return (
      <g key={i}>
        <path
          d={branchPaths[i]}
          pathLength={1}
          markerEnd={mode === "join" && p >= 1 ? `url(#${arrowFor(ids, factoryStates[st].ink)})` : undefined}
          style={{ fill: "none", stroke: ink, strokeWidth: (st === "active" ? 1.8 : 1.4) * sw, strokeDasharray: `${round(p)} 2`, strokeLinecap: "round" }}
        />
        {settled && p >= 1 && variant === "blueprint" ? (
          <g transform={`translate(${round(t.x)} ${round(t.y)})`}>
            <StateMark state={st} r={4.5} />
          </g>
        ) : null}
      </g>
    );
  });
  return (
    <g role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} style={{ opacity: dimmed ? dimmedOpacity : 1 }}>
      {variant === "atlas" ? <g transform={planeTransform(z)}>{body}</g> : body}
      {variant === "atlas"
        ? targets.map((t, i) => {
            const st = states?.[i] ?? "active";
            const p = clamp01(typeof progress === "number" ? progress : (progress[i] ?? 0));
            if (!(st === "succeeded" || st === "failed") || p < 1) return null;
            const s = project({ ...t, z: z + 2 });
            return (
              <g key={`m${i}`} transform={`translate(${round(s.x)} ${round(s.y)})`}>
                <StateMark state={st} r={4.5} />
              </g>
            );
          })
        : null}
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ */

export interface DependencyLinkProps {
  /** The prerequisite. */
  from: Vec3;
  /** The thing that waits on it. */
  to: Vec3;
  state: "blocking" | "satisfied";
  /** 0..1 of the unlock (dependencyUnlock), used when `state` is satisfied. */
  progress?: number;
  variant?: Variant;
  lift?: number;
  dimmed?: boolean;
  /** Highlighted: drawn at full weight while the rest dims. */
  highlighted?: boolean;
  /**
   * Blueprint only: route the link through a vertical channel at this x (the dependency gutter) instead
   * of an S-curve: across to the channel, along it, and across to the dependent, with the padlock at
   * the channel's middle.
   */
  channelX?: number;
}

/** A small padlock, shackle opening by `open` 0..1. Centred on its body. */
function Lock({ open, color, x, y }: { open: number; color: string; x: number; y: number }) {
  const lift = open * 3.2;
  return (
    <g aria-hidden="true" transform={`translate(${round(x)} ${round(y)})`}>
      <rect x={-6.5} y={-5} width={13} height={15} rx={2} style={{ fill: fc("plate-top"), stroke: color, strokeWidth: 1 }} />
      <path d={`M-2.6 ${-0.5 - lift}V${-3 - lift}a2.6 2.6 0 0 1 5.2 0V${open > 0.5 ? -3 - lift : -0.5}`} style={{ fill: "none", stroke: color, strokeWidth: 1.3, strokeLinecap: "round" }} />
      <rect x={-4} y={-0.5} width={8} height={6.5} rx={1} style={{ fill: color }} />
    </g>
  );
}

/**
 * A dependency between slices or cells: an overhead cable (Atlas) or an S-curve (Blueprint) from the
 * prerequisite to the dependent, arrowed at the dependent, with a padlock at its middle. Blocking:
 * dashed, waiting ink, lock shut. Satisfied: the unlock draws a solid passed line over the dashes and
 * opens the shackle; afterwards the link recedes to a fine solid line.
 */
export function DependencyLink({ from, to, state, progress = 1, variant = "atlas", lift = 46, dimmed, highlighted, channelX }: DependencyLinkProps) {
  const ids = useFactoryIds();
  const u = state === "satisfied" ? clamp01(progress) : 0;
  const pts: Vec2[] =
    variant === "atlas"
      ? liftedArc(from, to, lift, 24).map(project)
      : (() => {
          const out: Vec2[] = [];
          for (let i = 0; i <= 24; i++) {
            const t = i / 24;
            const e = t * t * (3 - 2 * t);
            out.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * e });
          }
          return out;
        })();
  const channel = variant === "blueprint" && channelX !== undefined;
  const d = channel ? roundedPath([from, { x: channelX!, y: from.y }, { x: channelX!, y: to.y }, to], 6) : roundedPath(pts, 0);
  const mid = channel ? { x: channelX!, y: (from.y + to.y) / 2 } : pts[12]!;
  const weight = highlighted ? 1.8 : 1.3;
  return (
    <g role="img" aria-label={state === "blocking" ? "Dependency: blocking" : "Dependency: satisfied"} style={{ opacity: dimmed ? dimmedOpacity : 1 }}>
      <path d={d} markerEnd={u < 1 ? `url(#${ids.arrowWait})` : undefined} aria-hidden="true" style={{ fill: "none", stroke: fc("wait"), strokeWidth: weight, strokeDasharray: "4 3", opacity: 1 - u * 0.85 }} />
      {u > 0 ? (
        <path d={d} pathLength={1} markerEnd={u >= 1 ? `url(#${ids.arrowPass})` : undefined} aria-hidden="true" style={{ fill: "none", stroke: fc("pass"), strokeWidth: weight, strokeDasharray: `${round(u)} 2` }} />
      ) : null}
      <Lock open={u} color={u >= 1 ? fc("pass") : fc("wait")} x={mid.x} y={mid.y - 3} />
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ */

export interface EscalationProps {
  /** Where the blocked work stands. */
  from: Vec3;
  /** How high the riser goes (Atlas elevation; Blueprint pixels). */
  height?: number;
  /** 0..1 draw. */
  progress?: number;
  variant?: Variant;
  label?: string;
  dimmed?: boolean;
}

/**
 * Escalation: a riser leaving the floor straight up, out of the plant's plane, to a tag naming the
 * person it waits for. Vertical is reserved for this: nothing else in the factory leaves the floor
 * upward, so an escalation is visible from any distance.
 */
export function Escalation({ from, height = 70, progress = 1, variant = "atlas", label = "Escalated to a person", dimmed }: EscalationProps) {
  const ids = useFactoryIds();
  const p = clamp01(progress);
  if (p <= 0) return null;
  const a = variant === "atlas" ? project(from) : { x: from.x, y: from.y };
  const top = variant === "atlas" ? project({ ...from, z: (from.z ?? 0) + height * p }) : { x: from.x, y: from.y - height * p };
  return (
    <g role="img" aria-label={label} style={{ opacity: dimmed ? dimmedOpacity : 1 }}>
      <line x1={a.x} y1={a.y} x2={top.x} y2={top.y} markerEnd={`url(#${ids.arrowFail})`} aria-hidden="true" style={{ stroke: fc("fail"), strokeWidth: 1.8, strokeDasharray: "2 3", strokeLinecap: "round" }} />
      <g transform={`translate(${round(top.x)} ${round(top.y - 16)})`} style={{ opacity: segment(p, 0.6, 1) }} aria-hidden="true">
        <rect x={-12} y={-11} width={24} height={22} rx={3} style={{ fill: fc("fail-soft"), stroke: fc("fail"), strokeWidth: 1.2 }} />
        <StationSymbol kind="human-approval" size={16} color={fc("fail")} strokeWidth={1.5} />
        <text x={18} y={4} style={{ fill: fc("fail"), fontSize: 10.5, fontWeight: 600 }}>
          {label}
        </text>
      </g>
    </g>
  );
}
