import { factoryTokens } from "../tokens/tokens";
import {
  agentRoles,
  artifacts,
  dimmedOpacity,
  factoryStates,
  fc,
  gatePositions,
  gates,
  modelTiers,
  reviewerSeats,
  stations,
  toolFamilies,
  type AgentRole,
  artifactProvenance,
  type ArtifactKind,
  type FactoryColor,
  type FactoryState,
  type GateKind,
  type GatePosition,
  type Lod,
  type ModelTier,
  type ReviewerSeat,
  type StationKind,
  type ToolFamily,
} from "./grammar";
import { clamp01, elapsedTicks, formatElapsed, lerp, segment } from "./motion";
import { planeStroke, planeTransform, project, round, uprightTransform, type Vec3 } from "./projection";
import { Prism } from "./plates";
import { FloorLettering } from "./lettering";
import { AgentHead, ArtifactMark, ElapsedTicks, ProvenanceBadge, RoleEmblem, StateMark, StationSymbol, ToolCap, artifactCardPath, artifactFoldPath } from "./symbols";

/**
 * The things that work on the plant: station machines, agents, gates, artifacts, tool-call ticks and
 * packets. Each takes a plan position (`at`, the point it stands on) and its state, plus a `progress`
 * 0..1 wherever something animates, so the caller drives it from the playhead. None keeps state.
 *
 * Every primitive also has a `variant="blueprint"` form, drawn flat at screen position `at` (x, y),
 * using the same symbols: the two modes share one alphabet.
 */

export type Variant = "atlas" | "blueprint";

interface Common {
  /** Atlas: plan point the thing stands on. Blueprint: its screen centre. */
  at: Vec3;
  variant?: Variant;
  lod?: Lod;
  dimmed?: boolean;
  /** Show the visible label. Labels default on at near zoom only. */
  showLabel?: boolean;
}

function labelOn(lod: Lod | undefined, showLabel: boolean | undefined): boolean {
  return showLabel ?? lod === "near";
}

/* ------------------------------------------------------------------------------------------------ */
/* Station machine                                                                                   */
/* ------------------------------------------------------------------------------------------------ */

/** A measured fraction with a real denominator: checks proven of checks declared, tasks green of tasks planned. */
export interface Fraction {
  done: number;
  of: number;
}

export interface StationMachineProps extends Common {
  kind: StationKind;
  state: FactoryState;
  /**
   * Deprecated: kept for compatibility and no longer drawn. A station's work in flight has no known
   * end, so it is shown by `elapsed`; a measured fraction goes in `fraction`.
   */
  progress?: number;
  /** How long the current work has run, in factory ms. Drawn as one tick per minute around the dial (at most 12) and in the near label. */
  elapsed?: number;
  /** A fraction with a real denominator, drawn as the dial's filled sector and "7 of 8" in the near label. */
  fraction?: Fraction;
  /** Number of the current judging round (1..3) when the station has run more than once. */
  round?: number;
  /** Visible label override (default: the station's name). */
  label?: string;
  /** Letter the station's name on the machine's front (lit) face, like a maker's plate. Shown at mid and near zoom. */
  nameplate?: boolean;
  /** Finished work at rest: a passed machine drawn quiet (machine top, plain edge, a small passed mark), for cells that are done. */
  settled?: boolean;
  /** Not reached yet in this run (Blueprint "unbuilt"): dashed outline, no fill, no state mark. */
  planned?: boolean;
}

function fractionWords(f: Fraction | undefined): string {
  return f && f.of > 0 ? `${f.done} of ${f.of}` : "";
}

/**
 * A station as a machine: a square block (36 plan units) whose height depends on its kind, with the
 * station's symbol inscribed on its top face. While it works, a live ring stands around the symbol
 * with one tick per minute of elapsed work; only a measured `fraction` fills the dial. Idle ones have a
 * dashed rim; settled ones are quiet; planned ones are dashed outlines.
 */
