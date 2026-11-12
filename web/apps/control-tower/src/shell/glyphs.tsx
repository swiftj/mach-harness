/**
 * Small upright glyphs for the chrome (inspector headers, links, the help sheet), drawn with the
 * factory alphabet from @mach/ui so the panels speak the same visual language as the views.
 * Every glyph is decorative (aria-hidden); the text beside it carries the meaning.
 */
import type { ReactNode } from "react";
import {
  AgentHead,
  ArtifactMark,
  artifactCardPath,
  artifactFoldPath,
  cn,
  fc,
  gates,
  RoleEmblem,
  StateMark,
  StationSymbol,
  stateInk,
  ToolCap,
  type AgentRole,
  type ArtifactKind,
  type FactoryMarkShape,
  type FactoryState,
  type GateKind,
  type ModelTier,
  type StationKind,
  type ToolFamily,
} from "@mach/ui";

export function Glyph({ size = 24, children, className }: { size?: number; children: ReactNode; className?: string }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="-12 -12 24 24" className={cn("shrink-0 overflow-visible", className)}>
      {children}
    </svg>
  );
}

export function StateGlyph({ state, mark, size = 14 }: { state: FactoryState; mark?: FactoryMarkShape; size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="-7 -7 14 14" className="shrink-0 overflow-visible">
      <StateMark state={state} r={6} mark={mark} surface="var(--mach-surface)" />
    </svg>
  );
}

/** The state mark and its word: shape first, colour second, never colour alone. */
export function StateWord({ state, mark, label, className }: { state: FactoryState; mark?: FactoryMarkShape; label: string; className?: string }) {
  const { ink } = stateInk(state);
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-caption font-semibold", className)} style={{ color: state === "idle" ? "var(--mach-ink-muted)" : ink }}>
      <StateGlyph state={state} mark={mark} size={12} />
      <span>{label}</span>
    </span>
  );
}

export function StationGlyph({ kind, size, state = "idle" }: { kind: StationKind | "red-green"; size?: number; state?: FactoryState }) {
  const { ink, soft } = stateInk(state);
  return (
    <Glyph size={size}>
      <circle r={11} style={{ fill: soft, stroke: state === "idle" ? fc("plate-edge") : ink, strokeWidth: 1.1 }} />
      <StationSymbol kind={kind} size={14} color={fc("ink")} strokeWidth={1.3} />
    </Glyph>
  );
}

export function GateGlyphSmall({ kind, size, state = "idle" }: { kind: GateKind; size?: number; state?: FactoryState }) {
  const { ink, soft } = stateInk(state);
  return (
    <Glyph size={size}>
      <path d="M0 -11.5L11.5 0L0 11.5L-11.5 0Z" style={{ fill: soft, stroke: state === "idle" ? fc("ink-soft") : ink, strokeWidth: 1.2, strokeLinejoin: "round" }} />
      <StationSymbol kind={gates[kind].symbol} size={11} color={fc("ink")} strokeWidth={1.3} />
    </Glyph>
  );
}

export function AgentGlyph({ tier, agentRole, size, state = "idle" }: { tier: ModelTier; agentRole: AgentRole; size?: number; state?: FactoryState }) {
  const { ink, soft } = stateInk(state);
  return (
    <Glyph size={size}>
      <ellipse cx={0} cy={8} rx={9} ry={3.4} style={{ fill: fc("floor"), stroke: fc("plate-edge"), strokeWidth: 0.8 }} />
      <g transform="translate(0 8) scale(1 0.5)">
        <RoleEmblem role={agentRole} color={fc("ink-soft")} />
      </g>
      <path d="M0 8V-1" style={{ stroke: fc("ink"), strokeWidth: 1.4 }} />
      <g transform="translate(0 -4)">
        <AgentHead tier={tier} fill={state === "active" ? fc("live") : soft} stroke={state === "idle" ? fc("ink") : ink} size={1.05} />
      </g>
    </Glyph>
  );
}

export function ArtifactGlyph({ kind, size, failed }: { kind: ArtifactKind; size?: number; failed?: boolean }) {
  const ink = failed ? fc("fail") : fc("ink");
  return (
    <Glyph size={size}>
      <g transform="translate(-7.7 -9.9) scale(1.1)">
        <path d={artifactCardPath} style={{ fill: failed ? fc("fail-soft") : fc("plate-top"), stroke: ink, strokeWidth: 0.9, strokeLinejoin: "round" }} />
        <path d={artifactFoldPath} style={{ fill: "none", stroke: ink, strokeWidth: 0.9, strokeLinejoin: "round" }} />
        <ArtifactMark kind={kind} color={ink} />
      </g>
    </Glyph>
  );
}

