/**
 * Reliability & Autonomy: how executions ended, each kind of ending counted on its own with its own
 * denominator (a model or workflow failure is not a gate rejection; waiting for a person is not a
 * failure; an interruption from outside is not the model's; unknown stays unknown), and where a
 * person stepped in.
 *
 * Selecting an ending lists the executions that ended that way beside the chart, with a chip that
 * removes it.
 */
import { groupedKey, type MetricRow } from "../../contract";
import { groupOf } from "../../model/charts";
import { count } from "../../model/format";
import { shareText } from "../../model/sample";
import { BarRows } from "../charts";
import { Announce, AreaFrame, ChartFrame, Chip, Readout, SectionHead, useAnalytics } from "../kit";
import type { Pick, ReliabilityProps, RowsRequest } from "../types";
import { NothingYet } from "./shared";
import { RefList } from "./RefList";

interface Ending {
  readonly key: string;
  readonly label: string;
  readonly what: string;
  readonly num: number | null;
  readonly den: number | null;
  readonly over: string;
  readonly tone: string;
  readonly rows?: RowsRequest;
  readonly row?: MetricRow | undefined;
}

export function Reliability(props: ReliabilityProps) {
  return (
    <AreaFrame id="reliability" title="Reliability and autonomy" intro="How executions ended and where a person stepped in. Each kind of ending is counted apart, over its own base; they are not shares of one whole and do not add up." props={props}>
      {() => <ReliabilityBody pick={props.pick} setPick={props.onPick} />}
    </AreaFrame>
  );
}

