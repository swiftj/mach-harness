/**
 * The Factory Flow: MACH's stations as a drawing of the belt, with the station-to-station moves the
 * lifecycle log records, the revise loops back to build drawn under the row, a person's approval
 * wait set below between review and merge, and the exits (blocked, abandoned).
 *
 * Edge widths are counts of recorded moves (square-root scale, so area reads as volume). They are
 * not ticket trajectories: a ticket that revised twice adds two moves to the loop.
 */
import { useMemo } from "react";
import type { Station, Transition } from "../../contract";
import { flowLayout, type FlowLayout, type FlowNode, type StationLoad } from "../../model/charts";
import { durationText } from "../../model/format";
import { Mark, useMarkNav, useTip, useWidth } from "../kit";

const MONO = { fontFamily: "var(--mach-font-mono)", fontVariantNumeric: "tabular-nums" } as const;
const SANS = { fontFamily: "var(--mach-font-sans)" } as const;

export const STATION_WORDS: Readonly<Record<FlowNode["station"], string>> = { groom: "Groom", plan: "Plan", audit: "Audit", build: "Build", verify: "Verify", review: "Review", human: "Human approval", merge: "Merge", cleanup: "Cleanup", blocked: "Escalated", abandoned: "Abandoned" };

export interface FlowStationFacts {
  readonly visits: number;
  readonly p50: number | null;
  readonly totalMs: number;
  readonly refusals: number;
  readonly open: number;
}