export function ToolGlyph({ family, size, state = "succeeded" }: { family: ToolFamily; size?: number; state?: FactoryState }) {
  const color = state === "active" ? fc("live") : state === "failed" ? fc("fail") : fc("ink");
  return (
    <Glyph size={size}>
      <path d="M0 10V-2" style={{ stroke: color, strokeWidth: 1.4, strokeLinecap: "round" }} />
      <path d="M-8 10H8" style={{ stroke: fc("plate-edge"), strokeWidth: 1 }} />
      <g transform="translate(0 -5) scale(1.7)">
        <ToolCap family={family} color={color} />
      </g>
    </Glyph>
  );
}

export function CellGlyph({ size, state = "idle" }: { size?: number; state?: FactoryState }) {
  const { ink } = stateInk(state);
  return (
    <Glyph size={size}>
      <path d="M-10 -4L0 -9L10 -4L0 1Z" style={{ fill: fc("floor"), stroke: fc("ink-soft"), strokeWidth: 1 }} />
      <path d="M-10 -4V3L0 8L10 3V-4" style={{ fill: "none", stroke: fc("ink-soft"), strokeWidth: 1 }} />
      <path d="M0 1V8" style={{ stroke: fc("plate-edge"), strokeWidth: 0.8 }} />
      <path d="M-6 -3.2V-10" style={{ stroke: fc("ink"), strokeWidth: 1.2 }} />
      <g transform="translate(-6 -10.5)">
        <StateMark state={state} r={2.8} surface="var(--mach-surface)" />
      </g>
      <path d="M-5 -2.5L5 -5.5" style={{ stroke: state === "active" ? ink : fc("route"), strokeWidth: 1.1 }} />
    </Glyph>
  );
}

export function WaveGlyph({ size }: { size?: number }) {
  return (
    <Glyph size={size}>
      {[4, 0, -4].map((d) => (
        <g key={d} transform={`translate(${-8 + d / 2} ${-8 + d})`}>
          <path d="M0 0H10L14 4V14H0Z" style={{ fill: fc("plate-top"), stroke: fc("ink"), strokeWidth: 0.9, strokeLinejoin: "round" }} />
        </g>
      ))}
      <path d="M-9.5 -1.5h8M-9.5 1.5h8" style={{ stroke: fc("ink-soft"), strokeWidth: 0.9 }} />
    </Glyph>
  );
}

export function SliceGlyph({ size, state = "idle", mark }: { size?: number; state?: FactoryState; mark?: FactoryMarkShape }) {
  const { soft } = stateInk(state);
  return (
    <Glyph size={size}>
      <path d="M-11 0L0 -6L11 0L0 6Z" style={{ fill: state === "idle" ? fc("plate-top") : soft, stroke: fc("ink-soft"), strokeWidth: 1 }} />
      <g transform="translate(0 -1)">
        <StateMark state={state} r={3.6} mark={mark} surface="var(--mach-surface)" />
      </g>
    </Glyph>
  );
}

export function DependencyGlyph({ size, satisfied }: { size?: number; satisfied: boolean }) {
  const ink = satisfied ? fc("pass") : fc("wait");
  return (
    <Glyph size={size}>
      <path d="M-11 8C-4 8 -4 -8 3 -8" style={{ fill: "none", stroke: ink, strokeWidth: 1.4, strokeDasharray: satisfied ? undefined : "3 2.4" }} />
      <rect x={1} y={-1} width={9} height={7.5} rx={1.2} style={{ fill: satisfied ? fc("pass-soft") : fc("wait-soft"), stroke: ink, strokeWidth: 1.2 }} />
      <path d={satisfied ? "M3.2 -1V-4a2.6 2.6 0 0 1 5.2 0" : "M3.2 -1V-3.6a2.3 2.3 0 0 1 4.6 0V-1"} style={{ fill: "none", stroke: ink, strokeWidth: 1.2 }} transform={satisfied ? "translate(-3 0)" : undefined} />
    </Glyph>
  );
}

export function ExecutionGlyph({ size, state = "idle" }: { size?: number; state?: FactoryState }) {
  const { ink } = stateInk(state);
  return (
    <Glyph size={size}>
      <path d="M-10 6H10" style={{ stroke: fc("route"), strokeWidth: 1.2 }} />
      <path d="M-6 6V-6M0 6V-2M6 6V-8" style={{ stroke: state === "idle" ? fc("ink") : ink, strokeWidth: 1.6, strokeLinecap: "round" }} />
    </Glyph>
  );
}

/** An actor (the line supervisor, the scheduler): not an agent, so no head; its emblem on a desk. */
export function ActorGlyph({ actor, size, acting }: { actor: "supervisor" | "scheduler"; size?: number; acting?: boolean }) {
  return (
    <Glyph size={size}>
      <rect x={-10} y={2} width={20} height={6} rx={1} style={{ fill: fc("plate-top"), stroke: fc("ink-soft"), strokeWidth: 1 }} />
      <circle r={7.5} cy={-4} style={{ fill: acting ? fc("live-soft") : fc("floor"), stroke: acting ? fc("live") : fc("ink"), strokeWidth: 1.2 }} />
      <g transform="translate(0 -4) scale(1.7)">
        <RoleEmblem role={actor} color={fc("ink")} />
      </g>
    </Glyph>
  );
}
