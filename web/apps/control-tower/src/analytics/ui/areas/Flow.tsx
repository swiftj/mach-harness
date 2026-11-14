/**
 * Flow & Bottlenecks: the Factory Flow drawing of the belt, a selected station's visits, the ranking
 * of where measured time went, waits by kind, and work in parallel against the recorded limit.
 * Selecting a station (in the drawing or the ranking) narrows the station detail and the slowest
 * visits to it and marks it in the ranking; a chip says so and removes it.
 */
import { useMemo } from "react";
import { contributorKey, groupedKey, type Station } from "../../contract";
import { bottleneckRanking, groupOf, histogramBins, transitionKind, type StationLoad } from "../../model/charts";
import { count, durationCompact, durationText, pct, plural } from "../../model/format";
import { durationShows } from "../../model/sample";
import { DurationHistogram, LogNote, RangeRows, RankTable, StepPanels } from "../charts";
import { FlowDiagram, STATION_WORDS, type FlowStationFacts } from "../charts/Flow";
import { Announce, AreaFrame, ChartFrame, Chip, NotRecorded, Readout, rowMissing, SectionHead, useAnalytics } from "../kit";
import type { FlowProps } from "../types";
import { NothingYet } from "./shared";
import { RefList } from "./RefList";

export function Flow(props: FlowProps) {
  return (
    <AreaFrame id="flow" title="Flow and bottlenecks" intro="Where time goes between dispatch and merge, measured from each cell's lifecycle log. Waits are shown apart from work." props={props}>
      {() => <FlowBody station={props.station} setStation={props.onStation} />}
    </AreaFrame>
  );
}