export function FlowDiagram({ transitions, facts, loads, selected, onSelect, humanFacts }: { transitions: readonly Transition[]; facts: Readonly<Partial<Record<Station, FlowStationFacts>>>; loads: readonly StationLoad[]; selected: Station | null; onSelect(s: Station | null): void; humanFacts: { waits: number; p50: number | null; open: number } }) {
  const [ref, width] = useWidth<HTMLDivElement>(1000);
  const [, setTip, tipNode] = useTip(width);
  const layout = useMemo(() => flowLayout(transitions, width), [transitions, width]);
  const stationNodes = layout.nodes.filter((n) => n.station !== "blocked" && n.station !== "abandoned");
  const nav = useMarkNav(stationNodes.length);
  const maxTotal = Math.max(1, ...loads.map((l) => l.totalMs));
  const labels = useMemo(() => placeCounts(layout), [layout]);
  return (
    <div ref={ref} className="relative" style={{ height: layout.height + 6 }}>
      <svg width={width} height={layout.height + 6} role="group" aria-label="Factory Flow: stations and the recorded moves between them" style={{ display: "block" }}>
        <defs>
          <marker id="an-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
            <path d="M0 0L8 4L0 8Z" style={{ fill: "var(--an-bar)" }} />
          </marker>
          <marker id="an-arrow-revise" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
            <path d="M0 0L8 4L0 8Z" style={{ fill: "var(--an-fail)" }} />
          </marker>
        </defs>
        {/* Edges under the nodes. */}
        {layout.edges.map((e) => {
          const revise = e.kind === "revise";
          const exit = e.kind === "exit";
          const faded = selected !== null && e.from !== selected && e.to !== selected;
          const tone = revise ? "var(--an-fail)" : exit ? "var(--an-halt)" : "var(--an-bar)";
          const words = revise ? `${e.count} revise moves from ${STATION_WORDS[e.from]} back to build` : exit ? `${e.count} tickets left ${STATION_WORDS[e.from]} as ${STATION_WORDS[e.to].toLowerCase()}` : `${e.count} moves from ${STATION_WORDS[e.from]} to ${STATION_WORDS[e.to]}`;
          return (
            <g key={`${e.from}>${e.to}`} style={{ opacity: faded ? 0.28 : 1 }}>
              <Mark
                name={words}
                x={e.lx - 14}
                y={e.ly - 12}
                w={28}
                h={16}
                tipAt={{ x: e.lx, y: e.ly - 10 }}
                card={{ title: words, rows: [["moves", String(e.count)]], foot: "Recorded moves between two stations, not one ticket's path." }}
                onTip={setTip}
              >
                <path d={e.d} style={{ fill: "none", stroke: tone, strokeWidth: e.weight, strokeDasharray: exit ? "4 3" : undefined, strokeLinecap: "round" }} markerEnd={`url(#${revise ? "an-arrow-revise" : "an-arrow"})`} />
              </Mark>
            </g>
          );
        })}
        {/* Every count after every stroke, so no later arc is drawn across an earlier count; each on its patch of ground. */}
        {layout.edges.map((e) => {
          const l = labels.get(`${e.from}>${e.to}`);
          if (!l) return null;
          const faded = selected !== null && e.from !== selected && e.to !== selected;
          return (
            <g key={`l-${e.from}>${e.to}`} style={{ opacity: faded ? 0.28 : 1, pointerEvents: "none" }} aria-hidden="true">
              <rect x={l.x} y={l.y} width={l.w} height={LABEL_H} rx={3} style={{ fill: "var(--mach-canvas)" }} />
              <text x={l.x + l.w / 2} y={l.y + LABEL_H - 4} textAnchor="middle" style={{ ...MONO, fontSize: 11, fill: e.kind === "revise" ? "var(--an-fail)" : "var(--an-muted)" }}>
                {e.count}
              </text>
            </g>
          );
        })}
        {layout.nodes.map((n) => {
          const isStation = n.station !== "blocked" && n.station !== "abandoned";
          const st = n.station as Station;
          const f = isStation && n.station !== "human" ? facts[st] : undefined;
          const isSel = selected === n.station;
          const faded = selected !== null && !isSel && n.station !== "blocked" && n.station !== "abandoned";
          if (!isStation) {
            const count = transitions.filter((t) => t.to === n.station).reduce((s, t) => s + t.count, 0);
            return (
              <g key={n.station}>
                <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={4} style={{ fill: "var(--mach-surface)", stroke: n.station === "blocked" ? "var(--an-halt)" : "var(--an-subtle)", strokeDasharray: "3 2" }} />
                <text x={n.x + 8} y={n.y + 19} style={{ ...SANS, fontSize: 12, fill: "var(--an-ink)" }}>
                  {STATION_WORDS[n.station]} <tspan style={{ ...MONO, fill: "var(--an-muted)" }}>{count}</tspan>
                </text>
              </g>
            );
          }
          const human = n.station === "human";
          const visits = human ? humanFacts.waits : (f?.visits ?? 0);
          const p50 = human ? humanFacts.p50 : (f?.p50 ?? null);
          const load = loads.find((l) => l.station === n.station);
          const name = human ? `Human approval ${durationText(humanFacts.p50)} median, ${humanFacts.waits} waits: ${humanFacts.waits} measured waits, median ${durationText(humanFacts.p50)}${humanFacts.open ? `, ${humanFacts.open} still waiting` : ""}. A wait for a person, not a station visit.` : `${STATION_WORDS[st]} ${durationText(p50)} median, ${visits} visits: ${visits} measured visits, median ${durationText(p50)}${load ? `, ${Math.round(load.share * 100)}% of measured station time` : ""}${f?.refusals ? `, ${f.refusals} gate refusals` : ""}`;
          return (
            <g key={n.station} style={{ opacity: faded ? 0.55 : 1 }}>
              <Mark
                nav={nav}
                index={stationNodes.indexOf(n)}
                name={name}
                x={n.x}
                y={n.y}
                w={n.w}
                h={n.h}
                tipAt={{ x: n.x + n.w / 2, y: n.y }}
                card={human ? { title: "Human approval", rows: [["measured waits", String(humanFacts.waits)], ["median", durationText(humanFacts.p50)], ...(humanFacts.open ? ([["still waiting", String(humanFacts.open)]] as [string, string][]) : [])], foot: "A wait for a person, not a station visit." } : { title: STATION_WORDS[st], rows: [["measured visits", String(visits)], ["median visit", durationText(p50)], ...(load ? ([["share of measured time", `${Math.round(load.share * 100)}%`]] as [string, string][]) : []), ...(f?.refusals ? ([["gate refusals", String(f.refusals)]] as [string, string][]) : [])], foot: isSel ? "Selected: Enter clears it." : "Enter selects it." }}
                onTip={setTip}
                onActivate={() => onSelect(isSel ? null : st)}
                pressed={isSel}
                overlay={
                  <>
                    <text x={n.x + 9} y={n.y + 18} style={{ ...SANS, fontSize: 13, fontWeight: 600, fill: "var(--an-ink)" }}>
                      {STATION_WORDS[n.station]}
                    </text>
                    <text x={n.x + 9} y={n.y + 36} style={{ ...MONO, fontSize: 12.5, fontWeight: 600, fill: "var(--an-ink)" }}>
                      {durationText(p50)}
                      {n.w >= 128 ? <tspan style={{ ...SANS, fontSize: 10.5, fontWeight: 400, fill: "var(--an-subtle)" }}> median</tspan> : null}
                    </text>
                    <text x={n.x + 9} y={n.y + 51} style={{ ...SANS, fontSize: 11, fill: "var(--an-subtle)" }}>
                      <tspan style={MONO}>{visits}</tspan> {human ? "waits" : "visits"}
                    </text>
                    {f?.refusals ? (
                      <text x={n.x + n.w - 8} y={n.y + 18} textAnchor="end" style={{ ...MONO, fontSize: 10.5, fill: "var(--an-wait)" }}>
                        {f.refusals}⊘
                      </text>
                    ) : null}
                  </>
                }
              >
                <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={6} style={{ fill: isSel ? "var(--mach-accent-soft)" : "var(--mach-surface)", stroke: isSel ? "var(--an-select)" : human ? "var(--an-human)" : "var(--an-outline)", strokeWidth: isSel ? 2 : 1, strokeDasharray: human ? "4 3" : undefined }} />
                {!human && load ? (
                  <g aria-hidden="true">
                    <line x1={n.x + 9} x2={n.x + n.w - 9} y1={n.y + n.h - 9} y2={n.y + n.h - 9} style={{ stroke: "var(--an-grid)", strokeWidth: 4, strokeLinecap: "round" }} />
                    <line x1={n.x + 9} x2={n.x + 9 + Math.max(1, (n.w - 18) * (load.totalMs / maxTotal))} y1={n.y + n.h - 9} y2={n.y + n.h - 9} style={{ stroke: isSel ? "var(--an-select)" : "var(--an-ink)", strokeWidth: 4, strokeLinecap: "round" }} />
                  </g>
                ) : null}
              </Mark>
            </g>
          );
        })}
      </svg>
      {tipNode}
    </div>
  );
}

