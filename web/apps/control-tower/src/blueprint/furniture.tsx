/**
 * The sheet's furniture, drawn on the sheet: the column head (pinned to the top of the stage while
 * the camera scrolls down, by `--bp-hy`), the legend of marks, and the revision table of rounds and
 * decisions, which fills in as the run proceeds (every row is an event the playhead has passed).
 */
import { memo, type ReactNode } from "react";
import { AgentHead, ArtifactCard, blueprintSheetLayout, fc, StateMark, StationSymbol, ToolCap, type FactoryState } from "@mach/ui";
import type { Scene } from "../sim";
import { useScene } from "../scene";
import type { ColumnKey, ColumnTemplate } from "./columns";
import { SHEET, type Layout } from "./layout";
import { clock } from "./time";

const HEADS: Array<[ColumnKey, string, boolean]> = [
  ["start", "Open", false],
  ["plan", "Plan", true],
  ["plan-check", "Check", false],
  ["audit", "Audit", false],
  ["build", "Build", true],
  ["red-before-green", "Red/green", false],
  ["verify", "Verify", true],
  ["verification", "Verdict", false],
  ["review", "Review", true],
  ["consensus", "Consensus", false],
  ["human-approval", "Person", true],
  ["merge-revalidation", "Revalidate", false],
  ["merge", "Merge", true],
  ["cleanup", "Clean", false],
  ["end", "Main", true],
];

export const HEAD_H = 22;

/** The column head: the belt's stations above their columns, as on a process sheet. Pinned at the top. */
export const ColumnHead = memo(function ColumnHead({ layout, template, y }: { layout: Layout; template: ColumnTemplate; y: number }) {
  const x0 = SHEET.left;
  const x1 = layout.width - SHEET.left;
  const channel = layout.ax + layout.aw + 26;
  return (
    <g aria-hidden="true" style={{ transform: "translateY(var(--bp-hy, 0px))" }}>
      <rect x={x0 - 4} y={y} width={x1 - x0 + 8} height={HEAD_H} style={{ fill: fc("ground") }} />
      <line x1={x0} y1={y + HEAD_H} x2={x1} y2={y + HEAD_H} style={{ stroke: fc("ink-soft"), strokeWidth: 0.75 }} />
      <line x1={x0} y1={y} x2={x1} y2={y} style={{ stroke: fc("plate-edge"), strokeWidth: 0.6 }} />
      <text x={x0 + 8} y={y + 15} className="bp-fine" style={{ fill: "var(--mach-ink-subtle)", fontSize: 9, fontWeight: 600, letterSpacing: "0.08em" }}>
        SECTION · SLICE · CELL
      </text>
      {HEADS.map(([k, word, major]) =>
        template.x[k] !== undefined ? (
          <g key={k}>
            <text x={layout.ax + (template.x[k] ?? 0)} y={y + 15} textAnchor="middle" className="bp-fine" style={{ fill: major ? "var(--mach-ink-muted)" : "var(--mach-ink-subtle)", fontSize: 9, fontWeight: 600, letterSpacing: "0.08em" }}>
              {word.toUpperCase()}
            </text>
            {major ? (
              <text x={layout.ax + (template.x[k] ?? 0)} y={y + 27} textAnchor="middle" className="bp-over" style={{ fill: "var(--mach-ink-muted)", fontSize: 30, fontWeight: 600, letterSpacing: "0.06em" }}>
                {word.toUpperCase()}
              </text>
            ) : null}
          </g>
        ) : null,
      )}
      <text x={channel - 6} y={y + 15} className="bp-fine" style={{ fill: "var(--mach-ink-subtle)", fontSize: 9, fontWeight: 600, letterSpacing: "0.08em" }}>
        DEPENDENCIES
      </text>
      <text x={channel - 6} y={y + 27} className="bp-over" style={{ fill: "var(--mach-ink-muted)", fontSize: 30, fontWeight: 600, letterSpacing: "0.04em" }}>
        DEPENDS
      </text>
    </g>
  );
});

