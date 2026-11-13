/**
 * Lens 2, parallel execution: stepped lines of how many executions ran, cells sat in a station and
 * agents worked at once in the window, from the concurrency series; the recorded `max_parallel` as a
 * dashed reference line only where recorded; and under it, per cell, when it was in a station, waiting
 * for capacity, eligible but not dispatched, and between claim and start (the supervisor's dispatch delay).
 */
import { useMemo } from "react";
import { fc } from "@mach/ui";
import { duration } from "../../shell/time";
import { capacityWords, durationWords } from "../render";
import type { BodyProps } from "./body";
import { Caption, Empty, Fig, Figures, FrameFig, Hit, LiveEdge, MONO, MUTED, Ring, SANS, scaleOf, SUBTLE, INK, when, type Scale } from "./figures";
import { activeAt, concurrencyView, spanSource, type ConcurrencyLine, type LaneSegment, frameOf } from "./model";

const CHART_TOP = 8;
const CHART_H = 120;
const LANE_H = 15;

const LINE_STYLE: Readonly<Record<ConcurrencyLine["kind"], { stroke: string; width: number }>> = {
  execution: { stroke: fc("live"), width: 2 },
  visit: { stroke: fc("ink-soft"), width: 0.6 },
  agent: { stroke: fc("ink-soft"), width: 1 },
};
const ORDER: Readonly<Record<ConcurrencyLine["kind"], number>> = { visit: 0, agent: 1, execution: 2 };

const SEGMENT_WORDS: Readonly<Record<LaneSegment["kind"], string>> = { station: "in a station", capacity: "waiting for capacity", eligible: "eligible, not yet dispatched", claim: "claimed, not yet started (dispatch delay)" };

