/**
 * Factory Pulse, the landing area: an editorial reading of the window, not a wall of tiles. A lead
 * paragraph whose every number opens its definition; delivery over time with the steps from an
 * execution to an accepted product kept apart; the findings that stand out; then four small charts,
 * one story each (where station time goes, how merged tickets passed, recorded cost over time, how
 * executions ended), each with at most two quiet supporting figures; and the data's own coverage.
 */
import { groupedKey, type MetricRow } from "../../contract";
import { clockText, count, coverageText, dayText, durationText, pct, plural, usd, valueText, windowText } from "../../model/format";
import { beltShares, costSeries, outcomePartition, type OutcomeKey } from "../../model/pulse";
import { durationShows, MIN_TREND_MEMBERS, MIN_TREND_PERIODS, SMALL_SAMPLE, shareText, verdictAllowed } from "../../model/sample";
import { grainFor, periodSeries } from "../../model/series";
import { BeltStrip, Columns, PartsBar } from "../charts";
import { STATION_WORDS } from "../charts/Flow";
import { AreaFrame, ChartFrame, useWidth, Definition, NotRecorded, rowMissing, SectionHead, TooFew, useAnalytics, type Card } from "../kit";
import type { Insight, InsightsReply } from "../../data/types";
import { capitalFirst, insightPopulation, populationWords, repeatsTitle, sampleWords } from "../../model/insights";
import type { AreaData, PulseProps } from "../types";
import { areaOf, measurementText } from "./Opportunities";
import { AreaLink, MiniFig, NothingYet, Num, RecordedTotal } from "./shared";

const D = 86_400_000;

export function Pulse(props: PulseProps) {
  return (
    <AreaFrame id="pulse" title="Factory Pulse" intro={null} props={props}>
      {() => <PulseBody insights={props.insights} />}
    </AreaFrame>
  );
}

function PulseBody({ insights }: { insights: AreaData<InsightsReply> | undefined }) {
  const { snapshot: s, density } = useAnalytics();
  if (density === "empty")
    return <NothingYet about={`The ${windowWords(s)} holds no finished ticket, no execution, no merge and no station visit. Factory Pulse reads what MACH writes as the line runs:`} />;
  const fs = insights?.state === "ready" ? insights.value.insights.slice(0, 4) : [];
  return (
    <>
      <Lead />
      <div className="an-grid-lead">
        <section className="an-section" aria-labelledby="pulse-delivery">
          <SectionHead id="pulse-delivery" title="Delivery" question="What reached the default and integration branches?" />
          <DeliveryTrend />
          <Ladder />
        </section>
        <section className="an-section" aria-labelledby="pulse-findings">
          <SectionHead id="pulse-findings" title="What stands out" />
          {insights?.state !== "ready" ? (
            <p className="text-body-sm text-ink-muted">{!insights ? "This source does not evaluate the improvement rules." : insights.state === "loading" ? "Evaluating the rules for this window." : insights.state === "error" ? `The observer answered ${insights.status ?? "nothing"}: ${insights.reason}` : insights.reason}</p>
          ) : fs.length === 0 ? (
            <p className="text-body-sm text-ink-muted">No rule's condition holds in this window{density !== "many" ? `; most rules need at least ${SMALL_SAMPLE} records` : ""}. Findings are fixed rules over recorded values; none is a guess.</p>
          ) : (
            <ol className="flex flex-col gap-4">
              {fs.map((f) => (
                <li key={f.id} className="border-l-2 border-line-strong pl-3" data-insight={f.rule}>
                  <div className="text-label text-ink">{capitalFirst(f.title)}</div>
                  <div className="an-num mt-0.5 text-body-sm text-ink-muted" data-insight-population="">
                    {[ownPopulation(f, s.window) ? populationWords(f) : null, sampleWords(f)].filter(Boolean).join("; ")}
                  </div>
                  {(() => {
                    const more = f.measurements.filter((m) => !repeatsTitle(m, f.title)).slice(0, 2);
                    return more.length ? <div className="an-num mt-0.5 text-body-sm text-ink-muted">{more.map((m) => `${m.label ?? m.metric} ${measurementText(m)}`).join("; ")}</div> : null;
                  })()}
                  {f.threshold ? <div className="mt-0.5 text-caption text-ink-subtle">Rule: {f.threshold}</div> : null}
                  <div className="mt-1">
                    <AreaLink to={areaOf(f)}>Open the figures</AreaLink>
                  </div>
                </li>
              ))}
            </ol>
          )}
          <div className="mt-4">
            <AreaLink to="opportunities">All improvement opportunities</AreaLink>
          </div>
        </section>
      </div>
      <div className="an-grid-4" role="list" aria-label="The four parts of the Factory, one chart each">
        <FlowPanel />
        <QualityPanel />
        <CostPanel />
        <ReliabilityPanel />
      </div>
      <Coverage />
    </>
  );
}

