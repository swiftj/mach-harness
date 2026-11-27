/**
 * A ticket's full record, station by station: every visit in the order it happened, who worked
 * there (the models recorded), how long it took and how that is known, what the station decided,
 * and what to look at, from which the evidence player is reached. Read only.
 */
import type { ReactNode } from "react";
import { CommandLine, Dialog, DialogContent } from "@mach/ui";
import { MAX_ROUNDS, type CellState, type StationVisit } from "../sim";
import { useScene, useStore } from "../scene";
import { FreeText } from "../shell/inspector/FreeText";
import { visitStateWords } from "../shell/inspector/outcomes";
import { planWords } from "../shell/inspector/words";
import { duration } from "../shell/time";
import { When } from "../shell/When";
import { columnOf, LINE_STATIONS, reviewOfVisit, visitRoundWords, type LineRow } from "./model";
import { StatePill } from "./Marks";
import { costWords, modelWords } from "./words";
import { EpicLine } from "./Epic";

/** The models recorded for agents that worked on this visit (same station, started while it was open). */
function visitModels(cell: CellState, v: StationVisit): string | null {
  const names: string[] = [];
  for (const id of cell.agentOrder) {
    const a = cell.agents[id];
    if (!a || a.station !== v.station || a.startedAt < v.enteredAt || (v.leftAt !== null && a.startedAt > v.leftAt)) continue;
    const name = a.modelName ?? (a.meta.authority === "simulated" ? a.model : null);
    if (name) names.push(name);
  }
  return modelWords(names);
}

function visitTime(v: StationVisit, now: number): string {
  if (v.interrupted) return "not continuous";
  if (v.leftAt === null) return `${duration(now - v.enteredAt)} so far`;
  const ms = v.durationMs ?? v.leftAt - v.enteredAt;
  return v.unclosed ? `at most ${duration(ms)}` : duration(ms);
}

const linkClass = "text-left text-body-sm font-semibold text-accent-ink underline decoration-1 underline-offset-[3px] hover:decoration-2";

/** What to look at for one visit, from what the station recorded. */
function LookAt({ cell, v, onEvidence }: { cell: CellState; v: StationVisit; onEvidence: () => void }) {
  switch (v.station) {
    case "verify": {
      const run = cell.verifications.find((x) => x.round === v.round);
      const n = run ? run.checks.filter((c) => c.result !== "pending").length : 0;
      return (
        <button type="button" onClick={onEvidence} className={linkClass} data-open-evidence="">
          {n ? `${n} check${n === 1 ? "" : "s"} and their captured proof` : "The checks and their captured proof"}
        </button>
      );
    }
    case "review": {
      const round = reviewOfVisit(cell, v);
      if (!round) return <span className="text-ink-muted">no round recorded</span>;
      const blockers = round.findings.filter((f) => f.severity === "blocker");
      const rules = [...new Set(blockers.map((f) => f.rule).filter((r): r is string => Boolean(r)))];
      return (
        <span className="text-ink">
          {round.findings.length} finding{round.findings.length === 1 ? "" : "s"}, {blockers.length} blocking
          {rules.length ? (
            <>
              {" "}
              (rules cited: <span className="font-mono text-[12.5px]">{rules.join(", ")}</span>)
            </>
          ) : null}
        </span>
      );
    }
    case "build": {
      if (!cell.tasks.length) return <span className="text-ink-muted">no task recorded</span>;
      const done = cell.tasks.filter((t) => t.doneAt !== null).length;
      const red = cell.tasks.filter((t) => t.kind === "test" && t.doneAt !== null).length;
      return (
        <span className="text-ink">
          {done} of {cell.tasks.length} tasks done; {red} test task{red === 1 ? "" : "s"} seen failing first
        </span>
      );
    }
    case "plan":
      return cell.plan ? <span className="text-ink">{planWords(cell.plan)}</span> : <span className="text-ink-muted">plan facts not recorded</span>;
    case "merge":
      if (v.outcomeWord === "landed-overlap") return <span className="text-ink">sent back to be verified and reviewed again: work that landed on main touches the same ground (no judging round used)</span>;
      return cell.merged ? (
        <span className="text-ink">
          merged as <span className="font-mono text-[12.5px]">{cell.merged.commit.slice(0, 10)}</span>
        </span>
      ) : (
        <span className="text-ink-muted">not merged</span>
      );
    default:
      return <span className="text-ink-muted">nothing more recorded</span>;
  }
}