function ReliabilityBody({ pick, setPick }: { pick: Pick | null; setPick(p: Pick | null): void }) {
  const { snapshot: s, density, open } = useAnalytics();
  const t = s.totals;
  if (density === "empty" && !s.no_whole_day) return <NothingYet about="No execution was claimed and no ticket finished in this window. Reliability is read from:" />;
  const s1 = s.grouped[groupedKey("S1", "kind")];
  const s6 = s.grouped[groupedKey("S6", "stop_reason")];
  const claimed = t.X1?.denominator_value ?? null;
  const endings: Ending[] = [
    { key: "completed", label: "Completed and moved the ticket", what: "execution.completed", num: t.S3?.numerator_value ?? null, den: t.S3?.denominator_value ?? null, over: "completed or failed", tone: "var(--an-pass)", row: t.S3 },
    { key: "failed", label: "Model or workflow failure", what: "execution.failed; the supervisor retried", num: t.X1?.numerator_value ?? null, den: claimed, over: "claimed", tone: "var(--an-fail)", rows: { key: "X1", title: "Failed executions", unit: "count" }, row: t.X1 },
    { key: "interrupted", label: "Interrupted from outside", what: "recovery.started, kind interrupted", num: groupOf(s1, "interrupted")?.numerator ?? (s1 ? 0 : null), den: claimed, over: "claimed", tone: "var(--an-halt)", rows: { key: "S1", title: "Recoveries", unit: "count" }, row: t.S1 },
    { key: "unknown", label: "Outcome unknown", what: "closed outcome-unknown; counted as neither success nor failure", num: t.S2?.numerator_value ?? null, den: t.S2?.denominator_value ?? null, over: "claimed", tone: "var(--an-stale)", rows: { key: "S2", title: "Executions with an unknown outcome", unit: "count" }, row: t.S2 },
    { key: "parked", label: "Parked for a person", what: "human.required at the end of the execution", num: t.S4?.numerator_value ?? null, den: claimed, over: "claimed", tone: "var(--an-human)", rows: { key: "S4", title: "Executions that parked a ticket for a person", unit: "count" }, row: t.S4 },
    { key: "killed", label: "Workflow killed", what: `workflow.finished killed${(s6?.groups ?? []).length ? `: ${(s6?.groups ?? []).map((g) => `${g.key} ${g.numerator}`).join(", ")}` : ""}`, num: t.S6?.numerator_value ?? null, den: t.S6?.denominator_value ?? null, over: "workflows finished", tone: "var(--an-halt)", row: t.S6 },
  ];
  const gates: Ending[] = [
    { key: "refused", label: "Gate refusals", what: "gate.evaluated refused", num: t.X2?.numerator_value ?? null, den: t.X2?.denominator_value ?? null, over: "gate evaluations", tone: "var(--an-wait)", row: t.X2 },
    { key: "overridden", label: "Gate overrides", what: "gate.evaluated overridden, with a recorded reason", num: t.X3?.numerator_value ?? null, den: t.X3?.denominator_value ?? null, over: "build tasks", tone: "var(--an-wait)", row: t.X3 },
    { key: "tools", label: "Tools refused", what: "tool.refused, by program name", num: t.S5?.numerator_value ?? null, den: claimed, over: "claimed executions", tone: "var(--an-wait)", row: t.S5 },
  ];
  const humanRuns = s.runs.filter((r) => r.human_approval).length;
  const picked = pick?.dim === "outcome" ? endings.find((e) => e.key === pick.value) ?? null : null;
  const pickedPage = picked?.rows ? s.contributors[picked.rows.key] : undefined;

  return (
    <>
      <div className="an-readouts">
        <Readout row={t.S3} label="Moved the ticket" />
        <Readout row={t.W4} label="Claim to process start" />
        <Readout row={t.W5} label="Observation lag" note={<span>the supervisor's poll, not work</span>} />
        <Readout row={t.G3} label="Evidence integrity" />
      </div>

      <section className="an-section" id="unknown">
        <SectionHead title="How executions ended" question={claimed !== null ? `${count(claimed)} executions claimed in this window. Select an ending to list its executions.` : undefined}>
          {picked ? <Chip label="Ending" value={picked.label} onRemove={() => setPick(null)} /> : null}
        </SectionHead>
        <div className={picked ? "an-grid-lead" : undefined}>
          <EndingRows chart="reliability-endings" title="Endings, each over its own base" rows={endings} selected={picked?.key ?? null} onPick={(k) => setPick(pick?.value === k ? null : { dim: "outcome", value: k })} />
          <Announce on={picked?.key ?? null}>{picked ? `${picked.label} selected: ${picked.num ?? 0} of ${picked.den ?? "no value"} ${picked.over}.` : ""}</Announce>
          {picked ? (
            <div>
              <h3 className="text-label text-ink">{picked.label}</h3>
              <p className="mb-2 text-caption text-ink-muted">
                {picked.num ?? 0} of {picked.den ?? "–"} {picked.over}. Recorded as {picked.what}.
              </p>
              {pickedPage ? <RefList items={pickedPage.items.slice(0, 12)} unit="count" showWhen onOpen={open} /> : <p className="text-body-sm text-ink-muted">The executions behind this ending are not listed by this source; the count is the recorded one.</p>}
            </div>
          ) : null}
        </div>
      </section>

      <div className="an-grid-2">
        <section className="an-section">
          <SectionHead title="Gates and tools" question="Refusals are the Factory's rules working; they are not failures of the work." />
          <EndingRows chart="reliability-gates" title="Refusals and overrides" rows={gates} compact />
        </section>
        <section className="an-section">
          <SectionHead title="Where a person stepped in" />
          <div className="grid grid-cols-2 gap-x-6 gap-y-5">
            <Readout row={t.W3} label="Waited for approval" drill={{ key: "W3", title: "Human approval waits", unit: "ms" }} />
            <Readout row={t.R5} label="Escalated" drill={{ key: "R5", title: "Escalated tickets", unit: "count" }} />
            <Readout row={t.S4} label="Parked by the supervisor" size="sm" />
            <div data-readout="human_approval" data-value={humanRuns}>
              <div className="text-body-sm text-ink-muted">Finished with a person's approval</div>
              <div className="an-fig text-[19px] text-ink">{shareText(humanRuns, s.runs.length)}</div>
              <div className="mt-1.5 text-caption text-ink-subtle">
                {count(humanRuns)} run records with human_approval, of {count(s.runs.length)} finished
              </div>
            </div>
          </div>
          <p className="mt-4 text-caption text-ink-subtle">A person's approval is required by the risk tier and the readiness tier; these counts show where it happened, not how to avoid it.</p>
        </section>
      </div>
    </>
  );
}

function EndingRows({ chart, title, rows, compact = false, selected, onPick }: { chart: string; title: string; rows: readonly Ending[]; compact?: boolean; selected?: string | null; onPick?: (k: string) => void }) {
  return (
    <ChartFrame
      chart={chart}
      title={title}
      summary={rows.map((r) => `${r.label}: ${r.num ?? "not recorded"} of ${r.den ?? "–"} ${r.over}`).join("; ")}
      table={{ columns: [{ label: "Ending" }, { label: "Count", num: true }, { label: "Of", num: true }, { label: "Base" }, { label: "Share", num: true }, { label: "Recorded as" }], rows: rows.map((r) => [r.label, r.num === null ? "not recorded" : count(r.num), count(r.den), r.over, r.num !== null && r.den ? shareText(r.num, r.den) : "not computed", r.what]) }}
      foot="Each bar is a share of its own base, from 0 to 100%; the bases differ, so the bars are not parts of one total."
    >
      <BarRows
        label={title}
        labelW={compact ? 130 : 220}
        valueW={128}
        max={1}
        selected={selected}
        onActivate={onPick}
        rows={rows.map((r) => {
          const share = r.num !== null && r.den ? r.num / r.den : null;
          return {
            key: r.key,
            label: r.label,
            value: share,
            valueText: share === null ? (r.num === null ? "not recorded" : "no base to share over") : shareText(r.num!, r.den!).includes(" of ") ? shareText(r.num!, r.den!) : `${shareText(r.num!, r.den!)} (${count(r.num)} of ${count(r.den)})`,
            card: { title: r.label, rows: [["count", r.num === null ? "not recorded" : count(r.num)], ["of", `${count(r.den)} ${r.over}`], ["share of its base", r.num !== null && r.den ? shareText(r.num, r.den) : "not computed"]], foot: r.num === null ? `Not recorded: ${(r.row?.status_reason ?? r.row?.null_reason ?? "this source records no such event").replace(/^not (recorded|available):\s*/, "")}.` : `Recorded as ${r.what}.` },
            tone: r.tone,
          };
        })}
      />
    </ChartFrame>
  );
}
