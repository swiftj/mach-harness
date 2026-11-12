import type { ReactNode } from "react";
import { dimmedOpacity, factoryStates, fc, type FactoryState } from "./grammar";
import { round } from "./projection";
import { useFactoryIds } from "./scene";
import { StateMark } from "./symbols";

/**
 * The Execution Blueprint's drafting language: a drawing sheet with a border, zone references and a
 * title block; lanes that nest (wave, cell, station, agent); dimension lines for durations; and
 * callouts with leaders. All in screen coordinates.
 */

export interface BlueprintSheetProps {
  width: number;
  height: number;
  title: string;
  /** Line under the title: the run, the wave. */
  subtitle?: string;
  /** Always shown in the title block. The prototype passes its simulation label. */
  simulationLabel: string;
  /** Zone columns (letters) and rows (numbers) along the border, for precise reference ("zone C4"). */
  zonesX?: number;
  zonesY?: number;
  /** Extra title-block rows, label then value. */
  facts?: ReadonlyArray<readonly [string, string]>;
  children?: ReactNode;
}

const MARGIN = 18;

/**
 * The sheet: a double border (outer hairline, inner 1.25), zone letters across the top and numbers
 * down the side, and a title block in the lower right carrying the title (serif), the facts and the
 * simulation label, which is never hidden.
 */
