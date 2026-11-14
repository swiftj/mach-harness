/**
 * Quality & Remediation: round-1 verification over time, first pass against remediated with the
 * observe target, judging rounds, failure and blocker categories, the paths tickets took to their
 * outcome, quality beside recorded cost, and the observe station's scorecard with its targets.
 *
 * Selecting a failure kind or a blocker rule narrows the ticket-level charts (paths, cost by rounds)
 * to the tickets it was recorded on, with a chip that removes it.
 */
import type { ReactNode } from "react";
import { contributorKey, groupedKey, SCORECARD_IDS, type MetricGroup, type MetricRow, type RunRecord } from "../../contract";
import { linear, medianOf, niceTicks, rankGroups, remediationPaths, roundsDistribution, stripLayout, type RemediationPath } from "../../model/charts";
import { count, dayText, pct, plural, SMALL_SAMPLE, targetText, usd, valueText } from "../../model/format";
import { MIN_TREND_MEMBERS, MIN_TREND_PERIODS, shareText, verdictAllowed } from "../../model/sample";
import { periodSeries } from "../../model/series";
import { Bullet, Columns, PartsBar, RankTable } from "../charts";
import { AreaFrame, ChartFrame, Chip, Definition, Key, Mark, NotRecorded, Readout, rowMissing, SectionHead, TooFew, useAnalytics, useMarkNav, useTip, useWidth, verdictWords } from "../kit";
import type { Pick, QualityProps } from "../types";
import { NothingYet } from "./shared";

export function Quality(props: QualityProps) {
  return (
    <AreaFrame id="quality" title="Quality and remediation" intro="How often work passes verification and review first time, what fails, and what it takes to put it right." props={props}>
      {() => <QualityBody pick={props.pick} setPick={props.onPick} />}
    </AreaFrame>
  );
}

/**
 * Why a count figure observed no member although members are known by exclusion (the observer's
 * coverage says so): its value is null, or members were excluded with a reason. Null when "none" is true.
 */
function unobserved(row: MetricRow | undefined): string | null {
  if (!row) return null;
  const excluded = (row.coverage.excluded ?? []).filter((e) => e.count > 0);
  if (row.value !== null && !excluded.length) return null;
  if (row.value !== null && (row.numerator_value ?? 0) > 0) return null;
  const parts = excluded.map((e) => `${e.count} ${e.reason}`);
  return parts.length ? `Not counted here: ${parts.join("; ")}.` : row.null_reason ? `${row.null_reason.charAt(0).toUpperCase()}${row.null_reason.slice(1)}.` : null;
}

const PICK_WORDS: Readonly<Record<string, string>> = { target_kind: "Failed check", rule: "Blocker rule" };