/** Whether an opportunity was measured over something other than the view's own window (the last N runs, another period): only then is its population said beside it. */
function ownPopulation(f: Insight, w: { from_ms: number; to_ms: number }): boolean {
  const p = insightPopulation(f);
  if (p.lastRuns) return true;
  if (p.fromMs === null || p.toMs === null) return !!f.window.comparison;
  const D1 = 86_400_000;
  return Math.abs(p.fromMs - w.from_ms) >= D1 || Math.abs(p.toMs - w.to_ms) >= D1 || !!f.window.comparison;
}

function windowWords(s: { window: { from_ms: number; to_ms: number } }): string {
  return `window ${windowText(s.window.from_ms, s.window.to_ms)}`;
}

// ------------------------------------------------------------------------------------------ lead

function Lead() {
  const { snapshot: s, density } = useAnalytics();
  const t = s.totals;
  const days = Math.round((s.window.to_ms - s.window.from_ms) / D);
  const merged = t.T1?.numerator_value ?? 0;
  const integrated = t.T2?.numerator_value ?? 0;
  const noCost = (t.K1?.coverage.of ?? 0) - (t.K1?.coverage.covered ?? 0);
  let body;
  if (density === "single") {
    const r = s.runs[0]!;
    body = (
      <>
        One ticket has finished in this history: <span className="an-mono text-[0.92em]">{r.ticket_id}</span>, {r.outcome === "merged" ? "merged" : r.outcome}
        {r.closed_at ? ` on ${dayText(r.closed_at.ms)}` : ""}
        {r.rounds !== null ? ` after ${plural(r.rounds, "judging round")}` : ""}
        {r.first_pass ? ", first time" : r.escalated ? ", after an escalation" : ""}. One run is not a sample: the figures below are that run's own, shown as counts, with no rate, percentile or trend.
      </>
    );
  } else if (density === "few") {
    body = (
      <>
        <span className="an-num font-semibold">{s.runs.length}</span> tickets have finished in this history, between {s.runs[0]?.closed_at ? dayText(s.runs[0].closed_at.ms) : "–"} and {dayText(s.window.to_ms - 1)}. That is too few for a rate, a target verdict or a direction: each figure below is a count of what was recorded (“{shareText(1, s.runs.length)}”), and no trend is drawn.
      </>
    );
  } else {
    body = (
      <>
        In the {days} days to {dayText(s.window.to_ms - 1)} {rowMissing(t.T1) ? <>no merges are recorded (no cell kept a lifecycle log), but</> : <>the Factory merged <Num row={t.T1} label="Tickets merged">{count(merged)}</Num> tickets, and</>} <Num row={t.T2} label="Slices integrated">{count(integrated)}</Num> product slices were integrated. {t.Q2 && t.Q2.value !== null ? <><Num row={t.Q2}>{valueText(t.Q2) ?? "–"}</Num> of merged tickets passed verification and review first time{verdictAllowed(t.Q2.denominator_value) ? ", against the observe station's target of above 85%" : ""}. </> : null}
        {t.K1 && !rowMissing(t.K1) ? (
          <>
            Executions recorded <Num row={t.K1} label="Recorded total">{usd(t.K1.numerator_value)}</Num> of cost{noCost > 0 ? <>; {count(noCost)} of {count(t.K1.coverage.of ?? 0)} carried none, so that total is a lower bound</> : null}.
          </>
        ) : null}
      </>
    );
  }
  return (
    <div className="an-lead-row">
      <p className="an-lead text-body-lg text-ink">{body}</p>
      <LeadNote />
    </div>
  );
}

/**
 * Beside the lead: what the paragraph stands on, said once and quietly (the window, the moment, how
 * much was recorded, and the least complete source), so the reader knows its footing before the
 * figures. Not a row of figures: one short line each.
 */