export function StationMachine({ kind, state, elapsed, fraction, round: judging, label, nameplate, settled, planned, at, variant = "atlas", lod = "mid", dimmed, showLabel }: StationMachineProps) {
  const look = stations[kind];
  const st = factoryStates[state];
  const fw = fractionWords(fraction);
  const timing = state === "active" && elapsed !== undefined ? `, for ${formatElapsed(elapsed)}` : "";
  const name = `${label ?? look.label}: ${planned ? "not reached yet" : st.label}${timing}${fw ? `, ${fw}` : ""}${judging && judging > 1 ? `, round ${judging} of 3` : ""}`;
  const ink = fc(st.ink);
  if (variant === "blueprint")
    return <ProcessSymbol kind={kind} state={state} elapsed={elapsed} fraction={fraction} round={judging} at={at} label={label ?? look.label} name={name} showLabel={showLabel ?? true} dimmed={dimmed} settled={settled} planned={planned} />;

  const s = factoryTokens.size.stationPad;
  const z = at.z ?? 0;
  const box = { x: at.x - s / 2, y: at.y - s / 2, w: s, d: s, z, h: look.height };
  const working = state === "active" && !planned;
  const quiet = settled && state === "succeeded";
  const r = 13;
  const f = fraction && fraction.of > 0 ? clamp01(fraction.done / fraction.of) : null;
  const arcEnd = f !== null ? { x: at.x + Math.sin(f * Math.PI * 2) * r, y: at.y - Math.cos(f * Math.PI * 2) * r } : null;
  const labelPt = project({ x: at.x + s / 2, y: at.y + s / 2, z });
  const top: FactoryColor = planned || state === "idle" || quiet ? "machine-top" : st.soft;
  const edge: FactoryColor = planned || state === "idle" || quiet ? "plate-edge" : st.ink;
  const ticks = working && elapsed !== undefined ? elapsedTicks(elapsed) : 0;
  return (
    <g role="img" aria-label={name} style={{ opacity: dimmed ? dimmedOpacity : 1 }}>
      <Prism box={box} top={top} weight={!quiet && (state === "failed" || state === "blocked") ? 1.6 : 1} edge={edge} dash={planned ? "3 2.5" : undefined} hatch={planned ? "none" : "shade"} shadow={!planned}>
        {/* Inscribed rim, dashed while unsettled. */}
        <rect
          aria-hidden="true"
          x={box.x + 3.5}
          y={box.y + 3.5}
          width={s - 7}
          height={s - 7}
          style={{ fill: "none", stroke: edge === "plate-edge" ? fc("plate-edge") : ink, strokeWidth: 0.8 * planeStroke, strokeDasharray: planned ? "2 2" : quiet ? undefined : st.dash }}
        />
        <g transform={`translate(${at.x} ${at.y}) rotate(-45) translate(${-at.x} ${-at.y})`}>
          {/* Symbols are rotated -45 degrees in plan so they read upright on the top face. */}
          <StationSymbol kind={kind} x={at.x} y={at.y} size={lod === "far" ? 22 : 18} color={state === "idle" || planned ? fc("ink-soft") : fc("ink")} strokeWidth={1.4 * planeStroke} />
        </g>
        {working ? (
          <g aria-hidden="true">
            {/* Working: a live ring, and one tick per minute it has run. Never a fill. */}
            <circle cx={at.x} cy={at.y} r={r} style={{ fill: "none", stroke: fc("live"), strokeOpacity: f === null ? 0.85 : 0.3, strokeWidth: (f === null ? 1.4 : 2) * planeStroke }} />
            {ticks > 0 ? (
              <g transform={`translate(${at.x} ${at.y})`}>
                <ElapsedTicks r={r + 1.5} count={ticks} color={fc("live")} length={3} strokeWidth={1.2 * planeStroke} />
              </g>
            ) : null}
          </g>
        ) : null}
        {f !== null && !planned ? (
          <g aria-hidden="true">
            {/* A measured fraction: the only thing that fills the dial. */}
            {f >= 0.999 ? (
              <circle cx={at.x} cy={at.y} r={r} style={{ fill: "none", stroke: ink, strokeWidth: 2 * planeStroke }} />
            ) : f > 0.001 && arcEnd ? (
              <path d={`M${at.x} ${at.y - r}A${r} ${r} 0 ${f > 0.5 ? 1 : 0} 1 ${round(arcEnd.x)} ${round(arcEnd.y)}`} style={{ fill: "none", stroke: ink, strokeWidth: 2 * planeStroke, strokeLinecap: "round" }} />
            ) : null}
          </g>
        ) : null}
      </Prism>
      {quiet ? (
        <g transform={`translate(${round(project({ x: box.x + 6, y: box.y + 6, z: z + look.height }).x)} ${round(project({ x: box.x + 6, y: box.y + 6, z: z + look.height }).y)})`}>
          <StateMark state="succeeded" r={3.4} />
        </g>
      ) : null}
      {nameplate && lod !== "far" && look.height >= 10 ? (
        <g transform={uprightTransform({ x: box.x, y: box.y + s, z }, look.height)} aria-hidden="true">
          <text x={5} y={look.height / 2 + Math.min(7, look.height * 0.5) * 0.36} style={{ fill: "var(--mach-ink-muted)", fontSize: Math.min(7, look.height * 0.5), fontWeight: 650, letterSpacing: "0.04em" }}>
            {label ?? look.label}
          </text>
        </g>
      ) : null}
      {labelOn(lod, showLabel) ? (
        <g transform={`translate(${round(labelPt.x + 6)} ${round(labelPt.y + 4)})`}>
          <text style={{ fill: "var(--mach-ink)", fontSize: 11, fontWeight: 600 }}>{label ?? look.label}</text>
          <text y={12} style={{ fill: "var(--mach-ink-muted)", fontSize: 9.5 }} className="tabular">
            {planned ? "Not reached yet" : st.label}
            {working && elapsed !== undefined ? ` · ${formatElapsed(elapsed)}` : ""}
            {fw ? ` · ${fw}` : ""}
            {judging && judging > 1 ? ` · round ${judging} of 3` : ""}
          </text>
        </g>
      ) : null}
    </g>
  );
}