function QualityBody({ pick, setPick }: { pick: Pick | null; setPick(p: Pick | null): void }) {
  const { snapshot: s, density, open } = useAnalytics();
  const t = s.totals;
  if (density === "empty") return <NothingYet about="No ticket finished, and no verification or review was recorded, in this window. Quality is read from:" />;
  const q4 = rankGroups(s.grouped[groupedKey("Q4", "target_kind")]);
  const r2 = rankGroups(s.grouped[groupedKey("R2", "rule")]);
  const active = pick && (pick.dim === "target_kind" || pick.dim === "rule") ? pick : null;
  // The tickets a picked category was recorded on: from its contributors, never guessed.
  const pickedPage = active ? s.contributors[contributorKey(active.dim === "target_kind" ? "Q4" : "R2", active.dim, active.value)] : undefined;
  // A category whose tickets this source does not list narrows nothing, and says so, rather than showing no tickets.
  const picked = active && pickedPage ? new Set(pickedPage.items.map((c) => c.ticket).filter((x): x is string => !!x)) : null;
  const runs = picked ? s.runs.filter((r) => picked.has(r.ticket_id)) : s.runs;
  const chip = active ? <Chip label={PICK_WORDS[active.dim] ?? active.dim} value={pickedPage ? active.value : `${active.value} (tickets not listed)`} onRemove={() => setPick(null)} /> : null;
  const merged = s.runs.filter((r) => r.outcome === "merged");
  const fp = merged.filter((r) => r.first_pass).length;
  const rounds = roundsDistribution(s.runs);
  const toggle = (dim: Pick["dim"], value: string) => setPick(active && active.dim === dim && active.value === value ? null : { dim, value });

  return (
    <>
      <div className="an-readouts">
        <Readout row={t.Q1} label="Round-1 verification passed" drill={{ key: "Q1", title: "Round-1 verifications", unit: "rate" }} />
        <Readout row={t.Q2} label="First pass (observe)" drill={{ key: "Q2", title: "Merged tickets: first pass or not", unit: "rate" }} />
        <Readout row={t.Q3} label="Judging rounds (observe)" />
        <Readout row={t.R1} label="Review rounds rejected" drill={{ key: "R1", title: "Rejected or escalated review rounds", unit: "count" }} />
        <Readout row={t.R3} label="Security vetoes" />
      </div>

      <div className="an-grid-2">
        <section className="an-section">
          <SectionHead title="Verification outcomes" question="Round-1 verifications per week." />
          <VerifyTrend />
        </section>
        <section className="an-section">
          <SectionHead title="First pass or remediated" question="Merged tickets in this window." />
          {merged.length === 0 ? (
            <p className="text-body-sm text-ink-muted">No merged tickets in this window.</p>
          ) : (
            <ChartFrame chart="quality-first-pass" title="Merged tickets by how they passed" summary={`${fp} of ${merged.length} merged tickets passed first time; ${merged.length - fp} were remediated.`} table={{ columns: [{ label: "How" }, { label: "Tickets", num: true }], rows: [["First pass", count(fp)], ["Remediated", count(merged.length - fp)]] }} foot={verdictAllowed(merged.length) ? "The upright mark is the observe station's target: above 85% first pass." : `Fewer than ${SMALL_SAMPLE} merged tickets: counts only, no target verdict.`}>
              <PartsBar
                name="Merged tickets by how they passed"
                height={20}
                target={verdictAllowed(merged.length) ? 0.85 : undefined}
                targetLabel="target 85%"
                parts={[
                  { key: "first", label: "First pass", value: fp, text: `${count(fp)} (${shareText(fp, merged.length)})`, tone: "var(--an-pass)" },
                  { key: "remediated", label: "Remediated", value: merged.length - fp, text: `${count(merged.length - fp)} (${shareText(merged.length - fp, merged.length)})`, tone: "var(--an-wait)" },
                ]}
              />
            </ChartFrame>
          )}
          <div className="mt-6">
            <ChartFrame
              chart="quality-rounds"
              title="Judging rounds per merged ticket"
              summary={rounds.map((r) => `${r.rounds} rounds: ${r.tickets}`).join(", ")}
              table={{ columns: [{ label: "Rounds", num: true }, { label: "Tickets", num: true }, { label: "Of them escalated", num: true }], rows: rounds.map((r) => [count(r.rounds), count(r.tickets), count(r.escalated)]) }}
              foot="Three judging rounds is the limit; a third failure escalates to a person."
            >
              <Columns label="Merged tickets by judging rounds" height={112} format={count} points={rounds.map((r) => ({ key: String(r.rounds), value: r.tickets, tick: `${r.rounds} ${r.rounds === 1 ? "round" : "rounds"}`, card: { title: `${r.rounds} ${r.rounds === 1 ? "round" : "rounds"}`, rows: [["merged tickets", count(r.tickets)], ["share", shareText(r.tickets, merged.length)], ...(r.escalated ? ([["after escalation", count(r.escalated)]] as [string, string][]) : [])] } }))} />
            </ChartFrame>
          </div>
        </section>
      </div>

      <div className="an-grid-2">
        <section className="an-section" id="failures">
          <SectionHead title="Verification failures by kind" question="Failed checks (Q4), grouped as the observe station groups them." />
          {q4.length === 0 && unobserved(t.Q4) ? (
            <NotRecorded title="Failed checks not observed" what={unobserved(t.Q4)!} why="Missing is not zero: these figures are not counted as none." state="not-recorded" compact />
          ) : (
            <CategoryTable groups={q4} chart="quality-failures" caption="Failed checks by kind" noun="failed check" selected={active?.dim === "target_kind" ? active.value : null} onPick={(k) => toggle("target_kind", k)} mono empty="No failed checks in this window." />
          )}
        </section>
        <section className="an-section" id="blockers">
          <SectionHead title="Review blockers by rule" question="Blocker findings (R2), reconstructed from review rounds." />
          {r2.length === 0 && unobserved(t.R2) ? (
            <NotRecorded title="Blocker findings not observed" what={unobserved(t.R2)!} why="Missing is not zero: the run records hold blockers this figure could not read, so it does not say none." state="not-recorded" compact />
          ) : (
            <CategoryTable groups={r2} chart="quality-blockers" caption="Blocker findings by rule" noun="blocker" selected={active?.dim === "rule" ? active.value : null} onPick={(k) => toggle("rule", k)} empty="No blocker findings in this window." />
          )}
        </section>
      </div>

      <section className="an-section" id="paths">
        <SectionHead title="Remediation paths" question="How finished tickets reached their outcome, from the run records.">
          {chip}
        </SectionHead>
        <Paths paths={remediationPaths(runs)} total={runs.length} onOpen={(id) => open(`cell:${id}`, "timeline")} narrowed={active && picked ? `${PICK_WORDS[active.dim]} ${active.value}` : null} />
      </section>

      <div className="an-grid-2">
        <section className="an-section">
          <SectionHead title="Quality beside recorded cost" question="Recorded cost of each ticket's executions, by judging rounds.">
            {chip}
          </SectionHead>
          <QualityCost runs={runs} />
        </section>
        <section className="an-section">
          <SectionHead title="Observe scorecard" question="The observe station's six measures, same formulas, this window." />
          <Scorecard rows={SCORECARD_IDS.map((id) => t[id]).filter((r): r is MetricRow => !!r)} />
        </section>
      </div>
    </>
  );
}

