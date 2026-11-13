/**
 * Lens 1, verification failures and retries: per cell a ladder, one rung per pass through build and
 * verify in time order (the build or revise visit, the verification, the gate verdict, what followed).
 * Review rounds are brackets above the ladder and execution attempts a rail below it, each labelled;
 * they overlap freely and neither is nested in the other. Two passes chosen (click, then shift-click;
 * Enter, then Shift+Enter) are compared on a shared relative time axis.
 */
import { useMemo, useState } from "react";
import { fc } from "@mach/ui";
import { duration } from "../../shell/time";
import type { TimelineSpan } from "../contract";
import { describeSpan, durationWords } from "../render";
import type { BodyProps } from "./body";
import { Caption, Diamond, Empty, Fig, Figures, Hit, Mark, MONO, MUTED, Ring, SANS, scaleOf, SUBTLE, INK, when } from "./figures";
import { compareRungs, endBy, retryLadders, rungTimings, spanSource, startAt, verdictWords, type Ladder, type Rung, type RungVerdict } from "./model";

const BLOCK = 112;
const CHIP_Y = 40;
const CHIP_H = 14;
const RAIL_Y = 82;

const partWord = (span: TimelineSpan, part: "build" | "verify") => (part === "verify" ? "Verify" : span.attrs.action === "revise" ? "Revise" : "Build");

/** A visit's length in a few characters, the way it is known. */
function shortLength(span: TimelineSpan, liveAt: number): string {
  const a = startAt(span);
  const b = endBy(span, liveAt);
  if (a === null) return "start not known";
  if (b === null) return `running ${duration(liveAt - a)}`;
  const r = span.end?.reason;
  if (r === "interrupted" || r === "superseded") return r;
  const ms = span.duration.ms ?? b - a;
  return span.duration.basis === "measured" ? duration(ms) : `≈ ${duration(ms)}`;
}

function verdictLook(v: RungVerdict): { tone: "pass" | "fail" | "wait" | "ink"; open: boolean; cross: boolean } {
  switch (v.kind) {
    case "failed":
      return { tone: "fail", open: false, cross: true };
    case "refused":
      return { tone: "fail", open: true, cross: true };
    case "overridden":
      return { tone: "wait", open: true, cross: false };
    case "passed":
      return { tone: "pass", open: false, cross: false };
    default:
      return { tone: "ink", open: true, cross: false };
  }
}

const rungKey = (r: Rung) => `${r.ticket}#${r.index}`;

export function RetriesBody(p: BodyProps) {
  const liveAt = p.viewport.liveAt;
  const { ladders, more } = useMemo(() => retryLadders(p.spans, p.marks, liveAt, p.selectedTicket), [p.spans, p.marks, liveAt, p.selectedTicket]);
  const [chosen, setChosen] = useState<string[]>([]);
  const s = scaleOf(p.viewport, p.width);

  if (p.status === "loading") return <Caption>Reading the station visits and gate verdicts of this window…</Caption>;
  if (ladders.length === 0)
    return (
      <Empty
        text={p.selectedTicket ? `No build or verification visit for ${p.selectedTicket} in this window` : "No failed verification or retry in this window"}
        detail={p.selectedTicket ? "Its visits may lie outside the window." : "Cells with one clean pass through build and verify are not listed."}
        onWiden={p.onWiden}
      />
    );

  const all = ladders.flatMap((l) => l.rungs.map((r) => ({ l, r })));
  const pick = (r: Rung, shift: boolean) => {
    const k = rungKey(r);
    setChosen((c) => (shift ? (c.includes(k) ? c.filter((x) => x !== k) : [...c.filter((x) => x !== k)].slice(-1).concat(k)) : c.length === 1 && c[0] === k ? [] : [k]));
  };
  const chosenRungs = chosen.map((k) => all.find((x) => rungKey(x.r) === k)).filter((x): x is { l: Ladder; r: Rung } => !!x);

  return (
    <Figures label="Passes through build and verify">
      <Caption>
        One rung per pass through build and verify, in time order; review rounds are bracketed above, execution attempts run below.{" "}
        {chosenRungs.length === 1 ? `Pass ${chosenRungs[0]!.r.index} of ${chosenRungs[0]!.r.ticket} chosen: Shift-click (Shift+Enter) a second pass to compare.` : chosenRungs.length === 2 ? "Comparing passes A and B." : "Choose a pass, then Shift-click (Shift+Enter) a second to compare them."}
        {more ? ` ${more} more cells with retries are in this window: select one to see it.` : ""}
      </Caption>
      {chosenRungs.length === 2 ? <Comparison a={chosenRungs[0]!} b={chosenRungs[1]!} width={p.width} gutter={s.gutter} liveAt={liveAt} onReveal={p.onReveal} /> : null}
      {ladders.map((l) => (
        <LadderDrawing key={l.ticket} ladder={l} width={p.width} gutter={s.gutter} liveAt={liveAt} chosen={chosen} onPick={pick} onReveal={p.onReveal} />
      ))}
    </Figures>
  );
}

