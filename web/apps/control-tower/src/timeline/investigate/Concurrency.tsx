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
import { activeAt, concurrencyView, spanSource, type ConcurrencyLine, type LaneSegment, type LimitLine, frameAbout, frameOf } from "./model";

const CHART_TOP = 6;
/** One line's panel: its plot height and the gap to the next. */
const PANEL_H = 44;
const PANEL_GAP = 8;
const LANE_H = 15;

const LINE_STYLE: Readonly<Record<ConcurrencyLine["kind"], { stroke: string; width: number }>> = {
  execution: { stroke: fc("live"), width: 2 },
  visit: { stroke: fc("ink-soft"), width: 0.6 },
  agent: { stroke: fc("ink-soft"), width: 1 },
};
/** Executions first: the recorded limit counts them. */
const PANEL_ORDER: Readonly<Record<ConcurrencyLine["kind"], number>> = { execution: 0, visit: 1, agent: 2 };

const SEGMENT_WORDS: Readonly<Record<LaneSegment["kind"], string>> = { station: "in a station", capacity: "waiting for capacity", eligible: "eligible, not yet dispatched", claim: "claimed, not yet started (dispatch delay)" };

export function ConcurrencyBody(p: BodyProps) {
  const liveAt = p.viewport.liveAt;
  const s = scaleOf(p.viewport, p.width);
  const v = useMemo(() => concurrencyView(p.series, p.spans, p.viewport.window, liveAt), [p.series, p.spans, p.viewport.window, liveAt]);

  if (p.status === "loading") return <Caption>Reading the concurrency series of this window…</Caption>;
  if (!p.series || (v.lines.length === 0 && v.lanes.length === 0))
    return <Empty text={p.series ? "Nothing ran in parallel in this window" : "This observer does not serve concurrency"} detail={p.series ? "No execution, station visit or agent is recorded as active here." : "Counts of spans active at once are not available from this source."} onWiden={p.onWiden} />;

  // One small panel per line, each on its own scale and labelled with it (round 6, defect 10): a limit
  // of 3 is not flattened by 23 agents, and no line is drawn as a share of another.
  const panels = [...v.lines].sort((a, b) => PANEL_ORDER[a.kind] - PANEL_ORDER[b.kind]);
  const panelTop = (i: number) => CHART_TOP + i * (PANEL_H + PANEL_GAP);
  const lanesTop = panelTop(panels.length) + 12;
  const H = lanesTop + v.lanes.length * LANE_H + 8;

  return (
    <Figures label="Work active at once">
      <Caption>
        Counts are recorded spans active at once, each line on its own scale; capacity is the recorded limit, not inferred from activity.{" "}
        {v.limits.length === 0 ? <span className="text-ink-muted">No limit recorded for this window.</span> : null}
      </Caption>
      <svg width={p.width} height={H} role="presentation" style={{ display: "block" }}>
        <line x1={s.gutter - 0.5} x2={s.gutter - 0.5} y1={0} y2={H} style={{ stroke: "var(--mach-line)" }} aria-hidden="true" />
        {panels.map((l, i) => (
          <LinePanel key={l.kind} l={l} limits={v.limits.filter((x) => x.lines.includes(l.kind))} top={panelTop(i)} s={s} p={p} liveAt={liveAt} />
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
              <FrameFig id={lane.key} what={lane.label} frame={frameOf(lane.segments.map((sg) => sg.span))} about={frameAbout(lane.segments.map((sg) => sg.span))} right={s.gutter - 6} y={ly + 1.5} onFrame={p.onFrame} />
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

/**
 * One line on its own scale: in the gutter its name, its most at once (which reveals what was active
 * then) and, for the line a recorded limit counts, that limit; on the plot its 0 and its scale's top,
 * the stepped line (cells in a station as a quiet area, the part whose end was inferred lighter), and
 * the limit as a dashed rule only where recorded.
 */
function LinePanel({ l, limits, top, s, p, liveAt }: { l: ConcurrencyLine; limits: readonly LimitLine[]; top: number; s: Scale; p: BodyProps; liveAt: number }) {
  const y = (c: number) => top + PANEL_H - (c / l.scaleMax) * PANEL_H;
  const peakSpans = l.peakAt !== null ? activeAt(p.spans, l.kind, l.peakAt + Math.min(p.series!.bucketMs / 2, 1000), liveAt) : [];
  const limitWords = [...new Set(limits.map((x) => x.value))].join("→");
  const steps = (count: (i: number) => number) => {
    let d = "";
    l.steps.forEach((st, i) => {
      d += `${i === 0 ? "M" : "L"}${s.cx(st.from)} ${y(count(i))}H${s.cx(st.to)}`;
    });
    return d;
  };
  let drawing;
  if (l.kind === "visit") {
    const first = l.steps[0]!;
    const last = l.steps[l.steps.length - 1]!;
    const rec = steps((i) => l.steps[i]!.count - (l.inferred[i]?.count ?? 0));
    const band = l.steps
      .map((st, i) => ({ st, inf: l.inferred[i]?.count ?? 0 }))
      .filter((x) => x.inf > 0)
      .map(({ st, inf }) => `M${s.cx(st.from)} ${y(st.count)}H${s.cx(st.to)}V${y(st.count - inf)}H${s.cx(st.from)}Z`)
      .join("");
    drawing = (
      <g aria-hidden="true">
        <path d={`M${s.cx(first.from)} ${y(0)}${rec.replace(/^M/, "L")}L${s.cx(last.to)} ${y(0)}Z`} style={{ fill: fc("plate-lit"), stroke: "none", opacity: 0.9 }} />
        {band ? <path d={band} style={{ fill: fc("plate-lit"), opacity: 0.45, stroke: fc("ink-soft"), strokeWidth: 0.6, strokeDasharray: "2 1.5" }} /> : null}
        <path d={rec} style={{ fill: "none", stroke: fc("ink-soft"), strokeWidth: 0.8 }} />
      </g>
    );
  } else drawing = <path d={steps((i) => l.steps[i]!.count)} aria-hidden="true" style={{ fill: "none", stroke: LINE_STYLE[l.kind].stroke, strokeWidth: LINE_STYLE[l.kind].width, strokeLinejoin: "miter" }} />;
  return (
    <g>
      <Fig
        id={`peak:${l.kind}`}
        name={`Most ${l.label} at once in this window: ${l.peak}${l.peakAt !== null ? `, from ${when(l.peakAt)}` : ""}, counted from recorded spans active at once${l.inferredPeak ? `, including ${l.inferredPeak} ended without an exit record` : ""}${limitWords ? `; recorded limit ${limitWords}` : ""}. Drawn on its own scale, 0 to ${l.scaleMax}`}
        sources={peakSpans.slice(0, 6).map((sp) => spanSource(sp, l.kind === "visit" ? "station visit" : l.kind))}
        onActivate={() => p.onReveal(peakSpans[0]?.entity ?? "actor:supervisor", l.peakAt ?? undefined)}
      >
        <Hit x={8} y={top + 1} w={s.gutter - 40} h={12} />
        {l.kind === "visit" ? (
          <rect x={10} y={top + 3} width={14} height={7} style={{ fill: fc("plate-lit"), stroke: fc("ink-soft"), strokeWidth: 0.8 }} />
        ) : (
          <line x1={10} x2={24} y1={top + 6.5} y2={top + 6.5} style={{ stroke: LINE_STYLE[l.kind].stroke, strokeWidth: LINE_STYLE[l.kind].width }} />
        )}
        {/* One text on two lines, so its words read "executions running 3 at most" as one phrase. */}
        <text x={29} y={top + 10} style={{ ...SANS, fontSize: 10.5, fill: INK }}>
          {l.label}{" "}
          <tspan x={29} dy={13} style={{ fontSize: 10, fill: MUTED }}>
            <tspan style={{ ...MONO, fill: INK }}>{l.peak}</tspan> at most
            {limitWords ? (
              <>
                {" · limit "}
                <tspan style={{ ...MONO, fill: INK }}>{limitWords}</tspan>
              </>
            ) : null}
          </tspan>
        </text>
        {l.inferredPeak ? (
          <text x={29} y={top + 35} style={{ ...SANS, fontSize: 9.5, fill: SUBTLE }}>
            {l.inferredPeak} ended without an exit record
          </text>
        ) : null}
        <Ring x={8} y={top + 1} w={s.gutter - 40} h={12} />
      </Fig>
      {/* Its own scale: the baseline and the top, labelled. */}
      <g aria-hidden="true">
        <line x1={s.gutter} x2={s.gutter + s.plotW} y1={y(0)} y2={y(0)} style={{ stroke: "var(--mach-line-strong)", strokeWidth: 1 }} />
        <line x1={s.gutter} x2={s.gutter + s.plotW} y1={y(l.scaleMax)} y2={y(l.scaleMax)} style={{ stroke: fc("grid"), strokeWidth: 1 }} />
        <text x={s.gutter - 5} y={y(0) + 3} textAnchor="end" style={{ ...MONO, fontSize: 9, fill: SUBTLE }}>
          0
        </text>
        <text x={s.gutter - 5} y={y(l.scaleMax) + 7} textAnchor="end" style={{ ...MONO, fontSize: 9, fill: SUBTLE }}>
          {l.scaleMax}
        </text>
      </g>
      {/* The recorded limit, where it applied, against the line it counts. */}
      {limits.map((x, i) => {
        const a = s.cx(x.from);
        const b = s.cx(x.to);
        return (
          <Fig key={i} id={`limit:${l.kind}:${i}`} name={`Recorded limit: ${x.value} parallel ${x.appliesTo}, from ${when(x.from)}${x.to < liveAt ? ` to ${when(x.to)}` : ""}, as the Factory's limits record it`} sources={[{ what: "the Factory's recorded limits (max_parallel)", ref: `limit:max_parallel@${x.from}`, eventId: null }]} onActivate={() => p.onReveal("actor:supervisor", x.from)}>
            <Hit x={a} y={y(x.value) - 2} w={b - a} h={4} />
            <line className="mach-inv-hover" x1={a} x2={b} y1={y(x.value)} y2={y(x.value)} style={{ stroke: INK, strokeWidth: 1, strokeDasharray: "5 3" }} />
            {b - a > 60 ? (
              <text x={b - 3} y={y(x.value) - 3} textAnchor="end" style={{ ...SANS, fontSize: 9.5, fill: MUTED }}>
                limit {x.value}
              </text>
            ) : null}
            <Ring x={a} y={y(x.value) - 2} w={b - a} h={4} />
          </Fig>
        );
      })}
      {drawing}
      {l.kind === "execution" && l.peakAt !== null ? <circle cx={s.cx(l.peakAt)} cy={y(l.peak)} r={2.6} aria-hidden="true" style={{ fill: fc("ground"), stroke: LINE_STYLE.execution.stroke, strokeWidth: 1.4 }} /> : null}
    </g>
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