/* ------------------------------------------------------------------------------------------------ */

function Swatch({ state, x, y, word, mark }: { state: FactoryState; x: number; y: number; word: string; mark?: "double-ring" }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <StateMark state={state} r={5} mark={mark} />
      <text x={9} y={3.5} className="bp-fine" style={{ fill: "var(--mach-ink-muted)", fontSize: 9 }}>
        {word}
      </text>
    </g>
  );
}

/** The legend: every mark the sheet uses, with its word, in the lower left corner. */
export const Legend = memo(function Legend({ x, y }: { x: number; y: number }) {
  const w = 600;
  const h = 112;
  const row = (i: number): number => y + 30 + i * 26;
  return (
    <g aria-hidden="true">
      <rect x={x} y={y} width={w} height={h} style={{ fill: fc("plate-top"), stroke: fc("ink-soft"), strokeWidth: 1 }} />
      <line x1={x} y1={y + 16} x2={x + w} y2={y + 16} style={{ stroke: fc("plate-edge"), strokeWidth: 0.75 }} />
      <text x={x + 8} y={y + 11.5} className="bp-fine" style={{ fill: "var(--mach-ink)", fontSize: 9, fontWeight: 700, letterSpacing: "0.08em" }}>
        LEGEND
      </text>
      <LegendOverview x={x} y={y} />
      <g className="bp-fine">
      {/* Row 1: states (shape first, colour second), unbuilt. */}
      <Swatch state="active" x={x + 16} y={row(0)} word="Working" />
      <Swatch state="succeeded" x={x + 86} y={row(0)} word="Passed" />
      <Swatch state="failed" x={x + 150} y={row(0)} word="Failed" />
      <Swatch state="waiting" x={x + 210} y={row(0)} word="Waiting" />
      <Swatch state="human" x={x + 278} y={row(0)} word="A person" />
      <Swatch state="idle" x={x + 352} y={row(0)} word="Idle" />
      <Swatch state="succeeded" mark="double-ring" x={x + 404} y={row(0)} word="Integrated" />
      <g transform={`translate(${x + 490} ${row(0)})`}>
        <circle r={6} style={{ fill: "none", stroke: fc("ink-soft"), strokeWidth: 1, strokeDasharray: "3 2.5", opacity: 0.6 }} />
        <text x={10} y={3.5} className="bp-fine" style={{ fill: "var(--mach-ink-muted)", fontSize: 9 }}>
          Not reached yet
        </text>
      </g>
      {/* Row 2: station, gate, the four model tiers, an artifact. */}
      <g transform={`translate(${x + 16} ${row(1)})`}>
        <circle r={7} style={{ fill: fc("plate-top"), stroke: fc("ink"), strokeWidth: 1 }} />
        <StationSymbol kind="build" size={9} color={fc("ink")} strokeWidth={1.1} />
        <text x={11} y={3.5} className="bp-fine" style={{ fill: "var(--mach-ink-muted)", fontSize: 9 }}>
          Station
        </text>
      </g>
      <g transform={`translate(${x + 82} ${row(1)})`}>
        <path d="M0 -7L7 0L0 7L-7 0Z" style={{ fill: fc("plate-top"), stroke: fc("ink"), strokeWidth: 1 }} />
        <text x={11} y={3.5} className="bp-fine" style={{ fill: "var(--mach-ink-muted)", fontSize: 9 }}>
          Gate
        </text>
      </g>
      {(["fable", "opus", "sonnet", "haiku"] as const).map((t, i) => (
        <g key={t} transform={`translate(${x + 140 + i * 56} ${row(1)})`}>
          <AgentHead tier={t} fill={fc("plate-top")} stroke={fc("ink")} />
          <text x={10} y={3.5} className="bp-fine" style={{ fill: "var(--mach-ink-muted)", fontSize: 9 }}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </text>
        </g>
      ))}
      <g>
        <ArtifactCard variant="blueprint" kind="plan" at={{ x: x + 372, y: row(1) }} showLabel={false} />
        <text x={x + 384} y={row(1) + 3.5} className="bp-fine" style={{ fill: "var(--mach-ink-muted)", fontSize: 9 }}>
          Artifact (count beside)
        </text>
      </g>
      {/* Row 3: tool calls by family, the return loop, a dependency, a dimension. */}
      {(["read", "write", "run", "search", "test", "git"] as const).map((f, i) => (
        <g key={f} transform={`translate(${x + 16 + i * 40} ${row(2)})`}>
          <line x1={0} y1={6} x2={0} y2={-2} style={{ stroke: fc("ink"), strokeWidth: 1 }} />
          <g transform="translate(0 -5)">
            <ToolCap family={f} color={fc("ink")} />
          </g>
          <text x={6} y={4} className="bp-fine" style={{ fill: "var(--mach-ink-muted)", fontSize: 8.5 }}>
            {f}
          </text>
        </g>
      ))}
      <path d={`M${x + 268} ${row(2) - 4}v6h36v-6`} style={{ fill: "none", stroke: fc("fail"), strokeWidth: 1.4, strokeDasharray: "4 2.5" }} />
      <text x={x + 310} y={row(2) + 3.5} className="bp-fine" style={{ fill: "var(--mach-ink-muted)", fontSize: 9 }}>
        Return to build
      </text>
      <path d={`M${x + 392} ${row(2)}h24`} style={{ stroke: fc("wait"), strokeWidth: 1.3, strokeDasharray: "4 3" }} />
      <text x={x + 422} y={row(2) + 3.5} className="bp-fine" style={{ fill: "var(--mach-ink-muted)", fontSize: 9 }}>
        Dependency
      </text>
      <path d={`M${x + 494} ${row(2) - 4}v6M${x + 530} ${row(2) - 4}v6M${x + 494} ${row(2)}H${x + 530}M${x + 491} ${row(2) + 3}l6 -6M${x + 527} ${row(2) + 3}l6 -6`} style={{ fill: "none", stroke: "var(--mach-ink-muted)", strokeWidth: 0.75 }} />
      <text x={x + 538} y={row(2) + 3.5} className="bp-fine" style={{ fill: "var(--mach-ink-muted)", fontSize: 9 }}>
        Duration
      </text>
      </g>
    </g>
  );
});