function FlowBody({ station, setStation }: { station: Station | null; setStation(s: Station | null): void }) {
  const { snapshot: s, density } = useAnalytics();
  const t = s.totals;
  const c1 = s.grouped[groupedKey("C1", "station")];
  const x2 = s.grouped[groupedKey("X2", "station")];
  const loads = useMemo(() => bottleneckRanking(c1), [c1]);
  const missing = rowMissing(t.C1);
  if (density === "empty") return <NothingYet about="No cell has entered a station in this window. Flow is read from each cell's lifecycle log:" />;
  const facts: Partial<Record<Station, FlowStationFacts>> = {};
  for (const g of c1?.groups ?? []) {
    const st = g.key as Station;
    const page = s.contributors[contributorKey("C1", "station", st)];
    facts[st] = { visits: g.denominator ?? 0, p50: g.p50_ms ?? null, totalMs: g.numerator ?? 0, refusals: groupOf(x2, st)?.numerator ?? 0, open: page?.items.filter((c) => c.value === null).length ?? 0 };
  }
  const w3Open = s.contributors.W3?.items.filter((c) => c.value === null).length ?? 0;
  const focus: Station = station ?? (loads[0]?.station as Station | undefined) ?? "build";
  const chip = station ? <Chip label="Station" value={STATION_WORDS[station]} onRemove={() => setStation(null)} /> : null;

  return (
    <>
      <div className="an-readouts">
        <Readout row={t.C3} label="Dispatch to merge" drill={{ key: "C3", title: "Product tickets, dispatch to merge", unit: "ms" }} />
        <Readout row={t.C4} label="Eligible to integrated" drill={{ key: "C4", title: "Slices, eligible to integrated", unit: "ms" }} />
        <Readout row={t.C2} label="Station visits per ticket" />
        <Readout row={t.X2} label="Gate refusals" />
      </div>

      <section className="an-section">
        <SectionHead title="Factory Flow" question="Recorded moves between stations, with each station's median visit.">
          {chip}
        </SectionHead>
        {missing ? (
          t.C1?.status === "unavailable" ? (
            <NotRecorded title={missing.title} what={missing.why} why="Station visits are recorded per station, risk and app type." state="unavailable" />
          ) : (
            <NotRecorded title="Station visits are not recorded for this history" what="No cell in this window kept a lifecycle log, so MACH recorded no station entries, exits or moves between them." why="Stations write the lifecycle log from M6.1 onward. Delivery, waits from the intake log, cost and run records are still shown in the other areas." />
          )
        ) : (
          <ChartFrame
            chart="flow-diagram"
            title="Moves between stations"
            question="Select a station to read its visits below; the arrows move between stations."
            summary={`Recorded moves between stations. ${s.transitions.filter((x) => transitionKind(x) === "revise").reduce((n, x) => n + x.count, 0)} moves went back to build to revise.${station ? ` ${STATION_WORDS[station]} is selected.` : ""}`}
            table={{ columns: [{ label: "From" }, { label: "To" }, { label: "Moves", num: true }, { label: "Tickets", num: true }, { label: "Kind" }], rows: s.transitions.map((x) => [STATION_WORDS[x.from], STATION_WORDS[x.to], count(x.count), count(x.tickets), transitionKind(x)]) }}
            foot="Each station shows its median measured visit and how many visits were measured. Line width is the number of recorded moves between two stations, not the path of any one ticket. Red loops go back to build after a failed verification or a rejected review. The bar in each station is its share of measured station time; ⊘ counts gate refusals."
          >
            <FlowDiagram transitions={s.transitions} facts={facts} loads={loads} selected={station} onSelect={setStation} humanFacts={{ waits: t.W3?.denominator_value ?? 0, p50: t.W3?.p50_ms ?? null, open: w3Open }} />
          </ChartFrame>
        )}
      </section>

      {missing ? null : (
        <div className="an-grid-2">
          <section className="an-section">
            <Announce on={station}>{`${focus === "human" ? "Human approval" : `${STATION_WORDS[focus]} station`} selected; its figures follow the flow.`}</Announce>
            <SectionHead title={focus === "human" ? "Human approval" : `${STATION_WORDS[focus]} station`} question={station ? "Selected in the flow." : "The station holding the most measured time; select another in the flow or the ranking."} />
            {focus === "human" ? <HumanDetail /> : <StationDetail station={focus} />}
          </section>
          <section className="an-section">
            <SectionHead title="Where measured time went" />
            <ChartFrame
              chart="flow-ranking"
              title="Total measured time by station"
              question="Each station's visits added together, so one slow visit cannot outrank a station that held dozens. Sort by any column; select a row to read that station."
              summary={loads.map((l) => `${STATION_WORDS[l.station]} ${pct(l.share)}`).join(", ")}
              table={{ columns: [{ label: "Station" }, { label: "Share", num: true }, { label: "Total", num: true }, { label: "Visits", num: true }, { label: "Median", num: true }, { label: "Mean", num: true }], rows: loads.map((l) => [STATION_WORDS[l.station], pct(l.share), durationText(l.totalMs), count(l.visits), durationText(l.p50), durationText(l.visits ? l.totalMs / l.visits : null)]) }}
              chips={chip}
              foot="Measured visits only: a visit cut by an interrupted execution or still open has no measured duration and is listed, not counted. The mean is the catalog's C1; the median leads because visit times are skewed."
            >
              <RankTable<StationLoad>
                caption="Total measured time by station"
                rows={loads}
                rowKey={(l) => l.station}
                rowName={(l) => `${STATION_WORDS[l.station]}: ${durationText(l.totalMs)} over ${plural(l.visits, "visit")}, ${pct(l.share)} of the total`}
                initial={{ key: "total", dir: "desc" }}
                selected={station}
                onActivate={(l) => setStation(station === l.station ? null : l.station)}
                columns={[
                  { key: "station", label: "Station", sort: (l) => l.station, cell: (l) => STATION_WORDS[l.station], width: "22%" },
                  { key: "total", label: "Total", sort: (l) => l.totalMs, cell: (l) => durationText(l.totalMs), bar: { value: (l) => l.totalMs } },
                  { key: "visits", label: "Visits", num: true, sort: (l) => l.visits, cell: (l) => count(l.visits) },
                  { key: "p50", label: "Median", num: true, sort: (l) => l.p50, cell: (l) => durationCompact(l.p50) },
                  { key: "mean", label: "Mean", num: true, sort: (l) => (l.visits ? l.totalMs / l.visits : null), cell: (l) => durationCompact(l.visits ? l.totalMs / l.visits : null) },
                ]}
              />
            </ChartFrame>
          </section>
        </div>
      )}

      <section className="an-section">
        <SectionHead title="Waiting" question="Time a ticket spent not being worked on, by what it waited for." />
        <ChartFrame
          chart="flow-waits"
          title="Waits by kind"
          summary={(["W1", "W2", "W2b", "W3"] as const).map((id) => `${t[id]?.name}: ${t[id]?.denominator_value ?? 0} measured, median ${durationText(t[id]?.p50_ms)}`).join("; ")}
          table={{ columns: [{ label: "Wait" }, { label: "Measured", num: true }, { label: "Median", num: true }, { label: "Mean", num: true }, { label: "90th", num: true }, { label: "Longest", num: true }, { label: "Total", num: true }], rows: (["W1", "W2", "W2b", "W3"] as const).map((id) => [t[id]?.name ?? id, count(t[id]?.denominator_value ?? 0), durationText(t[id]?.p50_ms), durationText(t[id]?.value), durationShows(t[id]?.denominator_value).p90 ? durationText(t[id]?.p90_ms) : "–", durationText(t[id]?.max_ms), durationText(t[id]?.numerator_value)]) }}
          foot={<>Not additive: a hold for execution capacity is part of the queue wait (the intake log cannot separate a cell-capacity wait from an engineer's), and the approval wait is counted per round. Capacity holds are reconstructed from the scheduler's decisions, in supervised mode only. <LogNote /></>}
        >
          <RangeRows
            rows={(
              [
                ["W1", "Dependency", "var(--an-bar)"],
                ["W2", "Queue (eligible, not dispatched)", "var(--an-bar)"],
                ["W2b", "Execution capacity", "var(--an-live)"],
                ["W3", "Human approval", "var(--an-human)"],
              ] as const
            ).map(([id, label, tone]) => {
              const r = t[id];
              const open = s.contributors[id]?.items.filter((c) => c.value === null).length ?? 0;
              return { key: id, label, n: r?.denominator_value ?? 0, min: r?.min_ms, p50: r?.p50_ms, p90: r?.p90_ms, max: r?.max_ms, total: r?.numerator_value, tone, open, ...(r?.basis === "not-recorded" ? { note: "not recorded" } : id === "W2b" && r?.value !== null ? { note: `${r?.denominator_value ?? 0} reconstructed` } : {}) };
            })}
          />
        </ChartFrame>
      </section>

      <section className="an-section">
        <SectionHead title="Work in parallel" question="How much ran at once, each on its own scale, against the recorded limit." />
        {s.concurrency ? (
          <ChartFrame
            chart="flow-parallel"
            title="Active at once"
            summary={s.concurrency.lines.map((l) => `${l.kind}: at most ${Math.max(0, ...l.counts)}`).join("; ")}
            table={{ columns: [{ label: "What ran" }, { label: "At most at once", num: true }, { label: "Recorded limit" }], rows: s.concurrency.lines.map((l) => [l.kind === "execution" ? "Executions running" : l.kind === "visit" ? "Cells in a station" : "Agents working", count(Math.max(0, ...l.counts)), l.kind === "execution" && s.concurrency!.limits.length ? [...new Set(s.concurrency!.limits.map((x) => x.value))].join(" then ") : "not recorded"]) }}
            foot={`The most active at once in each ${durationText(s.concurrency.bucket_ms)} bucket, counted from recorded spans. The dashed rule is the Factory's recorded max_parallel, which counts executions; it is not inferred from activity, and the number of events is not a workload.`}
          >
            <StepPanels
              from={s.window.from_ms}
              to={s.window.to_ms}
              bucketMs={s.concurrency.bucket_ms}
              lines={s.concurrency.lines.map((l) => ({ kind: l.kind, label: l.kind === "execution" ? "Executions running" : l.kind === "visit" ? "Cells in a station" : "Agents working", counts: l.counts, limit: l.kind === "execution" ? s.concurrency!.limits.map((x) => ({ from: x.from_ms, to: x.to_ms, value: x.value })) : [] }))}
            />
          </ChartFrame>
        ) : (
          <NotRecorded title="Concurrency not served" what="This source does not serve counts of work active at once." why="Counts come from the observer's concurrency reply." state="unavailable" />
        )}
      </section>
    </>
  );
}

function StationDetail({ station }: { station: Station }) {
  const { snapshot: s, rows, open } = useAnalytics();
  const g = groupOf(s.grouped[groupedKey("C1", "station")], station);
  const refusals = groupOf(s.grouped[groupedKey("X2", "station")], station);
  const agents = groupOf(s.grouped[groupedKey("K8", "station")], station);
  const tools = groupOf(s.grouped[groupedKey("K10", "station")], station);
  const page = s.contributors[contributorKey("C1", "station", station)];
  const later = page?.items.filter((c) => /#([2-9]|\d\d)$/.test(c.ref)).length ?? 0;
  const revise = s.transitions.filter((x) => x.to === station && transitionKind(x) === "revise").reduce((n, x) => n + x.count, 0);
  if (!g) return <p className="text-body-sm text-ink-muted">No visits to {STATION_WORDS[station].toLowerCase()} in this window.</p>;
  const shows = durationShows(g.denominator);
  const bins = histogramBins(g.distribution?.histogram);
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-4 @[520px]:grid-cols-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))" }}>
        {(
          [
            ["Measured visits", count(g.denominator)],
            [shows.single ? "The one visit" : "Median", shows.single ? durationText(g.value) : durationText(g.p50_ms)],
            ["Mean", shows.mean ? durationText(g.value) : "–"],
            ["90th percentile", shows.p90 ? durationText(g.p90_ms) : "too few"],
            ["Longest", durationText(g.max_ms)],
            ["Revise entries", count(revise)],
            ["Visits after the first", count(later)],
            ["Open, unknown", `${count(g.basis_counts?.open ?? 0)}, ${count(g.basis_counts?.unknown ?? 0)}`],
            ["Gate refusals", refusals ? `${count(refusals.numerator)} of ${count(refusals.denominator)}` : "none"],
          ] as const
        ).map(([k, v]) => (
          <div key={k}>
            <dt className="text-caption text-ink-muted">{k}</dt>
            <dd className="an-fig text-[17px] text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      <ChartFrame
        chart="flow-visit-durations"
        title="Visit durations"
        question="Every measured visit, in buckets of a doubling of time."
        summary={`${g.denominator} measured visits to ${station}; median ${durationText(g.p50_ms)}${shows.p90 ? `, 90th percentile ${durationText(g.p90_ms)}` : ""}, longest ${durationText(g.max_ms)}.`}
        table={{ columns: [{ label: "From" }, { label: "To" }, { label: "Visits", num: true }], rows: bins.map((b) => [durationText(b.fromMs), durationText(b.toMs), count(b.count)]) }}
        foot={<>Percentiles are read from the observer's buckets, as the upper edge of the bucket they fall in. <LogNote /></>}
      >
        <DurationHistogram buckets={g.distribution?.histogram} p50={shows.median ? g.p50_ms : undefined} p90={shows.p90 ? g.p90_ms : undefined} name="visits" />
      </ChartFrame>
      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <h3 className="text-label text-ink">Slowest visits</h3>
          {rows ? (
            <button type="button" className="an-link text-body-sm" onClick={() => rows({ key: contributorKey("C1", "station", station), title: `${STATION_WORDS[station]} visits, slowest first`, unit: "ms" })}>
              All {count(page?.total ?? 0)} visits
            </button>
          ) : null}
        </div>
        <RefList items={(page?.items ?? []).filter((c) => c.value !== null).slice(0, 5)} unit="ms" onOpen={open} />
      </div>
      {agents ? (
        <p className="text-body-sm text-ink-muted">
          Agents labelled for {station}: <span className="an-num font-semibold text-ink">{count(agents.denominator)}</span>, median <span className="an-num font-semibold text-ink">{durationText(agents.p50_ms)}</span>
          {tools?.value !== null && tools?.value !== undefined ? (
            <>
              , <span className="an-num font-semibold text-ink">{tools.value.toFixed(1)}</span> tool calls each on average (a count only)
            </>
          ) : null}
          . Station read from the agent's label.
        </p>
      ) : null}
    </div>
  );
}

function HumanDetail() {
  const { snapshot: s } = useAnalytics();
  const w3 = s.totals.W3;
  const byRisk = s.grouped[groupedKey("W3", "risk")];
  const shows = durationShows(w3?.denominator_value);
  const bins = histogramBins(w3?.distribution?.histogram);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-body-sm text-ink-muted">A wait for a person's approval after review, not a station visit. It is required by the risk tier; nothing here suggests skipping it.</p>
      <Readout row={w3} label="Approval wait" drill={{ key: "W3", title: "Human approval waits", unit: "ms" }} />
      <ChartFrame chart="flow-approval-durations" title="Approval waits" summary={`${w3?.denominator_value ?? 0} measured approval waits.`} table={{ columns: [{ label: "From" }, { label: "To" }, { label: "Waits", num: true }], rows: bins.map((b) => [durationText(b.fromMs), durationText(b.toMs), count(b.count)]) }} foot={<LogNote />}>
        <DurationHistogram buckets={w3?.distribution?.histogram} p50={shows.median ? w3?.p50_ms : undefined} p90={shows.p90 ? w3?.p90_ms : undefined} name="waits" tone="var(--an-human)" />
      </ChartFrame>
      <p className="text-caption text-ink-subtle">
        By risk: {(byRisk?.groups ?? []).map((g) => `${g.key} ${plural(g.denominator ?? 0, "wait")}, median ${durationText(g.p50_ms)}`).join("; ") || "none"}
      </p>
    </div>
  );
}
