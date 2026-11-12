/**
 * The inspector with nothing selected: the run at the playhead. What chapter this is (simulation) or
 * the latest landmark (real history), the latest significant moment, the connection (live), what is
 * working now, who is waiting and why, and the counts so far, from received facts only.
 */
import { useMemo } from "react";
import { isKnown, ref, type CellStage } from "../../sim";
import { useScene, useSceneStore } from "../../scene";
import { ActorGlyph, CellGlyph, SliceGlyph } from "../glyphs";
import { indexFor, lastAtOrBefore } from "../history";
import { ConnectionFacts } from "../SourceBadge";
import { ACTOR_WORDS, schedulerLook, stageLook, timecode } from "../vocab";
import { mayBeUnderReported, recordedCost } from "./anatomies";
import { Facts, JumpButton, NotRecorded, RefLink, RefList, Section } from "./parts";

export function RunNow() {
  const index = useSceneStore(indexFor);
  const source = useSceneStore((s) => s.source);
  const connection = useSceneStore((s) => s.connection);
  const chapter = useSceneStore((s) => lastAtOrBefore(indexFor(s).landmarks, s.playhead));
  const moment = useSceneStore((s) => lastAtOrBefore(indexFor(s).moments, s.playhead));
  // A key per cell (stage and how many agents work): the list re-renders when one of those changes,
  // not on every tool call.
  const cellKey = useScene((s) =>
    Object.values(s.cells)
      .sort((a, b) => a.openedAt - b.openedAt)
      .map((c) => `${c.ticketId}:${c.stage}:${c.activeAgentIds.length}`)
      .join("|"),
  );
  const slices = useScene((s) => s.slices);
  const attention = useScene((s) => s.supervisor.attention);
  const cellList = useMemo(() => (cellKey ? cellKey.split("|").map((k) => k.split(":") as [string, CellStage, string]) : []), [cellKey]);
  const waiting = Object.values(slices).filter((s) => s.scheduler === "waiting-on-dependency" || s.scheduler === "eligible");
  const n = chapter ? index.landmarks.indexOf(chapter) + 1 : 0;
  return (
    <div>
      <div className="px-5 pb-4 pt-5">
        <p className="text-caption text-ink-subtle">{source === "simulation" ? "Nothing selected. The run at the playhead." : "Nothing selected. What has been received, as of the playhead."}</p>
        {chapter && index.storyboard ? (
          <>
            <p className="mt-3 text-caption text-ink-subtle tabular">
              Chapter {n} of {index.landmarks.length}, from {timecode(chapter.t, false)}
            </p>
            <h2 className="mt-0.5 font-sans text-title-3 font-bold text-ink">{chapter.title}</h2>
            {chapter.summary ? <p className="mt-1.5 text-body-sm text-ink-muted">{chapter.summary}</p> : null}
          </>
        ) : chapter ? (
          <>
            <p className="mt-3 text-caption text-ink-subtle tabular">Last landmark, {timecode(chapter.t, false)} UTC</p>
            <h2 className="mt-0.5 font-sans text-title-3 font-bold text-ink">{chapter.title}</h2>
            <div className="mt-1">
              <JumpButton eventId={chapter.id} label="Go to event" />
            </div>
          </>
        ) : null}
        {moment && moment.id !== chapter?.id ? (
          <div className="mt-4 border-l-2 border-factory-select pl-3">
            <p className="font-mono text-[11px] text-ink-subtle tabular">Latest significant moment, {timecode(moment.t)}</p>
            <p className="mt-0.5 text-body-sm text-ink">{moment.text}</p>
            <div className="mt-1">
              <JumpButton eventId={moment.id} label={source === "simulation" ? "Go to this moment" : "Go to event"} />
            </div>
          </div>
        ) : null}
        {!chapter && !moment && source !== "simulation" ? <p className="mt-3 text-body-sm text-ink-muted">No significant moment has been received yet.</p> : null}
      </div>
      {connection ? (
        <Section title="Connection">
          <ConnectionFacts connection={connection} />
        </Section>
      ) : null}
      <Section title="Cells">
        {cellList.length ? (
          <RefList>
            {cellList.map(([ticketId, stage, working]) => (
              <CellRow key={ticketId} ticketId={ticketId} stage={stage} working={Number(working)} />
            ))}
          </RefList>
        ) : (
          <p className="text-body-sm text-ink-muted">No cell is open yet.</p>
        )}
      </Section>
      {waiting.length || Object.keys(attention).length ? (
        <Section title="Waiting">
          <RefList>
            {Object.entries(attention).map(([id, a]) => (
              <RefLink key={id} to={ref.gate(`${id}/human-approval`)} glyph={<CellGlyph size={18} state="human" />} detail="a person">
                <span className="font-mono text-[12px]">{id}</span> {a.reason}
              </RefLink>
            ))}
            {waiting.map((s) => {
              const look = schedulerLook(s.scheduler);
              return (
                <div key={s.id}>
                  <RefLink to={ref.slice(s.id)} glyph={<SliceGlyph size={18} state={look.state} mark={look.mark} />} detail={look.label}>
                    <span className="font-mono text-[12px]">{s.id}</span> <span className="text-ink-muted">{s.title}</span>
                  </RefLink>
                  {s.reasons[0] ? <p className="mb-1 ml-8 text-caption text-ink-subtle">{s.reasons.join(" ")}</p> : null}
                </div>
              );
            })}
          </RefList>
        </Section>
      ) : null}
      <Actors />
      {source === "simulation" ? <RunCounts /> : <ReceivedCounts />}
    </div>
  );
}