/** The legend at overview: the eight marks that matter at a glance, large enough to read at fit. */
function LegendOverview({ x, y }: { x: number; y: number }) {
  const entries: Array<{ word: string; mark: ReactNode }> = [
    { word: "Working", mark: <StateMark state="active" r={11} progress={0} /> },
    { word: "Passed", mark: <StateMark state="succeeded" r={10} /> },
    { word: "Failed", mark: <StateMark state="failed" r={10} /> },
    { word: "Person", mark: <StateMark state="human" r={10} /> },
    { word: "Waiting", mark: <StateMark state="waiting" r={10} /> },
    { word: "Not yet", mark: <circle r={10} style={{ fill: fc("ground"), stroke: fc("ink-soft"), strokeWidth: 1.6, strokeDasharray: "4 3" }} /> },
    { word: "Retry", mark: <path d="M-12 -4v8h24v-8" style={{ fill: "none", stroke: fc("fail"), strokeWidth: 2, strokeDasharray: "5 3" }} /> },
    { word: "Depends", mark: <path d="M-12 0h24" style={{ stroke: fc("wait"), strokeWidth: 2, strokeDasharray: "5 3" }} /> },
  ];
  return (
    <g className="bp-over">
      {entries.map((e, i) => (
        <g key={e.word} transform={`translate(${x + 24 + (i % 4) * 148} ${y + 36 + Math.floor(i / 4) * 48})`}>
          {e.mark}
          <text x={17} y={10} style={{ fill: "var(--mach-ink)", fontSize: 29, fontWeight: 600 }}>
            {e.word}
          </text>
        </g>
      ))}
    </g>
  );
}

