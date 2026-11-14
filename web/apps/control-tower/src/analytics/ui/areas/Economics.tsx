/**
 * Agent & Model Economics: recorded cost and tokens only, with what was not recorded in view. Cost
 * is per execution (K1), per model (K2) and per ticket (K4), as Claude Code reported it and MACH
 * recorded it. Never per agent or per station (K5), never priced from tokens, never split by time.
 *
 * Only this area offers the Model control: choosing a model narrows every figure recorded per model
 * and leaves the rest saying they are not recorded per model, never unfiltered. A chip removes it.
 */
import { contributorKey, groupedKey, MODELS, type MetricGroup } from "../../contract";
import { rankGroups, valueBins } from "../../model/charts";
import { count, coverageText, dayText, durationText, p50Text, pct, plural, tokens, usd } from "../../model/format";
import { costExclusionWords, failedCostWords, failedResultCost, failedResultCostWords } from "../../model/costCoverage";
import { useFailedCost } from "../failedCost";
import { LIST_CAP, pageCut } from "../../model/capped";
import { costSeries } from "../../model/pulse";
import { grainFor } from "../../model/series";
import { Columns, PartsBar, RankTable } from "../charts";
import { AreaFrame, ChartFrame, Chip, NotRecorded, Readout, rowMissing, SectionHead, TooFew, useAnalytics } from "../kit";
import type { EconomicsProps } from "../types";
import { NothingYet, RecordedTotal } from "./shared";

const TOKEN_KINDS = [
  ["cache_read", "Cache read", "var(--an-seq-1)"],
  ["cache_creation", "Cache creation", "var(--an-seq-2)"],
  ["input", "Input", "var(--an-seq-3)"],
  ["output", "Output", "var(--an-seq-4)"],
] as const;

export function Economics(props: EconomicsProps) {
  return (
    <AreaFrame
      id="economics"
      title="Agent and model economics"
      intro="What executions cost and used, as Claude Code reported it and MACH recorded it. Totals are lower bounds wherever a record is missing."
      props={props}
      aside={<ModelControl model={props.model} setModel={props.onModel} />}
    >
      {() => <EconomicsBody model={props.model} setModel={props.onModel} />}
    </AreaFrame>
  );
}

function ModelControl({ model, setModel }: { model: string | null; setModel(m: string | null): void }) {
  return (
    <div className="flex flex-col gap-1" role="radiogroup" aria-label="Model">
      <span className="text-caption text-ink-muted">Model, for figures recorded per model</span>
      <div className="flex rounded-sm border border-line-control">
        {[null, ...MODELS].map((m) => (
          <button key={m ?? "all"} type="button" role="radio" aria-checked={model === m} onClick={() => setModel(m)} className={`h-7 px-2.5 text-body-sm ${model === m ? "bg-accent-soft font-semibold text-accent-ink" : "text-ink-muted hover:text-ink"}`}>
            {m ?? "All"}
          </button>
        ))}
      </div>
    </div>
  );
}