function CategoryTable({ groups, chart, caption, noun, selected, onPick, mono = false, empty }: { groups: readonly MetricGroup[]; chart: string; caption: string; noun: string; selected: string | null; onPick(k: string): void; mono?: boolean; empty: string }) {
  if (groups.length === 0) return <p className="text-body-sm text-ink-muted">{empty}</p>;
  return (
    <ChartFrame chart={chart} title={caption} question="Select a row to narrow the paths and the cost chart to the tickets it was recorded on." summary={groups.map((g) => `${g.key}: ${g.value}`).join(", ")} table={{ columns: [{ label: mono ? "Check" : "Rule" }, { label: "Findings", num: true }], rows: groups.map((g) => [g.key, count(g.value)]) }}>
      <RankTable<MetricGroup>
        caption={caption}
        rows={groups}
        rowKey={(g) => g.key}
        rowName={(g) => `${g.key}: ${plural(g.value ?? 0, noun)}`}
        initial={{ key: "n", dir: "desc" }}
        selected={selected}
        onActivate={(g) => onPick(g.key)}
        columns={[
          { key: "key", label: mono ? "Check" : "Rule", sort: (g) => g.key, cell: (g) => (mono ? <span className="an-mono text-[12.5px]" translate="no">{g.key}</span> : g.key), width: "46%" },
          { key: "n", label: "Findings", sort: (g) => g.value, cell: (g) => count(g.value), bar: { value: (g) => g.value } },
        ]}
      />
    </ChartFrame>
  );
}

function VerifyTrend() {
  const { snapshot: s, density, window: setWindow } = useAnalytics();
  const weeks = periodSeries(s.grouped[groupedKey("Q1", "day")], s.window.from_ms, s.window.to_ms, "week");
  const withValue = weeks.filter((w) => w.value !== null);
  const members = withValue.reduce((n, w) => n + (w.denominator ?? 0), 0);
  if (!rowMissing(s.totals.Q1) && (density !== "many" || withValue.length < MIN_TREND_PERIODS || members < MIN_TREND_MEMBERS)) return <TooFew what="round-1 verifications" n={members} need={MIN_TREND_MEMBERS} periods={MIN_TREND_PERIODS} />;
  return (
    <ChartFrame
      chart="quality-verify-trend"
      requires={[s.totals.Q1]}
      title="Passed and failed first time, per week"
      summary={weeks.map((w) => `week to ${dayText(w.to - 1)}: ${w.numerator ?? 0} passed, ${(w.denominator ?? 0) - (w.numerator ?? 0)} failed`).join("; ")}
      table={{ columns: [{ label: "Week to" }, { label: "Passed", num: true }, { label: "Failed", num: true }, { label: "Passed share", num: true }], rows: weeks.map((w) => [dayText(w.to - 1), count(w.numerator ?? 0), count((w.denominator ?? 0) - (w.numerator ?? 0)), w.denominator ? shareText(w.numerator ?? 0, w.denominator) : "–"]) }}
      foot={`Tickets whose round-1 verification ended in each week. A week with fewer than ${SMALL_SAMPLE} shows its counts, not a share.`}
      actions={
        <span className="flex gap-3">
          <Key shape="bar" label="passed" tone="var(--an-pass)" />
          <Key shape="bar" label="failed" tone="var(--an-fail)" />
        </span>
      }
    >
      <Columns
        label="Round-1 verifications per week"
        height={150}
        format={count}
        tone="var(--an-pass)"
        onWindow={setWindow}
        points={weeks.map((w) => {
          const den = w.denominator ?? 0;
          const num = w.numerator ?? 0;
          return { key: w.key, value: num, stack: den - num, tick: dayText(w.to - 1), from: w.from, to: w.to, card: { title: `Week to ${dayText(w.to - 1)}${w.days < 7 ? ` (${w.days} days)` : ""}`, rows: [["passed", count(num)], ["failed", count(den - num)], ["passed share", den ? shareText(num, den) : "–"]] } };
        })}
      />
    </ChartFrame>
  );
}