/* ------------------------------------------------------------------------------------------------ */

interface Revision {
  readonly at: number;
  readonly ticket: string;
  readonly text: string;
  /** A few words for the overview. */
  readonly short: string;
  readonly tone: "fail" | "human" | "pass" | "wait";
}

function revisionsOf(scene: Scene): Revision[] {
  const out: Revision[] = [];
  for (const cell of Object.values(scene.cells)) {
    for (const g of Object.values(scene.gates)) {
      if (g.ticketId !== cell.ticketId || g.decidedAt === null) continue;
      if (g.gate === "verification" && g.state === "failed") {
        const failed = cell.verifications.find((v) => v.round === g.round)?.checks.filter((c) => c.result === "fail").map((c) => c.targetId) ?? [];
        out.push({ at: g.decidedAt, ticket: cell.ticketId, text: `Verification failed (${failed.join(", ")}); back to build, round ${(g.round ?? 1) + 1} of 3`, short: `${failed.join(", ")} failed, round ${(g.round ?? 1) + 1}`, tone: "fail" });
      }
      if (g.gate === "review" && g.state === "failed") {
        const b = cell.reviews.find((r) => r.round === g.round)?.findings.find((f) => f.severity === "blocker" && !f.outvoted);
        out.push({ at: g.decidedAt, ticket: cell.ticketId, text: `Review rejected (${b ? `${b.seat} ${b.rule ?? ""}` : "blocker"}); round ${(g.round ?? 1) + 1} of 3`, short: `Rejected ${b?.rule ?? ""}, round ${(g.round ?? 1) + 1}`, tone: "fail" });
      }
      if (g.gate === "human-approval" && g.state === "passed") {
        const by = [...cell.reviews].reverse().find((r) => r.humanApproval)?.humanApproval?.by ?? "a person";
        out.push({ at: g.decidedAt, ticket: cell.ticketId, text: `Approved by ${by}`, short: `Approved by ${by}`, tone: "human" });
      }
    }
    for (const r of cell.reviews) {
      const outvoted = r.findings.find((f) => f.outvoted);
      if (outvoted && r.decidedAt !== null) out.push({ at: r.decidedAt, ticket: cell.ticketId, text: `Approved with ${outvoted.seat} blocker ${outvoted.rule ?? ""} outvoted`, short: `${outvoted.rule ?? "Blocker"} outvoted`, tone: "wait" });
    }
    if (cell.merged) out.push({ at: cell.merged.at, ticket: cell.ticketId, text: `Merged${cell.merged.revalidated ? " after revalidation" : ""} (${cell.merged.commit.slice(0, 7)})`, short: "Merged", tone: "pass" });
  }
  for (const d of Object.values(scene.dependencies)) if (d.satisfiedAt !== null) out.push({ at: d.satisfiedAt, ticket: d.from, text: `${d.from} unlocked: ${d.to} integrated`, short: `${d.from.replace("SLICE-", "Slice ")} unlocked`, tone: "pass" });
  return out.sort((a, b) => a.at - b.at);
}

