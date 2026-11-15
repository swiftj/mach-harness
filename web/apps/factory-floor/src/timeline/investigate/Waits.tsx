/**
 * Lens 3, what a slice waited on: one row per slice, each wait as a dashed band with its stop bar where
 * it ended. A dependency wait names the slices it waited on, and those dependencies' own completion or
 * integration instants are leaders down to the row when the data holds them (each drawn once per row).
 * A capacity wait names no dependency: it says it waited for a free place, as the tracks do. No arrow of
 * cause is drawn: the records name the dependency; they do not say which event released the wait.
 */
import { useMemo, type ReactElement } from "react";
import { fc } from "@mach/ui";
import { capacityWords, durationWords } from "../render";
import type { BodyProps } from "./body";
import { Caption, Diamond, Empty, FadeDefs, Fig, Figures, FrameFig, Hit, LiveEdge, MONO, MUTED, Ring, SANS, scaleOf, SUBTLE, INK, when } from "./figures";
import { RELEASE_NOT_RECORDED, leaderLabels, rowLeaders, spanSource, textWidth, waitItems, type WaitItem, frameAbout, frameOf } from "./model";

const ROW_H = 44;
const BAND_Y = 6;
const BAND_H = 10;

export function WaitsBody(p: BodyProps) {
  const liveAt = p.viewport.liveAt;
  const s = scaleOf(p.viewport, p.width);
  const items = useMemo(() => waitItems(p.spans, p.marks, liveAt), [p.spans, p.marks, liveAt]);
  const rows = useMemo(() => {
    const m = new Map<string, WaitItem[]>();
    for (const it of items) m.set(it.slice, [...(m.get(it.slice) ?? []), it]);
    return [...m.entries()];
  }, [items]);

  if (p.status === "loading") return <Caption>Reading the waits of this window…</Caption>;
  if (rows.length === 0) return <Empty text="No slice waited on a dependency or for a free place in this window" detail="Waits for a person are in the review and recovery lenses." onWiden={p.onWiden} />;

  const H = rows.length * ROW_H + 6;
  return (
    <Figures label="What each slice waited on">
      <Caption>{RELEASE_NOT_RECORDED} A leader marks when a named dependency was itself integrated, where the data holds it. A wait for a free place names no dependency.</Caption>
      <svg width={p.width} height={H} role="presentation" style={{ display: "block" }}>
        <FadeDefs id="mach-inv-wait-fade" color="var(--mach-factory-wait-soft)" />
        <line x1={s.gutter - 0.5} x2={s.gutter - 0.5} y1={0} y2={H} style={{ stroke: "var(--mach-line)" }} aria-hidden="true" />
        {rows.map(([slice, waits], i) => {
          const y = 2 + i * ROW_H;
          const ticket = waits.find((w) => w.ticket)?.ticket ?? null;
          const dep = waits.filter((w) => w.kind === "dependency").length;
          const cap = waits.length - dep;
          const counts = [dep ? `blocked ${dep}×` : null, cap ? `${cap}× for a place` : null].filter(Boolean).join(" · ");
          const said = [dep ? `waited on a dependency ${dep} ${dep === 1 ? "time" : "times"}` : null, cap ? `waited for a free place ${cap} ${cap === 1 ? "time" : "times"}` : null].filter(Boolean).join(" and ");
          return (
            <g key={slice}>
              <Fig id={`slice:${slice}`} name={`Slice ${slice}${ticket ? `, cell ${ticket}` : ""}: ${said} in this window`} sources={waits.map((w) => spanSource(w.span, w.kind === "capacity" ? "capacity wait" : "dependency wait"))} onActivate={() => p.onReveal(`slice:${slice}`)}>
                <Hit x={8} y={y + 2} w={s.gutter - 56} h={14} />
                <text x={10} y={y + 13} style={{ ...MONO, fontSize: 11.5, fill: INK }}>
                  {slice}
                </text>
                <text x={10} y={y + 26} style={{ ...SANS, fontSize: 10.5, fill: MUTED }}>
                  {ticket ? `${ticket}${textWidth(ticket.length + 3 + counts.length, 10.5) <= s.gutter - 16 ? ` · ${counts}` : ""}` : counts}
                </text>
                {ticket && textWidth(ticket.length + 3 + counts.length, 10.5) > s.gutter - 16 ? (
                  <text x={10} y={y + 38} style={{ ...SANS, fontSize: 10.5, fill: MUTED }}>
                    {counts}
                  </text>
                ) : null}
                <Ring x={8} y={y + 2} w={s.gutter - 56} h={14} />
              </Fig>
              <FrameFig id={`slice:${slice}`} what={`the waits of ${slice}`} frame={frameOf(waits.map((w) => w.span))} about={frameAbout(waits.map((w) => w.span))} right={s.gutter - 6} y={y + 3} onFrame={p.onFrame} />
              <line x1={s.gutter} x2={s.gutter + s.plotW} y1={y + ROW_H - 2.5} y2={y + ROW_H - 2.5} style={{ stroke: fc("grid") }} aria-hidden="true" />
              {waits.map((w, k) => (
                <WaitBand key={w.span.id} w={w} next={waits[k + 1]?.from ?? null} y={y} s={s} liveAt={liveAt} onReveal={p.onReveal} />
              ))}
              <Leaders waits={waits} y={y} s={s} onReveal={p.onReveal} />
            </g>
          );
        })}
        <LiveEdge s={s} liveAt={liveAt} h={H} />
      </svg>
    </Figures>
  );
}

