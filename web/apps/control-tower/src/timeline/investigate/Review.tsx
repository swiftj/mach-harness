/**
 * Lens 4, review and human intervention: per review round the seats as parallel rows, each seat's
 * span and its vote at its recorded time, the panel's decision as a rule across the seats (a security
 * veto named as such only when the decision records it), and a person's gate after it as a terracotta
 * band. A person's approval of the code and the authorization to merge are different records with
 * different marks; when only one is recorded the other is said to be not recorded.
 */
import { useMemo } from "react";
import { fc, StationSymbol } from "@mach/ui";
import { durationWords } from "../render";
import type { BodyProps } from "./body";
import { Caption, Diamond, Empty, FadeDefs, Fig, Figures, FrameFig, Hit, HumanTriangle, LiveEdge, Mark, MONO, MUTED, Ring, SANS, scaleOf, SUBTLE, INK, when, type Scale } from "./figures";
import { frameAbout, frameOf, markSource, reviewCells, type CellReview, type ReviewRound } from "./model";
import type { TimeWindow } from "../contract";

const HEAD_H = 16;
const SEAT_H = 15;
const AFTER_H = 22;

const voteTone = (v: string | null): { tone: "pass" | "fail" | "wait" | "ink"; cross: boolean; open: boolean } =>
  v === "approved" ? { tone: "pass", cross: false, open: false } : v === "rejected" ? { tone: "fail", cross: true, open: false } : v === "escalated" ? { tone: "wait", cross: false, open: true } : { tone: "ink", cross: false, open: true };

export function ReviewBody(p: BodyProps) {
  const liveAt = p.viewport.liveAt;
  const s = scaleOf(p.viewport, p.width);
  const cells = useMemo(() => reviewCells(p.spans, p.marks, liveAt), [p.spans, p.marks, liveAt]);
  const shown = p.selectedTicket ? cells.filter((c) => c.ticket === p.selectedTicket) : cells;

  if (p.status === "loading") return <Caption>Reading review seats, decisions and approvals of this window…</Caption>;
  if (shown.length === 0) return <Empty text={p.selectedTicket ? `No review round for ${p.selectedTicket} in this window` : "No review round in this window"} onWiden={p.onWiden} />;

  return (
    <Figures label="Review rounds and a person's decisions">
      <Caption>Seats vote at their recorded times; the rule across them is the panel's decision. A person's approval of the code and the authorization to merge are separate records.</Caption>
      {shown.map((c) => (
        <CellDrawing key={c.ticket} c={c} s={s} width={p.width} liveAt={liveAt} onReveal={p.onReveal} onFrame={p.onFrame} />
      ))}
    </Figures>
  );
}

function CellDrawing({ c, s, width, liveAt, onReveal, onFrame }: { c: CellReview; s: Scale; width: number; liveAt: number; onReveal(ref: string, at?: number): void; onFrame(w: TimeWindow, about: readonly string[]): void }) {
  const heights = c.rounds.map((r) => HEAD_H + Math.max(1, r.seats.length) * SEAT_H + 6);
  const tops = heights.map((_, i) => heights.slice(0, i).reduce((a, b) => a + b, 0));
  const y = heights.reduce((a, b) => a + b, 0);
  const H = y + AFTER_H + c.notes.length * 13 + 6;
  return (
    <svg width={width} height={H} role="presentation" style={{ display: "block" }} className="border-b border-line">
      <FadeDefs id={`mach-inv-human-${c.ticket}`} color="var(--mach-factory-human-soft)" />
      <line x1={s.gutter - 0.5} x2={s.gutter - 0.5} y1={0} y2={H} style={{ stroke: "var(--mach-line)" }} aria-hidden="true" />
      {c.rounds.map((r, i) => (
        <RoundDrawing key={r.round} r={r} top={tops[i]!} s={s} liveAt={liveAt} onReveal={onReveal} />
      ))}
      <AfterReview c={c} top={y} s={s} liveAt={liveAt} onReveal={onReveal} />
      <FrameFig id={`review:${c.ticket}`} what={`the review of ${c.ticket}`} frame={reviewFrame(c)} about={frameAbout(c.rounds.flatMap((r) => r.seats.map((x) => x.span)))} right={s.gutter - 6} y={y + 4} onFrame={onFrame} />
      {c.notes.map((n, i) => (
        <text key={n} x={s.gutter + 6} y={y + AFTER_H + 10 + i * 13} style={{ ...SANS, fontSize: 10.5, fill: SUBTLE, fontStyle: "italic" }}>
          {n}
        </text>
      ))}
      <LiveEdge s={s} liveAt={liveAt} h={H} />
    </svg>
  );
}

