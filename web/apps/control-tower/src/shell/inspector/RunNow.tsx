/**
 * The inspector with nothing selected: the run at the playhead. What chapter this is, the latest
 * significant moment, what is working now, who is waiting and why, and the run's counts.
 */
import { useMemo } from "react";
import { chapterAt, moments, ref, SCENARIO, type CellStage, type Moment } from "../../sim";
import { useScene, useSceneStore } from "../../scene";
import { ActorGlyph, CellGlyph, SliceGlyph } from "../glyphs";
import { ACTOR_WORDS, schedulerLook, stageLook, timecode } from "../vocab";
import { Facts, JumpButton, RefLink, RefList, Section } from "./parts";

const MAJOR = moments(SCENARIO, "major");

function latestMoment(list: readonly Moment[], t: number): Moment | null {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid] as Moment).t <= t) lo = mid + 1;
    else hi = mid;
  }
  return list[lo - 1] ?? null;
}

export function RunNow() {
  const chapter = useSceneStore((s) => chapterAt(s.fixture, s.playhead));
  const moment = useSceneStore((s) => latestMoment(MAJOR, s.playhead));
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
  const n = chapter ? SCENARIO.chapters.indexOf(chapter) + 1 : 0;
  return (
    <div>
      <div className="px-5 pb-4 pt-5">
        <p className="text-caption text-ink-subtle">Nothing selected. The run at the playhead.</p>
        {chapter ? (
          <>
            <p className="mt-3 text-caption text-ink-subtle tabular">
              Chapter {n} of {SCENARIO.chapters.length}, from {timecode(chapter.t, false)}
            </p>
            <h2 className="mt-0.5 font-serif text-title-3 text-ink">{chapter.title}</h2>
            <p className="mt-1.5 text-body-sm text-ink-muted">{chapter.summary}</p>
          </>
        ) : null}
        {moment ? (
          <div className="mt-4 border-l-2 border-factory-select pl-3">
            <p className="font-mono text-[11px] text-ink-subtle tabular">Latest significant moment, {timecode(moment.t)}</p>
            <p className="mt-0.5 text-body-sm text-ink">{moment.text}</p>
            <div className="mt-1">
              <JumpButton seq={moment.seq} />
            </div>
          </div>
        ) : null}
      </div>
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
      <RunCounts />
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

const TITLES = Object.fromEntries(Object.values(SCENARIO.definitions.slices).map((d) => [d.id, d.title]));

function CellRow({ ticketId, stage, working }: { ticketId: string; stage: CellStage; working: number }) {
  const look = stageLook(stage);
  const title = useScene((s) => s.cells[ticketId]?.title ?? TITLES[s.cells[ticketId]?.sliceId ?? ""] ?? "");
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