const STEP_GLYPH: Readonly<Record<RemediationPath["steps"][number], { label: string; draw: (x: number) => ReactNode }>> = {
  pass: { label: "passed", draw: (x) => <circle cx={x} cy={9} r={5} style={{ fill: "var(--an-pass)" }} /> },
  "verify-fail": { label: "failed verification", draw: (x) => <path d={`M${x - 4.5} ${4.5}L${x + 4.5} ${13.5}M${x + 4.5} ${4.5}L${x - 4.5} ${13.5}`} style={{ stroke: "var(--an-fail)", strokeWidth: 2.2, strokeLinecap: "round" }} /> },
  reject: { label: "rejected in review", draw: (x) => <path d={`M${x} ${3.5}L${x + 5.5} ${14}H${x - 5.5}Z`} style={{ fill: "none", stroke: "var(--an-fail)", strokeWidth: 1.6 }} /> },
  escalate: { label: "escalated", draw: (x) => <rect x={x - 5} y={4} width={10} height={10} rx={1} transform={`rotate(45 ${x} 9)`} style={{ fill: "var(--an-halt)" }} /> },
  abandon: { label: "abandoned", draw: (x) => <circle cx={x} cy={9} r={4.5} style={{ fill: "none", stroke: "var(--an-subtle)", strokeWidth: 1.5, strokeDasharray: "2 1.5" }} /> },
};

