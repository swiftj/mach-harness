/**
 * Compare: two cohorts of finished tickets side by side (by risk tier, app type, time period, or the
 * execution configuration their executions recorded), each with its sample size, its distribution of
 * judging rounds and its first-pass count, and words that describe a difference without claiming a
 * cause, written only when both cohorts reach the documented minimum. Runs without a recorded
 * configuration are their own cohort, never merged into another.
 */
import { useMemo } from "react";
import type { RunRecord } from "../../contract";
import { cohortOptions, cohortRuns, defaultPair, type CohortBy } from "../../model/cohorts";
import { cohortSummary, compareWords, durationTicks, linear, logScale, medianOf, niceTicks, stripLayout, type Cohort } from "../../model/charts";
import { count, durationText, durationTick, usd } from "../../model/format";
import { comparisonAllowed, SMALL_SAMPLE, shareText } from "../../model/sample";
import { Columns, LogNote } from "../charts";
import { Announce, AreaFrame, ChartFrame, Mark, SectionHead, useAnalytics, useMarkNav, useTip, useWidth } from "../kit";
import type { CompareChoice, CompareProps } from "../types";
import { NothingYet } from "./shared";

const BASES: readonly { key: CohortBy; label: string }[] = [
  { key: "risk", label: "Risk tier" },
  { key: "app_type", label: "App type" },
  { key: "period", label: "Time period" },
  { key: "config", label: "Execution configuration" },
];

export function Compare(props: CompareProps) {
  return (
    <AreaFrame id="compare" title="Compare" intro="Two cohorts of finished tickets from this window, side by side. A difference here is observed, not explained: the cohorts differ in the work they held." props={props}>
      {() => <CompareBody configs={props.configs} choice={props.compare} onChoice={props.onCompare} />}
    </AreaFrame>
  );
}