export function BlueprintSheet({ width, height, title, subtitle, simulationLabel, zonesX = 8, zonesY = 4, facts = [], children }: BlueprintSheetProps) {
  const inner = { x: MARGIN, y: MARGIN, w: width - MARGIN * 2, h: height - MARGIN * 2 };
  const zw = inner.w / zonesX;
  const zh = inner.h / zonesY;
  const tbW = 260;
  const tbH = 54 + facts.length * 16;
  const tbX = inner.x + inner.w - tbW;
  const tbY = inner.y + inner.h - tbH;
  return (
    <g>
      <rect x={6} y={6} width={width - 12} height={height - 12} aria-hidden="true" style={{ fill: "none", stroke: fc("plate-edge"), strokeWidth: 0.75 }} />
      <rect x={inner.x} y={inner.y} width={inner.w} height={inner.h} aria-hidden="true" style={{ fill: fc("ground"), stroke: fc("ink-soft"), strokeWidth: 1.25 }} />
      <g aria-hidden="true" style={{ fill: "var(--mach-ink-subtle)", fontSize: 9, fontWeight: 600 }}>
        {Array.from({ length: zonesX }, (_, i) => (
          <g key={`zx${i}`}>
            {i > 0 ? <line x1={inner.x + i * zw} y1={6} x2={inner.x + i * zw} y2={inner.y} style={{ stroke: fc("plate-edge"), strokeWidth: 0.75 }} /> : null}
            {i > 0 ? <line x1={inner.x + i * zw} y1={inner.y + inner.h} x2={inner.x + i * zw} y2={height - 6} style={{ stroke: fc("plate-edge"), strokeWidth: 0.75 }} /> : null}
            <text x={inner.x + (i + 0.5) * zw} y={15} textAnchor="middle">
              {String.fromCharCode(65 + i)}
            </text>
          </g>
        ))}
        {Array.from({ length: zonesY }, (_, i) => (
          <g key={`zy${i}`}>
            {i > 0 ? <line x1={6} y1={inner.y + i * zh} x2={inner.x} y2={inner.y + i * zh} style={{ stroke: fc("plate-edge"), strokeWidth: 0.75 }} /> : null}
            {i > 0 ? <line x1={inner.x + inner.w} y1={inner.y + i * zh} x2={width - 6} y2={inner.y + i * zh} style={{ stroke: fc("plate-edge"), strokeWidth: 0.75 }} /> : null}
            <text x={12} y={inner.y + (i + 0.5) * zh + 3} textAnchor="middle">
              {i + 1}
            </text>
          </g>
        ))}
      </g>
      {children}
      {/* Title block. */}
      <g>
        <rect x={tbX} y={tbY} width={tbW} height={tbH} aria-hidden="true" style={{ fill: fc("plate-top"), stroke: fc("ink-soft"), strokeWidth: 1.25 }} />
        <line x1={tbX} y1={tbY + 38} x2={tbX + tbW} y2={tbY + 38} aria-hidden="true" style={{ stroke: fc("plate-edge"), strokeWidth: 0.75 }} />
        <text x={tbX + 10} y={tbY + 19} style={{ fill: "var(--mach-ink)", fontFamily: "var(--mach-font-serif)", fontSize: 15, fontWeight: 450 }}>
          {title}
        </text>
        {subtitle ? (
          <text x={tbX + 10} y={tbY + 32} style={{ fill: "var(--mach-ink-muted)", fontSize: 10 }}>
            {subtitle}
          </text>
        ) : null}
        {facts.map(([k, v], i) => (
          <g key={k}>
            <text x={tbX + 10} y={tbY + 52 + i * 16} style={{ fill: "var(--mach-ink-muted)", fontSize: 10 }}>
              {k}
            </text>
            <text x={tbX + 96} y={tbY + 52 + i * 16} style={{ fill: "var(--mach-ink)", fontFamily: "var(--mach-font-mono)", fontSize: 10 }} className="tabular">
              {v}
            </text>
          </g>
        ))}
        {/* The simulation label: a stamped box, never hidden. */}
        <g transform={`translate(${tbX + tbW - 10} ${tbY + 9})`}>
          <rect x={-74} y={0} width={74} height={18} rx={2} style={{ fill: fc("wait-soft"), stroke: fc("wait"), strokeWidth: 1 }} />
          <text x={-37} y={12.5} textAnchor="middle" style={{ fill: "var(--mach-warning-ink)", fontSize: 10, fontWeight: 700 }}>
            {simulationLabel}
          </text>
        </g>
      </g>
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ */

export type LaneDepth = 0 | 1 | 2 | 3;

export interface BlueprintLaneProps {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 0 wave, 1 slice/cell, 2 station, 3 agent. Deeper lanes indent and use lighter rules. */
  depth: LaneDepth;
  title: string;
  /** Engine ID (mono). */
  id?: string;
  state?: FactoryState;
  /** Collapsed lanes draw as a single rule with their title and a count of what is inside. */
  collapsed?: boolean;
  /** "3 stations, 7 agents" when collapsed. */
  summary?: string;
  dimmed?: boolean;
  selected?: boolean;
  children?: ReactNode;
}

const laneIndent = 14;

/**
 * A lane: a band with a gutter on the left holding the lane's title, ID and state mark, and a
 * hierarchy brace whose indent is its depth. Wave lanes have a heavy top rule and a serif title; cell
 * lanes a regular rule; station and agent lanes fine rules. A collapsed lane shows a disclosure
 * chevron, its summary and nothing else.
 */
export function BlueprintLane({ x, y, width, height, depth, title, id, state, collapsed, summary, dimmed, selected, children }: BlueprintLaneProps) {
  const gutter = 168;
  const indent = depth * laneIndent;
  const rule = depth === 0 ? 1.75 : depth === 1 ? 1 : 0.6;
  const st = state ? factoryStates[state] : null;
  return (
    <g role="group" aria-label={`${title}${id ? ` ${id}` : ""}${st ? `: ${st.label}` : ""}${collapsed ? ", collapsed" : ""}`} style={{ opacity: dimmed ? dimmedOpacity : 1 }}>
      {depth <= 1 ? <rect x={x} y={y} width={width} height={height} aria-hidden="true" style={{ fill: depth === 0 ? "transparent" : fc("floor"), opacity: depth === 1 ? 0.6 : 1 }} /> : null}
      <line x1={x + indent} y1={y} x2={x + width} y2={y} aria-hidden="true" style={{ stroke: depth === 0 ? fc("ink-soft") : fc("plate-edge"), strokeWidth: rule }} />
      {/* Hierarchy brace. */}
      {depth > 0 && !collapsed ? (
        <path d={`M${x + indent - 6} ${y + 6}h-3v${height - 12}h3`} aria-hidden="true" style={{ fill: "none", stroke: fc("plate-edge"), strokeWidth: 1 }} />
      ) : null}
      {selected ? <rect x={x + indent - 2} y={y + 1} width={3} height={height - 2} aria-hidden="true" style={{ fill: fc("select") }} /> : null}
      <g transform={`translate(${x + indent + 8} ${y + (collapsed ? height / 2 + 4 : 20)})`}>
        {collapsed ? <path d="M-2 -7l4 3.5l-4 3.5" aria-hidden="true" style={{ fill: "none", stroke: "var(--mach-ink-muted)", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round" }} /> : null}
        {st ? (
          <g transform={`translate(${collapsed ? 12 : 4} -4)`}>
            <StateMark state={state!} r={5} />
          </g>
        ) : null}
        <text
          x={st ? (collapsed ? 22 : 14) : collapsed ? 10 : 0}
          y={0}
          style={{
            fill: "var(--mach-ink)",
            fontFamily: depth === 0 ? "var(--mach-font-serif)" : "var(--mach-font-sans)",
            fontSize: depth === 0 ? 16 : depth === 1 ? 12.5 : 11,
            fontWeight: depth === 0 ? 450 : 600,
          }}
        >
          {title}
        </text>
        {id ? (
          <text x={st ? 14 : 0} y={14} style={{ fill: "var(--mach-ink-muted)", fontFamily: "var(--mach-font-mono)", fontSize: 9.5 }} className="notranslate">
            {id}
          </text>
        ) : null}
        {collapsed && summary ? (
          <text x={gutter - indent - 8} y={0} style={{ fill: "var(--mach-ink-muted)", fontSize: 10.5 }}>
            {summary}
          </text>
        ) : null}
      </g>
      {!collapsed ? children : null}
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ */

/**
 * A dimension line for a duration: extension lines, architectural slash ticks at both ends, and the
 * value set above the line in tabular figures ("4m 12s"). Precise, and quiet.
 */
export function DimensionLine({ x1, x2, y, label, extend = 8 }: { x1: number; x2: number; y: number; label: string; extend?: number }) {
  const ids = useFactoryIds();
  return (
    <g aria-label={`Duration ${label}`} role="img">
      <path d={`M${x1} ${y - extend}V${y + 3}M${x2} ${y - extend}V${y + 3}`} aria-hidden="true" style={{ stroke: fc("plate-edge"), strokeWidth: 0.75 }} />
      <line x1={x1} y1={y} x2={x2} y2={y} markerStart={`url(#${ids.tick})`} markerEnd={`url(#${ids.tick})`} aria-hidden="true" style={{ stroke: "var(--mach-ink-muted)", strokeWidth: 0.75 }} />
      <text x={round((x1 + x2) / 2)} y={y - 4} textAnchor="middle" style={{ fill: "var(--mach-ink-muted)", fontFamily: "var(--mach-font-mono)", fontSize: 9.5 }} className="tabular">
        {label}
      </text>
    </g>
  );
}

/**
 * A callout: a dot on the thing, a leader at 45 degrees, a horizontal shoulder and the note. Used for
 * the selected thing, for events under the playhead and in the composition studies.
 */
export function Callout({ x, y, dx = 28, dy = -28, text, detail, tone = "ink" }: { x: number; y: number; dx?: number; dy?: number; text: string; detail?: string; tone?: "ink" | "select" | "fail" | "human" }) {
  const color = tone === "ink" ? "var(--mach-ink-muted)" : fc(tone);
  const ex = x + dx;
  const ey = y + dy;
  const dir = dx >= 0 ? 1 : -1;
  const shoulder = 14 * dir;
  return (
    <g>
      <circle cx={x} cy={y} r={2} aria-hidden="true" style={{ fill: color }} />
      <path d={`M${x} ${y}L${ex} ${ey}h${shoulder}`} aria-hidden="true" style={{ fill: "none", stroke: color, strokeWidth: 0.9 }} />
      <text x={ex + shoulder + 4 * dir} y={ey + 3.5} textAnchor={dir > 0 ? "start" : "end"} style={{ fill: tone === "ink" ? "var(--mach-ink)" : color, fontSize: 10.5, fontWeight: 600 }}>
        {text}
      </text>
      {detail ? (
        <text x={ex + shoulder + 4 * dir} y={ey + 16} textAnchor={dir > 0 ? "start" : "end"} style={{ fill: "var(--mach-ink-muted)", fontSize: 9.5 }}>
          {detail}
        </text>
      ) : null}
    </g>
  );
}
