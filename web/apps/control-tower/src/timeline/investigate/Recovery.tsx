/**
 * Lens 5, recovery and interruption: interrupted executions, executions whose outcome is not known,
 * visits that ended without an exit record, visits stopped and taken up again, and the supervisor's
 * recoveries. An unresolved operation is drawn unresolved (the query ring, "outcome not known"), never
 * as completed; the dotted bridge to "taken up again" is drawn only when a later record shows it.
 */
import { useMemo } from "react";
import { fc } from "@mach/ui";
import { durationWords } from "../render";
import type { BodyProps } from "./body";
import { Caption, Diamond, Empty, Fig, Figures, Hit, LiveEdge, Mark, MONO, MUTED, Ring, SANS, scaleOf, SUBTLE, INK, when, type Scale } from "./figures";
import { markSource, recoveryItems, type RecoveryItem } from "./model";

const ROW_H = 30;

const KIND_WORDS: Readonly<Record<RecoveryItem["kind"], string>> = {
  interrupted: "interrupted",
  unknown: "outcome not known",
  "no-exit": "ended without an exit record",
  "taken-up": "stopped and taken up again",
};

export function RecoveryBody(p: BodyProps) {
  const liveAt = p.viewport.liveAt;
  const s = scaleOf(p.viewport, p.width);
  const { items, looseRecoveries } = useMemo(() => recoveryItems(p.spans, p.marks, liveAt), [p.spans, p.marks, liveAt]);

  if (p.status === "loading") return <Caption>Reading interruptions and recoveries of this window…</Caption>;
  if (items.length === 0 && looseRecoveries.length === 0) return <Empty text="No interruption or recovery in this window" detail="Executions and visits here all ended with a recorded exit." onWiden={p.onWiden} />;

  const rows = items.length + (looseRecoveries.length ? 1 : 0);
  const H = rows * ROW_H + 4;
  return (
    <Figures label="Interruptions and recoveries">
      <Caption>An operation whose outcome is not known stays unresolved. “Taken up again” is said only where a later record shows the work resumed.</Caption>
      <svg width={p.width} height={H} role="presentation" style={{ display: "block" }}>
        <line x1={s.gutter - 0.5} x2={s.gutter - 0.5} y1={0} y2={H} style={{ stroke: "var(--mach-line)" }} aria-hidden="true" />
        {items.map((it, i) => (
          <ItemRow key={it.span.id} it={it} y={i * ROW_H} s={s} liveAt={liveAt} onReveal={p.onReveal} />
        ))}
        {looseRecoveries.length ? (
          <g>
            <text x={10} y={items.length * ROW_H + 18} style={{ ...SANS, fontSize: 10.5, fill: MUTED }}>
              other recoveries
            </text>
            {looseRecoveries.map((m) => (
              <Fig key={m.id} id={m.id} name={`${m.label} At ${when(m.at)}.`} sources={[markSource(m, "recovery mark")]} onActivate={() => p.onReveal(m.entity ?? "actor:supervisor", m.at)}>
                <Hit x={s.cx(m.at) - 5} y={items.length * ROW_H + 9} w={10} h={10} />
                <Diamond x={s.cx(m.at)} y={items.length * ROW_H + 14} r={4.5} tone="halt" open />
                <Ring x={s.cx(m.at) - 5} y={items.length * ROW_H + 9} w={10} h={10} />
              </Fig>
            ))}
          </g>
        ) : null}
        <LiveEdge s={s} liveAt={liveAt} h={H} />
      </svg>
    </Figures>
  );
}