function RoundDrawing({ r, top, s, liveAt, onReveal }: { r: ReviewRound; top: number; s: Scale; liveAt: number; onReveal(ref: string, at?: number): void }) {
  const seatsTop = top + HEAD_H;
  const seatsBottom = seatsTop + Math.max(1, r.seats.length) * SEAT_H;
  const d = r.decision;
  const dTone = d ? voteTone(d.verdict === "awaiting-human" ? "approved" : d.verdict) : null;
  const decisionWord = d ? (r.securityVeto ? "rejected, security veto" : d.verdict.replace(/-/g, " ")) : "not decided by the live edge";
  return (
    <g>
      <Fig id={r.ref} name={`${r.ticket}, review round ${r.round}: ${decisionWord}${d ? ` at ${when(d.at)}` : ""}`} sources={d ? [markSource(d.mark, "the panel's decision")] : []} onActivate={() => onReveal(r.ref, d?.at)}>
        <Hit x={8} y={top + 2} w={s.gutter - 20} h={13} />
        <text x={10} y={top + 13} style={{ ...MONO, fontSize: 11, fill: INK }}>
          {r.ticket}
          <tspan style={{ ...SANS, fill: MUTED, fontWeight: 600 }}> · Round {r.round}</tspan>
        </text>
        <Ring x={8} y={top + 2} w={s.gutter - 20} h={13} />
      </Fig>
      {r.seats.map((seat, i) => {
        const sy = seatsTop + i * SEAT_H + SEAT_H / 2;
        const a = seat.from !== null ? s.cx(seat.from) : null;
        const b = seat.voteAt !== null ? s.cx(seat.voteAt) : seat.from !== null ? s.cx(liveAt) : null;
        const tone = voteTone(seat.vote);
        const name = `${r.ticket}, round ${r.round}, ${seat.seat} seat: ${seat.vote ? `voted ${seat.vote} at ${when(seat.voteAt!)}` : "no vote recorded by the live edge"}${seat.span ? `; ${durationWords(seat.span, liveAt)}` : ""}`;
        return (
          <g key={seat.seat}>
            <text x={22} y={sy + 3.5} style={{ ...SANS, fontSize: 10.5, fill: MUTED }} aria-hidden="true">
              {seat.seat}
            </text>
            <Fig id={seat.ref} name={name} sources={seat.sources} onActivate={() => onReveal(seat.ref, seat.voteAt ?? seat.from ?? undefined)}>
              {a !== null && b !== null ? (
                <>
                  <Hit x={a} y={sy - 4} w={Math.max(2, b - a)} h={8} />
                  <line className="mach-inv-hover" x1={a} x2={b} y1={sy} y2={sy} style={{ stroke: fc("ink-soft"), strokeWidth: 3, strokeLinecap: "butt" }} />
                </>
              ) : null}
              {seat.voteAt !== null ? <Diamond x={s.cx(seat.voteAt)} y={sy} r={4.6} tone={tone.tone} cross={tone.cross} open={tone.open} /> : null}
              <Ring x={(a ?? s.cx(seat.voteAt ?? liveAt)) - 4} y={sy - 5} w={Math.max(8, (b ?? 0) - (a ?? 0) + 8)} h={10} />
            </Fig>
          </g>
        );
      })}
      {/* The decision: a rule across the seats, at its recorded time. */}
      {d ? (
        <Fig id={`decision:${r.ref}`} name={`Decision of round ${r.round} for ${r.ticket}: ${decisionWord} at ${when(d.at)}, as the decision record says`} sources={[markSource(d.mark, "the panel's decision"), ...(r.securityVeto && r.securityVeto !== d.mark ? [markSource(r.securityVeto, "the recorded security veto")] : [])]} onActivate={() => onReveal(r.ref, d.at)}>
          <Hit x={s.cx(d.at) - 4} y={seatsTop - 4} w={8} h={seatsBottom - seatsTop + 8} />
          <line className="mach-inv-hover" x1={s.cx(d.at)} x2={s.cx(d.at)} y1={seatsTop - 2} y2={seatsBottom} style={{ stroke: dTone!.tone === "ink" ? fc("ink-soft") : fc(dTone!.tone), strokeWidth: 1.4 }} />
          {r.securityVeto ? <Mark x={s.cx(d.at)} y={top + 8} state="blocked" r={5.5} /> : <Diamond x={s.cx(d.at)} y={top + 8} r={5} tone={dTone!.tone} cross={dTone!.cross} />}
          <text x={s.cx(d.at) + 9} y={top + 11.5} style={{ ...SANS, fontSize: 10.5, fill: r.securityVeto || dTone!.tone === "fail" ? fc("fail") : dTone!.tone === "pass" ? fc("pass") : MUTED, fontWeight: 600 }}>
            {r.securityVeto ? "Rejected: security veto" : d.verdict === "awaiting-human" ? "Approved, a person must approve" : `${d.verdict[0]!.toUpperCase()}${d.verdict.slice(1).replace(/-/g, " ")}`}
          </text>
          <Ring x={s.cx(d.at) - 5} y={seatsTop - 4} w={10} h={seatsBottom - seatsTop + 8} />
        </Fig>
      ) : null}
      {/* A person's gate after the decision: the terracotta band from required to approved. */}
      {r.human ? (
        <Fig
          id={`human:${r.ref}`}
          name={`A person's approval required after round ${r.round} from ${when(r.human.from)}${r.human.to !== null ? ` to ${when(r.human.to)}` : ", still waiting at the live edge"}${r.human.approved ? `; a person approved the code at ${when(r.human.approved.at)}` : ""}`}
          sources={[...r.human.sources, ...(r.human.approved ? [r.human.approved.source] : [])]}
          onActivate={() => onReveal(r.human!.ref, r.human!.from)}
        >
          {(() => {
            const a = s.cx(r.human.from);
            const b = Math.max(a + 3, s.cx(r.human.to ?? liveAt));
            const hy = seatsBottom + 1;
            return (
              <>
                <Hit x={a} y={hy - 2} w={b - a} h={6} />
                <rect className="mach-inv-hover" x={a} y={hy - 1} width={b - a} height={5} style={{ fill: r.human.to === null ? `url(#mach-inv-human-${r.ticket})` : fc("human-soft"), stroke: fc("human"), strokeWidth: 1 }} />
                <HumanTriangle x={a} y={hy - 5} s={4.5} />
                <Ring x={a} y={hy - 2} w={b - a} h={6} />
              </>
            );
          })()}
        </Fig>
      ) : null}
    </g>
  );
}