export function ConcurrencyBody(p: BodyProps) {
  const liveAt = p.viewport.liveAt;
  const s = scaleOf(p.viewport, p.width);
  const v = useMemo(() => concurrencyView(p.series, p.spans, p.viewport.window, liveAt), [p.series, p.spans, p.viewport.window, liveAt]);

  if (p.status === "loading") return <Caption>Reading the concurrency series of this window…</Caption>;
  if (!p.series || (v.lines.length === 0 && v.lanes.length === 0))
    return <Empty text={p.series ? "Nothing ran in parallel in this window" : "This observer does not serve concurrency"} detail={p.series ? "No execution, station visit or agent is recorded as active here." : "Counts of spans active at once are not available from this source."} onWiden={p.onWiden} />;

  const y = (c: number) => CHART_TOP + CHART_H - (c / v.yMax) * CHART_H;
  const grid = Array.from({ length: v.yMax + 1 }, (_, i) => i).filter((i) => v.yMax <= 6 || i % Math.ceil(v.yMax / 6) === 0);
  const lanesTop = CHART_TOP + CHART_H + 16;
  const visitLine = v.lines.find((l) => l.kind === "visit");
  const inferredNote = visitLine && visitLine.inferredPeak > 0 ? visitLine.inferredPeak : 0;
  // Legend rows: one per line, then the inferred note under "cells in a station", then the limit.
  const legendRows = v.lines.length + (inferredNote ? 1 : 0);
  const H = lanesTop + v.lanes.length * LANE_H + 8;

  return (
    <Figures label="Work active at once">
      <Caption>
        Counts are recorded spans active at once; capacity is the recorded limit, not inferred from activity.{" "}
        {v.limits.length === 0 ? <span className="text-ink-muted">No limit recorded for this window.</span> : null}
      </Caption>
      <svg width={p.width} height={H} role="presentation" style={{ display: "block" }}>
        {/* Legend in the gutter: each entry names the line's most at once, and reveals what was active then. */}
        {v.lines.map((l, i) => {
          const ly = CHART_TOP + 8 + i * 15;
          const peak = l.peakAt !== null ? activeAt(p.spans, l.kind, l.peakAt + Math.min(p.series!.bucketMs / 2, 1000), liveAt) : [];
          return (
            <Fig
              key={l.kind}
              id={`peak:${l.kind}`}
              name={`Most ${l.label} at once in this window: ${l.peak}${l.peakAt !== null ? `, from ${when(l.peakAt)}` : ""}, counted from recorded spans active at once${l.inferredPeak ? `, including ${l.inferredPeak} ended without an exit record` : ""}`}
              sources={peak.slice(0, 6).map((sp) => spanSource(sp, l.kind === "visit" ? "station visit" : l.kind))}
              onActivate={() => p.onReveal(peak[0]?.entity ?? "actor:supervisor", l.peakAt ?? undefined)}
            >
              <Hit x={8} y={ly - 6} w={s.gutter - 20} h={12} />
              {l.kind === "visit" ? (
                <rect x={10} y={ly - 4} width={16} height={8} style={{ fill: fc("plate-lit"), stroke: fc("ink-soft"), strokeWidth: 0.8 }} />
              ) : (
                <line x1={10} x2={26} y1={ly} y2={ly} style={{ stroke: LINE_STYLE[l.kind].stroke, strokeWidth: LINE_STYLE[l.kind].width }} />
              )}
              <text x={31} y={ly + 3.5} style={{ ...SANS, fontSize: 10.5, fill: MUTED }}>
                {l.label} <tspan style={{ ...MONO, fill: INK }}>{l.peak}</tspan>
                <tspan style={{ fill: SUBTLE }}> at most</tspan>
              </text>
              <Ring x={8} y={ly - 6} w={s.gutter - 20} h={12} />
            </Fig>
          );
        })}
        {inferredNote ? (
          <g aria-hidden="true">
            <rect x={10} y={CHART_TOP + 8 + v.lines.length * 15 - 4} width={16} height={8} style={{ fill: fc("plate-lit"), opacity: 0.45, stroke: fc("ink-soft"), strokeWidth: 0.6, strokeDasharray: "2 1.5" }} />
            <text x={31} y={CHART_TOP + 11.5 + v.lines.length * 15} style={{ ...SANS, fontSize: 10, fill: SUBTLE }}>
              including {inferredNote} ended without an exit record
            </text>
          </g>
        ) : null}
        {v.limits.length ? (
          <g aria-hidden="true">
            <line x1={10} x2={26} y1={CHART_TOP + 8 + legendRows * 15} y2={CHART_TOP + 8 + legendRows * 15} style={{ stroke: INK, strokeWidth: 1, strokeDasharray: "5 3" }} />
            <text x={31} y={CHART_TOP + 11.5 + legendRows * 15} style={{ ...SANS, fontSize: 10.5, fill: MUTED }}>
              recorded limit <tspan style={{ ...MONO, fill: INK }}>{[...new Set(v.limits.map((l) => l.value))].join("→")}</tspan>
            </text>
          </g>
        ) : null}
        <line x1={s.gutter - 0.5} x2={s.gutter - 0.5} y1={0} y2={H} style={{ stroke: "var(--mach-line)" }} aria-hidden="true" />

        {/* Count grid. */}
        {grid.map((c) => (
          <g key={c} aria-hidden="true">
            <line x1={s.gutter} x2={s.gutter + s.plotW} y1={y(c)} y2={y(c)} style={{ stroke: c === 0 ? "var(--mach-line-strong)" : fc("grid"), strokeWidth: 1 }} />
            <text x={s.gutter - 5} y={y(c) + 3} textAnchor="end" style={{ ...MONO, fontSize: 9, fill: SUBTLE }}>
              {c}
            </text>
          </g>
        ))}

        {/* The recorded limit, where it applied. */}
        {v.limits.map((l, i) => {
          const a = s.cx(l.from);
          const b = s.cx(l.to);
          return (
            <Fig key={i} id={`limit:${i}`} name={`Recorded limit: ${l.value} parallel ${l.appliesTo}, from ${when(l.from)}${l.to < liveAt ? ` to ${when(l.to)}` : ""}, as the Factory's limits record it`} sources={[{ what: "the Factory's recorded limits (max_parallel)", ref: `limit:max_parallel@${l.from}`, eventId: null }]} onActivate={() => p.onReveal("actor:supervisor", l.from)}>
              <Hit x={a} y={y(l.value) - 2} w={b - a} h={4} />
              <line className="mach-inv-hover" x1={a} x2={b} y1={y(l.value)} y2={y(l.value)} style={{ stroke: INK, strokeWidth: 1, strokeDasharray: "5 3" }} />
              <Ring x={a} y={y(l.value) - 2} w={b - a} h={4} />
            </Fig>
          );
        })}

        {/* Stepped, never smoothed: cells in a station as a quiet area, agents a thin line, executions on top. */}
        {[...v.lines].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]).map((l) => {
          let d = "";
          l.steps.forEach((st, i) => {
            d += `${i === 0 ? "M" : "L"}${s.cx(st.from)} ${y(st.count)}H${s.cx(st.to)}`;
          });
          if (l.kind === "visit") {
            const first = l.steps[0]!;
            const last = l.steps[l.steps.length - 1]!;
            if (!l.inferred.length) return <path key={l.kind} d={`M${s.cx(first.from)} ${y(0)}${d.replace(/^M/, "L")}L${s.cx(last.to)} ${y(0)}Z`} aria-hidden="true" style={{ fill: fc("plate-lit"), stroke: fc("ink-soft"), strokeWidth: 0.6, opacity: 0.9 }} />;
            // The recorded part as the quiet area with its line; the part whose end was inferred as a lighter band above it (T9).
            let rec = "";
            l.steps.forEach((st, i) => {
              const r = st.count - (l.inferred[i]?.count ?? 0);
              rec += `${i === 0 ? "M" : "L"}${s.cx(st.from)} ${y(r)}H${s.cx(st.to)}`;
            });
            const band = l.steps
              .map((st, i) => ({ st, inf: l.inferred[i]?.count ?? 0 }))
              .filter((x) => x.inf > 0)
              .map(({ st, inf }) => `M${s.cx(st.from)} ${y(st.count)}H${s.cx(st.to)}V${y(st.count - inf)}H${s.cx(st.from)}Z`)
              .join("");
            return (
              <g key={l.kind} aria-hidden="true">
                <path d={`M${s.cx(first.from)} ${y(0)}${rec.replace(/^M/, "L")}L${s.cx(last.to)} ${y(0)}Z`} style={{ fill: fc("plate-lit"), stroke: "none", opacity: 0.9 }} />
                {band ? <path d={band} style={{ fill: fc("plate-lit"), opacity: 0.45, stroke: fc("ink-soft"), strokeWidth: 0.6, strokeDasharray: "2 1.5" }} /> : null}
                <path d={rec} style={{ fill: "none", stroke: fc("ink-soft"), strokeWidth: 0.8 }} />
              </g>
            );
          }
          return <path key={l.kind} d={d} aria-hidden="true" style={{ fill: "none", stroke: LINE_STYLE[l.kind].stroke, strokeWidth: LINE_STYLE[l.kind].width, strokeLinejoin: "miter" }} />;
        })}
        {v.lines
          .filter((l) => l.kind === "execution" && l.peakAt !== null)
          .map((l) => (
            <g key="peak" aria-hidden="true">
              <circle cx={s.cx(l.peakAt!)} cy={y(l.peak)} r={2.6} style={{ fill: fc("ground"), stroke: LINE_STYLE.execution.stroke, strokeWidth: 1.4 }} />
            </g>
          ))}
        {/* Per cell: in a station, waiting for capacity, eligible, claimed. */}
        {v.lanes.length ? (
          <text x={10} y={lanesTop - 4} style={{ ...SANS, fontSize: 10, fill: SUBTLE }} aria-hidden="true">
            per cell: station · capacity wait · eligible · claim
          </text>
        ) : null}
        {v.lanes.map((lane, i) => {
          const ly = lanesTop + i * LANE_H;
          return (
            <g key={lane.key}>
              <Fig id={`lane:${lane.key}`} name={`${lane.label}: ${lane.segments.length} recorded stretches in this window`} sources={[]} onActivate={() => p.onReveal(lane.ref)}>
                <Hit x={8} y={ly + 1} w={Math.min(s.gutter - 16, lane.label.length * 6.5 + 4)} h={12} />
                <text x={10} y={ly + 10.5} style={{ ...MONO, fontSize: 10.5, fill: INK }}>
                  {lane.label}
                </text>
                <Ring x={8} y={ly + 1} w={Math.min(s.gutter - 16, lane.label.length * 6.5 + 4)} h={12} />
              </Fig>
              <FrameFig id={lane.key} what={lane.label} frame={frameOf(lane.segments.map((sg) => sg.span))} right={s.gutter - 6} y={ly + 1.5} onFrame={p.onFrame} />
              <line x1={s.gutter} x2={s.gutter + s.plotW} y1={ly + LANE_H - 0.5} y2={ly + LANE_H - 0.5} style={{ stroke: fc("grid") }} aria-hidden="true" />
              {lane.segments.map((sg) => (
                <Segment key={sg.span.id} sg={sg} s={s} y={ly} liveAt={liveAt} label={lane.label} onReveal={p.onReveal} />
              ))}
            </g>
          );
        })}
        <LiveEdge s={s} liveAt={liveAt} h={H} />
      </svg>
    </Figures>
  );
}