function LeadNote() {
  const { snapshot: s, asOf } = useAnalytics();
  const days = Math.max(1, Math.round((s.window.to_ms - s.window.from_ms) / D));
  const executions = s.totals.X1?.denominator_value ?? null;
  const thinnest = [...s.freshness].filter((f) => f.coverage.share !== null && f.coverage.share < 1).sort((a, b) => (a.coverage.share ?? 1) - (b.coverage.share ?? 1))[0];
  return (
    <aside className="an-lead-note" aria-label="What these figures stand on">
      <dl>
        <dt>Window</dt>
        <dd className="an-num">
          {windowText(s.window.from_ms, s.window.to_ms)}, {plural(days, "day")}
        </dd>
        <dt>Read</dt>
        <dd>{asOf.replace(/^As of /, "as of ")}</dd>
        <dt>Recorded</dt>
        <dd className="an-num">
          {plural(s.runs.length, "finished ticket")}
          {executions !== null ? `, ${plural(executions, "execution")}` : ""}
        </dd>
        {thinnest ? (
          <>
            <dt>Least complete</dt>
            <dd className="an-num">
              {thinnest.source}, {thinnest.coverage.covered} of {thinnest.coverage.of}
            </dd>
          </>
        ) : null}
      </dl>
    </aside>
  );
}

// -------------------------------------------------------------------------------------- delivery

function DeliveryTrend() {
  const { snapshot: s, density, window: setWindow } = useAnalytics();
  const from = s.window.from_ms;
  const to = s.window.to_ms;
  const grain = grainFor(from, to);
  const t1 = periodSeries(s.grouped[groupedKey("T1", "day")], from, to, grain);
  const t2 = periodSeries(s.grouped[groupedKey("T2", "day")], from, to, grain);
  const withValue = t1.filter((p) => (p.value ?? 0) > 0).length;
  const members = (s.totals.T1?.numerator_value ?? 0) + (s.totals.T2?.numerator_value ?? 0);
  if (density !== "many" || t1.length < MIN_TREND_PERIODS || (members < MIN_TREND_MEMBERS && withValue < MIN_TREND_PERIODS))
    return <TooFew what={density === "single" ? "finished ticket" : "finished tickets"} n={s.runs.length} need={MIN_TREND_MEMBERS} periods={MIN_TREND_PERIODS} />;
  const top = Math.max(...t1.map((p) => p.value ?? 0), ...t2.map((p) => p.value ?? 0));
  const every = Math.max(1, Math.ceil(t1.length / 8));
  const periodName = (p: { from: number; to: number; days: number }) => (grain === "day" ? dayText(p.from) : `Week to ${dayText(p.to - 1)}${p.days < 7 ? ` (${p.days} days)` : ""}`);
  const tick = (i: number, p: { from: number; to: number }) => (i % every === 0 ? (grain === "day" ? dayText(p.from) : dayText(p.to - 1)) : undefined);
  const unit = grain === "day" ? "day" : "week";
  const table = { columns: [{ label: grain === "day" ? "Day" : "Week to" }, { label: "Tickets merged (T1)", num: true }, { label: "Slices integrated (T2)", num: true }], rows: t1.map((p, i) => [grain === "day" ? dayText(p.from) : dayText(p.to - 1), count(p.value), count(t2[i]?.value ?? null)]) };
  const card = (p: (typeof t1)[number], i: number): Card => ({ title: periodName(p), rows: [["tickets merged", count(p.value)], ["slices integrated", count(t2[i]?.value ?? null)]] });
  return (
    <ChartFrame
      chart="pulse-delivery"
      requires={[s.totals.T2]}
      title={`Merged and integrated, per ${unit}`}
      question={<>Two counts on one scale; slices are drawn outlined. {setWindow ? "Drag across the columns to look at those days alone." : null}</>}
      summary={`Over ${t1.length} ${unit}s, ${s.totals.T1?.numerator_value ?? 0} tickets were merged and ${s.totals.T2?.numerator_value ?? 0} slices integrated; the most in one ${unit} was ${top}.`}
      table={table}
      foot={<>{grain === "week" ? "The window holds too many days to draw one by one, so days are added into weeks ending on the window's last day. " : null}A period with nothing recorded is a zero count: both logs were read throughout. Merges from cells without a lifecycle log are not counted (T1 coverage {coverageText(s.totals.T1!.coverage)}).</>}
    >
      <div className="text-caption text-ink-muted">Tickets merged (T1)</div>
      {rowMissing(s.totals.T1) ? (
        <NotRecorded compact title={rowMissing(s.totals.T1)!.title} what={rowMissing(s.totals.T1)!.why} why="No columns are drawn for it: a missing count is not zero." />
      ) : (
        <Columns label="Tickets merged per period" series="Tickets merged (T1), filled columns" focusable={false} onWindow={setWindow} points={t1.map((p, i) => ({ key: p.key, value: p.value, from: p.from, to: p.to, card: card(p, i) }))} height={84} format={(v) => count(v)} minTop={top} />
      )}
      <div className="mt-2 text-caption text-ink-muted">Slices integrated (T2)</div>
      <Columns label="Slices integrated per period" series="Slices integrated (T2), outlined columns" onWindow={setWindow} points={t2.map((p, i) => ({ key: p.key, value: p.value, tick: tick(i, p), from: p.from, to: p.to, card: card(t1[i] ?? p, i) }))} height={106} format={(v) => count(v)} tone="var(--an-pass)" ringed minTop={top} />
    </ChartFrame>
  );
}