function LadderDrawing({ ladder, width, gutter, liveAt, chosen, onPick, onReveal }: { ladder: Ladder; width: number; gutter: number; liveAt: number; chosen: readonly string[]; onPick(r: Rung, shift: boolean): void; onReveal(ref: string, at?: number): void }) {
  const n = ladder.rungs.length;
  const avail = width - gutter - 20;
  const rungW = Math.max(130, Math.min(300, avail / n));
  const x0 = gutter + 8;
  const rx = (i: number) => x0 + i * rungW;
  const slotL = (slot: number) => rx(Math.floor(slot / 2)) + (slot % 2 === 0 ? 4 : rungW * 0.41);
  const slotR = (slot: number) => rx(Math.floor(slot / 2)) + (slot % 2 === 0 ? rungW * 0.37 : rungW * 0.7);
  const drawW = Math.max(width, x0 + n * rungW + 12);
  const failed = ladder.rungs.filter((r) => r.verdict.kind === "failed" || r.verdict.kind === "refused").length;

  const chip = (r: Rung, span: TimelineSpan, slot: number, word: string) => {
    const a = slotL(slot);
    const b = slotR(slot);
    const open = endBy(span, liveAt) === null;
    const inferred = span.end?.basis === "inferred";
    const at = startAt(span);
    const name = `Pass ${r.index}, ${word.toLowerCase()}: ${describeSpan(span, liveAt)} Started ${at !== null ? when(at) : "at a time not known"}${span.end?.basis === "inferred" ? ", end placed by rule" : ""}.`;
    return (
      <Fig
        key={span.id}
        id={span.id}
        name={name}
        sources={[spanSource(span, `${word.toLowerCase()} visit`)]}
        onActivate={(shift) => {
          onPick(r, shift);
          onReveal(span.entity, at ?? undefined);
        }}
      >
        <Hit x={a} y={CHIP_Y} w={b - a} h={CHIP_H} />
        <rect className="mach-inv-hover" x={a} y={CHIP_Y} width={b - a} height={CHIP_H} rx={2} style={{ fill: fc("plate-top"), stroke: fc("ink-soft"), strokeWidth: 1, strokeDasharray: inferred ? "3 2" : undefined }} />
        {open ? <rect x={b - 10} y={CHIP_Y - 1} width={11} height={CHIP_H + 2} style={{ fill: "url(#mach-inv-open)" }} /> : null}
        <text x={a + 5} y={CHIP_Y + 10.5} style={{ ...SANS, fontSize: 10.5, fill: INK }}>
          {word}
        </text>
        <text x={a} y={CHIP_Y + CHIP_H + 11} style={{ ...MONO, fontSize: 9.5, fill: SUBTLE }}>
          {/* The space keeps the figure's text "Build 4 min", not "Build4 min", for its accessible name; SVG collapses it. */}
          {" "}
          {shortLength(span, liveAt)}
        </text>
        <Ring x={a} y={CHIP_Y} w={b - a} h={CHIP_H} />
      </Fig>
    );
  };

  return (
    <svg width={drawW} height={BLOCK} role="presentation" style={{ display: "block" }}>
      <defs>
        <linearGradient id="mach-inv-open" x1="0" x2="1">
          <stop offset="0" stopColor="var(--mach-factory-ground)" stopOpacity={0} />
          <stop offset="1" stopColor="var(--mach-factory-ground)" stopOpacity={1} />
        </linearGradient>
      </defs>
      {/* Gutter: the cell, how many passes, failures. */}
      <Fig id={`cell:${ladder.ticket}`} name={`Cell ${ladder.ticket}: ${n} passes through build and verify in this window, ${failed} with a failed or refused verdict`} sources={[]} onActivate={() => onReveal(`cell:${ladder.ticket}`)}>
        <Hit x={8} y={10} w={gutter - 24} h={16} />
        <text x={10} y={22} style={{ ...MONO, fontSize: 12, fill: INK }}>
          {ladder.ticket}
        </text>
        <Ring x={8} y={10} w={Math.min(gutter - 24, ladder.ticket.length * 7.6 + 4)} h={16} />
      </Fig>
      <text x={10} y={40} style={{ ...SANS, fontSize: 11, fill: MUTED }}>
        {n} {n === 1 ? "pass" : "passes"} · {failed} not passed
      </text>
      {ladder.unroundedSlots ? (
        <text x={10} y={56} style={{ ...SANS, fontSize: 10.5, fill: SUBTLE }}>
          round not recorded on {ladder.unroundedSlots} {ladder.unroundedSlots === 1 ? "visit" : "visits"}
        </text>
      ) : null}
      {ladder.unattemptedSlots ? (
        <text x={10} y={70} style={{ ...SANS, fontSize: 10.5, fill: SUBTLE }}>
          execution not recorded on {ladder.unattemptedSlots}
        </text>
      ) : null}
      <line x1={gutter - 0.5} x2={gutter - 0.5} y1={4} y2={BLOCK - 4} style={{ stroke: "var(--mach-line)" }} aria-hidden="true" />

      {/* Rounds: brackets above. */}
      {ladder.rounds.map((rd) => {
        const a = slotL(rd.fromSlot);
        const b = slotR(rd.toSlot);
        const outcome = rd.span && rd.to !== null && rd.span.outcome ? rd.span.outcome.toLowerCase().replace(/_/g, " ") : null;
        return (
          <Fig key={`r${rd.fromSlot}`} id={`round:${ladder.ticket}:${rd.label}`} name={`${rd.label} of review for ${ladder.ticket}${rd.from !== null ? `, from ${when(rd.from)}` : ""}${rd.to !== null ? ` to ${when(rd.to)}` : ", not decided by the live edge"}${outcome ? `, ${outcome}` : ""}`} sources={rd.span ? [spanSource(rd.span, "review round")] : [{ what: "the visits' recorded round", ref: rd.ref, eventId: null }]} onActivate={() => onReveal(rd.ref, rd.from ?? undefined)}>
            <Hit x={a} y={6} w={b - a} h={16} />
            <path className="mach-inv-hover" d={`M${a} 22V16H${b}V22`} style={{ fill: "none", stroke: fc("ink-soft"), strokeWidth: 1.2 }} />
            <text x={a + 2} y={12} style={{ ...SANS, fontSize: 10.5, fill: MUTED, fontWeight: 600 }}>
              {rd.label}
              {outcome ? <tspan style={{ fontWeight: 400, fill: SUBTLE }}> · {outcome}</tspan> : null}
            </text>
            <Ring x={a} y={6} w={b - a} h={16} />
          </Fig>
        );
      })}

      {/* Rungs. */}
      {ladder.rungs.map((r, i) => {
        const k = rungKey(r);
        const sel = chosen.indexOf(k);
        const vx = rx(i) + rungW * 0.78;
        const look = verdictLook(r.verdict);
        const next = ladder.rungs[i + 1];
        return (
          <g key={k}>
            {sel >= 0 ? (
              <g aria-hidden="true">
                <rect x={rx(i) + 1} y={CHIP_Y - 13} width={rungW - 6} height={CHIP_H + 28} rx={3} style={{ fill: "none", stroke: fc("select"), strokeWidth: 1.5 }} />
                <text x={rx(i) + rungW - 10} y={CHIP_Y - 3} textAnchor="end" style={{ ...MONO, fontSize: 10, fill: fc("select"), fontWeight: 700 }}>
                  {sel === 0 ? "A" : "B"}
                </text>
              </g>
            ) : null}
            <text x={rx(i) + 4} y={CHIP_Y - 4} style={{ ...SANS, fontSize: 10.5, fill: INK, fontWeight: 600 }} aria-hidden="true">
              Pass {r.index}
              <tspan style={{ ...MONO, fontWeight: 400, fontSize: 9.5, fill: SUBTLE }}> {when(r.first)}</tspan>
            </text>
            {r.build ? chip(r, r.build, 2 * i, r.build.attrs.action === "revise" || (r.build.ids.station ?? "") === "revise" ? "Revise" : "Build") : null}
            {r.verify ? chip(r, r.verify, 2 * i + 1, "Verify") : null}
            {r.verify ? (
              <Fig
                id={`verdict:${k}`}
                name={r.verdict.kind === "none" ? `Pass ${r.index} of ${r.ticket}: no verdict recorded` : `Pass ${r.index} of ${r.ticket}: verification ${verdictWords(r.verdict.kind)}${r.verdict.at !== null ? ` at ${when(r.verdict.at)}` : ""}, ${r.verdict.mark ? "as its gate event records" : "as the visit's outcome records"}${r.verdict.checks ? `, ${r.verdict.checks}` : ""}`}
                sources={r.verdict.sources}
                onActivate={(shift) => {
                  onPick(r, shift);
                  if (r.verdict.mark?.entity) onReveal(r.verdict.mark.entity, r.verdict.at ?? undefined);
                  else onReveal(r.verify!.entity, r.verdict.at ?? undefined);
                }}
              >
                <Hit x={vx - 6} y={CHIP_Y + 1} w={12} h={12} />
                {r.verdict.kind === "none" ? <Mark x={vx} y={CHIP_Y + CHIP_H / 2} state="unknown" r={5.5} /> : <Diamond x={vx} y={CHIP_Y + CHIP_H / 2} r={6} tone={look.tone} open={look.open} cross={look.cross} />}
                <text x={vx} y={CHIP_Y + CHIP_H + 11} textAnchor="middle" style={{ ...SANS, fontSize: 9.5, fill: r.verdict.kind === "failed" || r.verdict.kind === "refused" ? fc("fail") : r.verdict.kind === "passed" ? fc("pass") : SUBTLE }}>
                  {r.verdict.kind === "none" ? "no verdict" : verdictWords(r.verdict.kind)}
                </text>
                <Ring x={vx - 7} y={CHIP_Y} w={14} h={14} />
              </Fig>
            ) : null}
            {/* What followed: the next visit, as recorded. A sequence, not a cause. */}
            {r.followed.kind !== "nothing-yet" && r.followed.span ? (
              <g aria-hidden="true">
                <line x1={vx + 8} x2={next ? rx(i + 1) + 2 : vx + 22} y1={CHIP_Y + CHIP_H / 2} y2={CHIP_Y + CHIP_H / 2} style={{ stroke: fc("route"), strokeWidth: 1.2, strokeDasharray: r.followed.kind === "revise" ? undefined : "2 2" }} />
                <text x={next ? (vx + 8 + rx(i + 1)) / 2 : vx + 26} y={next ? CHIP_Y + CHIP_H + 11 : CHIP_Y + CHIP_H / 2 + 3.5} textAnchor={next ? "middle" : "start"} style={{ ...SANS, fontSize: 9.5, fill: MUTED }}>
                  {next ? "" : "then "}
                  {r.followed.kind === "revise" ? "revise" : r.followed.kind === "review" ? "review" : r.followed.station}
                </text>
              </g>
            ) : r.verify ? (
              <text x={vx + 10} y={CHIP_Y + CHIP_H / 2 + 3.5} style={{ ...SANS, fontSize: 9.5, fill: SUBTLE }} aria-hidden="true">
                nothing yet
              </text>
            ) : null}
          </g>
        );
      })}

      {/* Execution attempts: a rail below, with tick ends; an interrupted attempt ends in the halt cut. */}
      {ladder.attempts.map((x, j) => {
        const a = slotL(x.fromSlot) + (j > 0 ? 2 : 0);
        const b = slotR(x.toSlot);
        const interrupted = x.endReason === "interrupted" || x.endReason === "superseded";
        const unknown = x.endReason === "unknown";
        return (
          <Fig key={`x${x.fromSlot}`} id={`attempt:${x.ref}`} name={`${x.label} for ${ladder.ticket}${x.from !== null ? `, started ${when(x.from)}` : ""}${x.to !== null ? `, ended ${when(x.to)}` : ", not ended by the live edge"}${interrupted ? ", interrupted" : unknown ? ", outcome not known" : ""}`} sources={x.span ? [spanSource(x.span, "execution")] : [{ what: "the visits' recorded execution", ref: x.ref, eventId: null }]} onActivate={() => onReveal(x.ref, x.from ?? undefined)}>
            <Hit x={a} y={RAIL_Y - 4} w={b - a} h={8} />
            <rect className="mach-inv-hover" x={a} y={RAIL_Y - 2} width={b - a} height={4} style={{ fill: fc("ink-soft"), stroke: "none" }} />
            <path d={`M${a} ${RAIL_Y - 5}V${RAIL_Y + 5}`} style={{ stroke: fc("ink-soft"), strokeWidth: 1.4 }} />
            {interrupted || unknown ? <Mark x={b} y={RAIL_Y} state={unknown ? "unknown" : "interrupted"} r={5} /> : <path d={`M${b} ${RAIL_Y - 5}V${RAIL_Y + 5}`} style={{ stroke: fc("ink-soft"), strokeWidth: 1.4 }} />}
            <text x={a + 1} y={RAIL_Y + 17} style={{ ...SANS, fontSize: 10.5, fill: MUTED, fontWeight: 600 }}>
              {x.label}
              {interrupted ? <tspan style={{ fontWeight: 400, fill: fc("halt") }}> · interrupted</tspan> : unknown ? <tspan style={{ fontWeight: 400, fill: SUBTLE }}> · outcome not known</tspan> : null}
            </text>
            <Ring x={a} y={RAIL_Y - 4} w={b - a} h={8} />
          </Fig>
        );
      })}
    </svg>
  );
}