function EconomicsBody({ model, setModel }: { model: string | null; setModel(m: string | null): void }) {
  const { snapshot: s, density, rows } = useAnalytics();
  const listed = useFailedCost();
  const t = s.totals;
  if (density === "empty" && !s.no_whole_day) return <NothingYet about="No execution was claimed in this window, so nothing was recorded as spent. Economics reads:" />;
  const k1 = t.K1;
  // One count each, used everywhere it is said: the members the observer excluded (cost: K1's; usage: K2's, over completed executions).
  const excludedOf = (c: { of: number | null; covered: number | null; excluded?: readonly { count: number }[] } | undefined) =>
    c?.excluded && c.excluded.length ? c.excluded.reduce((n, e) => n + e.count, 0) : Math.max(0, (c?.of ?? 0) - (c?.covered ?? 0));
  const noCost = excludedOf(k1?.coverage);
  const costWhy = costExclusionWords(k1?.coverage);
  // From a reply that carries it (coverage.other), else from the view's executions list (D8).
  const carried = failedResultCost(k1?.coverage);
  const failedLine = carried ? failedResultCostWords(carried) : listed ? failedCostWords(listed) : null;
  const noUsage = excludedOf(t.K2?.coverage);
  const usageOf = t.K2?.coverage.of ?? null;
  const k2 = s.grouped[groupedKey("K2", "model")];
  const k3m = s.grouped[groupedKey("K3", "model")];
  const k3k = s.grouped[groupedKey("K3", "token_kind")];
  const costs = (s.contributors.K1?.items ?? []).map((c) => c.value);
  const known = costs.filter((v): v is number => v !== null);
  const chip = model ? <Chip label="Model" value={model} onRemove={() => setModel(null)} /> : null;
  // The observer groups by the recorded model id ("claude-sonnet-5-5"); a tier is the family that id names.
  const ofTier = (key: string, m: string) => key === m || key.split("-").includes(m);
  const modelRows = MODELS.map((m) => ({ m, g: k2?.groups?.find((x) => ofTier(x.key, m)), tk: k3m?.groups?.find((x) => ofTier(x.key, m)) }));

  return (
    <>
      <div className="an-readouts">
        <RecordedTotal row={k1} />
        <Readout row={k1} label="Per execution" drill={{ key: "K1", title: "Executions by recorded cost", unit: "usd" }} />
        <Readout row={t.K4} label="Per ticket" drill={{ key: "K4", title: "Tickets by recorded cost", unit: "usd" }} />
        <Readout row={t.K3} label="Tokens per model, per execution" />
      </div>
      {noCost && !rowMissing(k1) ? (
        // Per execution and per ticket count recorded cost only: never read as full coverage when executions were left out.
        <p className="-mt-2 mb-4 text-caption text-ink-muted" data-cost-coverage="">
          Per execution and per ticket count recorded cost only: {count(k1?.coverage.covered ?? 0)} of {count(k1?.coverage.of ?? 0)} executions
          {t.K4 ? `; per ticket covers ${coverageText(t.K4.coverage)}` : ""}.
        </p>
      ) : null}
      {failedLine && !rowMissing(k1) ? (
        <p className="-mt-2 mb-4 text-caption text-ink-muted" data-cost-outside-figure="">
          {failedLine}
        </p>
      ) : null}

      {rowMissing(k1) ? null : noCost || noUsage ? (
        <div className="rounded-md border border-warning-line bg-warning-soft px-4 py-3 text-body-sm text-warning-ink" role="note">
          <strong className="font-semibold">Recording is incomplete.</strong> {plural(noCost, "execution")} of {count(k1?.coverage.of ?? 0)} carry no recorded cost{costWhy ? ` (${costWhy})` : ""}, and {plural(noUsage, "execution")}{usageOf !== null ? ` of ${count(usageOf)} ${t.K2?.coverage.unit ?? "completed executions"}` : ""} carry no per-model usage. Hand-driven work has no execution and no cost. Every total here is what was recorded, not what was spent.{" "}
          {rows ? (
            <button type="button" className="underline" onClick={() => rows({ key: "K1", title: "Executions by recorded cost, including those without one", unit: "usd" })}>
              List them
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="an-grid-2">
        <section className="an-section" id="coverage">
          <SectionHead title="Recorded cost over time" question="Recorded cost per period, and where an execution recorded none." />
          <CostTrend />
        </section>
        <section className="an-section">
          <SectionHead title="Cost beside integrated work" question="Weekly, on separate scales: recorded cost, and tickets merged into the default branch (what MACH records; not a product decision)." />
          <CostVsDelivery />
        </section>
      </div>

      <div className="an-grid-2">
        <section className="an-section">
          <SectionHead title="Model usage" question="Executions that used each model (K2), and recorded cost per execution for it.">
            {chip}
          </SectionHead>
          {rowMissing(k2) ? (
            <NotRecorded compact title={rowMissing(k2)!.title} what={rowMissing(k2)!.why} why="Nothing is drawn in its place." state="unavailable" />
          ) : (
            <ChartFrame chart="economics-models" foot={`Per-model usage from the execution stream (K2, K3)${t.K2 ? `; coverage ${coverageText(t.K2.coverage)}${t.K2.coverage.unit ? ` ${t.K2.coverage.unit}` : ""}` : ""}.`} title="Executions using each model" question="Select a model to narrow every figure recorded per model. An execution that used three models is counted under each." summary={modelRows.map(({ m, g }) => `${m}: ${g?.denominator ?? 0} executions, ${usd(g?.value)} per execution`).join("; ")} table={{ columns: [{ label: "Model" }, { label: "Executions", num: true }, { label: "Per execution", num: true }, { label: "Tokens each", num: true }], rows: modelRows.map((r) => [r.m, r.g ? count(r.g.denominator) : "–", usd(r.g?.value), tokens(r.tk?.value)]) }}>
              <RankTable<(typeof modelRows)[number]>
                caption="Executions using each model"
                rows={modelRows}
                rowKey={(r) => r.m}
                rowName={(r) => `${r.m}: ${r.g ? `${plural(r.g.denominator ?? 0, "execution")}, ${usd(r.g.value)} recorded per execution` : model && model !== r.m ? `not in this view; select it to narrow to it` : "not used"}`}
                initial={{ key: "n", dir: "desc" }}
                selected={model}
                onActivate={(r) => setModel(model === r.m ? null : r.m)}
                columns={[
                  { key: "m", label: "Model", sort: (r) => r.m, cell: (r) => <span className="an-mono">{r.m}</span>, width: "18%" },
                  { key: "n", label: "Executions", sort: (r) => r.g?.denominator ?? null, cell: (r) => (r.g ? count(r.g.denominator) : model && model !== r.m ? "not in this view" : "not used"), bar: { value: (r) => r.g?.denominator ?? null, tone: "var(--an-live)" } },
                  { key: "per", label: "Per execution", num: true, sort: (r) => r.g?.value ?? null, cell: (r) => usd(r.g?.value) },
                  { key: "tk", label: "Tokens each", num: true, sort: (r) => r.tk?.value ?? null, cell: (r) => tokens(r.tk?.value) },
                ]}
              />
            </ChartFrame>
          )}
          <div className="mt-6">
            <ChartFrame
              chart="economics-token-kinds"
              requires={[t.K3]}
              title="Tokens by kind"
              summary={TOKEN_KINDS.map(([k, label]) => `${label}: ${tokens(k3k?.groups?.find((g) => g.key === k)?.numerator)}`).join("; ")}
              table={{ columns: [{ label: "Kind" }, { label: "Tokens", num: true }], rows: TOKEN_KINDS.map(([k, label]) => [label, tokens(k3k?.groups?.find((g) => g.key === k)?.numerator)]) }}
              foot={`From per-model usage in the execution stream${model ? `, ${model} only` : ""}${t.K3 ? `; coverage ${coverageText(t.K3.coverage)}` : ""}. The stream gives no token kinds per agent. One hue, light to dark; the parts are of one whole.`}
            >
              <PartsBar
                name="Tokens by kind"
                parts={TOKEN_KINDS.map(([k, label, tone]) => {
                  const v = k3k?.groups?.find((g) => g.key === k)?.numerator ?? 0;
                  const total = TOKEN_KINDS.reduce((n, [kk]) => n + (k3k?.groups?.find((g) => g.key === kk)?.numerator ?? 0), 0);
                  return { key: k, label, value: v, tone, text: `${tokens(v)} (${total ? pct(v / total) : "–"})` };
                })}
              />
            </ChartFrame>
          </div>
        </section>
        <section className="an-section">
          <SectionHead title="Execution cost distribution" question="Executions with a recorded cost, in one-dollar bins." />
          {rowMissing(t.K1) ? (
            <NotRecorded title={rowMissing(t.K1)!.title} what={rowMissing(t.K1)!.why} why="Nothing is drawn in its place: a missing figure is not a zero." compact state="unavailable" />
          ) : known.length < 5 ? (
            <TooFew what="executions with a recorded cost" n={known.length} need={5} periods={1} />
          ) : (
            <CostDistribution values={known} missing={noCost} withCost={k1?.coverage.covered ?? null} cut={pageCut(s.contributors.K1)} />
          )}
          <div className="mt-6 flex flex-col gap-3">
            <NotRecorded title="Cost per agent or per station: not available" what={sentence(t.K5?.null_reason ?? "the stream gives no per-agent cost.")} why="Splitting an execution's cost by agent time or by tokens would be an estimate; it is never shown." compact />
            <NotRecorded title="Turns and duration per execution: not available" what={sentence(t.K6?.null_reason ?? "not forwarded by the contract.")} why="The result's turn count and duration describe its last turn only." compact />
          </div>
        </section>
      </div>

      <section className="an-section">
        <SectionHead title="Agents" question={`Per agent, from the execution stream${model ? `, ${model} only` : ""}. Station and seat are read from the agent's label.`}>
          {chip}
        </SectionHead>
        <Agents />
      </section>
    </>
  );
}

/** The observer's reason without its leading "not available:", as a sentence. */
function sentence(reason: string): string {
  const r = reason.replace(/^not available:\s*/, "");
  return `${r.charAt(0).toUpperCase()}${r.slice(1)}${r.endsWith(".") || r.endsWith(")") ? "" : "."}`;
}

function CostTrend() {
  const { snapshot: s, density, window: setWindow } = useAnalytics();
  const from = s.window.from_ms;
  const to = s.window.to_ms;
  const grain = grainFor(from, to);
  const series = costSeries(s.grouped[groupedKey("K1", "day")], from, to, grain);
  if (!rowMissing(s.totals.K1) && density !== "many") return <TooFew what="finished tickets" n={s.runs.length} need={10} />;
  const every = Math.max(1, Math.ceil(series.length / 7));
  const label = (p: (typeof series)[number]) => dayText(grain === "day" ? p.from : p.to - 1);
  return (
    <ChartFrame
      chart="economics-cost-trend"
      requires={[s.totals.K1]}
      title={`Recorded cost per ${grain}`}
      summary={`Recorded cost per ${grain} over ${series.length} ${grain}s; the highest recorded ${usd(Math.max(...series.map((d) => d.cost ?? 0)))}. ${series.filter((d) => d.without).length} ${grain}s had executions with no recorded cost.`}
      table={{ columns: [{ label: grain === "day" ? "Day" : "Week to" }, { label: "Recorded cost", num: true }, { label: "Executions with a cost", num: true }, { label: "Without", num: true }], rows: series.map((d) => [label(d), usd(d.cost), count(d.withCost), count(d.without)]) }}
      foot="Marks under the axis: periods in which some executions recorded no cost. What they cost is unknown, so it is not added; those columns are lower bounds. Drag across the columns to look at those periods alone."
      actions={<span className="flex gap-3"><KeySwatch /></span>}
    >
      <Columns
        label={`Recorded cost per ${grain}`}
        onWindow={setWindow}
        height={150}
        format={(v) => usd(v).replace(".00", "")}
        points={series.map((d, i) => ({
          key: d.key,
          value: d.cost,
          flag: d.without > 0,
          from: d.from,
          to: d.to,
          tick: i % every === 0 ? label(d) : undefined,
          card: { title: grain === "day" ? label(d) : `Week to ${label(d)}`, rows: d.withCost + d.without === 0 ? [["executions", "none claimed"]] : [["recorded", usd(d.cost)], ["executions with a cost", count(d.withCost)], ["without a cost", count(d.without)]], ...(d.without ? { foot: "A lower bound." } : {}) },
        }))}
      />
    </ChartFrame>
  );
}

function KeySwatch() {
  return (
    <span className="inline-flex items-center gap-1.5 text-caption text-ink-muted">
      <svg width="12" height="6" aria-hidden="true">
        <rect x="0" y="1.5" width="12" height="3" rx="1" style={{ fill: "var(--an-wait)" }} />
      </svg>
      some cost not recorded
    </span>
  );
}

function CostVsDelivery() {
  const { snapshot: s, density } = useAnalytics();
  const from = s.window.from_ms;
  const to = s.window.to_ms;
  const costW = costSeries(s.grouped[groupedKey("K1", "day")], from, to, "week");
  const merges = s.grouped[groupedKey("T1", "day")];
  const mergedOf = (a: number, b: number) => (merges?.groups ?? []).filter((g) => Date.parse(g.key) >= a && Date.parse(g.key) < b).reduce((n, g) => n + (g.value ?? 0), 0);
  if (!rowMissing(s.totals.K1) && (density !== "many" || costW.length < 3)) return <TooFew what="weeks" n={costW.length} need={3} periods={3} />;
  const every = Math.max(1, Math.ceil(costW.length / 6));
  return (
    <ChartFrame
      chart="economics-cost-delivery"
      requires={[s.totals.K1, s.totals.T1]}
      title="Per week, two charts, two scales"
      summary={costW.map((w) => `week to ${dayText(w.to - 1)}: ${usd(w.cost)} recorded, ${mergedOf(w.from, w.to)} tickets merged`).join("; ")}
      table={{ columns: [{ label: "Week to" }, { label: "Recorded cost", num: true }, { label: "Tickets merged", num: true }], rows: costW.map((w) => [dayText(w.to - 1), usd(w.cost), count(mergedOf(w.from, w.to))]) }}
      foot="A cost is counted on the day its execution completed and a merge on the day it landed, often in a later week; the two are shown one above the other, not divided."
    >
      <div className="text-caption text-ink-muted">Recorded cost</div>
      <Columns label="Recorded cost per week" height={92} format={(v) => usd(v).replace(".00", "")} points={costW.map((w) => ({ key: w.key, value: w.cost, flag: w.without > 0, card: { title: `Week to ${dayText(w.to - 1)}`, rows: [["recorded", usd(w.cost)], ["without a cost", count(w.without)]] } }))} />
      <div className="mt-2 text-caption text-ink-muted">Tickets merged (T1)</div>
      <Columns label="Tickets merged per week" height={104} format={count} tone="var(--an-pass)" points={costW.map((w, i) => ({ key: w.key, value: mergedOf(w.from, w.to), tick: i % every === 0 || i === costW.length - 1 ? dayText(w.to - 1) : undefined, card: { title: `Week to ${dayText(w.to - 1)}`, rows: [["tickets merged", count(mergedOf(w.from, w.to))]] } }))} />
    </ChartFrame>
  );
}

/**
 * The dots are the K1 contributor list, cut at its row cap; "without one" is K1's coverage. When the list
 * was cut, the bins hold only the listed executions and say so; the count with a cost is the reply's.
 */
function CostDistribution({ values, missing, withCost, cut }: { values: readonly number[]; missing: number; withCost: number | null; cut: boolean }) {
  const bins = valueBins(values, 1);
  const every = Math.max(1, Math.ceil(bins.length / 8));
  return (
    <ChartFrame
      chart="economics-cost-distribution"
      title="Executions by recorded cost"
      summary={`${cut ? `${values.length} listed of ${withCost ?? "an unknown number of"}` : values.length} executions with a recorded cost, from ${usd(Math.min(...values))} to ${usd(Math.max(...values))}${cut ? " among those listed" : ""}; ${missing} without one.`}
      table={{ columns: [{ label: "Cost" }, { label: "Executions", num: true }], rows: bins.map((b) => [`${usd(b.from)} to ${usd(b.to)}`, count(b.count)]) }}
      foot={`${plural(missing, "execution")} with no recorded cost are not placed in any bin.${cut ? ` The list behind these bins is cut at ${LIST_CAP} rows: ${values.length} of ${withCost ?? "more"} executions with a recorded cost are drawn, so the bins are lower bounds.` : ""}`}
    >
      <Columns label="Executions by recorded cost" height={140} format={count} points={bins.map((b, i) => ({ key: String(b.from), value: b.count, tick: i % every === 0 ? `$${b.from}` : undefined, card: { title: `${usd(b.from)} to ${usd(b.to)}`, rows: [["executions", count(b.count)]] } }))} />
    </ChartFrame>
  );
}

function Agents() {
  const { snapshot: s, rows } = useAnalytics();
  const k8 = rankGroups(s.grouped[groupedKey("K8", "station")], "denominator");
  const k10 = s.grouped[groupedKey("K10", "station")];
  const k7 = s.grouped[groupedKey("K7", "station")];
  const k9 = s.grouped[groupedKey("K9", "phase")];
  if (s.totals.K8?.basis === "not-recorded" || k8.length === 0) return <NotRecorded title="Agents not recorded" what="The execution stream carried no agent records in this window." why="Agents are observed from the stream's agent.started and agent.finished." />;
  const rowsOf = (g: MetricGroup) => ({ g, tools: k10?.groups?.find((x) => x.key === g.key), tokens: k7?.groups?.find((x) => x.key === g.key) });
  const data = k8.map(rowsOf);
  return (
    <>
      <ChartFrame
        chart="economics-agents"
        title="Agents by station"
        question="Time from agent.started to agent.finished, tool calls (a count; which tools and how long each took are not recorded), and one token total per agent (no kinds). Sort by any column; select a row for its agents."
        summary={data.map((d) => `${d.g.key}: ${d.g.denominator} agents, median ${p50Text(d.g)}, ${d.tools?.value?.toFixed(1) ?? "–"} tool calls each, ${tokens(d.tokens?.value)} tokens each`).join("; ")}
        table={{ columns: [{ label: "Station" }, { label: "Agents", num: true }, { label: "Median time", num: true }, { label: "Mean", num: true }, { label: "Tool calls each", num: true }, { label: "Tokens each", num: true }], rows: data.map((d) => [d.g.key, count(d.g.denominator), p50Text(d.g), durationText(d.g.value), d.tools?.value === null || d.tools?.value === undefined ? "–" : d.tools.value.toFixed(1), tokens(d.tokens?.value)]) }}
        foot={<>{rowMissing(k9) ? "Queue time is not recorded per model." : (k9?.groups ?? []).length ? `Queue median: ${(k9?.groups ?? []).map((g) => `${g.key} ${p50Text(g)}`).join(", ")}.` : `Queue time by phase is not listed${k9?.groups_reason ? `: ${k9.groups_reason}` : ""}.`} Clerks that relay “what next?” carry no station{s.totals.K8?.coverage.share !== null && s.totals.K8 ? `; ${pct(s.totals.K8.coverage.share)} of agents covered` : ""}. Tool-call counts are not tool-call spans.</>}
      >
        <RankTable<(typeof data)[number]>
          caption="Agents by station"
          rows={data}
          rowKey={(d) => d.g.key}
          rowName={(d) => `${d.g.key}: ${plural(d.g.denominator ?? 0, "agent")}; open their rows`}
          initial={{ key: "time", dir: "desc" }}
          onActivate={rows ? (d) => rows({ key: contributorKey("K8", "station", d.g.key), title: `Agents labelled ${d.g.key}, longest first`, unit: "ms" }) : undefined}
          columns={[
            { key: "station", label: "Station", sort: (d) => d.g.key, cell: (d) => d.g.key, width: "14%" },
            { key: "n", label: "Agents", num: true, sort: (d) => d.g.denominator, cell: (d) => count(d.g.denominator) },
            { key: "time", label: "Median time", sort: (d) => d.g.p50_ms ?? null, cell: (d) => p50Text(d.g), bar: { value: (d) => d.g.p50_ms ?? null } },
            { key: "mean", label: "Mean", num: true, sort: (d) => d.g.value, cell: (d) => durationText(d.g.value) },
            { key: "tools", label: "Tool calls each", num: true, sort: (d) => d.tools?.value ?? null, cell: (d) => (d.tools?.value === null || d.tools?.value === undefined ? "–" : d.tools.value.toFixed(1)) },
            { key: "tokens", label: "Tokens each", num: true, sort: (d) => d.tokens?.value ?? null, cell: (d) => tokens(d.tokens?.value) },
          ]}
        />
      </ChartFrame>
    </>
  );
}
