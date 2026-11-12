import type { ReactNode } from "react";
import { fc, factoryStates, type AgentRole, type ArtifactKind, type FactoryColor, type FactoryMarkShape, type FactoryState, type ModelTier, type StationKind, type ToolFamily } from "./grammar";

/**
 * The symbol alphabet: one drafted mark per station kind, artifact kind, tool family, agent tier
 * and state. Symbols are pure line drawings on a fixed grid with no colour of their own: the caller
 * passes the ink. The same symbol is drawn flat on a machine's top face in the Atlas and upright in
 * the Blueprint, which is what makes the two modes read as one product.
 *
 * All symbols are aria-hidden; the thing that carries them has the accessible name.
 */

/* Station symbols: a 24-unit grid, centred on (12, 12), stroked at 1.5. */
const stationPaths: Record<StationKind | "red-green", ReactNode> = {
  // A hopper: work poured in from above.
  intake: (
    <>
      <path d="M3.5 5h17l-6 7.5V19h-5v-6.5z" />
      <path d="M8 8.5h8" />
    </>
  ),
  // A wedge cut from a whole: carving the ticket into one thin slice.
  groom: (
    <>
      <path d="M11 13V4.6A8 8 0 1 0 19.4 13z" />
      <path d="M14 10V3.2A7 7 0 0 1 20.8 10z" />
    </>
  ),
  // A set square: drafting the contracts and the plan.
  plan: (
    <>
      <path d="M4 20V4l16 16z" />
      <path d="M8 16v-4.4l4.4 4.4z" />
    </>
  ),
  // A gauge: the readiness score.
  audit: (
    <>
      <path d="M3.5 16.5a8.5 8.5 0 0 1 17 0" />
      <path d="M12 16.5l4.2-5.4" />
      <path d="M2.5 20h19" />
      <path d="M6.2 11.6l1.2 1M12 8v1.6M17.8 11.6l-1.2 1" />
    </>
  ),
  // Bonded courses: construction, task on task.
  build: (
    <>
      <path d="M3.5 5.5h17v5h-17zM3.5 13.5h17v5h-17z" />
      <path d="M12 5.5v5M7.8 13.5v5M16.2 13.5v5" />
    </>
  ),
  // A crosshair: evidence taken by an independent eye.
  verify: (
    <>
      <circle cx="12" cy="12" r="6.5" />
      <path d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  // Three seats in a ring: the panel.
  review: (
    <>
      <path d="M12 6.4L6.6 16.2h10.8z" strokeDasharray="2 2" />
      <circle cx="12" cy="5.2" r="2.7" />
      <circle cx="5.6" cy="17.4" r="2.7" />
      <circle cx="18.4" cy="17.4" r="2.7" />
    </>
  ),
  // A person.
  "human-approval": (
    <>
      <circle cx="12" cy="7.6" r="3.4" />
      <path d="M5 20.5a7 7 0 0 1 14 0" />
    </>
  ),
  // Two lines becoming one.
  merge: (
    <>
      <path d="M6.5 3.5v4.5c0 4.2 5.5 5 5.5 9v3.5" />
      <path d="M17.5 3.5v4.5c0 4.2-5.5 5-5.5 9" />
      <circle cx="12" cy="20.5" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  // An archive box.
  cleanup: (
    <>
      <path d="M3.5 5.5h17v4.5h-17z" />
      <path d="M5 10v9h14v-9" />
      <path d="M9.8 13.5h4.4" />
    </>
  ),
  // A lens: the observer reading the record.
  observe: (
    <>
      <path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6S2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  // Red before green: a failing mark, then a passing one.
  "red-green": (
    <>
      <path d="M3.5 8.5l5 5M8.5 8.5l-5 5" />
      <path d="M13.5 11.5l2.6 2.6 4.4-5" />
      <path d="M11 5v14" strokeDasharray="1.6 1.8" />
    </>
  ),
};

export interface SymbolProps {
  /** Ink colour (a CSS colour; use `fc()` or a `var(--mach-*)`). */
  color?: string;
  /** Rendered size in user units. */
  size?: number;
  x?: number;
  y?: number;
  strokeWidth?: number;
}

/** The station symbol, centred at (x, y). */
export function StationSymbol({ kind, color = fc("ink"), size = 24, x = 0, y = 0, strokeWidth = 1.5 }: SymbolProps & { kind: StationKind | "red-green" }) {
  const s = size / 24;
  return (
    <g
      aria-hidden="true"
      transform={`translate(${x - size / 2} ${y - size / 2}) scale(${s})`}
      style={{ color, stroke: color, fill: "none", strokeWidth: strokeWidth / s, strokeLinecap: "round", strokeLinejoin: "round" }}
    >
      {stationPaths[kind]}
    </g>
  );
}

/* Artifact marks: drawn on a card 14 wide by 18 tall, origin top-left, the top-right corner folded. */
const artifactPaths: Record<ArtifactKind, ReactNode> = {
  intent: <path d="M3 6h6M3 8.6h8M3 11.2h8M3 13.8h5" />,
  spec: <path d="M5.4 5.2c-1.4 0-1.6.8-1.6 2s-.2 1.8-1.2 1.8c1 0 1.2.6 1.2 1.8s.2 2 1.6 2M8.6 5.2c1.4 0 1.6.8 1.6 2s.2 1.8 1.2 1.8c-1 0-1.2.6-1.2 1.8s-.2 2-1.6 2" />,
  contract: (
    <>
      <path d="M2.8 5h8.4v9.6H2.8z" />
      <path d="M5 8h4M5 11h4" />
    </>
  ),
  plan: <path d="M2.8 5.2h2v2h-2zM6.6 6.2h4.6M2.8 9.6h2v2h-2zM6.6 10.6h4.6M3.4 14.4h7.8" />,
  commit: (
    <>
      <path d="M7 4.2v3.4M7 12v3.4" />
      <circle cx="7" cy="9.8" r="2.2" />
    </>
  ),
  "build-report": <path d="M3 14.5V10M5.7 14.5V7M8.4 14.5V11.5M11.1 14.5V5.5M2.4 14.5h9.2" />,
  evidence: (
    <>
      <path d="M2.6 7V4.8h2.2M9.2 4.8h2.2V7M11.4 12.6v2.2H9.2M4.8 14.8H2.6v-2.2" />
      <circle cx="7" cy="9.8" r="1.6" />
    </>
  ),
  results: <path d="M2.8 6.2l1.2 1.2 2-2.2M2.8 10.2l1.2 1.2 2-2.2M2.8 14.4l2.6-2.6M5.4 14.4l-2.6-2.6M8 6.4h3.4M8 10.4h3.4M8 13.4h3.4" />,
  vote: (
    <>
      <path d="M2.6 8.6h8.8v6.4H2.6z" />
      <path d="M4.6 5.6l1.6 1.6 3.2-3.4" />
    </>
  ),
  findings: <path d="M3 5.4h5.4M3 8.2h4.4M3 11h5.4M3 13.8h3.6M10.6 5.4v5.2M10.6 13v.8" />,
  decision: (
    <>
      <circle cx="7" cy="9.8" r="3.8" />
      <path d="M5.3 9.9l1.2 1.2 2.3-2.5" />
    </>
  ),
  "merge-commit": <path d="M3.8 4.4v2.4c0 2.4 3.2 2.8 3.2 5.2v3.4M10.2 4.4v2.4c0 2.4-3.2 2.8-3.2 5.2" />,
  // An envelope: the packet sent to the panel.
  "review-packet": <path d="M2.6 6.6h8.8v7.4H2.6zM2.6 6.6L7 10.4l4.4-3.8" />,
  // A plus over a minus, beside a gutter: what changed.
  diff: <path d="M3 6.4h3.4M4.7 4.7v3.4M3 11.8h3.4M8.6 4.6v10.2M10.2 6h1.2M10.2 9h1.2M10.2 12h1.2" />,
  // A segmented progress bar: task progress and suite state.
  "build-state": <path d="M2.6 8.2h8.8v3.8H2.6zM5.5 8.2v3.8M8.5 8.2v3.8M3.4 10.1h1.3M6.3 10.1h1.3M3 5.4h5M3 14.6h6.4" />,
  // A banded box: the finished cell's archive.
  archive: <path d="M2.6 5.6h8.8v2.6H2.6zM3.4 8.2v6.6h7.2V8.2M5.8 10.8h2.4" />,
  // Ledger lines with bullets: one line per finished ticket.
  "run-record": <path d="M3 5.6h.2M5 5.6h6.2M3 8.4h.2M5 8.4h6.2M3 11.2h.2M5 11.2h6.2M3 14h.2M5 14h4" />,
  // Pass 3: MACH's own kinds. The base mark says what it is; the corner badge (ArtifactCard) says where from.
  "findings-copy": <path d="M3 5.4h5.4M3 8.2h4.4M3 11h5.4M3 13.8h3.6M10.6 5.4v5.2M10.6 13v.8" />,
  "verification-results": <path d="M2.8 6.2l1.2 1.2 2-2.2M2.8 10.2l1.2 1.2 2-2.2M2.8 14.4l2.6-2.6M5.4 14.4l-2.6-2.6M8 6.4h3.4M8 10.4h3.4M8 13.4h3.4" />,
  "verification-summary": (
    <>
      <circle cx="7" cy="10.2" r="3.8" />
      <path d="M5.3 10.3l1.2 1.2 2.3-2.5M3 5h4" />
    </>
  ),
  "verification-findings": <path d="M3 5.4h5.4M3 8.2h4.4M3 11h5.4M3 13.8h3.6M10.6 5.4v5.2M10.6 13v.8" />,
  "review-diff": <path d="M3 6.4h3.4M4.7 4.7v3.4M3 11.8h3.4M8.6 4.6v10.2M10.2 6h1.2M10.2 9h1.2M10.2 12h1.2" />,
  "review-findings": <path d="M3 5.4h5.4M3 8.2h4.4M3 11h5.4M3 13.8h3.6M10.6 5.4v5.2M10.6 13v.8" />,
};

/** The provenance badge drawn in an artifact's folded corner (card coordinates), 3.6 across. */
export function ProvenanceBadge({ from, color }: { from: "verification" | "review" | "return"; color: string }) {
  const s = { stroke: color, fill: "none", strokeWidth: 0.7, strokeLinecap: "round" as const };
  if (from === "verification")
    return (
      <g aria-hidden="true" style={s}>
        <circle cx="12" cy="2" r="1.3" />
        <path d="M12 0.2v0.6M12 3.2v0.6M10.2 2h0.6M13.2 2h0.6" />
      </g>
    );
  if (from === "review")
    return (
      <g aria-hidden="true" style={{ fill: color }}>
        <circle cx="12" cy="1" r="0.6" />
        <circle cx="11.1" cy="2.7" r="0.6" />
        <circle cx="12.9" cy="2.7" r="0.6" />
      </g>
    );
  return <path aria-hidden="true" d="M13.4 1.2H11l1-1M11 1.2l1 1" style={s} />;
}

/**
 * Elapsed ticks: one short radial tick per whole minute a thing has been working, around a circle of
 * radius `r` centred at (0, 0), clockwise from 12 o'clock, at most 12. A count of time spent, never
 * a fraction of a total.
 */
export function ElapsedTicks({ r, count, color, length = 2.6, strokeWidth = 1.1 }: { r: number; count: number; color: string; length?: number; strokeWidth?: number }) {
  const n = Math.max(0, Math.min(12, Math.floor(count)));
  const d = Array.from({ length: n }, (_, i) => {
    const a = (i / 12) * Math.PI * 2;
    const sx = Math.sin(a);
    const cy = -Math.cos(a);
    return `M${(sx * r).toFixed(2)} ${(cy * r).toFixed(2)}L${(sx * (r + length)).toFixed(2)} ${(cy * (r + length)).toFixed(2)}`;
  }).join("");
  return n > 0 ? <path aria-hidden="true" d={d} style={{ stroke: color, strokeWidth, strokeLinecap: "round" }} /> : null;
}

/** An artifact's mark only (without its card), in card coordinates. */
export function ArtifactMark({ kind, color = fc("ink") }: { kind: ArtifactKind; color?: string }) {
  return (
    <g aria-hidden="true" style={{ stroke: color, fill: "none", strokeWidth: 1, strokeLinecap: "round", strokeLinejoin: "round" }}>
      {artifactPaths[kind]}
    </g>
  );
}

/** Card outline 14 x 18 with a folded corner, in card coordinates. */
export const artifactCardPath = "M0 0H10L14 4V18H0Z";
export const artifactFoldPath = "M10 0V4H14";

/* Tool caps: the head of a tool-call tick, centred at (0, 0), about 5 units across. */
export function ToolCap({ family, color, filled = true }: { family: ToolFamily; color: string; filled?: boolean }) {
  const fill = filled ? color : "none";
  const common = { stroke: color, strokeWidth: 1.1, strokeLinejoin: "round" as const };
  switch (family) {
    case "read":
      return <circle aria-hidden="true" r="2.3" style={{ ...common, fill: "none" }} />;
    case "write":
      return <rect aria-hidden="true" x="-2.2" y="-2.2" width="4.4" height="4.4" style={{ ...common, fill }} />;
    case "run":
      return <path aria-hidden="true" d="M-2 -2.6L2.8 0L-2 2.6z" style={{ ...common, fill }} />;
    case "search":
      return <path aria-hidden="true" d="M0 -2.8L2.8 0L0 2.8L-2.8 0z" style={{ ...common, fill: "none" }} />;
    case "test":
      return <path aria-hidden="true" d="M-2.4 -0.2L-0.6 1.8L2.6 -2" style={{ ...common, fill: "none", strokeLinecap: "round" }} />;
    case "git":
      return (
        <g aria-hidden="true" style={{ ...common, fill: "none" }}>
          <circle r="1.7" />
          <path d="M0 -3.2v1.5M0 1.7v1.5" />
        </g>
      );
  }
}

/* Agent heads: tier as shape. Centred at (0, 0). */
export function AgentHead({ tier, fill, stroke, size = 1, strokeWidth = 1.4 }: { tier: ModelTier; fill: string; stroke: string; size?: number; strokeWidth?: number }) {
  const style = { fill, stroke, strokeWidth: strokeWidth / size, strokeLinejoin: "round" as const };
  return (
    <g aria-hidden="true" transform={size === 1 ? undefined : `scale(${size})`}>
      {tier === "fable" ? <path d="M0 -6.2L5 0L0 6.2L-5 0z" style={style} /> : null}
      {tier === "opus" ? <rect x="-4.3" y="-4.3" width="8.6" height="8.6" rx="0.8" style={style} /> : null}
      {tier === "sonnet" ? <circle r="4.6" style={style} /> : null}
      {tier === "haiku" ? <path d="M0 -5L4.6 3.4H-4.6z" style={style} /> : null}
    </g>
  );
}

/* Role emblems: a small mark drawn on the agent's floor disc (plan coordinates, about 6 across). */
export function RoleEmblem({ role, color }: { role: AgentRole; color: string }) {
  const s = { stroke: color, fill: "none", strokeWidth: 1, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (role) {
    case "builder":
      return <rect aria-hidden="true" x="-2.4" y="-2.4" width="4.8" height="4.8" style={{ ...s, fill: color }} />;
    case "verifier":
      return <path aria-hidden="true" d="M-3 0h6M0 -3v6" style={s} />;
    case "reviewer":
      return (
        <g aria-hidden="true" style={{ fill: color }}>
          <circle cx="0" cy="-2.2" r="1.1" />
          <circle cx="-2" cy="1.4" r="1.1" />
          <circle cx="2" cy="1.4" r="1.1" />
        </g>
      );
    case "contract-engineer":
      return <path aria-hidden="true" d="M-2.6 2.4V-2.6L2.6 2.4z" style={s} />;
    case "supervisor":
      return (
        <g aria-hidden="true" style={s}>
          <circle r="2.8" />
          <circle r="1.2" />
        </g>
      );
    case "scheduler":
      return (
        <g aria-hidden="true" style={s}>
          <circle r="2.8" />
          <path d="M0 0V-2M0 0L1.4 1" />
        </g>
      );
    // The belt's own workers (pass 3).
    case "clerk":
      return <path aria-hidden="true" d="M-2.2 -2.6h4.4v5.2h-4.4zM-1 -2.6v-0.6h2v0.6M-1.2 0h2.4" style={s} />;
    case "intent":
      return <path aria-hidden="true" d="M-0.4 0.4V-2.8A2.8 2.8 0 1 0 2.8 0.4z" style={{ ...s, fill: color }} />;
    case "audit":
      return <path aria-hidden="true" d="M-2.8 1.6a2.8 2.8 0 0 1 5.6 0M0 1.6l1.4-1.8" style={s} />;
    case "merge":
      return <path aria-hidden="true" d="M-2 -2.6v1c0 1.4 2 1.6 2 3v1.2M2 -2.6v1c0 1.4-2 1.6-2 3" style={s} />;
    case "cleanup":
      return <path aria-hidden="true" d="M-2.6 -2.4h5.2v1.6h-5.2zM-2.1 -0.8v3h4.2v-3" style={s} />;
    case "observe":
      return (
        <g aria-hidden="true" style={s}>
          <path d="M-3 0s1.2-2 3-2 3 2 3 2-1.2 2-3 2-3-2-3-2z" />
          <circle r="0.8" style={{ fill: color }} />
        </g>
      );
  }
}

/* State marks: shape carries the state, colour reinforces it. Centred at (0, 0), radius `r`. */
export function StateMark({ state, r = 6, progress, mark, surface = fc("plate-top") }: { state: FactoryState; r?: number; progress?: number; mark?: FactoryMarkShape; surface?: string }) {
  const look = factoryStates[state];
  const ink = fc(look.ink);
  const shape = mark ?? look.mark;
  const sw = Math.max(1.1, r * 0.22);
  switch (shape) {
    case "ring-working": {
      // A ring with four spokes: a wheel that is turning. Static; says "working", not how far.
      const a = r * 0.22;
      const b = r * 0.62;
      return (
        <g aria-hidden="true">
          <circle r={r - sw / 2} style={{ fill: surface, stroke: ink, strokeWidth: sw }} />
          <path d={`M0 ${-a}V${-b}M0 ${a}V${b}M${-a} 0H${-b}M${a} 0H${b}`} style={{ stroke: ink, strokeWidth: sw * 0.9, strokeLinecap: "round" }} />
        </g>
      );
    }
    case "ring-dashed":
      return <circle aria-hidden="true" r={r - sw / 2} style={{ fill: surface, stroke: ink, strokeWidth: sw, strokeDasharray: `${r * 0.42} ${r * 0.34}` }} />;
    case "ring-sector": {
      const p = Math.min(1, Math.max(0, progress ?? 0));
      const a = p * Math.PI * 2;
      const rr = r - sw * 1.4;
      const large = p > 0.5 ? 1 : 0;
      const sector =
        p >= 0.999
          ? <circle r={rr} style={{ fill: ink }} />
          : p > 0.001
            ? <path d={`M0 0V${-rr}A${rr} ${rr} 0 ${large} 1 ${Math.sin(a) * rr} ${-Math.cos(a) * rr}Z`} style={{ fill: ink }} />
            : null;
      return (
        <g aria-hidden="true">
          <circle r={r - sw / 2} style={{ fill: surface, stroke: ink, strokeWidth: sw }} />
          {sector}
        </g>
      );
    }
    case "disc-tick":
      return (
        <g aria-hidden="true">
          <circle r={r} style={{ fill: ink }} />
          <path d={`M${-r * 0.45} ${r * 0.02}L${-r * 0.12} ${r * 0.34}L${r * 0.46} ${-r * 0.3}`} style={{ fill: "none", stroke: surface, strokeWidth: sw, strokeLinecap: "round", strokeLinejoin: "round" }} />
        </g>
      );
    case "disc-cross":
      return (
        <g aria-hidden="true">
          <circle r={r} style={{ fill: ink }} />
          <path d={`M${-r * 0.36} ${-r * 0.36}L${r * 0.36} ${r * 0.36}M${r * 0.36} ${-r * 0.36}L${-r * 0.36} ${r * 0.36}`} style={{ stroke: surface, strokeWidth: sw, strokeLinecap: "round" }} />
        </g>
      );
    case "ring-hourglass":
      return (
        <g aria-hidden="true">
          <circle r={r - sw / 2} style={{ fill: surface, stroke: ink, strokeWidth: sw }} />
          <path d={`M${-r * 0.36} ${-r * 0.42}H${r * 0.36}L${-r * 0.36} ${r * 0.42}H${r * 0.36}Z`} style={{ fill: ink, stroke: ink, strokeWidth: sw * 0.5, strokeLinejoin: "round" }} />
        </g>
      );
    case "ring-dot":
      return (
        <g aria-hidden="true">
          <circle r={r - sw / 2} style={{ fill: surface, stroke: ink, strokeWidth: sw }} />
          <circle r={r * 0.38} style={{ fill: ink }} />
        </g>
      );
    case "octagon-bar": {
      const k = r * 0.414;
      return (
        <g aria-hidden="true">
          <path d={`M${-k} ${-r}H${k}L${r} ${-k}V${k}L${k} ${r}H${-k}L${-r} ${k}V${-k}Z`} style={{ fill: ink }} />
          <path d={`M${-r * 0.5} 0H${r * 0.5}`} style={{ stroke: surface, strokeWidth: sw * 1.1, strokeLinecap: "round" }} />
        </g>
      );
    }
    case "double-ring":
      return (
        <g aria-hidden="true">
          <circle r={r - sw * 0.4} style={{ fill: surface, stroke: ink, strokeWidth: sw * 0.8 }} />
          <circle r={r * 0.55} style={{ fill: ink }} />
        </g>
      );
  }
}

/** The ink and tint of a state, as CSS colours. */
export function stateInk(state: FactoryState): { ink: string; soft: string; color: FactoryColor } {
  const look = factoryStates[state];
  return { ink: fc(look.ink), soft: fc(look.soft), color: look.ink };
}
