/**
 * Lens 3, dependency waits: one row per slice, each wait as a dashed band with its stop bar where it
 * ended, the dependencies it names, and those dependencies' own completion or integration instants as
 * leaders down to the row when the data holds them. No arrow of cause is drawn: the records name the
 * dependency; they do not say which event released the wait.
 */
import { useMemo } from "react";
import { fc } from "@mach/ui";
import { durationWords } from "../render";
import type { BodyProps } from "./body";
import { Caption, Diamond, Empty, FadeDefs, Fig, Figures, Hit, LiveEdge, MONO, MUTED, Ring, SANS, scaleOf, SUBTLE, INK, when } from "./figures";
import { RELEASE_NOT_RECORDED, spanSource, waitItems, type WaitItem } from "./model";

const ROW_H = 40;
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

  if (p.status === "loading") return <Caption>Reading the dependency waits of this window…</Caption>;
  if (rows.length === 0) return <Empty text="No slice waited on a dependency in this window" detail="Waits for capacity and for a person are in the other lenses." onWiden={p.onWiden} />;

  const H = rows.length * ROW_H + 6;
  return (
    <Figures label="Dependency waits">
      <Caption>{RELEASE_NOT_RECORDED} A leader marks when a named dependency was itself integrated, where the data holds it.</Caption>
      <svg width={p.width} height={H} role="presentation" style={{ display: "block" }}>
        <FadeDefs id="mach-inv-wait-fade" color="var(--mach-factory-wait-soft)" />
        <line x1={s.gutter - 0.5} x2={s.gutter - 0.5} y1={0} y2={H} style={{ stroke: "var(--mach-line)" }} aria-hidden="true" />
        {rows.map(([slice, waits], i) => {
          const y = 2 + i * ROW_H;
          const ticket = waits.find((w) => w.ticket)?.ticket ?? null;
          return (
            <g key={slice}>
              <Fig id={`slice:${slice}`} name={`Slice ${slice}${ticket ? `, cell ${ticket}` : ""}: waited on a dependency ${waits.length} ${waits.length === 1 ? "time" : "times"} in this window`} sources={waits.map((w) => spanSource(w.span, "dependency wait"))} onActivate={() => p.onReveal(`slice:${slice}`)}>
                <Hit x={8} y={y + 2} w={s.gutter - 20} h={14} />
                <text x={10} y={y + 14} style={{ ...MONO, fontSize: 11.5, fill: INK }}>
                  {slice}
                </text>
                <text x={10} y={y + 28} style={{ ...SANS, fontSize: 10.5, fill: MUTED }}>
                  {ticket ? `${ticket} · ` : ""}blocked {waits.length}×
                </text>
                <Ring x={8} y={y + 2} w={s.gutter - 20} h={14} />
              </Fig>
              <line x1={s.gutter} x2={s.gutter + s.plotW} y1={y + ROW_H - 2.5} y2={y + ROW_H - 2.5} style={{ stroke: fc("grid") }} aria-hidden="true" />
              {waits.map((w, k) => (
                <WaitBand key={w.span.id} w={w} next={waits[k + 1]?.from ?? null} y={y} s={s} liveAt={liveAt} onReveal={p.onReveal} />
              ))}
            </g>
          );
        })}
        <LiveEdge s={s} liveAt={liveAt} h={H} />
      </svg>
    </Figures>
  );
}