function Segment({ sg, s, y, liveAt, label, onReveal }: { sg: LaneSegment; s: Scale; y: number; liveAt: number; label: string; onReveal(ref: string, at?: number): void }) {
  if (sg.from > s.to || (sg.to ?? liveAt) < s.from) return null;
  const a = s.cx(sg.from);
  const b = Math.max(a + 1.5, s.cx(sg.to ?? liveAt));
  const mid = y + LANE_H / 2;
  const open = sg.to === null;
  const words = sg.kind === "capacity" ? capacityWords(sg.span) : SEGMENT_WORDS[sg.kind];
  const name = `${label}, ${words}, from ${when(sg.from)}: ${durationWords(sg.span, liveAt)}`;
  let drawing;
  switch (sg.kind) {
    case "station":
      drawing = <rect className="mach-inv-hover" x={a} y={mid - 3} width={b - a} height={6} style={{ fill: fc("plate-lit"), stroke: fc("ink-soft"), strokeWidth: 0.8 }} />;
      break;
    case "capacity":
      drawing = (
        <g>
          <rect className="mach-inv-hover" x={a} y={mid - 4} width={b - a} height={8} style={{ fill: fc("wait-soft"), stroke: fc("wait"), strokeWidth: 1, strokeDasharray: "3 2" }} />
          {open ? null : <line x1={b} x2={b} y1={mid - 5} y2={mid + 5} style={{ stroke: fc("wait"), strokeWidth: 2 }} />}
        </g>
      );
      break;
    case "eligible":
      drawing = <line className="mach-inv-hover" x1={a} x2={b} y1={mid} y2={mid} style={{ stroke: fc("ink-soft"), strokeWidth: 1.4, strokeDasharray: "1 2.4", strokeLinecap: "round" }} />;
      break;
    case "claim":
      drawing = <path className="mach-inv-hover" d={`M${a} ${mid - 4}V${mid + 4}M${a} ${mid}H${b}M${b} ${mid - 4}V${mid + 4}`} style={{ fill: "none", stroke: fc("live"), strokeWidth: 1.3 }} />;
      break;
  }
  return (
    <Fig id={`seg:${sg.span.id}`} name={name} sources={[spanSource(sg.span, words)]} onActivate={() => onReveal(sg.span.entity, sg.from)}>
      <Hit x={a} y={y + 2} w={b - a} h={LANE_H - 4} />
      {drawing}
      {sg.kind === "capacity" && b - a > 150 ? (
        <text x={a + 4} y={mid + 3} style={{ ...MONO, fontSize: 8, fill: INK }} data-capacity-label="">
          {words}
        </text>
      ) : null}
      {sg.kind === "claim" && b - a > 40 ? (
        <text x={(a + b) / 2} y={mid - 2.5} textAnchor="middle" style={{ ...MONO, fontSize: 8.5, fill: SUBTLE }}>
          {duration((sg.to ?? liveAt) - sg.from)}
        </text>
      ) : null}
      <Ring x={a} y={y + 2} w={b - a} h={LANE_H - 4} />
    </Fig>
  );
}