/** One cell's review, padded: its seats, decisions, a person's gate and the merge. */
function reviewFrame(c: CellReview): TimeWindow | null {
  const spans = c.rounds.flatMap((r) => r.seats.map((s) => s.span).filter((x): x is NonNullable<typeof x> => x !== null));
  const base = frameOf(spans);
  const ts = [...c.rounds.flatMap((r) => [r.decision?.at, r.human?.from, r.human?.to]), c.codeApproval?.at, c.merge?.at].filter((t): t is number => typeof t === "number");
  if (!base && !ts.length) return null;
  const from = Math.min(base?.from ?? Infinity, ...ts);
  const to = Math.max(base?.to ?? -Infinity, ...ts);
  const pad = Math.max(60_000, (to - from) * 0.05);
  return base && ts.every((t) => t >= base.from && t <= base.to) ? base : { from: from - pad, to: to + pad };
}

/** Two different records, two different marks: a person approved the code; the merge was authorized. */
function AfterReview({ c, top, s, liveAt, onReveal }: { c: CellReview; top: number; s: Scale; liveAt: number; onReveal(ref: string, at?: number): void }) {
  const y = top + AFTER_H / 2;
  const ap = c.codeApproval;
  const mg = c.merge;
  const mergeWords = mg ? (mg.authority === "policy" ? "merge authorized by policy" : mg.authority === "person" ? "merged by a person" : "merged; authorization not recorded") : null;
  return (
    <g>
      <text x={10} y={y + 3.5} style={{ ...SANS, fontSize: 10.5, fill: MUTED }} aria-hidden="true">
        after review
      </text>
      <line x1={s.gutter} x2={s.gutter + s.plotW} y1={top + 1} y2={top + 1} style={{ stroke: fc("grid") }} aria-hidden="true" />
      {ap ? (
        <Fig id={`approval:${c.ticket}`} name={`A person approved the code for ${c.ticket} at ${when(ap.at)}, as the approval record says`} sources={[ap.source]} onActivate={() => onReveal(ap.ref, ap.at)}>
          <Hit x={s.cx(ap.at) - 6} y={y - 6} w={12} h={12} />
          <Mark x={s.cx(ap.at)} y={y} state="succeeded" r={5} />
          <circle cx={s.cx(ap.at)} cy={y} r={6.5} style={{ fill: "none", stroke: fc("human"), strokeWidth: 1.4 }} aria-hidden="true" />
          <text x={s.cx(ap.at) - 11} y={y + 3.5} textAnchor="end" style={{ ...SANS, fontSize: 10.5, fill: fc("human") }}>
            a person approved the code
          </text>
          <Ring x={s.cx(ap.at) - 7} y={y - 7} w={14} h={14} />
        </Fig>
      ) : null}
      {mg ? (
        <Fig id={`merge:${c.ticket}`} name={`${c.ticket}: ${mergeWords} at ${when(mg.at)}`} sources={[mg.source]} onActivate={() => onReveal(mg.ref, mg.at)}>
          <Hit x={s.cx(mg.at) - 7} y={y - 7} w={14} h={14} />
          <rect x={s.cx(mg.at) - 7} y={y - 7} width={14} height={14} rx={2} style={{ fill: fc("ground"), stroke: fc("route"), strokeWidth: 1.2 }} aria-hidden="true" />
          <StationSymbol kind="merge" size={12} x={s.cx(mg.at)} y={y} color={fc("route")} strokeWidth={1.4} />
          <text x={s.cx(mg.at) + 11} y={y + 3.5} style={{ ...SANS, fontSize: 10.5, fill: INK }}>
            {mergeWords}
          </text>
          <Ring x={s.cx(mg.at) - 8} y={y - 8} w={16} h={16} />
        </Fig>
      ) : null}
      {!ap && !mg ? (
        <text x={s.gutter + 6} y={y + 3.5} style={{ ...SANS, fontSize: 10.5, fill: SUBTLE }}>
          Neither a person's approval of the code nor a merge is recorded for this cell{liveAt ? "" : ""}.
        </text>
      ) : null}
    </g>
  );
}