function ItemRow({ it, y, s, liveAt, onReveal }: { it: RecoveryItem; y: number; s: Scale; liveAt: number; onReveal(ref: string, at?: number): void }) {
  const mid = y + 11;
  const isExec = it.span.kind === "execution";
  const a = it.from !== null ? s.cx(it.from) : null;
  const stop = it.stoppedAt !== null ? s.cx(it.stoppedAt) : null;
  const visitEnd = it.kind === "taken-up" ? s.cx(it.span.end?.at ?? liveAt) : null;
  const word = KIND_WORDS[it.kind];
  const name = `${it.label}: ${word}${it.stoppedAt !== null ? ` at ${when(it.stoppedAt)}` : ""}; ${durationWords(it.span, liveAt)}.${it.resumed ? ` ${it.resumed.words[0]!.toUpperCase()}${it.resumed.words.slice(1)} at ${when(it.resumed.at)}.` : it.kind === "unknown" ? " Nothing later in the records takes it up again." : " Not taken up again in the records held."}`;
  return (
    <g>
      <text x={10} y={y + 14} style={{ ...MONO, fontSize: 10.5, fill: INK }} aria-hidden="true">
        {it.label}
      </text>
      <text x={10} y={y + 26} style={{ ...SANS, fontSize: 10, fill: it.kind === "interrupted" ? fc("halt") : MUTED }} aria-hidden="true">
        {word}
      </text>
      <line x1={s.gutter} x2={s.gutter + s.plotW} y1={y + ROW_H - 0.5} y2={y + ROW_H - 0.5} style={{ stroke: fc("grid") }} aria-hidden="true" />
      <Fig id={it.span.id} name={name} sources={[...it.sources, ...(it.resumed ? [it.resumed.source] : [])]} onActivate={() => onReveal(it.span.entity, it.stoppedAt ?? it.from ?? undefined)}>
        {a !== null && stop !== null ? (
          <>
            <Hit x={a} y={mid - 5} w={Math.max(2, (visitEnd ?? stop) - a)} h={10} />
            {isExec ? (
              <g className="mach-inv-hover">
                <rect x={a} y={mid - 2} width={Math.max(1, stop - a)} height={4} style={{ fill: fc("ink-soft") }} />
                <path d={`M${a} ${mid - 5}V${mid + 5}`} style={{ stroke: fc("ink-soft"), strokeWidth: 1.4 }} />
              </g>
            ) : (
              <rect className="mach-inv-hover" x={a} y={mid - 4} width={Math.max(1, (visitEnd ?? stop) - a)} height={8} rx={1} style={{ fill: fc("plate-top"), stroke: fc("ink-soft"), strokeWidth: 1, strokeDasharray: it.kind === "no-exit" ? "3 2" : undefined }} />
            )}
            {it.kind === "taken-up" ? <path d={`M${stop} ${mid - 6}V${mid + 6}`} style={{ stroke: fc("halt"), strokeWidth: 2 }} aria-hidden="true" /> : <Mark x={stop} y={mid} state={it.kind === "interrupted" ? "interrupted" : "unknown"} r={5.5} />}
            <Ring x={a} y={mid - 5} w={Math.max(2, (visitEnd ?? stop) - a)} h={10} />
          </>
        ) : stop !== null ? (
          <>
            <Hit x={stop - 6} y={mid - 6} w={12} h={12} />
            <Mark x={stop} y={mid} state={it.kind === "interrupted" ? "interrupted" : "unknown"} r={5.5} />
          </>
        ) : null}
      </Fig>
      {stop !== null && it.kind !== "taken-up" ? (
        <text x={stop + 8} y={mid + 13} style={{ ...SANS, fontSize: 10, fill: it.kind === "interrupted" ? fc("halt") : MUTED }} aria-hidden="true">
          {it.kind === "unknown" ? "outcome not known" : it.kind === "no-exit" ? "no exit recorded" : "interrupted"}
        </text>
      ) : null}
      {/* Recoveries the supervisor recorded for this item. */}
      {it.recoveries.map((m) => (
        <Fig key={m.id} id={m.id} name={`${m.label} At ${when(m.at)}.`} sources={[markSource(m, "recovery mark")]} onActivate={() => onReveal(m.entity ?? it.span.entity, m.at)}>
          <Hit x={s.cx(m.at) - 5} y={mid - 5} w={10} h={10} />
          <Diamond x={s.cx(m.at)} y={mid} r={4} tone="halt" open />
          <Ring x={s.cx(m.at) - 5} y={mid - 5} w={10} h={10} />
        </Fig>
      ))}
      {/* Taken up again: a dotted bridge to the later record, only when one exists. */}
      {it.resumed && it.kind !== "taken-up" && stop !== null ? (
        <Fig id={`resumed:${it.span.id}`} name={`${it.label}: ${it.resumed.words} at ${when(it.resumed.at)}, as that record shows`} sources={[it.resumed.source]} onActivate={() => onReveal(it.resumed!.ref, it.resumed!.at)}>
          {(() => {
            const rx = s.cx(it.resumed.at);
            return (
              <>
                <Hit x={stop} y={mid - 4} w={Math.max(4, rx - stop)} h={8} />
                <line x1={stop + 6} x2={rx} y1={mid} y2={mid} style={{ stroke: fc("halt"), strokeWidth: 1.2, strokeDasharray: "1 3", strokeLinecap: "round" }} />
                <path d={`M${rx} ${mid - 5}V${mid + 5}`} style={{ stroke: fc("live"), strokeWidth: 1.6 }} />
                <text x={rx + 5} y={mid + 3.5} style={{ ...SANS, fontSize: 10, fill: INK }}>
                  {it.resumed.words}
                </text>
                <Ring x={stop} y={mid - 4} w={Math.max(4, rx - stop)} h={8} />
              </>
            );
          })()}
        </Fig>
      ) : null}
      {it.kind === "taken-up" && visitEnd !== null ? (
        <text x={visitEnd + 6} y={mid + 3.5} style={{ ...SANS, fontSize: 10, fill: SUBTLE }} aria-hidden="true">
          taken up again in the same visit
        </text>
      ) : null}
    </g>
  );
}