function Paths({ paths, total, onOpen, narrowed }: { paths: readonly RemediationPath[]; total: number; onOpen(ticket: string): void; narrowed: string | null }) {
  const max = Math.max(1, ...paths.map((p) => p.tickets.length));
  if (paths.length === 0) return <p className="text-body-sm text-ink-muted">No finished tickets {narrowed ? `with ${narrowed}` : "in this window"}.</p>;
  return (
    <ChartFrame
      chart="quality-paths"
      title={narrowed ? `Paths of the tickets with ${narrowed}` : "Paths of finished tickets"}
      summary={paths.map((p) => `${p.words}: ${p.tickets.length}`).join("; ")}
      table={{ columns: [{ label: "Path" }, { label: "Tickets", num: true }, { label: "Tickets on it" }], rows: paths.map((p) => [p.words, count(p.tickets.length), p.tickets.join(", ")]) }}
      foot={
        <span className="flex flex-wrap gap-x-4">
          {(Object.keys(STEP_GLYPH) as (keyof typeof STEP_GLYPH)[]).map((k) => (
            <span key={k} className="inline-flex items-center gap-1">
              <svg width={14} height={18} aria-hidden="true">
                {STEP_GLYPH[k].draw(7)}
              </svg>
              {STEP_GLYPH[k].label}
            </span>
          ))}
          <span>{plural(total, "finished ticket")}; each counted once.</span>
        </span>
      }
    >
      <table className="an-table">
        <thead>
          <tr>
            <th scope="col" style={{ width: 96 }}>
              Rounds
            </th>
            <th scope="col">Path</th>
            <th scope="col" className="num" style={{ width: 64 }}>
              Tickets
            </th>
            <th scope="col" style={{ width: "22%" }}>
              <span className="sr-only">Share</span>
            </th>
            <th scope="col" style={{ width: "30%" }}>
              Examples
            </th>
          </tr>
        </thead>
        <tbody>
          {paths.map((p) => (
            <tr key={p.key}>
              <td>
                <svg width={p.steps.length * 18 + 4} height={18} role="img" aria-label={p.steps.map((x) => STEP_GLYPH[x].label).join(", then ")}>
                  {p.steps.map((x, i) => (
                    <g key={i}>{STEP_GLYPH[x].draw(9 + i * 18)}</g>
                  ))}
                </svg>
              </td>
              <td>{p.words}</td>
              <td className="num an-num font-semibold">{p.tickets.length}</td>
              <td>
                <svg width="100%" height={12} aria-hidden="true" preserveAspectRatio="none" viewBox={`0 0 ${max} 12`}>
                  <rect x={0} y={2} width={p.tickets.length} height={8} style={{ fill: "var(--an-bar)" }} />
                </svg>
              </td>
              <td className="text-caption">
                {p.tickets.slice(0, 3).map((id, i) => (
                  <span key={id}>
                    {i ? ", " : ""}
                    <a
                      className="an-link an-mono"
                      href={`#timeline?sel=${encodeURIComponent(`cell:${id}`)}`}
                      data-ref={`cell:${id}`}
                      translate="no"
                      onClick={(e) => {
                        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                        e.preventDefault();
                        onOpen(id);
                      }}
                    >
                      {id}
                    </a>
                  </span>
                ))}
                {p.tickets.length > 3 ? <span className="text-ink-subtle"> and {p.tickets.length - 3} more</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ChartFrame>
  );
}

/**
 * Each finished ticket as a dot: recorded cost of its executions (K4) along x, one row per number of
 * judging rounds. Tickets without a recorded cost are counted below the chart, never placed at zero.
 * Observational: work that needed more rounds may also have been larger.
 */
function QualityCost({ runs: all }: { runs: readonly RunRecord[] }) {
  const { snapshot: s, open } = useAnalytics();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [, setTip, tipNode] = useTip(width);
  const cost = new Map((s.contributors.K4?.items ?? []).map((c) => [c.ticket, c.value] as const));
  const runs = all.filter((r) => r.outcome === "merged" && r.rounds !== null);
  const placed = runs.map((r) => ({ r, cost: cost.get(r.ticket_id) ?? null }));
  const known = placed.filter((p): p is { r: RunRecord; cost: number } => p.cost !== null).sort((a, b) => (a.r.rounds ?? 0) - (b.r.rounds ?? 0) || a.cost - b.cost);
  const nav = useMarkNav(known.length);
  const missing = placed.length - known.length;
  // No rows for K4 from this source: the per-ticket costs are not served, which is not "no cost recorded".
  if (!s.contributors.K4) return <NotRecorded title="Per-ticket cost not listed" what="This source does not list each ticket's recorded cost (K4), so tickets cannot be placed by cost." why="Recorded totals are in Economics; nothing is drawn here in their place." state="unavailable" compact />;
  if (known.length < SMALL_SAMPLE) return <TooFew what="merged tickets with a recorded cost" n={known.length} need={SMALL_SAMPLE} periods={1} />;
  const left = 74;
  const right = 14;
  const rowH = 56;
  const rows = [1, 2, 3];
  const ticks = niceTicks(Math.max(...known.map((k) => k.cost)), Math.max(2, Math.min(4, Math.floor((width - left) / 90))));
  const x = linear(0, ticks[ticks.length - 1]!, left, width - right);
  const height = rows.length * rowH + 24;
  return (
    <ChartFrame
      chart="quality-cost"
      title="Recorded cost per merged ticket, by rounds"
      summary={rows.map((n) => `${n} rounds: ${known.filter((k) => k.r.rounds === n).length} tickets, median ${usd(medianOf(known.filter((k) => k.r.rounds === n).map((k) => k.cost)))}`).join("; ")}
      table={{ columns: [{ label: "Ticket" }, { label: "Rounds", num: true }, { label: "Recorded cost", num: true }], rows: known.map((k) => [<button key={k.r.ticket_id} type="button" className="an-link an-mono inline-flex min-h-6 items-center" onClick={() => open(`cell:${k.r.ticket_id}`, "timeline")}>{k.r.ticket_id}</button>, count(k.r.rounds), usd(k.cost)]) }}
      foot={<>Each dot is one ticket (filled: passed in one round; open: needed more); the tick is the median of a row of at least {SMALL_SAMPLE}. {missing ? `${plural(missing, "merged ticket")} with no recorded cost (hand-driven, or no execution result) are not placed. ` : ""}The table view lists every ticket with a link. This compares groups of tickets as they happened; it does not say that rounds caused the cost.</>}
    >
      <div ref={ref} className="relative" style={{ height }}>
        <svg width={width} height={height} role="group" aria-label="Recorded cost per merged ticket, by rounds" style={{ display: "block" }}>
          {ticks.map((tk) => (
            <g key={tk} aria-hidden="true">
              <line x1={x(tk)} x2={x(tk)} y1={0} y2={height - 18} style={{ stroke: tk === 0 ? "var(--an-axis)" : "var(--an-grid)" }} />
              <text x={x(tk)} y={height - 4} textAnchor={tk === ticks[ticks.length - 1] ? "end" : "middle"} style={{ fontFamily: "var(--mach-font-sans)", fontVariantNumeric: "tabular-nums", fontSize: 11, fill: "var(--an-subtle)" }}>
                {usd(tk).replace(".00", "")}
              </text>
            </g>
          ))}
          {rows.map((n, i) => {
            const cy = i * rowH + rowH / 2;
            const these = known.filter((k) => k.r.rounds === n);
            const dots = stripLayout(these.map((k) => ({ id: k.r.ticket_id, x: x(k.cost) })), cy, 3.4, 3);
            const med = these.length >= SMALL_SAMPLE ? medianOf(these.map((k) => k.cost)) : null;
            return (
              <g key={n}>
                <text x={0} y={cy + 1} style={{ fontSize: 13, fill: "var(--an-ink)", fontFamily: "var(--mach-font-sans)" }}>
                  {n} {n === 1 ? "round" : "rounds"}
                </text>
                <text x={0} y={cy + 15} style={{ fontSize: 11, fill: "var(--an-subtle)", fontFamily: "var(--mach-font-sans)" }}>
                  n {these.length}
                </text>
                {dots.map((d) => {
                  const k = these.find((z) => z.r.ticket_id === d.id)!;
                  return (
                    <Mark key={d.id} nav={nav} index={known.indexOf(k)} x={d.x - 3.5} y={d.y - 3.5} w={7} h={7} tipAt={{ x: d.x, y: d.y - 5 }} card={{ title: d.id, rows: [["recorded cost", usd(k.cost)], ["judging rounds", String(n)], ["dot", n === 1 ? "filled: passed first time" : "open ring: needed more rounds"]], foot: "Enter opens it in the Timeline." }} onTip={setTip} onActivate={() => open(`cell:${d.id}`, "timeline")}>
                      {n === 1 ? <circle cx={d.x} cy={d.y} r={3.4} style={{ fill: "var(--an-pass)", stroke: "var(--mach-canvas)", strokeWidth: 1 }} /> : <circle cx={d.x} cy={d.y} r={3} style={{ fill: "var(--mach-canvas)", stroke: "var(--an-wait)", strokeWidth: 1.6 }} />}
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

function Scorecard({ rows }: { rows: readonly MetricRow[] }) {
  return (
    <div className="flex flex-col" data-chart="quality-scorecard">
      {rows.map((r) => {
        const v = r.value === null ? null : r.kind === "rate" && verdictAllowed(r.denominator_value) ? pct(r.value, 1) : valueText(r);
        const target = r.target ? Number(r.target.split(" ")[1]) : undefined;
        const max = r.kind === "rate" ? 1 : Math.max(3, (r.value ?? 0) * 1.25, (target ?? 0) * 1.5);
        const verdict = verdictWords(r);
        return (
          <div key={r.id} className="grid grid-cols-[4.5rem_minmax(48px,1fr)_minmax(0,8.5rem)] items-center gap-x-3 gap-y-0.5 border-b border-line py-2" data-readout={r.id} data-value={r.value ?? undefined}>
            <div className="col-span-3 flex min-w-0 items-center gap-1 text-body-sm text-ink">
              <span>{r.name.replace(" (observe)", "")}</span>
              <Definition row={r} />
              <span className="an-num ml-1 text-caption text-ink-subtle">n {r.denominator_value ?? 0}</span>
            </div>
            <div className="an-fig text-[17px] text-ink">{v ?? "–"}</div>
            <Bullet value={r.value} target={target} max={max} name={`${r.name}: ${v ?? "no value"}${r.target ? `, target ${targetText(r.target, r.kind)}` : ", no target"}`} />
            <div className="text-caption">{verdict ? <span className={verdict.tone === "meets" ? "text-success-ink" : verdict.tone === "misses" ? "text-warning-ink" : "text-ink-subtle"}>{verdict.text}</span> : <span className="text-ink-subtle">no target set</span>}</div>
          </div>
        );
      })}
      <p className="mt-2 text-caption text-ink-subtle">Bars run from zero: rates to 100%, means to a little past their target. The upright mark is the target. A verdict needs at least {SMALL_SAMPLE} tickets.</p>
      <p className="mt-1 text-caption text-ink-subtle">The observe station reports on the last runs by close time; this window is a period, so the two can differ in what they include, never in how a value is computed.</p>
    </div>
  );
}