/** The revision table: rounds and decisions as the drawing's revisions, lettered A, B, C as they happen. */
export function Revisions({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const scene = useScene();
  const all = revisionsOf(scene);
  const rows = Math.floor((h - 22) / 13);
  const shown = all.slice(-rows);
  const first = all.length - shown.length;
  return (
    <g aria-hidden="true">
      <rect x={x} y={y} width={w} height={h} style={{ fill: fc("plate-top"), stroke: fc("ink-soft"), strokeWidth: 1 }} />
      <g className="bp-fine">
        <line x1={x} y1={y + 16} x2={x + w} y2={y + 16} style={{ stroke: fc("plate-edge"), strokeWidth: 0.75 }} />
        <line x1={x + 26} y1={y} x2={x + 26} y2={y + h} style={{ stroke: fc("plate-edge"), strokeWidth: 0.6 }} />
        <line x1={x + 70} y1={y} x2={x + 70} y2={y + h} style={{ stroke: fc("plate-edge"), strokeWidth: 0.6 }} />
        <line x1={x + 138} y1={y} x2={x + 138} y2={y + h} style={{ stroke: fc("plate-edge"), strokeWidth: 0.6 }} />
      </g>
      <g className="bp-fine" style={{ fill: "var(--mach-ink)", fontSize: 8.5, fontWeight: 700, letterSpacing: "0.06em" }}>
        <text x={x + 6} y={y + 11.5}>REV</text>
        <text x={x + 32} y={y + 11.5}>TIME</text>
        <text x={x + 76} y={y + 11.5}>WHERE</text>
        <text x={x + 144} y={y + 11.5}>ROUNDS AND DECISIONS</text>
      </g>
      <g className="bp-over">
        <text x={x + 12} y={y + 34} style={{ fill: "var(--mach-ink)", fontFamily: "var(--mach-font-serif)", fontSize: 32 }}>
          Revisions · {all.length}
        </text>
        {all.slice(-2).map((r, i, list) => (
          <text key={`o${r.at}${r.short}`} x={x + 12} y={y + 70 + i * 34} style={{ fontSize: 29 }}>
            <tspan style={{ fill: "var(--mach-ink)", fontWeight: 700 }}>{String.fromCharCode(65 + ((all.length - list.length + i) % 26))} </tspan>
            <tspan style={{ fill: "var(--mach-ink-muted)", fontFamily: "var(--mach-font-mono)" }}>{clock(r.at)} {r.ticket.replace("LOCAL-", "")} </tspan>
            <tspan style={{ fill: fc(r.tone), fontWeight: 600 }}>{r.short}</tspan>
          </text>
        ))}
      </g>
      {shown.map((r, i) => (
        <g key={`${r.at}${r.text}`} className="bp-fine" style={{ fontSize: 9 }}>
          <text x={x + 9} y={y + 29 + i * 13} style={{ fill: "var(--mach-ink)", fontWeight: 700 }}>
            {String.fromCharCode(65 + ((first + i) % 26))}
          </text>
          <text x={x + 32} y={y + 29 + i * 13} style={{ fill: "var(--mach-ink-muted)", fontFamily: "var(--mach-font-mono)" }} className="tabular">
            {clock(r.at)}
          </text>
          <text x={x + 76} y={y + 29 + i * 13} style={{ fill: "var(--mach-ink-muted)", fontFamily: "var(--mach-font-mono)" }}>
            {r.ticket}
          </text>
          <text x={x + 144} y={y + 29 + i * 13} style={{ fill: fc(r.tone) }}>
            {r.text.length > 58 ? `${r.text.slice(0, 57)}…` : r.text}
          </text>
        </g>
      ))}
      {!all.length ? (
        <text x={x + 144} y={y + 29} className="bp-fine" style={{ fill: "var(--mach-ink-subtle)", fontSize: 9 }}>
          No rounds or decisions yet.
        </text>
      ) : null}
    </g>
  );
}

/** Where the furniture sits: in the title-block strip along the bottom, the legend at left, the revisions beside the block. */
export function furnitureBox(layout: Layout): { legend: { x: number; y: number }; rev: { x: number; y: number; w: number; h: number } } {
  const { block, inner } = blueprintSheetLayout(layout.width, layout.height, 4, "strip");
  const y = block.y + (block.h - 112) / 2;
  const lx = inner.x + 10;
  const rx = lx + 600 + 24;
  return { legend: { x: lx, y }, rev: { x: rx, y, w: Math.min(760, block.x - 24 - rx), h: 112 } };
}