const LABEL_H = 15;
const DIGIT_W = 6.8;

/**
 * Where each move's count is written, or nothing when it does not fit. A forward move's count goes
 * in the gap between its two stations only when the gap holds it; every other count sits on its own
 * patch of the ground at its label point and is dropped where it would meet a station or a larger
 * count already placed. Exits are named by their boxes. The full counts stay in the hover card and
 * the table.
 */
function placeCounts(layout: FlowLayout): Map<string, { x: number; y: number; w: number }> {
  const out = new Map<string, { x: number; y: number; w: number }>();
  const boxes: { x: number; y: number; w: number; h: number }[] = layout.nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }));
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  const meets = (b: { x: number; y: number; w: number; h: number }) => [...boxes, ...placed].some((o) => b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y);
  const byNode = new Map(layout.nodes.map((n) => [n.station, n] as const));
  for (const e of [...layout.edges].sort((p, q) => q.count - p.count)) {
    if (e.kind === "exit") continue;
    const w = String(e.count).length * DIGIT_W + 6;
    const a = byNode.get(e.from);
    const b = byNode.get(e.to);
    const adjacentForward = e.kind === "forward" && a && b && b.x > a.x && Math.abs(b.y - a.y) < 1 && b.x - (a.x + a.w) < 40;
    if (adjacentForward) {
      // In the gap when it holds the count; otherwise just above the two stations, over the gap,
      // where nothing else is drawn, unless it would meet a count already placed there.
      const gap = b.x - (a.x + a.w);
      const box = w <= gap - 2 ? { x: e.lx - w / 2, y: e.ly - LABEL_H + 3, w, h: LABEL_H } : { x: e.lx - w / 2, y: a.y - LABEL_H - 3, w, h: LABEL_H };
      if (w > gap - 2 && (w > gap + 0.5 * Math.min(a.w, b.w) || placed.some((o) => box.x < o.x + o.w + 2 && box.x + box.w + 2 > o.x && box.y < o.y + o.h && box.y + box.h > o.y))) continue;
      placed.push(box);
      out.set(`${e.from}>${e.to}`, { x: box.x, y: box.y, w });
      continue;
    }
    // On its label point; where that would be cut at the top of the drawing (an arc's apex), just under the stroke instead.
    const above = { x: e.lx - w / 2, y: e.ly - LABEL_H + 3, w, h: LABEL_H };
    const box = above.y >= 0 ? above : { ...above, y: e.ly + Math.max(2, e.weight / 2 + 1) };
    if (meets(box)) continue;
    placed.push(box);
    out.set(`${e.from}>${e.to}`, { x: box.x, y: box.y, w });
  }
  return out;
}