/**
 * The steps from work done to product accepted, each counted on its own: an execution that completed
 * is not a merged ticket, a merge is not an integrated slice, and integration is not acceptance.
 */
function Ladder() {
  const { snapshot: s } = useAnalytics();
  const t = s.totals;
  const steps: { label: string; row: MetricRow | undefined; value: number | null; unit: [string, string] }[] = [
    { label: "Executions completed", row: t.S3, value: t.S3?.numerator_value ?? null, unit: ["execution", "executions"] },
    { label: "Tickets merged", row: t.T1, value: rowMissing(t.T1) ? null : t.T1?.numerator_value ?? 0, unit: ["ticket", "tickets"] },
    { label: "Slices integrated", row: t.T2, value: rowMissing(t.T2) ? null : t.T2?.numerator_value ?? 0, unit: ["slice", "slices"] },
  ];
  return (
    <div className="mt-6">
      <h3 className="text-label text-ink">From work done to product accepted</h3>
      <p className="text-caption text-ink-muted">Each step is a different thing, counted on its own; one does not imply the next.</p>
      <ol className="an-ladder mt-2 border-y border-line">
        {steps.map((st, i) => (
          <li key={st.label} className={`px-3 py-2 ${i ? "border-l border-line" : ""}`} data-readout={st.row?.id} data-value={st.value ?? undefined}>
            <div className="flex items-start gap-1 text-caption text-ink-muted">
              <span className="min-w-0 pt-0.5">{st.label}</span>
              {st.row ? <Definition row={st.row} label={st.label} /> : null}
            </div>
            {st.value === null ? (
              <span className="text-body-sm text-ink-muted">{rowMissing(st.row)?.title ?? "No value"}</span>
            ) : (
              <div className="flex items-baseline gap-1">
                <span className="an-fig text-[21px] text-ink">{count(st.value)}</span>
                <span className="text-caption text-ink-subtle">{st.value === 1 ? st.unit[0] : st.unit[1]}</span>
              </div>
            )}
          </li>
        ))}
        <li className="an-hatch border-l border-line px-3 py-2" data-state="not-recorded">
          <div className="text-caption text-ink-muted">Accepted by product</div>
          <div className="text-body-sm font-semibold text-ink">Not recorded</div>
          <div className="text-caption text-ink-subtle">No MACH record says a person accepted a delivered slice.</div>
        </li>
      </ol>
      <p className="mt-1.5 text-caption text-ink-subtle">The catalog's name for slices integrated is “Accepted delivery” (T2); it counts commits on the integration branch, not a product decision.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------------- four panels

/** "67% of merged tickets passed first time." or, under five, "1 of 2 merged tickets passed first time." */
function shareWords(k: number, n: number, many: string, one: string): string {
  const t = shareText(k, n);
  return t.includes(" of ") ? `${t} ${n === 1 ? one : many}.` : `${t} of ${many}.`;
}

function Panel({ title, to, question, chart, figures }: { title: string; to: Parameters<typeof AreaLink>[0]["to"]; question: string; chart: React.ReactNode; figures: React.ReactNode }) {
  return (
    <section className="an-section flex min-w-0 flex-col" role="listitem" aria-label={title}>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <h2 className="text-title-3 text-ink">{title}</h2>
      </div>
      <p className="mb-3 text-body-sm text-ink-muted">{question}</p>
      <div className="min-h-[104px]">{chart}</div>
      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line pt-3">{figures}</div>
      <div className="mt-auto pt-3">
        <AreaLink to={to}>Open {title.toLowerCase()}</AreaLink>
      </div>
    </section>
  );
}

function FlowPanel() {
  const { snapshot: s, area } = useAnalytics();
  const t = s.totals;
  const belt = beltShares(s.grouped[groupedKey("C1", "station")]);
  const missing = rowMissing(t.C1);
  const top = belt.reduce((m, b) => (b.share > m.share ? b : m), belt[0] ?? { share: 0, station: "build" as const });
  return (
    <Panel
      title="Flow"
      to="flow"
      question={missing || belt.length === 0 ? "Where does station time go?" : `${STATION_WORDS[top.station]} held ${pct(top.share)} of measured station time.`}
      chart={
        missing ? (
          <NotRecorded compact title={missing.title} what={missing.why} why="Station visits are recorded from M6.1 onward." />
        ) : belt.length === 0 ? (
          <p className="text-body-sm text-ink-muted">No measured station visit in this window.</p>
        ) : (
          <ChartFrame
            chart="pulse-belt"
            targetEquivalent="Open flow link, and the station rows in Flow and bottlenecks"
            size="sm"
            title="Measured station time, along the belt"
            summary={belt.map((b) => `${STATION_WORDS[b.station]} ${pct(b.share)}`).join(", ")}
            table={{ columns: [{ label: "Station" }, { label: "Share", num: true }, { label: "Measured", num: true }, { label: "Visits", num: true }], rows: belt.map((b) => [area ? <button key={b.station} type="button" className="an-link inline-flex min-h-6 items-center" onClick={() => area("flow", b.station)}>{STATION_WORDS[b.station]}</button> : STATION_WORDS[b.station], pct(b.share), durationText(b.totalMs), count(b.visits)]) }}
          >
            <BeltStrip
              name="Share of measured station time, along the belt"
              parts={belt.map((b) => ({ key: b.station, label: STATION_WORDS[b.station], value: b.totalMs, text: pct(b.share), tone: b.station === top.station ? "var(--an-ink-soft)" : "var(--an-bar)" }))}
              onActivate={area ? (k) => area("flow", k) : undefined}
            />
          </ChartFrame>
        )
      }
      figures={
        <>
          <MiniFig row={t.C3} label="Dispatch to merge" sub={t.C3 && !rowMissing(t.C3) && t.C3.value !== null && durationShows(t.C3.denominator_value).mean ? <>mean {durationText(t.C3.value)}; n {count(t.C3.denominator_value)}</> : undefined} />
          <MiniFig row={t.C2} label="Visits per ticket" />
        </>
      }
    />
  );
}

function QualityPanel() {
  const { snapshot: s } = useAnalytics();
  const t = s.totals;
  const merged = s.runs.filter((r) => r.outcome === "merged");
  const fp = merged.filter((r) => r.first_pass).length;
  const judge = verdictAllowed(merged.length);
  return (
    <Panel
      title="Quality"
      to="quality"
      question={merged.length === 0 ? "How did merged tickets pass?" : shareWords(fp, merged.length, "merged tickets passed first time", "merged ticket passed first time")}
      chart={
        merged.length === 0 ? (
          <p className="text-body-sm text-ink-muted">No merged ticket in this window.</p>
        ) : (
          <ChartFrame size="sm" chart="pulse-first-pass" title="Merged tickets, first pass or remediated" summary={`${fp} of ${merged.length} merged tickets passed first time and ${merged.length - fp} were remediated${judge ? "; the observe station's target is above 85%" : ""}.`} table={{ columns: [{ label: "How" }, { label: "Tickets", num: true }], rows: [["First pass", count(fp)], ["Remediated", count(merged.length - fp)]] }}>
            <PartsBar
              name="Merged tickets by how they passed"
              height={22}
              target={judge ? 0.85 : undefined}
              targetLabel="target 85%"
              parts={[
                { key: "first", label: "First pass", value: fp, text: count(fp), tone: "var(--an-pass)" },
                { key: "remediated", label: "Remediated", value: merged.length - fp, text: count(merged.length - fp), tone: "var(--an-wait)" },
              ]}
            />
          </ChartFrame>
        )
      }
      figures={
        <>
          <MiniFig row={t.Q3} label="Judging rounds" />
          <MiniFig row={t.R5} label="Escalated" />
        </>
      }
    />
  );
}

function CostPanel() {
  const { snapshot: s, density, window: setWindow } = useAnalytics();
  const t = s.totals;
  const from = s.window.from_ms;
  const to = s.window.to_ms;
  // Days become weeks when the window is long, or when a day's column would be under 3 px wide here.
  const [box, boxW] = useWidth<HTMLDivElement>(300, 40);
  const dayCount = Math.ceil((to - Math.floor(from / D) * D) / D);
  const narrow = ((boxW - 48) / Math.max(1, dayCount)) * 0.76 < 3;
  const grain = grainFor(from, to) === "week" || narrow ? "week" : "day";
  const series = costSeries(s.grouped[groupedKey("K1", "day")], from, to, grain);
  const missing = rowMissing(t.K1);
  const flagged = series.filter((p) => p.without > 0).length;
  return (
    <Panel
      title="Recorded cost"
      to="economics"
      question={missing ? "What did executions record as spent?" : `${usd(t.K1?.numerator_value)} recorded, a lower bound.`}
      chart={
        <div ref={box} className="min-w-0">{missing ? (
          <NotRecorded compact title={missing.title} what={missing.why} why="Nothing is drawn in its place." />
        ) : density !== "many" ? (
          <p className="text-body-sm text-ink-muted">Too few executions for cost over time: {plural(t.K1?.coverage.of ?? 0, "execution")} recorded.</p>
        ) : (
          <ChartFrame
            chart="pulse-cost"
            size="sm"
            title={`Recorded cost per ${grain}`}
            summary={`Recorded cost per ${grain}; ${flagged} ${grain}s had executions that recorded no cost.`}
            table={{ columns: [{ label: grain === "day" ? "Day" : "Week to" }, { label: "Recorded", num: true }, { label: "With a cost", num: true }, { label: "Without", num: true }], rows: series.map((p) => [dayText(grain === "day" ? p.from : p.to - 1), usd(p.cost), count(p.withCost), count(p.without)]) }}
            foot={<>{grain === "week" && grainFor(from, to) === "day" ? "Days are added into weeks ending on the window's last day: one column a day would be too thin here. " : null}{flagged ? <>Marks under the axis: {grain}s in which some executions recorded no cost; those columns are lower bounds.</> : null}</>}
          >
            <Columns
              label={`Recorded cost per ${grain}`}
              onWindow={setWindow}
              height={96}
              format={(v) => usd(v).replace(".00", "")}
              points={series.map((p, i) => ({
                key: p.key,
                value: p.cost,
                flag: p.without > 0,
                from: p.from,
                to: p.to,
                tick: i === 0 || i === series.length - 1 ? dayText(grain === "day" ? p.from : p.to - 1) : undefined,
                card: { title: grain === "day" ? dayText(p.from) : `Week to ${dayText(p.to - 1)}`, rows: p.withCost + p.without === 0 ? [["executions", "none claimed"]] : [["recorded", usd(p.cost)], ["executions with a cost", count(p.withCost)], ["without a cost", count(p.without)]], ...(p.without ? { foot: "A lower bound: what those executions cost is unknown." } : {}) },
              }))}
            />
          </ChartFrame>
        )}</div>
      }
      figures={
        <>
          <RecordedTotal row={t.K1} size="sm" />
          <MiniFig row={t.K4} label="Per ticket" />
        </>
      }
    />
  );
}

const OUTCOME_WORDS: Readonly<Record<OutcomeKey, string>> = { completed: "Completed", failed: "Failed", interrupted: "Interrupted", unknown: "Outcome unknown", open: "No end recorded" };
const OUTCOME_TONES: Readonly<Record<OutcomeKey, string>> = { completed: "var(--an-pass)", failed: "var(--an-fail)", interrupted: "var(--an-halt)", unknown: "var(--an-stale)", open: "var(--an-subtle)" };

function ReliabilityPanel() {
  const { snapshot: s, area } = useAnalytics();
  const t = s.totals;
  const p = outcomePartition(s);
  const done = p.parts.find((x) => x.key === "completed")?.count ?? 0;
  return (
    <Panel
      title="Reliability"
      to="reliability"
      question={p.missing ? "How did executions end?" : shareWords(done, p.claimed, "claimed executions completed", "claimed execution completed")}
      chart={
        p.missing ? (
          <p className="text-body-sm text-ink-muted">{p.missing.charAt(0).toUpperCase() + p.missing.slice(1)}.</p>
        ) : !p.partition ? (
          <p className="text-body-sm text-ink-muted">These endings overlap in this window, so they are not drawn as parts of one whole; each is shown over its own base in Reliability.</p>
        ) : (
          <ChartFrame size="sm" chart="pulse-outcomes" title={`How ${plural(p.claimed, "claimed execution")} ended`} summary={p.parts.map((x) => `${OUTCOME_WORDS[x.key]} ${x.count}`).join(", ")} table={{ columns: [{ label: "Ending" }, { label: "Executions", num: true }], rows: p.parts.map((x) => [area ? <button key={x.key} type="button" className="an-link inline-flex min-h-6 items-center" onClick={() => area("reliability", `outcome:${x.key}`)}>{OUTCOME_WORDS[x.key]}</button> : OUTCOME_WORDS[x.key], count(x.count)]) }}>
            <PartsBar name={`How ${p.claimed} claimed executions ended`} height={22} parts={p.parts.map((x) => ({ key: x.key, label: OUTCOME_WORDS[x.key], value: x.count, text: count(x.count), tone: OUTCOME_TONES[x.key], hatch: x.key === "open" }))} onActivate={area ? (k) => area("reliability", `outcome:${k}`) : undefined} />
          </ChartFrame>
        )
      }
      figures={
        <>
          <MiniFig row={t.S4} label="Parked for a person" />
          <MiniFig row={t.W3} label="Approval wait" />
        </>
      }
    />
  );
}

// -------------------------------------------------------------------------------------- coverage

function Coverage() {
  const { snapshot: s, asOf } = useAnalytics();
  if (s.freshness.length === 0) return null;
  // A column is shown only when some source has it: the time of a source's last event is not served by every observer.
  const events = s.freshness.some((f) => f.last_event_ms !== null);
  const reads = s.freshness.some((f) => f.last_read_ms != null);
  return (
    <section className="an-section" aria-labelledby="pulse-coverage">
      <SectionHead id="pulse-coverage" title="Data coverage and freshness" question={`${asOf}. Generated ${clockText(s.generated_at_ms)} for ${windowText(s.window.from_ms, s.window.to_ms)}.`} />
      <div className="overflow-x-auto">
        <table className="an-table">
          <thead>
            <tr>
              <th scope="col">Source</th>
              {events ? <th scope="col">Last event</th> : null}
              {reads ? <th scope="col">Last read</th> : null}
              <th scope="col" className="num">
                Coverage
              </th>
              <th scope="col" style={{ width: "40%" }}>
                What it covers
              </th>
            </tr>
          </thead>
          <tbody>
            {s.freshness.map((f) => (
              <tr key={f.source}>
                <td>{f.source}</td>
                {events ? <td className="an-num">{f.last_event_ms === null ? <span className="text-ink-subtle">none</span> : clockText(f.last_event_ms)}</td> : null}
                {reads ? <td className="an-num">{f.last_read_ms == null ? <span className="text-ink-subtle">not read</span> : clockText(f.last_read_ms)}</td> : null}
                <td className="num">
                  <CoverageBar share={f.coverage.share} text={f.coverage.share === null ? "–" : `${f.coverage.covered} of ${f.coverage.of}`} />
                </td>
                <td className="text-caption text-ink-subtle">{f.note ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CoverageBar({ share, text }: { share: number | null; text: string }) {
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span className="an-num text-caption">{text}</span>
      <svg width="48" height="8" aria-hidden="true">
        <rect x="0" y="1" width="48" height="6" rx="2" style={{ fill: "var(--an-grid)" }} />
        {share !== null ? <rect x="0" y="1" width={Math.max(1, 48 * share)} height="6" rx="2" style={{ fill: share < 0.9 ? "var(--an-wait)" : "var(--an-bar)" }} /> : null}
      </svg>
    </span>
  );
}