/** The Blueprint's station: a process bubble (after the instrument bubble of a P&ID). */
function ProcessSymbol({
  kind,
  state,
  elapsed,
  fraction,
  round: judging,
  at,
  label,
  name,
  showLabel,
  dimmed,
  settled,
  planned,
}: {
  kind: StationKind;
  state: FactoryState;
  elapsed?: number;
  fraction?: Fraction;
  round?: number;
  at: Vec3;
  label: string;
  name: string;
  showLabel: boolean;
  dimmed?: boolean;
  settled?: boolean;
  planned?: boolean;
}) {
  const st = factoryStates[state];
  const ink = fc(st.ink);
  const r = 15;
  const quiet = settled && state === "succeeded";
  const plain = planned || state === "idle" || quiet;
  const f = fraction && fraction.of > 0 ? clamp01(fraction.done / fraction.of) : null;
  const a = (f ?? 0) * Math.PI * 2;
  const working = state === "active" && !planned;
  return (
    <g role="img" aria-label={name} transform={`translate(${round(at.x)} ${round(at.y)})`} style={{ opacity: dimmed ? dimmedOpacity : 1 }}>
      <circle
        r={r}
        style={{
          fill: planned ? fc("ground") : plain ? fc("plate-top") : fc(st.soft),
          stroke: planned ? fc("ink-soft") : plain ? (quiet ? fc("plate-edge") : fc("ink-soft")) : ink,
          strokeWidth: planned ? 1 : 1.25 * st.weight,
          strokeDasharray: planned ? "3 2.5" : quiet ? undefined : st.dash,
        }}
      />
      {/* Horizontal bar: the P&ID mark for a station on the line, as opposed to a field instrument. */}
      <line x1={-r} y1={0} x2={r} y2={0} aria-hidden="true" style={{ stroke: plain ? fc("plate-edge") : ink, strokeWidth: 0.6, opacity: 0.6 }} />
      <StationSymbol kind={kind} size={17} color={state === "idle" || planned ? fc("ink-soft") : fc("ink")} strokeWidth={1.35} />
      {working ? (
        <g aria-hidden="true">
          <circle r={r + 3.5} style={{ fill: "none", stroke: fc("live"), strokeWidth: 1.2, strokeOpacity: f === null ? 0.85 : 0.3 }} />
          {elapsed !== undefined ? <ElapsedTicks r={r + 4.5} count={elapsedTicks(elapsed)} color={fc("live")} length={2.6} /> : null}
        </g>
      ) : null}
      {f !== null && !planned && f > 0.001 ? (
        <path
          aria-hidden="true"
          d={f >= 0.999 ? `M0 ${-r - 3.5}A${r + 3.5} ${r + 3.5} 0 1 1 -0.01 ${-r - 3.5}` : `M0 ${-r - 3.5}A${r + 3.5} ${r + 3.5} 0 ${f > 0.5 ? 1 : 0} 1 ${round(Math.sin(a) * (r + 3.5))} ${round(-Math.cos(a) * (r + 3.5))}`}
          style={{ fill: "none", stroke: ink, strokeWidth: 2, strokeLinecap: "round" }}
        />
      ) : null}
      {!planned ? (
        <g transform={`translate(${r * 0.78} ${-r * 0.78})`}>
          <StateMark state={state} r={quiet ? 3.6 : 4.6} />
        </g>
      ) : null}
      {judging && judging > 1 ? (
        <text x={-r - 2} y={-r + 2} textAnchor="end" style={{ fill: fc("fail"), fontSize: 9.5, fontWeight: 700 }} className="tabular">
          ×{judging}
        </text>
      ) : null}
      {showLabel ? (
        <text y={r + 14} textAnchor="middle" style={{ fill: planned ? "var(--mach-ink-subtle)" : "var(--mach-ink)", fontSize: 10.5, fontWeight: 600 }}>
          {label}
        </text>
      ) : null}
      {showLabel && (working || f !== null) ? (
        <text y={r + 26} textAnchor="middle" className="tabular" style={{ fill: "var(--mach-ink-muted)", fontSize: 9.5 }}>
          {[working && elapsed !== undefined ? formatElapsed(elapsed) : "", fractionWords(fraction)].filter(Boolean).join(" · ")}
        </text>
      ) : null}
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Agent                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

export interface AgentMarkerProps extends Common {
  /** The agent's role (named `agentRole` so it is never mistaken for an ARIA role). */
  agentRole: AgentRole;
  tier: ModelTier;
  seat?: ReviewerSeat;
  state: FactoryState;
  /**
   * Deprecated: kept for compatibility and no longer drawn. An agent's run has no known end; pass
   * `elapsed` and the head shows one tick per minute it has worked.
   */
  progress?: number;
  /** How long the agent has been working, in factory ms. */
  elapsed?: number;
  /** 0..1 arrival (agentArrive). 1 means present. */
  arrive?: number;
  /** 0..1 departure (agentLeave). 0 means present. */
  leave?: number;
  /** An agent's own name if it has one (e.g. a run ID); defaults to role and tier. */
  label?: string;
  /** Where the visible label goes in the Atlas: beside the head (default) or centred below the floor disc. */
  labelPosition?: "beside" | "below";
}

/**
 * An agent as a standing figure: a floor disc carrying its role emblem, a post whose height is its
 * model tier, and a head whose shape is its tier (Fable diamond, Opus square, Sonnet circle, Haiku
 * triangle). While working, its head is filled with the live ink and ringed, with one tick per minute it
 * has worked (never a fill toward an unknown end). A reviewer carries its seat
 * letter. Arrival grows the post up from the disc; departure sinks it back.
 */
export function AgentMarker({ agentRole: role, tier, seat, state, elapsed, arrive = 1, leave = 0, label, labelPosition = "beside", at, variant = "atlas", lod = "mid", dimmed, showLabel }: AgentMarkerProps) {
  const tierLook = modelTiers[tier];
  const st = factoryStates[state];
  const roleLabel = role === "reviewer" && seat ? `${reviewerSeats[seat].label} reviewer` : agentRoles[role].label;
  const name = `${label ?? roleLabel}, ${tierLook.label}: ${st.label}${state === "active" && elapsed !== undefined ? `, for ${formatElapsed(elapsed)}` : ""}`;
  const ink = fc(st.ink);
  const present = clamp01(arrive) * (1 - clamp01(leave));
  const ticks = state === "active" && elapsed !== undefined ? elapsedTicks(elapsed) : 0;
  const headFill = state === "active" ? fc("live") : state === "idle" ? fc("plate-top") : fc(st.soft);
  const headStroke = state === "idle" ? fc("ink") : ink;

  if (variant === "blueprint") {
    return (
      <g role="img" aria-label={name} transform={`translate(${round(at.x)} ${round(at.y)})`} style={{ opacity: (dimmed ? dimmedOpacity : 1) * present }}>
        <AgentHead tier={tier} fill={headFill} stroke={headStroke} />
        {state === "active" ? (
          <g aria-hidden="true">
            <circle r={8.5} style={{ fill: "none", stroke: fc("live"), strokeWidth: 1, strokeOpacity: 0.6 }} />
            <ElapsedTicks r={8.5} count={ticks} color={fc("live")} length={2.2} strokeWidth={1} />
          </g>
        ) : null}
        {seat ? (
          <text x={0} y={-11} textAnchor="middle" style={{ fill: "var(--mach-ink-muted)", fontSize: 8.5, fontWeight: 700 }} aria-hidden="true">
            {reviewerSeats[seat].letter}
          </text>
        ) : null}
        {labelOn(lod, showLabel) ? (
          <text x={10} y={3.5} style={{ fill: "var(--mach-ink-muted)", fontSize: 10 }}>
            {roleLabel} · {tierLook.label}
          </text>
        ) : null}
      </g>
    );
  }

  const z = at.z ?? 0;
  const h = tierLook.height * present;
  const base = project({ ...at, z });
  const top = project({ ...at, z: z + h });
  const rr = 8.5;
  return (
    <g role="img" aria-label={name} style={{ opacity: (dimmed ? dimmedOpacity : 1) * Math.min(1, present * 1.6) }}>
      {/* Floor disc with the role emblem, in the plane. */}
      <g transform={planeTransform(z)}>
        <ellipse cx={at.x + h * 0.25} cy={at.y - h * 0.09} rx={8} ry={8} aria-hidden="true" style={{ fill: fc("shadow") }} />
        <circle cx={at.x} cy={at.y} r={8} aria-hidden="true" style={{ fill: fc("plate-top"), stroke: headStroke, strokeWidth: 1 * planeStroke }} />
        <g transform={`translate(${at.x} ${at.y}) rotate(-45)`}>
          <RoleEmblem role={role} color={fc("ink")} />
        </g>
      </g>
      {/* Post. */}
      <line x1={base.x} y1={base.y} x2={top.x} y2={top.y} aria-hidden="true" style={{ stroke: headStroke, strokeWidth: 1.6, strokeLinecap: "round" }} />
      <g transform={`translate(${round(top.x)} ${round(top.y - 4)})`}>
        <AgentHead tier={tier} fill={headFill} stroke={headStroke} />
        {state === "active" ? (
          <g aria-hidden="true">
            <circle r={rr} style={{ fill: "none", stroke: fc("live"), strokeOpacity: 0.6, strokeWidth: 1.1 }} />
            <ElapsedTicks r={rr} count={ticks} color={fc("live")} length={2.4} strokeWidth={1.1} />
          </g>
        ) : null}
        {state !== "active" && state !== "idle" ? (
          <g transform="translate(7 -7)">
            <StateMark state={state} r={3.8} />
          </g>
        ) : null}
        {seat && lod !== "far" ? (
          <text x={-11} y={3.5} textAnchor="end" style={{ fill: "var(--mach-ink)", fontSize: 9, fontWeight: 700 }} aria-hidden="true">
            {reviewerSeats[seat].letter}
          </text>
        ) : null}
        {labelOn(lod, showLabel) && labelPosition === "beside" ? (
          <g aria-hidden="true">
            <text x={12} y={-1} style={{ fill: "var(--mach-ink)", fontSize: 10.5, fontWeight: 600 }}>
              {label ?? roleLabel}
            </text>
            <text x={12} y={10} style={{ fill: "var(--mach-ink-muted)", fontSize: 9.5 }}>
              {tierLook.label}
            </text>
          </g>
        ) : null}
      </g>
      {labelOn(lod, showLabel) && labelPosition === "below" ? (
        <g aria-hidden="true" transform={`translate(${round(base.x)} ${round(base.y + 16)})`}>
          <text textAnchor="middle" style={{ fill: "var(--mach-ink)", fontSize: 10, fontWeight: 600 }}>
            {label ?? roleLabel}
          </text>
          <text y={11} textAnchor="middle" style={{ fill: "var(--mach-ink-muted)", fontSize: 9 }}>
            {tierLook.label}
          </text>
        </g>
      ) : null}
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Gate                                                                                              */
/* ------------------------------------------------------------------------------------------------ */

export type GateLamp = "off" | "pending" | "pass" | "fail";

export interface GateGlyphProps extends Common {
  kind: GateKind;
  position: GatePosition;
  /** 0..1 of the transition into `position` (gateOpen, gateClose, gateRefuse, humanRelease). 1 = settled. */
  progress?: number;
  /** The position it is coming from, for the transition. Defaults to closed. */
  from?: GatePosition;
  /** Lamps on the lintel: three votes for consensus, red then green for red-before-green. */
  lamps?: GateLamp[];
  /** Which plan axis the gate's span lies along: "y" stands across a route that runs along x. */
  axis?: "x" | "y";
  /**
   * Letter a word on the floor beside the gate's footing, downstream, along its span (e.g. "Consensus",
   * or a ticket ID). Shown at mid and near zoom; use instead of, or with, the upright label.
   */
  floorLabel?: string;
  /** Not reached yet in this run (Blueprint "unbuilt"): dashed outline, no fill, no bar, no lamps. */
  planned?: boolean;
}

const armAngle: Record<GatePosition, number> = { open: 82, closed: 0, refusing: 0, waiting: 0 };

/**
 * A gate as a portal frame: two posts, a lintel carrying the gate's symbol plaque and its lamps, and a
 * barrier arm pivoting at the near post. Open raises the arm to 82 degrees; closed lowers it across
 * the span; refusing drops it shut with one damped overshoot and lights the plaque in the fail ink;
 * waiting holds it shut with the plaque in the human ink. The state word is in the accessible name.
 */
export function GateGlyph({ kind, position, progress = 1, from = "closed", lamps, axis = "y", floorLabel, planned, at, variant = "atlas", lod = "mid", dimmed, showLabel }: GateGlyphProps) {
  const g = gates[kind];
  const pos = gatePositions[position];
  const st = factoryStates[pos.state];
  const ink = position === "closed" ? fc("ink") : fc(st.ink);
  const name = `${g.label}: ${planned ? "not reached yet" : pos.label}`;
  const p = clamp01(progress);

  if (variant === "blueprint" && planned) {
    const r = 14;
    return (
      <g role="img" aria-label={name} transform={`translate(${round(at.x)} ${round(at.y)})`} style={{ opacity: dimmed ? dimmedOpacity : 1 }}>
        <path d={`M0 ${-r}L${r} 0L0 ${r}L${-r} 0Z`} style={{ fill: fc("ground"), stroke: fc("ink-soft"), strokeWidth: 1, strokeDasharray: "3 2.5" }} />
        <StationSymbol kind={g.symbol} size={13} color={fc("ink-soft")} strokeWidth={1.2} />
        {showLabel ?? true ? (
          <text y={r + 17} textAnchor="middle" style={{ fill: "var(--mach-ink-subtle)", fontSize: 10.5, fontWeight: 600 }}>
            {g.label}
          </text>
        ) : null}
      </g>
    );
  }

  if (variant === "blueprint") {
    const r = 14;
    return (
      <g role="img" aria-label={name} transform={`translate(${round(at.x)} ${round(at.y)})`} style={{ opacity: dimmed ? dimmedOpacity : 1 }}>
        <path d={`M0 ${-r}L${r} 0L0 ${r}L${-r} 0Z`} style={{ fill: position === "closed" ? fc("plate-top") : fc(st.soft), stroke: ink, strokeWidth: 1.4 }} />
        <StationSymbol kind={g.symbol} size={13} color={fc("ink")} strokeWidth={1.3} />
        {/* The bar: horizontal across the diamond when shut, absent when open. */}
        {position !== "open" ? <line x1={-r - 5} y1={r + 4} x2={r + 5} y2={r + 4} aria-hidden="true" style={{ stroke: ink, strokeWidth: 2, strokeLinecap: "round", opacity: position === "refusing" ? 1 : 0.85 }} /> : null}
        {position === "open" ? <path d={`M${-r - 5} ${r + 4}h4M${r + 1} ${r + 4}h4`} aria-hidden="true" style={{ stroke: ink, strokeWidth: 2, strokeLinecap: "round" }} /> : null}
        {lamps ? <Lamps lamps={lamps} x={0} y={-r - 6} /> : null}
        {showLabel ?? true ? (
          <text y={r + 17} textAnchor="middle" style={{ fill: "var(--mach-ink)", fontSize: 10.5, fontWeight: 600 }}>
            {g.label}
          </text>
        ) : null}
      </g>
    );
  }

  const span = factoryTokens.size.gateSpan;
  const H = kind === "human" ? factoryTokens.elevation.gatehouse : factoryTokens.elevation.gate;
  const z = at.z ?? 0;
  const along = (t: number, zz: number): Vec3 => (axis === "y" ? { x: at.x, y: at.y - span / 2 + t * span, z: zz } : { x: at.x - span / 2 + t * span, y: at.y, z: zz });
  const postA = [project(along(0, z)), project(along(0, z + H))] as const;
  const postB = [project(along(1, z)), project(along(1, z + H))] as const;

  // Arm angle: interpolate from the previous position, with the refusal curve when refusing.
  const fromA = armAngle[from];
  const toA = armAngle[position];
  const angle = position === "refusing" ? lerp(14, 0, p) : lerp(fromA, toA, p);
  const pivotZ = z + 11;
  const rad = (angle * Math.PI) / 180;
  const armLen = span - 4;
  const armEnd: Vec3 = axis === "y" ? { x: at.x, y: at.y - span / 2 + Math.cos(rad) * armLen, z: pivotZ + Math.sin(rad) * armLen } : { x: at.x - span / 2 + Math.cos(rad) * armLen, y: at.y, z: pivotZ + Math.sin(rad) * armLen };
  const pivot = project(along(0, pivotZ));
  const end = project(armEnd);
  const lintelMid = project(along(0.5, z + H));
  const flash = position === "refusing" ? 1 - segment(p, 0.25, 1) * 0.5 : 1;
  const plaqueFill = position === "closed" ? fc("plate-top") : fc(st.soft);
  return (
    <g role="img" aria-label={name} style={{ opacity: dimmed ? dimmedOpacity : 1 }}>
      {/* Footing shadows. */}
      <g transform={planeTransform(z)} aria-hidden="true">
        <line x1={along(0, z).x} y1={along(0, z).y} x2={along(1, z).x} y2={along(1, z).y} style={{ stroke: fc("plate-edge"), strokeWidth: 1 * planeStroke, strokeDasharray: "2 2.5" }} />
      </g>
      {/* Far post, then lintel, arm, near post. */}
      <line x1={postB[0].x} y1={postB[0].y} x2={postB[1].x} y2={postB[1].y} aria-hidden="true" style={{ stroke: fc("ink"), strokeWidth: 2.4, strokeLinecap: "square" }} />
      <line x1={postA[1].x} y1={postA[1].y} x2={postB[1].x} y2={postB[1].y} aria-hidden="true" style={{ stroke: fc("ink"), strokeWidth: 3, strokeLinecap: "square" }} />
      <line x1={pivot.x} y1={pivot.y} x2={end.x} y2={end.y} aria-hidden="true" style={{ stroke: ink, strokeWidth: 2.6, strokeLinecap: "round" }} />
      {/* Arm banding: drafted stripes on the barrier so its position reads without colour. */}
      {[0.25, 0.5, 0.75].map((t) => {
        const q = { x: pivot.x + (end.x - pivot.x) * t, y: pivot.y + (end.y - pivot.y) * t };
        return <circle key={t} cx={round(q.x)} cy={round(q.y)} r={1.5} aria-hidden="true" style={{ fill: fc("plate-top") }} />;
      })}
      <line x1={postA[0].x} y1={postA[0].y} x2={postA[1].x} y2={postA[1].y} aria-hidden="true" style={{ stroke: fc("ink"), strokeWidth: 2.4, strokeLinecap: "square" }} />
      <circle cx={pivot.x} cy={pivot.y} r={2.2} aria-hidden="true" style={{ fill: fc("ink") }} />
      {/* The plaque, standing on the middle of the lintel, carrying the gate symbol. */}
      <g transform={`translate(${round(lintelMid.x)} ${round(lintelMid.y - 8)})`} aria-hidden="true">
        <rect x={-9} y={-7.5} width={18} height={15} rx={1.5} style={{ fill: plaqueFill, stroke: ink, strokeWidth: 1.1, opacity: flash }} />
        <StationSymbol kind={g.symbol} size={11} color={fc("ink")} strokeWidth={1.2} />
      </g>
      {lamps ? <Lamps lamps={lamps} x={lintelMid.x} y={lintelMid.y - 23} /> : null}
      {floorLabel && lod !== "far" ? (
        <FloorLettering
          at={axis === "y" ? { x: at.x + 14, y: at.y + span / 2, z } : { x: at.x - span / 2, y: at.y + 14, z }}
          axis={axis}
          text={floorLabel}
          size={8}
          font="sans"
          weight={600}
          decorative
        />
      ) : null}
      {labelOn(lod, showLabel) ? (
        <g transform={`translate(${round(Math.max(postA[1].x, postB[1].x) + 8)} ${round(Math.min(postA[1].y, postB[1].y) + 2)})`}>
          <text style={{ fill: "var(--mach-ink)", fontSize: 11, fontWeight: 600 }}>{g.label}</text>
          <text y={12} style={{ fill: "var(--mach-ink-muted)", fontSize: 9.5 }}>
            {pos.label}
          </text>
        </g>
      ) : null}
    </g>
  );
}

function Lamps({ lamps, x, y }: { lamps: GateLamp[]; x: number; y: number }) {
  const gap = 9;
  const x0 = x - ((lamps.length - 1) * gap) / 2;
  return (
    <g aria-hidden="true">
      {lamps.map((lamp, i) => {
        const cx = round(x0 + i * gap);
        if (lamp === "pass") return <g key={i} transform={`translate(${cx} ${y})`}><StateMark state="succeeded" r={3.6} /></g>;
        if (lamp === "fail") return <g key={i} transform={`translate(${cx} ${y})`}><StateMark state="failed" r={3.6} /></g>;
        if (lamp === "pending") return <g key={i} transform={`translate(${cx} ${y})`}><StateMark state="active" r={3.6} progress={0} /></g>;
        return <circle key={i} cx={cx} cy={y} r={3} style={{ fill: fc("plate-top"), stroke: fc("ink-soft"), strokeWidth: 1, strokeDasharray: "1.6 1.2" }} />;
      })}
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Artifact                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

export interface ArtifactCardProps extends Common {
  kind: ArtifactKind;
  state?: FactoryState;
  /** 0..1 materialisation (artifactMaterialise): the card rises from the floor and its marks draw. */
  progress?: number;
  /** The file name, if more specific than the kind's (e.g. "SLICE-007-invite.md"). */
  file?: string;
}

/**
 * An artifact as a sheet standing on the floor, face to the viewer, with a folded corner and its
 * kind's mark. It materialises by rising out of the floor (its height grows from 0 with the settle
 * curve) as its outline and mark fade in. A handoff is the same card carried along a route by the
 * caller (`at` from `pointAlong`).
 */
export function ArtifactCard({ kind, state = "succeeded", progress = 1, file, at, variant = "atlas", lod = "mid", dimmed, showLabel }: ArtifactCardProps) {
  const look = artifacts[kind];
  const st = factoryStates[state];
  const p = clamp01(progress);
  const name = `${look.label} (${file ?? look.file})${state === "failed" ? `: ${st.label}` : ""}`;
  const stroke = state === "failed" ? fc("fail") : state === "active" ? fc("live") : fc("ink");
  const fill = state === "failed" ? fc("fail-soft") : fc("plate-top");
  const { w, h } = factoryTokens.size.artifact;
  if (variant === "blueprint") {
    return (
      <g role="img" aria-label={name} transform={`translate(${round(at.x - w / 2)} ${round(at.y - h / 2)})`} style={{ opacity: (dimmed ? dimmedOpacity : 1) * p }}>
        <path d={artifactCardPath} style={{ fill, stroke, strokeWidth: 1.1, strokeLinejoin: "round" }} />
        <path d={artifactFoldPath} aria-hidden="true" style={{ fill: "none", stroke, strokeWidth: 0.9 }} />
        <ArtifactMark kind={kind} color={state === "failed" ? fc("fail") : fc("ink")} />
        {artifactProvenance[kind] ? <ProvenanceBadge from={artifactProvenance[kind]!} color={state === "failed" ? fc("fail") : fc("ink")} /> : null}
        {showLabel ?? lod === "near" ? (
          <text x={w + 5} y={h / 2 + 3.5} style={{ fill: "var(--mach-ink-muted)", fontFamily: "var(--mach-font-mono)", fontSize: 9.5 }} className="notranslate">
            {file ?? look.file}
          </text>
        ) : null}
      </g>
    );
  }
  const height = h * p;
  const z = at.z ?? 0;
  const s = height / h || 0.0001;
  const foot = project({ x: at.x - w / 2, y: at.y, z });
  return (
    <g role="img" aria-label={name} style={{ opacity: (dimmed ? dimmedOpacity : 1) * Math.min(1, p * 1.4) }}>
      <g transform={planeTransform(z)} aria-hidden="true">
        <path d={`M${at.x - w / 2} ${at.y}h${w}l${height * 0.5} ${-height * 0.18}h${-w}z`} style={{ fill: fc("shadow") }} />
      </g>
      <g transform={uprightTransform({ x: at.x - w / 2, y: at.y, z }, height)}>
        <g transform={`scale(1 ${round(s)})`}>
          <path d={artifactCardPath} style={{ fill, stroke, strokeWidth: 1, strokeLinejoin: "round" }} />
          <path d={artifactFoldPath} aria-hidden="true" style={{ fill: "none", stroke, strokeWidth: 0.8 }} />
          <g style={{ opacity: segment(p, 0.4, 1) }}>
            <ArtifactMark kind={kind} color={state === "failed" ? fc("fail") : fc("ink")} />
            {artifactProvenance[kind] ? <ProvenanceBadge from={artifactProvenance[kind]!} color={state === "failed" ? fc("fail") : fc("ink")} /> : null}
          </g>
        </g>
      </g>
      {labelOn(lod, showLabel) ? (
        <text x={round(foot.x)} y={round(foot.y + 14)} style={{ fill: "var(--mach-ink-muted)", fontFamily: "var(--mach-font-mono)", fontSize: 9 }} className="notranslate">
          {file ?? look.file}
        </text>
      ) : null}
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Tool-call tick                                                                                    */
/* ------------------------------------------------------------------------------------------------ */

export interface ToolTickProps extends Common {
  family: ToolFamily;
  /** idle (scheduled), active (running), succeeded, failed. */
  state?: FactoryState;
  /** 0..1 (toolTick): the stem rises and the cap settles. */
  progress?: number;
  /** The tool's own words for a tooltip or the inspector (e.g. "pnpm test"). */
  detail?: string;
}

/**
 * A tool call as a tick on the cell's ticker: a short stem rising from the floor strip, capped by
 * its family's shape (read: ring, write: square, run: triangle, search: lozenge, test: check, git: node).
 * A failed call has a cross-barred stem. Ticks accumulate along the ticker in time order.
 */
export function ToolTick({ family, state = "succeeded", progress = 1, detail, at, variant = "atlas", dimmed }: ToolTickProps) {
  const f = toolFamilies[family];
  const st = factoryStates[state];
  const p = clamp01(progress);
  const color = state === "failed" ? fc("fail") : state === "active" ? fc("live") : fc("ink");
  const name = `${f.label} tool call${detail ? ` (${detail})` : ""}: ${st.label}`;
  const stem = (variant === "blueprint" ? 9 : 11) * p;
  const base = variant === "blueprint" ? { x: at.x, y: at.y } : project(at);
  return (
    <g role="img" aria-label={name} transform={`translate(${round(base.x)} ${round(base.y)})`} style={{ opacity: (dimmed ? dimmedOpacity : 1) * Math.min(1, p * 2) }}>
      <line x1={0} y1={0} x2={0} y2={-stem} aria-hidden="true" style={{ stroke: color, strokeWidth: 1.1 }} />
      {state === "failed" ? <line x1={-2.2} y1={-stem * 0.45} x2={2.2} y2={-stem * 0.45} aria-hidden="true" style={{ stroke: color, strokeWidth: 1.1 }} /> : null}
      <g transform={`translate(0 ${round(-stem - 3)})`}>
        <ToolCap family={family} color={color} filled={state !== "idle"} />
      </g>
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Packet                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

export interface PacketProps extends Common {
  /** Heading on the plan, radians (from `pointAlong`). */
  angle?: number;
  state?: FactoryState;
  /** The ticket it carries, for the name and the near label. */
  ticket?: string;
}

/**
 * A packet: one ticket's work in transit, drawn as a small carriage (12 x 8 x 6) riding the route,
 * its top in the state tint with a chevron pointing the way. Its position is the caller's
 * `pointAlong(route, progress)`; it has no motion of its own.
 */
export function Packet({ at, angle = 0, state = "active", ticket, variant = "atlas", lod = "mid", dimmed, showLabel }: PacketProps) {
  const st = factoryStates[state];
  const ink = fc(st.ink);
  const name = `${ticket ? `${ticket} ` : ""}in transit: ${st.label}`;
  if (variant === "blueprint") {
    const deg = (angle * 180) / Math.PI;
    return (
      <g role="img" aria-label={name} transform={`translate(${round(at.x)} ${round(at.y)}) rotate(${round(deg)})`} style={{ opacity: dimmed ? dimmedOpacity : 1 }}>
        <path d="M-6 -4.5H3L7 0L3 4.5H-6Z" style={{ fill: fc(st.soft), stroke: ink, strokeWidth: 1.3, strokeLinejoin: "round" }} />
      </g>
    );
  }
  const { x: L, y: W, z: H } = factoryTokens.size.packet;
  const alongX = Math.abs(Math.cos(angle)) >= Math.abs(Math.sin(angle));
  const lx = alongX ? L : W;
  const ly = alongX ? W : L;
  const z = (at.z ?? 0) + 1;
  const dir = alongX ? Math.sign(Math.cos(angle)) || 1 : Math.sign(Math.sin(angle)) || 1;
  const cx = at.x;
  const cy = at.y;
  const chevron = alongX ? `M${cx - 2.5 * dir} ${cy - 2.6}L${cx + 2 * dir} ${cy}L${cx - 2.5 * dir} ${cy + 2.6}` : `M${cx - 2.6} ${cy - 2.5 * dir}L${cx} ${cy + 2 * dir}L${cx + 2.6} ${cy - 2.5 * dir}`;
  const label = project({ x: cx, y: cy, z: z + H });
  return (
    <g role="img" aria-label={name} style={{ opacity: dimmed ? dimmedOpacity : 1 }}>
      <Prism box={{ x: cx - lx / 2, y: cy - ly / 2, z, w: lx, d: ly, h: H }} top={st.soft} lit="plate-top" shade={st.soft} edge={st.ink} hatch="none" weight={1.1}>
        <path d={chevron} aria-hidden="true" style={{ fill: "none", stroke: ink, strokeWidth: 1.3 * planeStroke, strokeLinecap: "round", strokeLinejoin: "round" }} />
      </Prism>
      {ticket && labelOn(lod, showLabel) ? (
        <text x={round(label.x)} y={round(label.y - 7)} textAnchor="middle" style={{ fill: "var(--mach-ink)", fontFamily: "var(--mach-font-mono)", fontSize: 9 }} className="notranslate">
          {ticket}
        </text>
      ) : null}
    </g>
  );
}
