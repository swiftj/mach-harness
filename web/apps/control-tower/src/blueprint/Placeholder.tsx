/**
 * The sheet before any wave has arrived (the first 30 s of the run): the belt drawn unbuilt, column
 * by column, so the first frame of a recording is a composed drawing waiting to be filled. Nothing
 * here is an event; it is the belt's plan, which every slice will pass (the grammar's `planned`).
 */
import { memo } from "react";
import { fc, RoutePath } from "@mach/ui";
import { FutureEnd, FutureMark } from "./CellFlow";
import { COLUMN_ORDER, type ColumnTemplate } from "./columns";
import type { FlowNode } from "./flow";
import { SHEET, type Layout } from "./layout";

export const PlaceholderBelt = memo(function PlaceholderBelt({ layout, template }: { layout: Layout; template: ColumnTemplate }) {
  const y = layout.waveY + SHEET.waveHeader;
  const row0 = 92;
  const h = 210;
  const ax = layout.ax;
  const cols = COLUMN_ORDER.filter((c) => template.x[c] !== undefined);
  const nodes: FlowNode[] = cols.map((col) => ({ key: `p:${col}`, kind: col === "end" ? "end" : col === "start" ? "start" : "future", col, row: 0, x: template.x[col] ?? 0, y: 0, round: 1, r: col === "end" ? 11 : col === "start" ? 9 : col === "review" ? 12 : 15 }));
  const x = SHEET.left;
  return (
    <g aria-hidden="true" transform={`translate(0 ${y})`}>
      <rect x={x} y={0} width={layout.width - SHEET.left * 2} height={h} style={{ fill: fc("floor"), opacity: 0.3 }} />
      <line x1={x + 12} y1={0} x2={layout.width - SHEET.left} y2={0} style={{ stroke: fc("plate-edge"), strokeWidth: 1 }} />
      <line x1={ax - 14} y1={0} x2={ax - 14} y2={h} style={{ stroke: fc("plate-edge"), strokeWidth: 0.6 }} />
      <g className="bp-fine">
        <text x={x + 20} y={34} style={{ fill: "var(--mach-ink)", fontFamily: "var(--mach-font-sans)", fontSize: 21, fontWeight: 650 }}>
          Awaiting an approved wave
        </text>
        <text x={x + 20} y={54} style={{ fill: "var(--mach-ink-muted)", fontSize: 10.5 }}>
          The belt, unbuilt: every station and gate a slice will pass.
        </text>
        <text x={x + 20} y={70} style={{ fill: "var(--mach-ink-muted)", fontSize: 10.5 }}>
          Each slice of the wave gets a section; it fills in as the run proceeds.
        </text>
      </g>
      <g className="bp-over">
        <text x={x + 20} y={52} style={{ fill: "var(--mach-ink)", fontFamily: "var(--mach-font-sans)", fontSize: 40, fontWeight: 650 }}>
          Awaiting a wave
        </text>
        <text x={x + 20} y={96} style={{ fill: "var(--mach-ink-muted)", fontSize: 30, fontWeight: 600 }}>
          The belt, not yet built
        </text>
      </g>
      {/* Where the sections will stand: a quiet note in the empty part of the sheet. */}
      <text x={layout.width / 2} y={h + (layout.height - y - h - 170) / 2} textAnchor="middle" style={{ fill: "var(--mach-ink-subtle)", fontFamily: "var(--mach-font-sans)", fontSize: 34, fontWeight: 650 }}>
        One section per slice, drawn as the wave is dispatched
      </text>
      <g className="bp-flow" transform={`translate(${ax} ${row0})`}>
        {nodes.slice(1).map((n, i) => {
          const a = nodes[i] as FlowNode;
          return <RoutePath key={n.key} variant="blueprint" planned points={[{ x: a.x + a.r + 3, y: 0 }, { x: n.x - n.r - 4, y: 0 }]} />;
        })}
        {nodes.map((n) =>
          n.kind === "start" ? (
            <circle key={n.key} cx={n.x} cy={0} r={7.5} style={{ fill: fc("ground"), stroke: fc("ink-soft"), strokeWidth: 1, strokeDasharray: "3 2.5" }} />
          ) : n.kind === "end" ? (
            <FutureEnd key={n.key} node={n} />
          ) : (
            <FutureMark key={n.key} node={n} seats={template.seats} />
          ),
        )}
      </g>
    </g>
  );
});