/** An accessible name says how many reasons a wait recorded, never their words (free text, I-05): they are in the inspector. */
function reasonsCount(n: number): string {
  return n ? `${n} reason${n === 1 ? "" : "s"} recorded, shown in the inspector as free text.` : "";
}

function WaitBand({ w, next, y, s, liveAt, onReveal }: { w: WaitItem; next: number | null; y: number; s: ReturnType<typeof scaleOf>; liveAt: number; onReveal(ref: string, at?: number): void }) {
  if (w.from > s.to || (w.to ?? liveAt) < s.from) return null;
  const a = s.cx(w.from);
  const b = Math.max(a + 2, s.cx(w.to ?? liveAt));
  const open = w.to === null;
  const capacity = w.kind === "capacity";
  const deps = w.dependencies.map((d) => d.slice).join(", ");
  const place = capacityWords(w.span);
  const what = capacity ? `${open ? "still " : ""}${place}` : `${open ? "still waiting" : "waited"} on ${deps || "a dependency not named"}`;
  const name = capacity
    ? `${w.slice}${w.ticket ? ` (${w.ticket})` : ""} ${open ? "is" : "was"} ${place}, from ${when(w.from)}: ${durationWords(w.span, liveAt)}. ${reasonsCount(w.reasons.length)}`.trim()
    : `${w.slice} waited on ${deps || "a dependency not named"}, from ${when(w.from)}: ${durationWords(w.span, liveAt)}. ${reasonsCount(w.reasons.length)}${w.reasons.length ? " " : ""}${RELEASE_NOT_RECORDED}`;
  const short = capacity ? "for a place" : deps;
  // An end known only within bounds is said as such ("ended by"), its stop bar dashed, as on the tracks.
  const exact = w.span.end?.at !== null && w.span.end?.at !== undefined;
  return (
    <g>
      <Fig id={w.span.id} name={name} sources={[spanSource(w.span, capacity ? "capacity wait (the supervisor's record)" : "dependency wait (the scheduler's record)")]} onActivate={() => onReveal(w.span.entity, w.from)}>
        <Hit x={a} y={y + BAND_Y} w={b - a} h={BAND_H} />
        <rect className="mach-inv-hover" x={a} y={y + BAND_Y} width={b - a} height={BAND_H} style={{ fill: open ? "url(#mach-inv-wait-fade)" : fc("wait-soft"), stroke: fc("wait"), strokeWidth: 1, strokeDasharray: capacity ? "1 2" : "3 2" }} />
        {open ? null : <line x1={b} x2={b} y1={y + BAND_Y - 2} y2={y + BAND_Y + BAND_H + 2} style={{ stroke: fc("wait"), strokeWidth: 2.2, strokeDasharray: exact ? undefined : "2 1.5" }} />}
        <text x={a + 4} y={y + BAND_Y + 8} style={{ ...SANS, fontSize: 9.5, fill: INK }}>
          {textWidth(what.length, 9.5) + 8 <= b - a ? what : textWidth(short.length, 9.5) + 8 <= b - a ? short : ""}
        </text>
        <Ring x={a} y={y + BAND_Y} w={b - a} h={BAND_H} />
      </Fig>
      {/* The event that ended the wait: its own record, at its own time (the stop bar; the time when there is room). */}
      {w.ended && (next === null || s.cx(next) - b > 84) && b < s.gutter + s.plotW - 84 ? (
        <text x={b + 4} y={y + BAND_Y + 8} style={{ ...MONO, fontSize: 9, fill: SUBTLE }} aria-hidden="true">
          {exact ? "ended" : "ended by"} {when(w.ended.at)}
        </text>
      ) : null}
    </g>
  );
}