function WaitBand({ w, next, y, s, liveAt, onReveal }: { w: WaitItem; next: number | null; y: number; s: ReturnType<typeof scaleOf>; liveAt: number; onReveal(ref: string, at?: number): void }) {
  if (w.from > s.to || (w.to ?? liveAt) < s.from) return null;
  const a = s.cx(w.from);
  const b = Math.max(a + 2, s.cx(w.to ?? liveAt));
  const open = w.to === null;
  const deps = w.dependencies.map((d) => d.slice).join(", ");
  const name = `${w.slice} waited on ${deps || "a dependency not named"}, from ${when(w.from)}: ${durationWords(w.span, liveAt)}. ${w.reasons.length ? `Reasons recorded: ${w.reasons.join("; ")}. ` : ""}${RELEASE_NOT_RECORDED}`;
  return (
    <g>
      <Fig id={w.span.id} name={name} sources={[spanSource(w.span, "dependency wait (the scheduler's record)")]} onActivate={() => onReveal(w.span.entity, w.from)}>
        <Hit x={a} y={y + BAND_Y} w={b - a} h={BAND_H} />
        <rect className="mach-inv-hover" x={a} y={y + BAND_Y} width={b - a} height={BAND_H} style={{ fill: open ? "url(#mach-inv-wait-fade)" : fc("wait-soft"), stroke: fc("wait"), strokeWidth: 1, strokeDasharray: "3 2" }} />
        {open ? null : <line x1={b} x2={b} y1={y + BAND_Y - 2} y2={y + BAND_Y + BAND_H + 2} style={{ stroke: fc("wait"), strokeWidth: 2.2 }} />}
        <text x={a + 4} y={y + BAND_Y + 8} style={{ ...SANS, fontSize: 9.5, fill: INK }}>
          {b - a > 150 ? `${open ? "still waiting" : "waited"} on ${deps || "a dependency not named"}` : b - a > 50 ? deps : ""}
        </text>
        <Ring x={a} y={y + BAND_Y} w={b - a} h={BAND_H} />
      </Fig>
      {/* The event that ended the wait: its own record, at its own time (the stop bar; the time when there is room). */}
      {w.ended && (next === null || s.cx(next) - b > 84) && b < s.gutter + s.plotW - 84 ? (
        <text x={b + 4} y={y + BAND_Y + 8} style={{ ...MONO, fontSize: 9, fill: SUBTLE }} aria-hidden="true">
          ended {when(w.ended.at)}
        </text>
      ) : null}
      {/* Each named dependency's own completion, where the data holds it: a leader, never an arrow. */}
      {w.dependencies.map((d, k) => {
        const ly = y + BAND_Y + BAND_H + 8 + k * 0;
        if (!d.instant) {
          return (
            <text key={d.slice} x={a + 4 + k * 150} y={ly + 9} style={{ ...SANS, fontSize: 9.5, fill: SUBTLE, fontStyle: "italic" }} aria-hidden="true">
              {d.slice}: completion not in the data
            </text>
          );
        }
        const inst = d.instant;
        const inside = inst.at >= s.from && inst.at <= s.to;
        const x = s.cx(inst.at);
        return (
          <Fig key={d.slice} id={`dep:${w.span.id}:${d.slice}`} name={`${w.slice} named ${d.slice} as a dependency; ${inst.what} at ${when(inst.at)}${inside ? "" : " (outside this window)"}. The records do not say this released the wait.`} sources={[inst.source]} onActivate={() => onReveal(inst.ref, inst.at)}>
            <Hit x={x - 5} y={ly - 2} w={10} h={12} />
            {inside ? <line x1={x} x2={x} y1={y + BAND_Y + BAND_H / 2} y2={ly + 3} style={{ stroke: fc("pass"), strokeWidth: 1, strokeDasharray: "1 2" }} aria-hidden="true" /> : null}
            <Diamond x={x} y={ly + 4} r={3.6} tone="pass" />
            <text x={x + (x > s.gutter + s.plotW - 120 ? -6 : 6)} y={ly + 7.5} textAnchor={x > s.gutter + s.plotW - 120 ? "end" : "start"} style={{ ...SANS, fontSize: 9.5, fill: MUTED }}>
              {inst.what}
              {inside ? null : ` ${when(inst.at)}, outside the window`}
            </text>
            <Ring x={x - 5} y={ly - 2} w={10} h={12} />
          </Fig>
        );
      })}
    </g>
  );
}