/** Two passes one above the other on a shared relative time axis, each from its own first event. */
function Comparison({ a, b, width, gutter, liveAt, onReveal }: { a: { l: Ladder; r: Rung }; b: { l: Ladder; r: Rung }; width: number; gutter: number; liveAt: number; onReveal(ref: string, at?: number): void }) {
  const rows = [a, b].map(({ r }) => ({ r, parts: rungTimings(r, liveAt), verdictAt: r.verdict.at !== null ? r.verdict.at - r.first : null }));
  const span = Math.max(60_000, ...rows.flatMap((x) => [...x.parts.map((p) => p.to ?? liveAt - x.r.first), x.verdictAt ?? 0]));
  const plotW = Math.max(160, (width - gutter - 24) * 0.58);
  const X = (ms: number) => gutter + 8 + (ms / span) * plotW;
  const step = [60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000].find((s) => span / s <= 6) ?? 14_400_000;
  const ticks: number[] = [];
  for (let t = 0; t <= span; t += step) ticks.push(t);
  const same = a.l === b.l;
  const diffs = same ? compareRungs(a.r, b.r, a.l) : compareRungs(a.r, b.r, a.l).filter((d) => !/^Execution|^Review round/.test(d));
  const H = 22 + rows.length * 30 + 6;
  const colX = gutter + 16 + plotW + 16;
  return (
    <div className="border-b border-line">
      <svg width={width} height={H} role="presentation" style={{ display: "block" }}>
        {ticks.map((t) => (
          <g key={t} aria-hidden="true">
            <line x1={X(t)} x2={X(t)} y1={16} y2={H - 4} style={{ stroke: fc("grid-major"), strokeWidth: 1 }} />
            <text x={X(t)} y={11} textAnchor="middle" style={{ ...MONO, fontSize: 9.5, fill: SUBTLE }}>
              +{t === 0 ? "0" : duration(t)}
            </text>
          </g>
        ))}
        <text x={10} y={11} style={{ ...SANS, fontSize: 10.5, fill: MUTED }} aria-hidden="true">
          Compared from each pass's first event
        </text>
        {rows.map(({ r, parts, verdictAt }, i) => {
          const y = 22 + i * 30;
          const look = verdictLook(r.verdict);
          return (
            <g key={rungKey(r)}>
              <text x={10} y={y + 10} style={{ ...SANS, fontSize: 11, fill: INK, fontWeight: 600 }}>
                <tspan style={{ ...MONO, fill: fc("select") }}>{i === 0 ? "A" : "B"}</tspan> Pass {r.index}
                {same ? null : <tspan style={{ ...MONO, fontWeight: 400, fill: MUTED }}> {r.ticket}</tspan>}
              </text>
              <text x={10} y={y + 23} style={{ ...MONO, fontSize: 9.5, fill: SUBTLE }}>
                from {when(r.first)}
              </text>
              {parts.map((pt) => {
                const x1 = X(pt.from);
                const x2 = X(pt.to ?? liveAt - r.first);
                return (
                  <Fig key={pt.part} id={`cmp:${i}:${pt.part}`} name={`${i === 0 ? "A" : "B"}, pass ${r.index}, ${partWord(pt.span, pt.part).toLowerCase()}: from +${duration(pt.from)}, ${durationWords(pt.span, liveAt)}`} sources={[spanSource(pt.span, `${pt.part} visit`)]} onActivate={() => onReveal(pt.span.entity, startAt(pt.span) ?? undefined)}>
                    <Hit x={x1} y={y + 4} w={Math.max(2, x2 - x1)} h={8} />
                    <rect className="mach-inv-hover" x={x1} y={y + 4} width={Math.max(2, x2 - x1)} height={8} style={{ fill: pt.part === "verify" ? fc("plate-lit") : fc("plate-top"), stroke: fc("ink-soft"), strokeWidth: 1, strokeDasharray: pt.span.end?.basis === "inferred" ? "3 2" : undefined }} />
                    <Ring x={x1} y={y + 4} w={Math.max(2, x2 - x1)} h={8} />
                  </Fig>
                );
              })}
              {verdictAt !== null ? <Diamond x={X(verdictAt)} y={y + 8} r={5} tone={look.tone} open={look.open} cross={look.cross} /> : null}
              <text x={colX} y={y + 11} style={{ ...SANS, fontSize: 11, fill: INK }} aria-hidden="true">
                {parts.map((pt) => `${partWord(pt.span, pt.part)} ${durationWords(pt.span, liveAt)}`).join(" · ") || "No visit timed"}
                <tspan style={{ fill: MUTED }}> · {verdictWords(r.verdict.kind)}</tspan>
              </text>
            </g>
          );
        })}
      </svg>
      <ul className="px-2 pb-2 pl-[10px]">
        {diffs.length ? (
          diffs.map((d) => (
            <li key={d} className="text-[11.5px] leading-[16px] text-ink">
              {d}
            </li>
          ))
        ) : (
          <li className="text-[11.5px] leading-[16px] text-ink-muted">The records show no difference in verdict, checks, what followed, round or execution attempt.</li>
        )}
        {!same ? <li className="text-[11px] text-ink-subtle">Different cells: rounds and attempts are not compared.</li> : null}
      </ul>
    </div>
  );
}