/**
 * Each named dependency's own completion on the row, once, where the data holds it: a leader, never
 * an arrow. A label that would overprint the one before it, or run past the drawing, is left to the
 * figure's hover card and accessible name.
 */
function Leaders({ waits, y, s, onReveal }: { waits: readonly WaitItem[]; y: number; s: ReturnType<typeof scaleOf>; onReveal(ref: string, at?: number): void }) {
  const ly = y + BAND_Y + BAND_H + 8;
  const right = s.gutter + s.plotW;
  const out: ReactElement[] = [];
  const leaders = rowLeaders(waits);
  // Labels: each beside its own diamond; one that would overprint the label before it joins that label
  // ("SLICE-007 merged · SLICE-002 merged") instead of being drawn over it.
  const labels = leaderLabels(
    leaders.map((l) => ({ x: s.cx(l.instant.at), text: `${l.instant.what}${l.instant.at >= s.from && l.instant.at <= s.to ? "" : ` ${when(l.instant.at)}, outside the window`}` })),
    s.gutter,
    right,
  );
  for (const l of leaders) {
    const inst = l.instant;
    const inside = inst.at >= s.from && inst.at <= s.to;
    const x = s.cx(inst.at);
    const first = l.waits[0]!;
    const names = [...new Set(l.waits.map((w) => w.slice))].join(", ");
    out.push(
      <Fig key={`${l.slice}@${inst.at}`} id={`dep:${first.span.id}:${l.slice}`} name={`${names} named ${l.slice} as a dependency${l.waits.length > 1 ? ` in ${l.waits.length} waits` : ""}; ${inst.what} at ${when(inst.at)}${inside ? "" : " (outside this window)"}. The records do not say this released the wait.`} sources={[inst.source]} onActivate={() => onReveal(inst.ref, inst.at)}>
        <Hit x={x - 5} y={ly - 2} w={10} h={12} />
        {inside
          ? l.waits.map((w) => {
              const wa = s.cx(w.from);
              const wb = Math.max(wa + 2, s.cx(w.to ?? s.to));
              return x >= wa - 1 && x <= wb + 1 ? <line key={w.span.id} x1={x} x2={x} y1={y + BAND_Y + BAND_H / 2} y2={ly + 3} style={{ stroke: fc("pass"), strokeWidth: 1, strokeDasharray: "1 2" }} aria-hidden="true" /> : null;
            })
          : null}
        <Diamond x={x} y={ly + 4} r={3.6} tone="pass" />
        <Ring x={x - 5} y={ly - 2} w={10} h={12} />
      </Fig>,
    );
  }
  for (const lb of labels)
    out.push(
      <text key={`label@${lb.x}`} x={lb.x} y={ly + 7.5} textAnchor={lb.anchor} style={{ ...SANS, fontSize: 9.5, fill: MUTED }} aria-hidden="true">
        {lb.text}
      </text>,
    );
  const taken = labels.reduce((m, lb) => Math.max(m, lb.anchor === "start" ? lb.x + textWidth(lb.text.length, 9.5) : lb.x), s.gutter);
  // A named dependency whose completion is not in the data: said once per row, where there is room.
  const missing = [...new Set(waits.flatMap((w) => w.dependencies.filter((d) => !d.instant).map((d) => d.slice)))];
  if (missing.length) {
    const text = `${missing.join(", ")}: completion not in the data`;
    const x = Math.max(taken + 8, s.cx(waits.find((w) => w.dependencies.some((d) => !d.instant))!.from) + 4);
    if (x + textWidth(text.length, 9.5) <= right)
      out.push(
        <text key="missing" x={x} y={ly + 9} style={{ ...SANS, fontSize: 9.5, fill: SUBTLE, fontStyle: "italic" }} aria-hidden="true">
          {text}
        </text>,
      );
  }
  return <>{out}</>;
}