function CompareBody({ configs, choice, onChoice }: { configs: CompareProps["configs"]; choice: CompareChoice | null; onChoice(c: CompareChoice): void }) {
  const { snapshot: s, density } = useAnalytics();
  const by: CohortBy = choice?.by ?? "risk";
  const mid = (s.window.from_ms + s.window.to_ms) / 2;
  const options = useMemo(() => cohortOptions(by, s.runs, configs, mid), [by, s.runs, configs, mid]);
  if (density === "empty" && !s.no_whole_day) return <NothingYet about="No ticket finished in this window, so there is nothing to compare. Compare groups finished tickets, from:" />;
  const [da, db] = defaultPair(options);
  const a = choice?.a && options.some((o) => o.key === choice.a) ? choice.a : da;
  const b = choice?.b && options.some((o) => o.key === choice.b) ? choice.b : db;
  const label = (k: string | null) => options.find((o) => o.key === k)?.label ?? "–";
  const ca: Cohort = { label: label(a), runs: a ? cohortRuns(by, a, s.runs, configs, mid) : [] };
  const cb: Cohort = { label: label(b), runs: b ? cohortRuns(by, b, s.runs, configs, mid) : [] };
  const sa = cohortSummary(ca);
  const sb = cohortSummary(cb);
  const set = (p: Partial<CompareChoice>) => onChoice({ by, a, b, ...p });

  return (
    <>
      <section className="an-section">
        <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-caption text-ink-muted">Compare by</legend>
            <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Compare by">
              {BASES.map((x) => (
                <button key={x.key} type="button" role="radio" aria-checked={by === x.key} onClick={() => onChoice({ by: x.key, a: null, b: null })} className={`h-7 rounded-sm border px-2 text-body-sm ${by === x.key ? "border-accent bg-accent-soft font-semibold text-accent-ink" : "border-line-control text-ink-muted hover:text-ink"}`}>
                  {x.label}
                </button>
              ))}
            </div>
          </fieldset>
          {(["a", "b"] as const).map((side) => (
            <label key={side} className="flex flex-col gap-1 text-caption text-ink-muted">
              {side === "a" ? "First cohort" : "Second cohort"}
              <select className="h-7 max-w-[18rem] rounded-sm border border-line-control bg-surface px-2 text-body-sm text-ink" value={(side === "a" ? a : b) ?? ""} onChange={(e) => set({ [side]: e.target.value || null })}>
                {options.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label} ({o.runs})
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        {by === "config" ? <p className="mt-3 max-w-[80ch] text-caption text-ink-subtle">A configuration is the id the supervisor recorded when it started each execution: equal ids mean the same MACH files, model tiers, review thresholds and policy. It is compared, not interpreted. Tickets whose executions recorded none are their own cohort, and so are tickets whose executions recorded more than one.</p> : null}
        <p className="mt-4 max-w-[80ch] rounded-md border border-line bg-surface-sunken px-4 py-3 text-body text-ink" data-state={comparisonAllowed(sa.merged, sb.merged) ? undefined : "sparse"}>
          {a === b ? "Choose two different cohorts." : compareWords(sa, sb)}
        </p>
        <Announce on={`${a}|${b}`}>{a === b ? "Choose two different cohorts." : compareWords(sa, sb)}</Announce>
      </section>

      <div className="an-grid-2">
        {[sa, sb].map((c, i) => (
          <section key={`${i}-${c.label}`} className="an-section">
            <SectionHead title={c.label} question={`${count(c.finished)} finished, ${count(c.merged)} merged`} />
            <dl className="grid grid-cols-3 gap-4">
              <div>
                <dt className="text-caption text-ink-muted">First pass</dt>
                <dd className="an-fig text-[22px] text-ink">{c.merged ? shareText(c.firstPass, c.merged) : "–"}</dd>
                <dd className="an-num text-caption text-ink-subtle">{c.enough ? `${c.firstPass} of ${c.merged} merged` : "too few for a share"}</dd>
              </div>
              <div>
                <dt className="text-caption text-ink-muted">Escalated</dt>
                <dd className="an-fig text-[22px] text-ink">{c.finished ? shareText(c.escalated, c.finished) : "–"}</dd>
                <dd className="an-num text-caption text-ink-subtle">of {c.finished} finished</dd>
              </div>
              <div>
                <dt className="text-caption text-ink-muted">Rounds, median</dt>
                <dd className="an-fig text-[22px] text-ink">{c.rounds.length >= 2 ? medianOf(c.rounds) : c.rounds.length === 1 ? c.rounds[0] : "–"}</dd>
                <dd className="an-num text-caption text-ink-subtle">{c.rounds.length === 1 ? "the one merged" : `over ${c.rounds.length} merged`}</dd>
              </div>
            </dl>
            <div className="mt-4">
              <ChartFrame
                chart={`compare-rounds-${i ? "b" : "a"}`}
                title="Judging rounds, share of the cohort's merged tickets"
                summary={[1, 2, 3].map((n) => `${n} rounds: ${c.rounds.filter((r) => r === n).length} of ${c.rounds.length}`).join(", ")}
                table={{ columns: [{ label: "Rounds", num: true }, { label: "Tickets", num: true }, { label: "Share", num: true }], rows: [1, 2, 3].map((n) => { const k = c.rounds.filter((r) => r === n).length; return [count(n), count(k), c.rounds.length ? shareText(k, c.rounds.length) : "–"]; }) }}
                foot="Shares within each cohort, on the same 0–100% scale, so cohorts of different sizes can be read side by side; the counts are in each card."
              >
                <Columns
                  label={`${c.label}: judging rounds`}
                  height={104}
                  format={(v) => `${Math.round(v * 100)}%`}
                  minTop={1}
                  points={[1, 2, 3].map((n) => {
                    const k = c.rounds.filter((r) => r === n).length;
                    return { key: String(n), value: c.rounds.length ? k / c.rounds.length : null, tick: `${n} ${n === 1 ? "round" : "rounds"}`, card: { title: `${c.label}, ${n} ${n === 1 ? "round" : "rounds"}`, rows: [["tickets", `${k} of ${c.rounds.length}`], ["share", c.rounds.length ? shareText(k, c.rounds.length) : "–"]] } };
                  })}
                />
              </ChartFrame>
            </div>
            {!c.enough ? <p className="mt-2 text-caption text-warning-ink">Fewer than {SMALL_SAMPLE} merged tickets: counts only, and no comparison is written.</p> : null}
          </section>
        ))}
      </div>

      <section className="an-section">
        <SectionHead title="Distributions on one axis" question="Every ticket in each cohort as a dot; the tick is the cohort's median." />
        <div className="an-grid-2">
          <DotCompare chart="compare-c3" title="Dispatch to merge (C3)" cohorts={[ca, cb]} values={new Map((s.contributors.C3?.items ?? []).map((x) => [x.ticket ?? "", x.value]))} kind="ms" />
          <DotCompare chart="compare-k4" title="Recorded cost per ticket (K4)" cohorts={[ca, cb]} values={new Map((s.contributors.K4?.items ?? []).map((x) => [x.ticket ?? "", x.value]))} kind="usd" />
        </div>
      </section>
    </>
  );
}

const DURATION_ROUND = new Set([1000, 10_000, 60_000, 300_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000, 28_800_000, 86_400_000, 172_800_000, 604_800_000, 2_592_000_000]);

/** Round ticks plus the two ends of the axis, an end dropped only where a round tick already sits within 40 px of it. */
function withEnds(ticks: readonly number[], lo: number, hi: number, x: (v: number) => number): number[] {
  const out = [...ticks];
  if (!out.some((t) => Math.abs(x(t) - x(lo)) < 40)) out.unshift(lo);
  if (!out.some((t) => Math.abs(x(t) - x(hi)) < 40)) out.push(hi);
  return out;
}

/** Two cohorts' values as dot strips on one shared axis (log for durations, labelled; linear from zero for cost). Missing values are counted, not placed. */
function DotCompare({ chart, title, cohorts, values, kind }: { chart: string; title: string; cohorts: readonly Cohort[]; values: ReadonlyMap<string, number | null>; kind: "ms" | "usd" }) {
  const { open } = useAnalytics();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [, setTip, tipNode] = useTip(width);
  const rows = cohorts.map((c) => {
    const vals = c.runs.map((r: RunRecord) => ({ id: r.ticket_id, v: values.get(r.ticket_id) ?? null }));
    return { c, known: vals.filter((x): x is { id: string; v: number } => x.v !== null), missing: vals.filter((x) => x.v === null).length };
  });
  const flat = rows.flatMap((r) => r.known);
  const nav = useMarkNav(flat.length);
  const all = flat.map((k) => k.v);
  if (values.size === 0) return <p className="text-body-sm text-ink-muted">{title}: this source does not list each ticket's value, so no ticket is placed.</p>;
  if (all.length === 0) return <p className="text-body-sm text-ink-muted">{title}: nothing recorded for these cohorts.</p>;
  const left = Math.min(196, Math.max(120, width * 0.3));
  const right = 14;
  // Tall enough for the strip's three rows of dots each way (3 x 7.4 px) plus a dot's radius, so no dot is cut or spills into the next cohort.
  const rowH = Math.ceil(2 * (3 * (3.2 * 2 + 1) + 3.2)) + 8;
  const height = rows.length * rowH + 24;
  const lo = kind === "ms" ? Math.max(60_000, Math.min(...all) * 0.8) : 0;
  const hi = Math.max(...all) * (kind === "ms" ? 1.2 : 1) || 1;
  const inner = kind === "ms" ? durationTicks(lo, hi, 5) : niceTicks(hi, Math.max(2, Math.min(4, Math.floor((width - left) / 80))));
  const x = kind === "ms" ? logScale(lo, hi, left, width - right) : linear(0, inner[inner.length - 1]!, left, width - right);
  // The axis always shows both ends, so a strip with one dot (or a narrow range) still has a scale.
  const ticks = kind === "ms" ? withEnds(inner, lo, hi, x) : inner;
  const fmt = (v: number) => (kind === "ms" ? durationText(v) : usd(v));
  let idx = 0;
  return (
    <ChartFrame
      chart={chart}
      title={title}
      summary={rows.map((r) => `${r.c.label}: ${r.known.length} placed, median ${r.known.length >= SMALL_SAMPLE ? fmt(medianOf(r.known.map((k) => k.v))!) : "not drawn"}, ${r.missing} without a value`).join("; ")}
      table={{ columns: [{ label: "Ticket" }, { label: "Cohort" }, { label: kind === "ms" ? "Dispatch to merge" : "Recorded cost", num: true }], rows: rows.flatMap((r) => r.known.map((k) => [<button key={k.id} type="button" className="an-link an-mono inline-flex min-h-6 items-center" onClick={() => open(`cell:${k.id}`, "timeline")}>{k.id}</button>, r.c.label, fmt(k.v)])) }}
      foot={<>{rows.map((r) => `${r.c.label}: ${r.missing} without a recorded value`).join("; ")}. Cohorts smaller than {SMALL_SAMPLE} show their dots but no median. {kind === "ms" ? <LogNote /> : "The cost axis starts at zero."}</>}
    >
      <div ref={ref} className="relative" style={{ height }}>
        <svg width={width} height={height} role="group" aria-label={title} style={{ display: "block" }}>
          {ticks.map((t, i) => (
            <g key={t} aria-hidden="true">
              <line x1={x(t)} x2={x(t)} y1={0} y2={height - 18} style={{ stroke: t === 0 ? "var(--an-axis)" : "var(--an-grid)" }} />
              <text x={x(t)} y={height - 4} textAnchor={i === ticks.length - 1 && ticks.length > 1 ? "end" : i === 0 && t === lo && kind === "ms" ? "start" : "middle"} style={{ fontFamily: "var(--mach-font-sans)", fontVariantNumeric: "tabular-nums", fontSize: 11, fill: "var(--an-subtle)" }}>
                {kind === "ms" ? (DURATION_ROUND.has(t) ? durationTick(t) : durationText(t)) : usd(t).replace(".00", "")}
              </text>
            </g>
          ))}
          {rows.map((r, i) => {
            const cy = i * rowH + rowH / 2;
            const dots = stripLayout(r.known.map((k) => ({ id: k.id, x: x(k.v) })), cy, 3.2, 3);
            const med = r.known.length >= SMALL_SAMPLE ? medianOf(r.known.map((k) => k.v)) : null;
            return (
              <g key={`${i}-${r.c.label}`}>
                <foreignObject x={0} y={cy - 16} width={left - 10} height={34}>
                  <div className="truncate text-body-sm text-ink">{r.c.label}</div>
                  <div className="text-caption text-ink-subtle">n {r.known.length}</div>
                </foreignObject>
                {dots.map((d) => {
                  const k = r.known.find((z) => z.id === d.id)!;
                  const my = idx++;
                  return (
                    <Mark key={d.id} nav={nav} index={my} x={d.x - 3} y={d.y - 3} w={6} h={6} tipAt={{ x: d.x, y: d.y - 4 }} card={{ title: d.id, rows: [[kind === "ms" ? "dispatch to merge" : "recorded cost", fmt(k.v)], ["cohort", r.c.label]], foot: "Enter opens it in the Timeline." }} onTip={setTip} onActivate={() => open(`cell:${d.id}`, "timeline")}>
                      <circle cx={d.x} cy={d.y} r={3.2} style={{ fill: i === 0 ? "var(--an-live)" : "var(--an-bar)", stroke: "var(--mach-canvas)", strokeWidth: 1 }} />
                    </Mark>
                  );
                })}
                {med !== null ? <line x1={x(med)} x2={x(med)} y1={cy - 14} y2={cy + 14} style={{ stroke: "var(--an-ink)", strokeWidth: 2 }} aria-hidden="true" /> : null}
              </g>
            );
          })}
        </svg>
        {tipNode}
      </div>
    </ChartFrame>
  );
}