function Cell({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={`border-b border-line px-2 py-2 align-top ${className ?? ""}`}>{children}</td>;
}

export function TicketRecord({ row, now, onClose }: { row: LineRow | null; now: number; onClose: () => void }) {
  const store = useStore();
  const cell = useScene((s) => (row ? (s.cells[row.ticketId] ?? null) : null));
  const visits = cell ? cell.visits.filter((v) => columnOf(v.station) !== null) : [];
  const evidence = () => {
    if (!row) return;
    onClose();
    store.openEvidence(row.ticketId);
  };
  return (
    <Dialog open={row !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      {row ? (
        <DialogContent
          width="lg"
          className="max-w-[min(920px,calc(100vw-2rem))]"
          title={`${row.ticketId}: the full record`}
          description="Every station visit in the order it happened, who worked there, how long it took and what the station decided. Read only."
          data-line-record={row.ticketId}
        >
          <div className="pb-2">
            {row.title ? (
              <p className="text-body-lg font-semibold text-ink">
                <FreeText field="sliceTitle" text={row.title} />
              </p>
            ) : null}
            <EpicLine row={row} className="mt-1 block text-body-sm text-ink-muted" />
            <p className="mt-2 flex flex-wrap items-center gap-2 text-body-sm text-ink-muted">
              <StatePill state={row.state} />
              <span>
                {row.risk ? `${row.risk} risk` : "Risk not recorded"}. Rounds used: {row.roundsUsed} of {MAX_ROUNDS}. Cost: {costWords(row.cost)}.
              </span>
            </p>
            <p className="mt-1 text-body-sm text-ink-muted" data-record-ids="">
              {row.smallChange ? <span data-small-change="">{row.smallChange.widened ? "Began as a small change, now a full slice. " : "A small change. "}</span> : null}
              Jira: {row.jira ? <span className="font-mono text-[13px] text-ink">{row.jira}</span> : "not recorded"}. Change record:{" "}
              {row.changeRecord ? <span className="break-all font-mono text-[13px] text-ink">{row.changeRecord}</span> : "not recorded"}.
            </p>
            {visits.length === 0 ? (
              <p className="mt-4 text-body-sm text-ink-muted">No station visit is recorded for this ticket yet.</p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full border-collapse text-body-sm" data-record-table="">
                  <thead>
                    <tr className="text-left text-label text-ink-muted">
                      <th scope="col" className="border-b border-line-strong px-2 py-1.5 font-semibold">Station</th>
                      <th scope="col" className="border-b border-line-strong px-2 py-1.5 font-semibold">Worker</th>
                      <th scope="col" className="border-b border-line-strong px-2 py-1.5 font-semibold">Started</th>
                      <th scope="col" className="border-b border-line-strong px-2 py-1.5 font-semibold">Time</th>
                      <th scope="col" className="border-b border-line-strong px-2 py-1.5 font-semibold">Result</th>
                      <th scope="col" className="border-b border-line-strong px-2 py-1.5 font-semibold">What to look at</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visits.map((v, i) => {
                      const column = columnOf(v.station) as number;
                      const again = visits.slice(0, i).some((x) => columnOf(x.station) === column);
                      return (
                        <tr key={`${v.station}-${v.enteredAt}-${i}`}>
                          <Cell>
                            <span className="font-semibold text-ink">{v.station === "human-approval" ? "A person's approval" : v.station === "audit" ? "Readiness check" : LINE_STATIONS[column]!.name}</span>
                            {again ? <span className="ml-1.5 rounded-xs border border-factory-fail px-1 text-caption font-semibold text-factory-fail">again</span> : null}
                            <span className="block text-caption text-ink-subtle">{visitRoundWords(cell, v)}</span>
                          </Cell>
                          <Cell>{cell ? (visitModels(cell, v) ?? <span className="text-ink-muted">not recorded</span>) : null}</Cell>
                          <Cell className="whitespace-nowrap">
                            <When t={v.enteredAt} precision="second" age={false} />
                          </Cell>
                          <Cell className="whitespace-nowrap tabular">{visitTime(v, now)}</Cell>
                          <Cell>{visitStateWords(v)}</Cell>
                          <Cell>{cell ? <LookAt cell={cell} v={v} onEvidence={evidence} /> : null}</Cell>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <h4 className="mb-1 mt-5 text-label text-ink-muted">What it needs from you</h4>
            <p className="text-body-sm text-ink">{row.needs}</p>
            <CommandLine className="mt-2" command={row.command} purpose={`for ${row.ticketId}`} />
            {row.alsoCommand ? <CommandLine className="mt-1.5" command={row.alsoCommand} purpose={`also for ${row.ticketId}`} /> : null}
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