/** The run's counts change with nearly every event, so they render on their own. */
function RunCounts() {
  const counters = useScene((s) => s.counters);
  return (
    <>
      <Section title="So far">
        <Facts
          facts={[
            ["Agents", `${counters.agentsActive} working, ${counters.agentsStarted} started`],
            ["Tool calls", `${counters.toolCallsActive} running, ${counters.toolCalls} made`],
            ["Artifacts", `${counters.artifacts}, of which ${counters.commits} commits`],
            ["Test runs", counters.testRuns],
            ["Checks", `${counters.checksPassed} passed, ${counters.checksFailed} failed`],
            ["Review rounds", `${counters.reviewRounds}, ${counters.blockers} blockers, ${counters.notes} notes`],
            ["People", `${counters.humanApprovals} approval${counters.humanApprovals === 1 ? "" : "s"}`],
            ["Landed", `${counters.merged} merged, ${counters.integrated} integrated`],
            ["Cost", `$${counters.costUsd.toFixed(2)} (simulated)`],
            ["Events", counters.events],
          ]}
        />
      </Section>
    </>
  );
}

/**
 * Real history's counts, from received facts only: what each count is made of is said, and what no
 * record says is "Not recorded" (never 0). Workflow agents' tool calls are their reported counts.
 */
function ReceivedCounts() {
  const counters = useScene((s) => s.counters);
  const executions = useScene((s) => s.executions);
  const cells = useScene((s) => s.cells);
  const events = useSceneStore((s) => s.cursor);
  const { perCall, counted, countOnly, cost, costed, under } = useMemo(() => {
    let perCallN = 0;
    let countedN = 0;
    let countOnlyN = 0;
    for (const cell of Object.values(cells)) {
      for (const id of cell.agentOrder) {
        const a = cell.agents[id];
        if (!a) continue;
        if (a.observation === "count-only") {
          countOnlyN += 1;
          countedN += a.toolCallCount ?? 0;
        } else perCallN += a.toolCalls.length;
      }
    }
    let total = 0;
    let costedN = 0;
    let underAny = false;
    for (const x of Object.values(executions)) {
      const c = recordedCost(x);
      if (c === null) continue;
      total += c;
      costedN += 1;
      underAny = underAny || mayBeUnderReported(x);
    }
    return { perCall: perCallN, counted: countedN, countOnly: countOnlyN, cost: total, costed: costedN, under: underAny };
  }, [cells, executions]);
  const executionCount = Object.keys(executions).length;
  return (
    <Section title="So far">
      <Facts
        facts={[
          ["Events", `${events.toLocaleString("en-GB")} received up to the playhead`],
          ["Executions", `${counters.executionsRunning} running, ${executionCount} seen`],
          ["Agents", `${counters.agentsActive} working, ${counters.agentsStarted} started`],
          ["Tool calls", countOnly ? `${perCall.toLocaleString("en-GB")} observed one by one; ${counted.toLocaleString("en-GB")} reported as counts by ${countOnly} workflow agent${countOnly === 1 ? "" : "s"}` : `${perCall.toLocaleString("en-GB")} observed`],
          ["Review rounds", `${counters.reviewRounds}, ${counters.blockers} blockers, ${counters.notes} notes`],
          ["People", `${counters.humanApprovals} approval${counters.humanApprovals === 1 ? "" : "s"} by a person`],
          ["Landed", `${counters.merged} merged, ${counters.integrated} integrated`],
          [
            "Cost",
            costed ? (
              <span key="c">
                ${cost.toFixed(2)} recorded, over {costed} of {executionCount} execution{executionCount === 1 ? "" : "s"}
                {under ? <span className="block text-caption text-warning-ink">May be under-reported: a budget stop ended work in flight.</span> : null}
              </span>
            ) : (
              <NotRecorded key="c" />
            ),
          ],
        ]}
      />
    </Section>
  );
}

function CellRow({ ticketId, stage, working }: { ticketId: string; stage: CellStage; working: number }) {
  const look = stageLook(stage);
  const title = useScene((s) => {
    const cell = s.cells[ticketId];
    if (!cell) return "";
    return isKnown(cell.meta, "title") ? cell.title : (s.slices[cell.sliceId]?.title ?? "");
  });
  return (
    <RefLink to={ref.cell(ticketId)} glyph={<CellGlyph size={20} state={look.state} />} detail={working ? `${look.label}, ${working} working` : look.label}>
      <span className="font-mono text-[12px]">{ticketId}</span> <span className="text-ink-muted">{title}</span>
    </RefLink>
  );
}

/** The two actors that are not agents: the line supervisor and the scheduler, with their last act. */
function Actors() {
  const actors = useScene((s) => s.actors);
  return (
    <Section title="Actors">
      <RefList>
        {(["supervisor", "scheduler"] as const).map((id) => {
          const a = actors[id];
          return (
            <RefLink key={id} to={ref.actor(id)} glyph={<ActorGlyph actor={id} size={20} />} detail={a.lastActedAt !== null ? `${a.acts} acts, last ${timecode(a.lastActedAt, false)}` : "not yet"}>
              {ACTOR_WORDS[id].role} {a.lastKind ? <span className="font-mono text-[12px] text-ink-muted">{a.lastKind}</span> : null}
            </RefLink>
          );
        })}
      </RefList>
    </Section>
  );
}
