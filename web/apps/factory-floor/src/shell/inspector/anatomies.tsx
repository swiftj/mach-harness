/**
 * One anatomy per entity type (spec f.9, item 3 and 5): the facts that matter for that kind of
 * thing now, each related entity a link where it is named (no "Related" list: the ticket that owns
 * the entity is the link in the header's id). Each reads its entity's own object from
 * the scene, so it re-renders when that entity changes, not on every tick.
 */
import { useMemo, type ReactNode } from "react";
import { stations as stationLooks, type StationKind } from "@mach/ui";
import {
  ACTOR_KINDS,
  activityOf,
  holdOf,
  artifactCountsOf,
  costCompletenessOf,
  cellGateList,
  executionStatusOf,
  isKnown,
  sourceRuntimeOf,
  streamObservationOf,
  visitStatusOf,
  type Scene,
  carriedOnTitle,
  carriedOnWords,
  roundAgainstLimit,
  roundGroups,
  roundOfWords,
  stoppedForPerson,
  ref,
  type ActorState,
  type AgentState,
  type ArtifactState,
  type CellState,
  type DependencyState,
  type EntityRef,
  type ExecutionState,
  type FindingState,
  type GateState,
  type ProjectEntity,
  type SeatEntity,
  type SliceState,
  type ToolCallState,
  type VisitEntity,
  type WorkflowEntity,
  executionEndedAt,
  parkedWords,
} from "../../sim";
import { useScene } from "../../scene";
import { AgentGlyph, ArtifactGlyph, DependencyGlyph, GateGlyphSmall, StateGlyph, StateWord, StationGlyph, ToolGlyph } from "../glyphs";
import {
  ACTOR_WORDS,
  artifactOf,
  gateName,
  gateOf,
  gateState,
  modelName,
  outcomeState,
  roleOf,
  ROLE_WORDS,
  runState,
  schedulerLook,
  stageLook,
  STATION_WORDS,
  tierOf,
  spanCode,
  timecode,
  timecodeInline,
  toolFamily,
} from "../vocab";
import { When } from "../When";
import { Elapsed, EntityLink, Facts, Mono, NotRecorded, RecurrenceLink, RefLink, RefList, Section, StationHistoryLink, useEntityEvents, VisitHistoryLink } from "./parts";
import { parseStation } from "./entity";
import { reviewTally } from "./timing";
import { activityNote, agentsWords, interruptionWords, modelCostsOf, planWords, reviewerWords, runtimeWords, seatModelName, visitLeftWords } from "./words";
import { useFreeTextLabel } from "./catalog";
import { EventWords, FreeText, FreeTextLabel } from "./FreeText";
import { evaluationWords, gateDecisionOf, gatePositionWords, NO_REASON_WORDS, outcomeStateWords, outcomeWordsOf, visitStateWords } from "./outcomes";
import { OpenEvidence } from "../../evidence/OpenEvidence";
import { checkCitingPath } from "../../evidence/model";
import { useSource } from "../source/context";
import { landedCommitOf, type CommitLink } from "../../line/lanesModel";
import { lanesKey, useCellLanes } from "../../line/useLanes";
import { rowOfCell } from "../../line/model";
import { StoppedPanel } from "../../stopped/StoppedPanel";
import { useNeeds } from "../../needs/context";
import { historyEndedAt, useSceneStore } from "../../scene";
import { isStale, type FactoryStatus } from "../../scene/connection";

/**
 * How a live agent's activity was read (observer M6.2 runtime states): a phrase when its stream's
 * runtime is not proven (unproven, not stated yet, some records refused), else null. A string, so the
 * selector stays stable.
 */
function useAgentNote(agent: AgentState): string | null {
  const status = useSceneStore((s) => s.factoryStatus);
  return useScene((s) => {
    const x = agent.executionId ? s.executions[agent.executionId] : undefined;
    if (!x || agent.meta.authority === "simulated") return null;
    return activityNote(streamObservationOf(s, x.id, sourceRuntimeOf(status?.sources, x.id)));
  });
}

/** An execution's agents in words (D7): a count when its stream was read, "Not observed" with the reason otherwise. Strings, so selectors stay stable. */
function agentsOf(scene: Scene, status: FactoryStatus | null, executionId: string | null, started: number, working?: number): string {
  if (!executionId || !scene.executions[executionId]) return agentsWords(null, started, working);
  const observation = streamObservationOf(scene, executionId, sourceRuntimeOf(status?.sources, executionId));
  // The simulation records every agent: its count stands as it is.
  if (scene.executions[executionId]?.meta.authority === "simulated") return agentsWords(null, started, working);
  return agentsWords(observation, started, working);
}

const at = (t: number | null | undefined) => (t === null || t === undefined ? "not yet" : <Mono><When t={t} /></Mono>);

/** An agent by its role (and seat), never by its opaque id. */
const agentWord = (agent: Pick<AgentState, "role" | "seat">): string => (agent.role === "reviewer" && agent.seat ? `Reviewer, ${agent.seat}` : ROLE_WORDS[agent.role]);

function AgentLink({ agent }: { agent: AgentState }) {
  const word = agentWord(agent);
  return (
    <RefLink to={ref.agent(agent.id)} glyph={<AgentGlyph tier={tierOf(agent.model)} agentRole={roleOf(agent.role)} size={20} state={runState(agent.status)} />} detail={agent.status === "running" ? "working" : <When t={agent.startedAt} age={false} />}>
      {word} <FreeText field="agentLabel" text={agent.label} labelled expandable={false} className="text-ink-subtle" />
    </RefLink>
  );
}

/**
 * What the inspector shows of an artifact (I-45, M6.4): its recorded facts. Its content is never read
 * here; a file a verification check cites opens in the evidence player (src/evidence), through the
 * observer's guarded content route by catalog id, beside the check it proves, with its free-text label.
 */
export const ARTIFACT_CONTENT_NOTE = "These are the artifact's recorded facts. A file a verification check cites opens in the evidence player, beside the check it proves; any other file is listed here with its facts only.";

/**
 * The persistent label on an evidence document served as free text the observer could not check for
 * names (R1, the product owner's decision): text, so it is read with the row or fact it sits in.
 */
function FreeTextNote({ label, block = false }: { label: string; block?: boolean }) {
  return (
    <span data-free-text="" className={block ? "mt-1 block text-caption font-semibold text-warning-ink" : "ml-1.5 text-caption font-semibold text-warning-ink"}>
      {block ? label : `· ${label}`}
    </span>
  );
}

export function ArtifactLink({ artifact }: { artifact: ArtifactState }) {
  const freeText = useFreeTextLabel(artifact);
  return (
    <RefLink to={ref.artifact(artifact.id)} glyph={<ArtifactGlyph kind={artifactOf(artifact.kind)} size={18} failed={/findings/.test(artifact.kind)} />} detail={<When t={artifact.writtenAt} age={false} />}>
      <span className="font-mono text-[12px]">{artifact.label}</span>
      {freeText ? <FreeTextNote label={freeText} /> : null}
    </RefLink>
  );
}

function GateLink({ gate, to }: { gate: GateState; to?: EntityRef }) {
  return (
    <RefLink to={to ?? ref.gate(gate.id)} glyph={<GateGlyphSmall kind={gateOf(gate.gate)} size={18} state={gateState(gate.state)} />} detail={gatePositionWords(gate)}>
      {gateName(gate)}
      {gate.round ? `, round ${gate.round}` : ""}
      {gate.recorded && gate.recorded.evaluations.at(-1)?.subject ? <span className="text-ink-subtle">, {gate.recorded.evaluations.at(-1)?.subject}</span> : null}
    </RefLink>
  );
}

/**
 * An id, in a fact, that is a link to its entity. There is no "Related" list: a panel links what it
 * relates to where it is named, and the ticket that owns it in the header's id.
 */
function IdLink({ to, id, label }: { to: EntityRef; id: string; label?: string }) {
  return (
    <EntityLink to={to} label={label} className="font-mono text-[12px] [overflow-wrap:anywhere]">
      {id}
    </EntityLink>
  );
}

/** Refused requests as the supervisor recorded them (`refused_tools[]`, free text): each contained, labelled once. */
function RefusedTools({ tools }: { tools: readonly string[] }) {
  return (
    <span className="flex flex-col">
      <span>
        {tools.map((t, i) => (
          <span key={i}>
            {i ? ", " : null}
            <FreeText field="refusedTool" text={t} labelled />
          </span>
        ))}
      </span>
      <FreeTextLabel className="text-caption text-ink-subtle" />
    </span>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-body-sm text-ink-muted">{children}</p>;
}

/** A workflow's declared phase titles (`workflow.phases_declared`, prose): each contained, the label once. */
function DeclaredPhases({ phases }: { phases: readonly string[] }) {
  return (
    <span className="flex flex-col">
      <span>
        {phases.map((p, i) => (
          <span key={`${i}-${p.length}`}>
            {i ? ", " : null}
            <FreeText field="declaredPhase" text={p} labelled />
          </span>
        ))}
      </span>
      <FreeTextLabel className="text-caption text-ink-subtle" />
    </span>
  );
}

// ---------------------------------------------------------------- slice

/** A slice's epic: its recorded name (free text, contained) and its id; "not recorded" when neither is. */
function EpicWords({ epicId, epicTitle }: { epicId: string | null; epicTitle: string | null }) {
  if (!epicId && !epicTitle) return <NotRecorded />;
  return (
    <span>
      {epicTitle ? <FreeText field="epicTitle" text={epicTitle} /> : null}
      {epicId ? <span className="ml-1 font-mono text-[12px] text-ink-muted">{epicId}</span> : null}
    </span>
  );
}

export function SliceAnatomy({ slice }: { slice: SliceState }) {
  const deps = useScene((s) => s.dependencies);
  const cell = useScene((s) => s.cells[slice.ticketId] ?? null);
  const waitsFor = Object.values(deps).filter((d) => d.from === slice.id);
  const blocks = Object.values(deps).filter((d) => d.to === slice.id);
  // M6.6 D2: held by the line supervisor, in its recorded words only (no wait kind is claimed).
  const hold = holdOf(useScene((s) => s.supervisor.holds), slice);
  const look = hold ? { label: "Eligible, held by the supervisor", state: "waiting" as const, mark: undefined } : schedulerLook(slice.scheduler);
  return (
    <>
      <Section title="Scheduler">
        <Facts
          facts={[
            ["State", <StateWord key="s" state={look.state} mark={look.mark} label={look.label} />],
            ["Since", at(slice.since)],
            hold ? ["Held since", at(hold.since)] : null,
            ["Risk", isKnown(slice.meta, "risk") ? slice.risk : <NotRecorded key="r" />],
            // The ticket's cell, once it has one: a link (the only way to it from here).
            ["Ticket", slice.ticketId ? cell ? <IdLink key="t" to={ref.cell(cell.ticketId)} id={slice.ticketId} /> : <Mono key="t">{slice.ticketId}</Mono> : <NotRecorded key="t" />],
            ["Issue", slice.issue !== null ? <Mono key="i">#{slice.issue}</Mono> : <NotRecorded key="i" />],
            ["Epic", <EpicWords key="e" epicId={slice.epicId} epicTitle={slice.epicTitle} />],
            slice.integratedCommit ? ["Integrated", <Mono key="c">{slice.integratedCommit.slice(0, 7)}</Mono>] : null,
          ]}
        />
        {hold ? (
          <div className="mt-3 rounded-sm border border-dashed border-factory-wait bg-factory-wait-soft px-3 py-2">
            <p className="text-caption font-semibold text-ink">Why the supervisor holds it, in its words</p>
            <p className="mt-1 text-body-sm text-ink-muted">
              <FreeText field="heldWhy" text={hold.why} labelled />
            </p>
            <FreeTextLabel />
          </div>
        ) : null}
        {slice.reasons.length ? (
          <div className="mt-3 rounded-sm border border-dashed border-factory-wait bg-factory-wait-soft px-3 py-2">
            <p className="text-caption font-semibold text-ink">Why it waits, in the scheduler's words</p>
            <ul className="mt-1 list-disc pl-4 text-body-sm text-ink-muted">
              {slice.reasons.map((r) => (
                <li key={r}>
                  <FreeText field="waitReason" text={r} labelled />
                </li>
              ))}
            </ul>
            <FreeTextLabel />
          </div>
        ) : null}
        {slice.summary ? <p className="mt-3 text-body-sm text-ink-muted">{slice.summary}</p> : null}
        {/* What it waits for and what waits for it: the scheduler's dependencies, each a link. */}
        {waitsFor.length || blocks.length ? (
          <div className="mt-3">
            <RefList>
              {waitsFor.map((d) => (
                <RefLink key={d.id} to={ref.dependency(d.from, d.to)} glyph={<DependencyGlyph size={18} satisfied={d.state === "satisfied"} />} detail={d.state === "satisfied" ? "satisfied" : "blocking"}>
                  Waits for <span className="font-mono text-[12px]">{d.to}</span>
                </RefLink>
              ))}
              {blocks.map((d) => (
                <RefLink key={d.id} to={ref.dependency(d.from, d.to)} glyph={<DependencyGlyph size={18} satisfied={d.state === "satisfied"} />} detail={d.state === "satisfied" ? "released" : "held"}>
                  <span className="font-mono text-[12px]">{d.from}</span> waits for this
                </RefLink>
              ))}
            </RefList>
          </div>
        ) : null}
      </Section>
      <Section title="History">
        <ol className="flex flex-col gap-1 text-body-sm">
          {slice.history.map((h) => {
            const l = schedulerLook(h.state);
            return (
              <li key={h.seq} className="flex items-center gap-2">
                <StateGlyph state={l.state} mark={l.mark} size={11} />
                <span className="flex-1 text-ink">{l.label}</span>
                <Mono muted><When t={h.at} /></Mono>
              </li>
            );
          })}
        </ol>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- cell

/** A cell stopped for a person: the same panel the Line opens from its "Stopped" box (src/stopped). */
function CellStopped({ cell }: { cell: CellState }) {
  const needs = useNeeds();
  const words = useScene((s) => {
    // The stop's sentence and moment do not depend on the clock: 0 is enough here.
    const row = rowOfCell(s, cell, 0);
    return `${row.since ?? ""}\u0000${row.why}`;
  });
  const [since, why] = words.split("\u0000") as [string, string];
  const need = needs.find(cell.ticketId);
  return (
    <div className="mb-5 rounded-sm border border-factory-fail bg-factory-fail-soft/40 px-3 py-3" data-cell-stopped={cell.ticketId}>
      <StoppedPanel ticketId={cell.ticketId} cell={cell} sentence={why} at={since ? Number(since) : null} need={need} live={cell.meta.authority !== "simulated"} />
    </div>
  );
}

export function CellAnatomy({ cell }: { cell: CellState }) {
  const gates = useScene((s) => s.gates);
  const look = stageLook(cell.stage);
  const active = cell.activeAgentIds.map((id) => cell.agents[id]).filter((a): a is AgentState => Boolean(a));
  // Every gate evaluated for this cell (D6): its gate states and every evaluation no gate state
  // stands for (each override, refusal and pass: frozen-tests, build.start...), each a link.
  // (from the cell and the gate record, both stable objects: a selector returning a new array would re-render forever)
  const gateList = useMemo(() => cellGateList({ cells: { [cell.ticketId]: cell }, gates } as unknown as Scene, cell.ticketId), [cell, gates]);
  const factory = useSceneStore((s) => s.factoryStatus);
  const agentsLine = useScene((s) => agentsOf(s, factory, cell.executionId, cell.agentOrder.length, active.length));
  const artifactCounts = artifactCountsOf(cell);
  const recordedChecks = cell.verifications.reduce((n, v) => n + v.checks.filter((c) => c.result !== "pending").length, 0);
  // Live: what the cell is doing now, from what is recorded (the nine states; idle between two
  // executions is said as such, never "working"). A string, so the selector is stable.
  const live = cell.meta.authority !== "simulated";
  const stale = useSceneStore((s) => isStale(s.connection));
  const now = useScene((s) => (live ? activityOf(s, ref.cell(cell.ticketId), { stale }).reason : null));
  // A wait on a dependency or a person quotes the record's own words (its reasons, what it waits for): contained.
  const nowQuotes = useScene((s) => (live ? ["waiting-dependency", "waiting-person"].includes(activityOf(s, ref.cell(cell.ticketId), { stale }).state) : false));
  return (
    <>
      {stoppedForPerson(cell) ? <CellStopped cell={cell} /> : null}
      <Section title="Facts">
        <Facts
          facts={[
            ["Stage", <StateWord key="s" state={look.state} mark={look.mark} label={look.label} />],
            ["Round", stoppedForPerson(cell) ? `${roundOfWords(cell)}, stopped for a person` : roundOfWords(cell)],
            ["Slice", <Mono key="sl">{cell.sliceId}</Mono>],
            now ? ["Now", nowQuotes ? <FreeText key="n" field="waitReason" text={now} /> : now] : null,
            ["Risk", isKnown(cell.meta, "risk") ? cell.risk : <NotRecorded key="r" />],
            ["App type", isKnown(cell.meta, "appType") ? cell.appType : cell.plan?.appType ? <Mono key="a">{cell.plan.appType}</Mono> : <NotRecorded key="a" />],
            live ? ["Plan", cell.plan ? planWords(cell.plan) : <NotRecorded key="p" />] : null,
            ["Worktree", <Mono key="w" muted>{`.factory/worktrees/${cell.ticketId}/repo`}</Mono>],
            ["Branch", <Mono key="b" muted>{cell.branch}</Mono>],
            ["At station", cell.station ? <span key="st">{STATION_WORDS[cell.station as StationKind]}, <Elapsed startedAt={cell.stationSince ?? 0} finishedAt={null} /></span> : "Between stations"],
            ["Suite", cell.lastTest ? `${cell.suite}, ${cell.lastTest.passed} passed, ${cell.lastTest.failed} failed` : cell.suite === "unknown" ? <NotRecorded key="s" /> : cell.suite],
            ["Agents", agentsLine],
            // Two different counts, each named for what it is (D13); the files available to view are the observer's catalog.
            ["Artifacts referenced", `${artifactCounts.distinct} distinct`],
            artifactCounts.records !== artifactCounts.distinct ? ["Artifact records", `${artifactCounts.records} received (a file recorded again counts again)`] : null,
            cell.merged ? ["Merged", <Mono key="m">{`${cell.merged.commit.slice(0, 7)}, `}<When t={cell.merged.at} inline /></Mono>] : null,
          ]}
        />
      </Section>
      <Section title="Rounds">
        {cell.verifications.length === 0 && cell.reviews.length === 0 ? <Empty>No verification or review yet.</Empty> : null}
        <ol className="flex flex-col gap-3">
          {roundGroups(cell).map((g) => {
            if (g.kind === "carried-on") {
              return (
                <li key={g.key} className="rounded-sm border border-dashed border-factory-human bg-factory-human-soft px-3 py-2" data-round-carried-on={g.carry.by ?? ""}>
                  <p className="text-caption font-semibold text-ink">
                    {carriedOnTitle(g.carry)}, <When t={g.carry.at} inline />
                  </p>
                  <p className="mt-0.5 text-caption text-ink-muted">{carriedOnWords(g.carry)}</p>
                </li>
              );
            }
            const n = g.round;
            const v = g.verification;
            const r = g.review;
            const passed = v ? v.checks.filter((c) => c.result === "pass").length : 0;
            return (
              <li key={g.key} className="rounded-sm border border-line px-3 py-2">
                <p className="mb-1 text-caption font-semibold text-ink">
                  Round {n}
                  {g.reads ? <span className="font-normal text-ink-muted"> · reads {g.reads}</span> : null}
                </p>
                <RefList>
                  {v ? (
                    <RefLink to={ref.gate(`${cell.ticketId}/verification#${n}`)} glyph={<GateGlyphSmall kind="verification" size={18} state={v.status === "running" ? "active" : v.status === "PASS" ? "succeeded" : "failed"} />} detail={`${passed} of ${v.checks.length}`}>
                      Verification {v.status === "running" ? "running" : v.status === "PASS" ? "passed" : "failed"}
                    </RefLink>
                  ) : null}
                  {r ? (
                    <RefLink to={ref.gate(`${cell.ticketId}/review#${n}`)} glyph={<GateGlyphSmall kind="consensus" size={18} state={r.outcome === null ? "active" : r.outcome === "APPROVED" ? "succeeded" : r.outcome === "AWAITING_HUMAN" ? "human" : "failed"} />} detail={reviewTally(r)}>
                      Review {r.outcome ? r.outcome.toLowerCase().replace("_", " ") : "in progress"}
                    </RefLink>
                  ) : null}
                </RefList>
              </li>
            );
          })}
        </ol>
      </Section>
      <Section title="Evidence" aside={<span className="text-caption text-ink-subtle">{recordedChecks} {recordedChecks === 1 ? "check" : "checks"} recorded</span>}>
        <p className="mb-2 text-body-sm text-ink-muted">What the verifier captured for each check: screenshots, recordings and transcripts, beside the check they prove.</p>
        <OpenEvidence ticket={cell.ticketId}>Open the evidence player</OpenEvidence>
      </Section>
      <Section title="Stage history">
        <ol className="flex flex-col gap-1 text-body-sm">
          {cell.stageHistory.map((h) => {
            const l = stageLook(h.stage);
            return (
              <li key={h.seq} className="flex items-center gap-2">
                <StateGlyph state={l.state} mark={l.mark} size={11} />
                <span className="w-24 shrink-0 text-ink">{l.label}</span>
                <span className="min-w-0 flex-1 truncate text-caption text-ink-subtle" title={h.by}>
                  {h.by}
                </span>
                <Mono muted><When t={h.at} /></Mono>
              </li>
            );
          })}
        </ol>
      </Section>
      <Section title={active.length ? "Working now" : "Agents"}>
        {active.length ? (
          <RefList>
            {active.map((a) => (
              <AgentLink key={a.id} agent={a} />
            ))}
          </RefList>
        ) : null}
        {active.length ? <FreeTextLabel what="Agent labels" /> : (
          <Empty>No agent is working in this cell now. {cell.agentOrder.length} have worked here.</Empty>
        )}
      </Section>
      <Section title="Gates">
        {gateList.length ? (
          <RefList>
            {gateList.map((g) => (
              <GateLink key={g.ref} gate={g.gate} to={g.ref} />
            ))}
          </RefList>
        ) : (
          <Empty>No gate has been reached.</Empty>
        )}
      </Section>
      <Section title="Latest artifacts" aside={<span className="text-caption text-ink-subtle">{cell.artifacts.length} in all</span>}>
        <RefList>
          {cell.artifacts.slice(-6).reverse().map((a) => (
            <ArtifactLink key={a.id} artifact={a} />
          ))}
        </RefList>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- station visit

export function StationAnatomy({ id, cell }: { id: string; cell: CellState }) {
  const { station } = parseStation(id);
  const gates = useScene((s) => s.gates);
  const kind = station as StationKind;
  const visits = cell.visits.filter((v) => v.station === station);
  const agents = cell.agentOrder.map((a) => cell.agents[a]).filter((a): a is AgentState => Boolean(a && a.station === station));
  const artifacts = cell.artifacts.filter((a) => a.station === station);
  const gateKinds: Record<string, string[]> = { verify: ["verification"], review: ["review"], "human-approval": ["human-approval"], merge: ["merge-revalidation"], build: ["audit", "red-before-green"], plan: ["plan-check"] };
  const related = Object.values(gates).filter((g) => g.ticketId === cell.ticketId && (gateKinds[station] ?? []).includes(g.gate));
  return (
    <>
      <Section title="Facts" aside={<StationHistoryLink kind={station} />}>
        <Facts
          facts={[
            ["Station", STATION_WORDS[kind]],
            ["Skill", <Mono key="k">{stationLooks[kind]?.skill ?? station}</Mono>],
            ["Cell", <Mono key="c">{cell.ticketId}</Mono>],
            ["Visits", visits.length],
            station === "merge" && cell.merged ? ["Merged", <Mono key="m">{`${cell.merged.commit.slice(0, 7)}${cell.merged.revalidated ? ", revalidated" : ""}`}</Mono>] : null,
          ]}
        />
      </Section>
      <Section title="Visits">
        <ol className="flex flex-col gap-2">
          {visits.map((v) => {
            const status = visitStatusOf(v);
            const state = status.state === "working" ? "active" : status.state === "waiting-person" ? "human" : status.state === "ended-unrecorded" ? "idle" : outcomeState(v.outcome);
            return (
              <li key={v.enteredSeq} className="flex items-start gap-2.5 rounded-sm border border-line px-3 py-2">
                <StationGlyph kind={kind} size={22} state={state} />
                <div className="min-w-0 flex-1">
                  <p className="text-body-sm text-ink">
                    Round {v.round}, {v.action}
                    <span className="text-ink-muted">
                      {" "}
                      {status.state === "ended" ? `${visitStateWords(v).toLowerCase()}, ` : status.state === "ended-unrecorded" ? "" : `${status.word.toLowerCase()}, `}<Elapsed startedAt={v.enteredAt} finishedAt={v.leftAt} mode={status.state === "waiting-person" ? "wait" : status.state === "ended-unrecorded" ? "ended-unrecorded" : v.interrupted ? "interrupted" : "work"} />
                    </span>
                  </p>
                  <p className="font-mono text-[11px] text-ink-subtle tabular">
                    {v.leftAt === null ? `${timecode(v.enteredAt)} to now` : spanCode(v.enteredAt, v.leftAt, status.state === "ended-unrecorded" ? "at most " : "")}
                  </p>
                  {v.interrupted ? <p className="text-[11px] text-ink-subtle">Not continuous: {interruptionWords(v, (t) => timecodeInline(t, true))}.</p> : null}
                </div>
              </li>
            );
          })}
        </ol>
      </Section>
      {related.length ? (
        <Section title="Gates">
          <RefList>
            {related.map((g) => (
              <GateLink key={g.id} gate={g} />
            ))}
          </RefList>
        </Section>
      ) : null}
      <Section title="Workers">
        {agents.length ? (
          <RefList>
            {agents.map((a) => (
              <AgentLink key={a.id} agent={a} />
            ))}
          </RefList>
        ) : (
          <Empty>No agent has worked at this station yet.</Empty>
        )}
        {agents.length ? <FreeTextLabel what="Agent labels" /> : null}
      </Section>
      {artifacts.length ? (
        <Section title="Written here" aside={<span className="text-caption text-ink-subtle">{artifacts.length}</span>}>
          <RefList>
            {artifacts.slice(-8).reverse().map((a) => (
              <ArtifactLink key={a.id} artifact={a} />
            ))}
          </RefList>
        </Section>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- agent

/**
 * A Dynamic Workflow agent (count-only, contract 8.1): its label, phase, model, elapsed time, token
 * total, tool-call count and last tool name. Its individual tool calls are not observable, so none is
 * listed, ticked or timed; no cost is shown for it (no per-agent cost exists).
 */
function CountOnlyAgent({ agent }: { agent: AgentState }) {
  const cell = useScene((s) => s.cells[agent.ticketId] ?? null);
  const known = (field: string) => isKnown(agent.meta, field);
  const note = useAgentNote(agent);
  return (
    <>
      <Section title="Facts">
        <Facts
          facts={[
            ["Label", agent.label ? <FreeText key="l" field="agentLabel" text={agent.label} /> : <NotRecorded key="l" />],
            ["Phase", known("phase") && agent.phase ? <FreeText key="p" field="agentPhase" text={agent.phase} /> : <NotRecorded key="p" />],
            ["Model", known("model") ? `${modelName(agent.model)}${agent.modelName && agent.modelName !== agent.model ? ` (${agent.modelName})` : ""}` : agent.modelName ? <Mono key="m">{agent.modelName}</Mono> : <NotRecorded key="m" />],
            agent.agentType ? ["Agent type", <Mono key="t">{agent.agentType}</Mono>] : null,
            ["State", agent.lifecycle === "queued" ? "Queued in its workflow" : agent.lifecycle === "unknown" ? "Ended; how is not recorded" : agent.lifecycle === "running" ? "Running" : agent.lifecycle === "error" ? "Ended in an error" : "Finished"],
            agent.lifecycle === "queued" ? null : ["Started", known("startedAt") ? at(agent.startedAt) : <NotRecorded key="s" />],
            agent.lifecycle === "queued" ? null : ["Elapsed", agent.durationMs !== null ? `took ${durationOf(agent.durationMs)}` : <Elapsed key="e" startedAt={agent.startedAt} finishedAt={agent.finishedAt} />],
            ["Tokens", agent.tokens !== null ? agent.tokens.toLocaleString("en-GB") : <NotRecorded key="k" />],
            ["Tool calls", agent.toolCallCount !== null ? agent.toolCallCount.toLocaleString("en-GB") : <NotRecorded key="c" />],
            ["Last tool", agent.lastTool ? <Mono key="lt">{agent.lastTool}</Mono> : <NotRecorded key="lt" />],
            agent.refused.length ? ["Refused tools", <RefusedTools key="rt" tools={agent.refused} />] : null,
            note ? ["Read as", note] : null,
            // An agent's id does not name its ticket: the ticket and the execution are linked here.
            cell ? ["Ticket", <IdLink key="tk" to={ref.cell(cell.ticketId)} id={cell.ticketId} />] : null,
            agent.executionId ? ["Execution", <IdLink key="x" to={ref.execution(agent.executionId)} id={agent.executionId} />] : null,
          ]}
        />
        <p className="mt-3 text-body-sm text-ink-muted">Individual tool calls are not observable for workflow agents. The count and the last tool's name come from the workflow's progress snapshots.</p>
      </Section>
    </>
  );
}

const durationOf = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

export function AgentAnatomy({ agent }: { agent: AgentState }) {
  if (agent.observation === "count-only") return <CountOnlyAgent agent={agent} />;
  return <PerCallAgent agent={agent} />;
}

function PerCallAgent({ agent }: { agent: AgentState }) {
  const cell = useScene((s) => s.cells[agent.ticketId] ?? null);
  const parent = agent.parentId && cell ? (cell.agents[agent.parentId] ?? null) : null;
  const children = cell ? cell.agentOrder.map((id) => cell.agents[id]).filter((a): a is AgentState => Boolean(a && a.parentId === agent.id)) : [];
  const families = useMemo(() => {
    const c = new Map<ReturnType<typeof toolFamily>, number>();
    for (const call of agent.toolCalls) {
      const f = toolFamily(call.tool, call.target);
      c.set(f, (c.get(f) ?? 0) + 1);
    }
    return [...c.entries()];
  }, [agent.toolCalls]);
  const produced = cell ? cell.artifacts.filter((a) => a.writer.agentId === agent.id) : [];
  const note = useAgentNote(agent);
  return (
    <>
      <Section title="Facts">
        <Facts
          facts={[
            ["Role", ROLE_WORDS[agent.role]],
            agent.seat ? ["Seat", agent.seat] : null,
            ["Model", isKnown(agent.meta, "model") ? `${modelName(agent.model)} (${agent.tier} tier)` : agent.modelName ? <Mono key="m">{agent.modelName}</Mono> : <NotRecorded key="m" />],
            ["Effort", isKnown(agent.meta, "effort") ? agent.effort : <NotRecorded key="ef" />],
            agent.agentType ? ["Agent type", <Mono key="t">{agent.agentType}</Mono>] : null,
            ["Working on", <FreeText key="w" field="agentLabel" text={agent.label} />],
            ["Belt phase", isKnown(agent.meta, "phase") ? <FreeText key="ph" field="agentPhase" text={agent.phase} /> : <NotRecorded key="ph" />],
            agent.station ? ["Station", STATION_WORDS[agent.station as StationKind]] : null,
            ["Started", at(agent.startedAt)],
            ["Finished", agent.finishedAt === null ? "not yet" : at(agent.finishedAt)],
            ["Time at work", <Elapsed key="e" startedAt={agent.startedAt} finishedAt={agent.finishedAt} />],
            agent.summary ? ["Reported", agent.summary] : null,
            note ? ["Read as", note] : null,
            // An agent's id does not name its ticket: the ticket, the execution and the agent that started it are linked here.
            cell ? ["Ticket", <IdLink key="tk" to={ref.cell(cell.ticketId)} id={cell.ticketId} />] : null,
            agent.executionId ? ["Execution", <IdLink key="x" to={ref.execution(agent.executionId)} id={agent.executionId} />] : null,
            parent ? ["Started by", <EntityLink key="pa" to={ref.agent(parent.id)}>{agentWord(parent)}</EntityLink>] : null,
          ]}
        />
      </Section>
      <Section title="Tool calls" aside={<span className="text-caption text-ink-subtle tabular">{agent.toolCalls.length}</span>}>
        {agent.toolCalls.length ? (
          <>
            <p className="mb-2 flex flex-wrap gap-3">
              {families.map(([f, n]) => (
                <span key={f} className="inline-flex items-center gap-1 text-caption text-ink-muted">
                  <ToolGlyph family={f} size={16} />
                  {f} <span className="tabular text-ink">{n}</span>
                </span>
              ))}
            </p>
            <RefList>
              {agent.toolCalls.slice(-8).reverse().map((c) => (
                <RefLink key={c.id} to={ref.tool(c.id)} glyph={<ToolGlyph family={toolFamily(c.tool, c.target)} size={16} state={runState(c.status)} />} detail={c.status === "running" ? "running" : <When t={c.startedAt} age={false} />}>
                  <span className="font-mono text-[12px]">
                    {c.tool} <span className="text-ink-muted">{c.target}</span>
                  </span>
                </RefLink>
              ))}
            </RefList>
            {agent.toolCalls.length > 8 ? <p className="mt-1 text-caption text-ink-subtle">The latest 8 of {agent.toolCalls.length}; every call is on its timeline row.</p> : null}
          </>
        ) : (
          <Empty>No tool call yet.</Empty>
        )}
      </Section>
      {children.length ? (
        <Section title="Agents it started" aside={<span className="text-caption text-ink-subtle tabular">{children.length}</span>}>
          <RefList>
            {children.map((a) => (
              <AgentLink key={a.id} agent={a} />
            ))}
          </RefList>
          <FreeTextLabel what="Agent labels" />
        </Section>
      ) : null}
      {produced.length ? (
        <Section title="What it wrote" aside={<span className="text-caption text-ink-subtle tabular">{produced.length}</span>}>
          <RefList>
            {produced.slice(-5).map((a) => (
              <ArtifactLink key={a.id} artifact={a} />
            ))}
          </RefList>
          {produced.length > 5 ? <p className="mt-1 text-caption text-ink-subtle">The latest 5 of {produced.length}.</p> : null}
        </Section>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- tool call

export function ToolAnatomy({ call }: { call: ToolCallState }) {
  const agent = useScene((s) => s.cells[call.ticketId]?.agents[call.agentId] ?? null);
  const cell = useScene((s) => s.cells[call.ticketId] ?? null);
  const artifacts = cell ? cell.artifacts.filter((a) => call.artifactIds.includes(a.id)) : [];
  return (
    <>
      <Section title="Facts">
        <figure className="mb-3 rounded-sm border-l-2 border-line-strong bg-surface-sunken px-3 py-2">
          <figcaption className="text-caption text-ink-subtle">The call, as the agent made it (short target only)</figcaption>
          <p className="mt-0.5 break-all font-mono text-[12px] text-ink">
            {call.tool} {call.target}
          </p>
        </figure>
        <Facts
          facts={[
            ["Tool", call.toolName || call.tool],
            ["Family", toolFamily(call.tool, call.target)],
            ["Started", at(call.startedAt)],
            ["Time", <Elapsed key="e" startedAt={call.startedAt} finishedAt={call.finishedAt} />],
            ["Outcome", call.result === "unknown" ? "Not recorded: its execution ended before it returned" : call.status === "running" ? "Running" : call.status === "ok" ? "Returned" : "Returned an error"],
            call.summary ? ["Result", call.summary] : null,
            // A call's id does not name its ticket: the agent that made it and the ticket are linked here.
            agent ? ["Made by", <EntityLink key="ag" to={ref.agent(agent.id)}>{agentWord(agent)}</EntityLink>] : null,
            cell ? ["Ticket", <IdLink key="tk" to={ref.cell(cell.ticketId)} id={cell.ticketId} />] : null,
          ]}
        />
      </Section>
      {artifacts.length ? (
        <Section title="What it wrote">
          <RefList>
            {artifacts.map((a) => (
              <ArtifactLink key={a.id} artifact={a} />
            ))}
          </RefList>
        </Section>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- artifact

/**
 * M22: a commit a task made in a lane. Once the lanes are joined it no longer exists on any branch:
 * the join landed a copy under another id. The observer's lanes record links the two; that link is
 * followed here, so the lane commit reads as landed (or set aside), never as missing.
 */
function useLaneCommit(artifact: ArtifactState, cell: CellState | null): CommitLink | null | undefined {
  const { client } = useSource();
  const commit = artifact.record?.commit ?? null;
  // A ticket built in lanes: a task named its lane, or a lanes gate was evaluated.
  const inLanes = Boolean(commit && cell && (cell.tasks.some((t) => t.lane) || cell.gateLog.some((g) => g.gate === "build.lanes-open" || g.gate === "build.join" || g.gate === "build.hand-back")));
  // This very commit is one an event named as a lane's.
  const known = Boolean(commit && cell?.tasks.some((t) => t.lane && t.commit && (t.commit.startsWith(commit) || commit.startsWith(t.commit))));
  const wanted = useMemo(() => (inLanes && cell ? new Map([[cell.ticketId, lanesKey(cell)]]) : new Map<string, string>()), [inLanes, cell]);
  const replies = useCellLanes(inLanes ? client : null, wanted);
  if (!inLanes || !commit) return undefined;
  const link = landedCommitOf(replies.get(artifact.ticketId)?.lanes ?? null, commit);
  return link ?? (known ? null : undefined);
}

const LANE_COMMIT_WORDS: Readonly<Record<CommitLink["state"], string>> = {
  landed: "made in a lane; the join landed it on the ticket's branch as",
  "set-aside": "made in a lane that was set aside: not landed; its task is built again in the cell",
  "not-joined": "made in a lane; on the lane's branch until the lanes are joined",
};

export function ArtifactAnatomy({ artifact }: { artifact: ArtifactState }) {
  const cell = useScene((s) => s.cells[artifact.ticketId] ?? null);
  const laneCommit = useLaneCommit(artifact, cell);
  const freeText = useFreeTextLabel(artifact);
  const writer = artifact.writer.agentId && cell ? (cell.agents[artifact.writer.agentId] ?? null) : null;
  const base = artifact.path.split("/").pop() ?? artifact.path;
  // M6.4: a file a verification check cites opens in the evidence player at that check.
  const citing = useMemo(() => (cell ? checkCitingPath(cell, artifact.path) : null), [cell, artifact.path]);
  // Consumers: tool calls in this cell, after the write, whose target names the file. Derived from the
  // calls' short targets, so it is a lower bound.
  const readers = useMemo(() => {
    if (!cell) return [];
    const out: Array<{ call: ToolCallState; agent: AgentState }> = [];
    for (const id of cell.agentOrder) {
      const agent = cell.agents[id];
      if (!agent) continue;
      for (const call of agent.toolCalls) {
        if (call.id === artifact.writer.callId || call.startedAt < artifact.writtenAt) continue;
        if (base.length > 3 && call.target.includes(base)) out.push({ call, agent });
      }
    }
    return out;
  }, [cell, artifact, base]);
  return (
    <>
      <Section title="Facts">
        <Facts
          facts={[
            ["File", <Mono key="p">{artifact.path}</Mono>],
            ["Kind", artifact.kind],
            ["Version", artifact.version],
            artifact.sha ? ["Commit", <Mono key="s">{artifact.sha.slice(0, 7)}</Mono>] : null,
            ["Written", at(artifact.writtenAt)],
            artifact.station ? ["At station", STATION_WORDS[artifact.station as StationKind]] : null,
            artifact.round ? ["Round", artifact.round] : null,
            ["Written by", writer ? <span key="w">{ROLE_WORDS[writer.role]} (<FreeText field="agentLabel" text={writer.label} />)</span> : artifact.writer.script ? <Mono key="w">{artifact.writer.script}</Mono> : <NotRecorded key="w" />],
            artifact.record ? ["Integrity", `${artifact.record.integrity}, ${artifact.record.nature}${artifact.record.bytes !== null ? `, ${artifact.record.bytes.toLocaleString("en-GB")} bytes` : ""}`] : null,
            laneCommit !== undefined
              ? [
                  "Lane",
                  laneCommit === null ? (
                    "made in a lane; what happened to it is not recorded yet"
                  ) : (
                    <span key="lc">
                      {LANE_COMMIT_WORDS[laneCommit.state]} {laneCommit.state === "landed" && laneCommit.landed ? <Mono>{laneCommit.landed.slice(0, 10)}</Mono> : null}
                    </span>
                  ),
                ]
              : null,
            freeText ? ["Content", <FreeTextNote key="ft" label={freeText} block />] : null,
          ]}
        />
        {artifact.summary && isKnown(artifact.meta, "summary") ? <p className="mt-3 text-body-sm text-ink-muted">{artifact.summary}</p> : null}
        <p className="mt-3 text-caption text-ink-subtle" data-artifact-content-note="">
          {ARTIFACT_CONTENT_NOTE}
        </p>
        {citing ? (
          <div className="mt-2">
            <OpenEvidence ticket={artifact.ticketId} check={citing.checkId} start={{ sceneArtifactId: artifact.id, path: artifact.path }}>
              {`Open in the evidence player (${citing.checkId}, round ${citing.round})`}
            </OpenEvidence>
          </div>
        ) : null}
      </Section>
      <Section title="Writer and readers">
        <RefList>
          {writer ? <AgentLink agent={writer} /> : null}
          {artifact.writer.callId ? (
            <RefLink to={ref.tool(artifact.writer.callId)} glyph={<ToolGlyph family="write" size={16} />} detail="wrote it">
              <span className="font-mono text-[12px]">{artifact.writer.callId}</span>
            </RefLink>
          ) : null}
          {readers.slice(0, 6).map(({ call, agent }) => (
            <RefLink key={call.id} to={ref.tool(call.id)} glyph={<ToolGlyph family={toolFamily(call.tool, call.target)} size={16} />} detail={<When t={call.startedAt} age={false} />}>
              {ROLE_WORDS[agent.role]} <span className="font-mono text-[12px] text-ink-muted">{call.tool}</span>
            </RefLink>
          ))}
        </RefList>
        {readers.length === 0 ? <Empty>No later tool call names this file yet.</Empty> : <p className="mt-1 text-caption text-ink-subtle">Readers are tool calls whose target names the file: {readers.length} so far.</p>}
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- gate

export function GateAnatomy({ gate }: { gate: GateState }) {
  const cell = useScene((s) => s.cells[gate.ticketId] ?? null);
  const attention = useScene((s) => s.supervisor.attention[gate.ticketId] ?? null);
  const verification = gate.gate === "verification" && cell ? cell.verifications.find((v) => v.round === gate.round) : undefined;
  const review = (gate.gate === "review" || gate.gate === "human-approval") && cell ? (gate.gate === "review" ? cell.reviews.find((r) => r.round === gate.round) : [...cell.reviews].reverse().find((r) => r.humanApprovalRequired)) : undefined;
  const waitingSince = gate.state === "waiting" ? Math.max(0, gate.openedAt) : null;
  // A review rejection or a failed verification: how often it recurs is Analytics' Quality area.
  const recurs = gate.state === "failed" && (gate.gate === "review" || gate.gate === "verification") ? (gate.gate === "review" ? "review" : "verify") : null;
  // The lifecycle evaluation that set this gate state, if one did (the latest), for its reason and subject.
  const evaluation = useMemo(() => (gate.recorded || !cell ? null : ([...cell.gateLog].reverse().find((g) => g.gateId === gate.id) ?? null)), [gate, cell]);
  const decision = gateDecisionOf(gate, evaluation);
  // The header names the gate, shows its position and when it was decided (or reached, while open):
  // none of them is repeated here.
  const reachedEarlier = gate.decidedAt !== null && gate.openedAt !== gate.decidedAt;
  return (
    <>
      <Section title="Decision" aside={recurs ? <RecurrenceLink kind={recurs} /> : undefined}>
        <Facts
          facts={[
            decision.reason ? ["Reason", decision.reason === "none" ? NO_REASON_WORDS : <ReasonWords key="r" reason={decision.reason} />] : null,
            decision.subject ? ["For", <Mono key="s">{decision.subject}</Mono>] : null,
            gate.round ? ["Round", cell ? roundAgainstLimit(cell, gate.round) : String(gate.round)] : null,
            reachedEarlier ? ["Reached", at(gate.openedAt)] : null,
            waitingSince !== null ? ["Waiting", <Elapsed key="w" startedAt={waitingSince} finishedAt={null} mode="wait" />] : null,
            // Once merged, where the merge is (its station's visits): reached from here only.
            cell?.merged && gate.gate === "merge-revalidation" ? ["Merged", <EntityLink key="m" to={ref.station("merge", gate.ticketId)}>Merge of {gate.ticketId}</EntityLink>] : null,
          ]}
        />
        {decision.evaluations.length ? (
          <div className="mt-3">
            <p className="text-caption text-ink-subtle">Evaluated {decision.evaluations.length} times, oldest first</p>
            <ol className="mt-1 flex flex-col gap-1 text-body-sm">
              {decision.evaluations.map((e, i) => (
                <li key={`${e.at}-${i}`} className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 text-ink">{evaluationWords(e)}</span>
                  <Mono muted><When t={e.at} /></Mono>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
        {decision.detail ? <p className="mt-3 text-body-sm text-ink-muted">{decision.detail}</p> : null}
      </Section>
      {verification ? (
        <Section title="What it checked" aside={<span className="text-caption text-ink-subtle">{verification.checks.filter((c) => c.result === "pass").length} of {verification.checks.length} proven</span>}>
          <ul className="flex flex-col gap-1.5">
            {verification.checks.map((c) => (
              <li key={c.targetId} className="flex items-start gap-2 text-body-sm">
                <span className="mt-0.5">
                  <StateGlyph state={c.result === "pass" ? "succeeded" : c.result === "fail" ? "failed" : "idle"} size={12} />
                </span>
                <span className="w-9 shrink-0 font-mono text-[12px] text-ink-muted">{c.targetId}</span>
                <span className="min-w-0 flex-1 text-ink">
                  {c.title}
                  {c.note ? <span className="block text-caption text-factory-fail">{c.note}</span> : null}
                </span>
                {c.result !== "pending" ? (
                  <OpenEvidence ticket={gate.ticketId} check={c.targetId} variant="ghost" className="shrink-0">
                    {`Evidence for ${c.targetId}, ${c.evidence.length} ${c.evidence.length === 1 ? "file" : "files"}`}
                  </OpenEvidence>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-caption text-ink-subtle">Evidence required: {verification.requiredEvidence.join(", ")}</p>
        </Section>
      ) : null}
      {review && gate.gate === "review" ? (
        <Section title="Votes" aside={<span className="text-caption text-ink-subtle">{review.approvalsNeeded} approvals needed</span>}>
          <ul className="flex flex-col gap-1">
            {review.seats.map((seat) => (
              <li key={seat.seat} className="flex items-center gap-2 text-body-sm">
                <StateGlyph state={seat.vote === null ? "active" : seat.vote === "APPROVE" ? "succeeded" : "failed"} size={12} />
                <span className="flex-1 text-ink">{seat.seat}</span>
                <span className="text-caption text-ink-muted">{modelName(seat.model)}</span>
                <span className="w-16 text-right text-caption font-semibold text-ink">{seat.vote ? seat.vote.toLowerCase() : "voting"}</span>
              </li>
            ))}
          </ul>
          {review.findings.length ? (
            <div className="mt-3">
              <p className="mb-1 text-caption font-semibold text-ink">Findings</p>
              <RefList>
                {review.findings.map((f) => (
                  <FindingLink key={f.id} finding={f} />
                ))}
              </RefList>
              <FreeTextLabel what="Finding titles" />
            </div>
          ) : null}
          {review.delta ? <p className="mt-2 text-caption text-ink-subtle">Delta review since {review.delta.sinceCommit.slice(0, 7)}: {review.delta.filesChanged.length} files changed.</p> : null}
        </Section>
      ) : null}
      {gate.gate === "human-approval" ? (
        <Section title="The person">
          {review?.humanApproval ? (
            <div className="flex items-start gap-3 rounded-sm border border-factory-human bg-factory-human-soft px-3 py-2">
              <GateGlyphSmall kind="human" size={24} state="succeeded" />
              <div>
                <p className="text-body-sm font-semibold text-ink">Approved by {review.humanApproval.by}</p>
                <p className="mt-0.5 text-body-sm text-ink-muted">
                  <When t={review.humanApproval.at} className="font-mono text-[12px]" />
                  {review.humanApproval.note ? `, “${review.humanApproval.note}”` : ", no note"}
                </p>
              </div>
            </div>
          ) : review?.humanSentBack ? (
            <div className="flex items-start gap-3 rounded-sm border border-factory-human bg-factory-human-soft px-3 py-2">
              <GateGlyphSmall kind="human" size={24} state="failed" />
              <div>
                <p className="text-body-sm font-semibold text-ink">Sent back by {review.humanSentBack.by}</p>
                <p className="mt-0.5 text-body-sm text-ink-muted">
                  <When t={review.humanSentBack.at} className="font-mono text-[12px]" />
                  {review.humanSentBack.noteGiven ? ", with a reason (not shown here)" : ", no reason given"}. The change went back to the build station; it was not approved.
                </p>
              </div>
            </div>
          ) : (
            <Empty>
              {attention ? (
                <>
                  Waiting for a person: {parkedWords(attention.code) ?? <FreeText field="personNeeded" text={attention.reason} />}.
                </>
              ) : (
                "Waiting for a person to approve this High-risk change."
              )}{" "}
              Nothing moves until they do.
            </Empty>
          )}
          {review?.humanApprovalReasons.length ? (
            <ul className="mt-2 list-disc pl-4 text-body-sm text-ink-muted">
              {review.humanApprovalReasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          ) : null}
        </Section>
      ) : null}
    </>
  );
}

/**
 * A recorded reason in plain words (the code itself stays in the evidence, with its record); a code
 * the table does not know, as recorded, in mono.
 */
function ReasonWords({ reason }: { reason: { readonly words: string; readonly code: string; readonly known: boolean } }) {
  if (!reason.known) return <Mono>{reason.code}</Mono>;
  return <span>{`${reason.words[0]!.toUpperCase()}${reason.words.slice(1)}`}</span>;
}

function FindingLink({ finding }: { finding: FindingState }) {
  return (
    <RefLink to={ref.finding(finding.id)} glyph={<ArtifactGlyph kind="findings" size={16} failed={finding.severity === "blocker"} />} detail={finding.severity === "blocker" ? (finding.outvoted ? "blocker, outvoted" : "blocker") : "note"}>
      <span className="text-ink-muted">{finding.seat}:</span> <FreeText field="findingTitle" text={finding.title} labelled expandable={false} />
    </RefLink>
  );
}

// ---------------------------------------------------------------- finding

export function FindingAnatomy({ finding }: { finding: FindingState }) {
  const ticketId = finding.id.split("/")[0] ?? "";
  const round = useScene((s) => s.cells[ticketId]?.reviews.find((r) => r.round === finding.round) ?? null);
  const seat = round?.seats.find((x) => x.seat === finding.seat);
  return (
    <>
      <Section title="The finding">
        <figure className="mb-3 border-l-2 border-line-strong pl-3">
          <blockquote className="text-body text-ink">
            <FreeText field="findingTitle" text={finding.title} />
          </blockquote>
          <figcaption className="mt-1 text-caption text-ink-subtle">The {finding.seat} reviewer, round {finding.round}</figcaption>
        </figure>
        <Facts
          facts={[
            ["Severity", finding.severity === "blocker" ? <StateWord key="s" state="failed" label="Blocker" /> : "Note"],
            finding.rule ? ["Rule broken", <Mono key="r">{finding.rule}</Mono>] : null,
            finding.file ? ["File", <Mono key="f">{finding.file}</Mono>] : null,
            ["Recorded", at(finding.at)],
            finding.outvoted ? ["Outcome", "Outvoted: reported, not hidden"] : null,
            seat ? ["Seat's vote", seat.vote ? seat.vote.toLowerCase() : "not yet"] : null,
            // The round's gate and the seat's reviewer, each a link (the ticket is the header's link).
            round ? ["Review", <EntityLink key="g" to={ref.gate(`${ticketId}/review#${finding.round}`)}>Review consensus, round {finding.round}</EntityLink>] : null,
            round ? ["Round's outcome", round.outcome ? outcomeWordsOf(round.outcome).words : "in progress"] : null,
            seat?.agentId ? ["Reviewer", <EntityLink key="a" to={ref.agent(seat.agentId)}>Reviewer, {seat.seat} seat</EntityLink>] : null,
          ]}
        />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- dependency

export function DependencyAnatomy({ dependency }: { dependency: DependencyState }) {
  const from = useScene((s) => s.slices[dependency.from] ?? null);
  const to = useScene((s) => s.slices[dependency.to] ?? null);
  const satisfied = dependency.state === "satisfied";
  return (
    <>
      <Section title="What it holds">
        <div className={satisfied ? "rounded-sm border border-factory-pass bg-factory-pass-soft px-3 py-2" : "rounded-sm border border-dashed border-factory-wait bg-factory-wait-soft px-3 py-2"}>
          <p className="text-body-sm text-ink">
            {satisfied ? (
              <>
                <span className="font-mono text-[12px]">{dependency.to}</span> is integrated, so <span className="font-mono text-[12px]">{dependency.from}</span> is no longer held by it.
              </>
            ) : (
              <>
                <span className="font-mono text-[12px]">{dependency.from}</span> cannot be dispatched until <span className="font-mono text-[12px]">{dependency.to}</span> is integrated on main.
              </>
            )}
          </p>
        </div>
        <div className="mt-3">
          <Facts
            facts={[
              // Each slice is a link to it where it is named.
              ["Waits", from ? <IdLink key="f" to={ref.slice(from.id)} id={dependency.from} /> : <Mono key="f">{dependency.from}</Mono>],
              ["For", to ? <IdLink key="t" to={ref.slice(to.id)} id={dependency.to} /> : <Mono key="t">{dependency.to}</Mono>],
              ["State", <StateWord key="s" state={satisfied ? "succeeded" : "waiting"} label={satisfied ? "Satisfied" : "Blocking"} />],
              ["Cleared", dependency.satisfiedAt === null ? "not yet" : at(dependency.satisfiedAt)],
            ]}
          />
        </div>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- execution

/** Recorded spend per model, from the execution's own usage record (never per agent). */
/** Cost by model: the last usage record received so far. */
function useModelCosts(executionId: string): Array<[string, number | null]> {
  const { all, happened } = useEntityEvents(ref.execution(executionId));
  return useMemo(() => modelCostsOf(all.slice(0, happened)), [all, happened]);
}


const COST_REASON_WORDS: Readonly<Record<string, string>> = {
  "budget-stop": "a budget stop ended the run",
  "agents-killed-in-flight": "agents were stopped with work in flight",
};

/** A cost the record itself says may be low (execution.usage.cost_complete: false). Never guessed. */
export function mayBeUnderReported(x: ExecutionState): boolean {
  return costCompletenessOf(x).complete === false;
}

/** Why the record says the cost may be low, in words. */
export function underReportedWhy(x: ExecutionState): string {
  const reasons = costCompletenessOf(x).reasons.map((r) => COST_REASON_WORDS[r] ?? r);
  return reasons.length ? reasons.join("; ") : "the record does not say why";
}

/** The execution's recorded cost, or null when none is recorded (never 0 for "not recorded"). */
export function recordedCost(x: ExecutionState): number | null {
  if (x.usage && x.usage.costUsd !== null) return x.usage.costUsd;
  if (x.outcome && isKnown(x.meta, "costUsd")) return x.outcome.costUsd;
  return null;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

export function ExecutionAnatomy({ execution }: { execution: ExecutionState }) {
  const agents = useScene((s) => s.cells);
  const strays = useScene((s) => s.strayAgents);
  const count = useMemo(() => allAgentsOf(agents, execution.id) + Object.values(strays).filter((a) => a.executionId === execution.id).length, [agents, strays, execution.id]);
  const factory = useSceneStore((s) => s.factoryStatus);
  const historyEnd = useSceneStore(historyEndedAt);
  const agentsLine = useScene((s) => agentsOf(s, factory, execution.id, count));
  const runtimeLine = useScene((s) => (execution.meta.authority === "simulated" ? null : runtimeWords(streamObservationOf(s, execution.id, sourceRuntimeOf(factory?.sources, execution.id)))));
  const real = execution.meta.authority !== "simulated";
  const cost = recordedCost(execution);
  const models = useModelCosts(execution.id);
  const under = mayBeUnderReported(execution);
  const ticketCell = useScene((s) => Boolean(s.cells[execution.ticketId]));
  return (
    <>
      <Section title="Facts">
        <Facts
          facts={[
            // An execution's id does not name its ticket: the ticket is linked here.
            ["Ticket", ticketCell ? <IdLink key="t" to={ref.cell(execution.ticketId)} id={execution.ticketId} /> : <Mono key="t">{execution.ticketId}</Mono>],
            ["State", executionStatusOf(execution, historyEnd).word],
            ["Attempt", isKnown(execution.meta, "attempt") ? execution.attempt : <NotRecorded key="at" />],
            ["Asked to", isKnown(execution.meta, "next") ? execution.next : <NotRecorded key="n" />],
            execution.workflow ? ["Workflow", <Mono key="w">{execution.workflow}</Mono>] : null,
            execution.workflowStatus ? ["Workflow ended", execution.workflowStatus === "running" ? "Still running" : execution.workflowStatus] : null,
            execution.phase ? ["Belt phase", <FreeText key="ph" field="agentPhase" text={execution.phase} />] : null,
            execution.phases.length ? ["Declared phases", <DeclaredPhases key="dp" phases={execution.phases} />] : null,
            ["Claimed", isKnown(execution.meta, "claimedAt") ? at(execution.claimedAt) : <NotRecorded key="c" />],
            ["Started", at(execution.startedAt)],
            // The execution ended when its process ended (measured, from the process record); the
            // supervisor's record of its end, when later, is said on its own line (one rule everywhere).
            ["Ended", at(executionEndedAt(execution))],
            real && execution.processEndedAt !== null && execution.endedAt !== null && execution.endedAt !== execution.processEndedAt
              ? ["Recorded by the supervisor", at(execution.endedAt)]
              : null,
            real && execution.processStartedAt !== null
              ? ["Process", `${execution.processEndedAt !== null ? spanCode(execution.processStartedAt, execution.processEndedAt) : `${timecode(execution.processStartedAt)} to ${historyEnd !== null ? `no end recorded (the history ends ${timecodeInline(historyEnd, true)})` : "now"}`}${execution.ended ? `, ${execution.ended}` : ""}${execution.exitCode !== null ? `, exit ${execution.exitCode}` : ""}`]
              : null,
            execution.recovery ? ["Recovery", execution.recovery] : null,
            execution.outcome
              ? [
                  "Outcome",
                  <span key="o">
                    {execution.outcome.stage ?? "?"}, next {execution.outcome.next}
                    {execution.outcome.waitingFor ? (
                      <>
                        , waiting for <FreeText field="waitingFor" text={execution.outcome.waitingFor} />
                      </>
                    ) : null}
                  </span>,
                ]
              : null,
            [
              "Cost",
              cost === null ? (
                <NotRecorded key="cost" />
              ) : (
                <span key="cost">
                  {usd(cost)}
                  {real ? " (recorded)" : " (simulated)"}
                  {under ? <span className="block text-caption text-warning-ink">May be under-reported: {underReportedWhy(execution)}.</span> : null}
                </span>
              ),
            ],
            ["Agents", agentsLine],
            execution.claudeCodeVersion || runtimeLine
              ? [
                  "Claude Code",
                  <span key="v">
                    {execution.claudeCodeVersion ? <Mono>{execution.claudeCodeVersion}</Mono> : <NotRecorded />}
                    {runtimeLine ? <span className="block text-caption text-ink-subtle">{runtimeLine}</span> : null}
                  </span>,
                ]
              : null,
            execution.refused.length ? ["Refused tools", <RefusedTools key="rt" tools={execution.refused.map((r) => r.tool)} />] : null,
          ]}
        />
      </Section>
      {models.length ? (
        <Section title="Cost by model" aside={<span className="text-caption text-ink-subtle">recorded; never per agent</span>}>
          <Facts facts={models.map(([name, cost]): [string, ReactNode] => [name, cost === null ? <NotRecorded key={name} /> : usd(cost)])} />
          {under ? <p className="mt-2 text-caption text-warning-ink">These may be under-reported: {underReportedWhy(execution)}.</p> : null}
        </Section>
      ) : null}
    </>
  );
}

function allAgentsOf(cells: Readonly<Record<string, CellState>>, executionId: string): number {
  let n = 0;
  for (const cell of Object.values(cells)) for (const id of cell.agentOrder) if (cell.agents[id]?.executionId === executionId) n += 1;
  return n;
}

// ---------------------------------------------------------------- actor

/**
 * The supervisor and the tickets stopped for a person: it takes no step on them until a person decides,
 * and says who carries each on once decided (a Factory running here, or the next /mach pull).
 */
function SupervisorWaits() {
  const stopped = useScene((s) => Object.values(s.cells).filter((c) => c.stage === "blocked").map((c) => c.ticketId).sort().join(" "));
  const running = useSceneStore((s) => s.factoryStatus?.running?.running ?? null);
  const tickets = stopped ? stopped.split(" ") : [];
  return (
    <Section title="What it does now">
      <p className="text-body-sm text-ink" data-supervisor-running={running === null ? "unknown" : running ? "yes" : "no"}>
        {running === true ? "A Factory runs here, so the supervisor ticks once a minute." : running === false ? "No Factory runs here, so the supervisor is not running. /mach pull in Claude Code starts it." : "Whether a Factory runs here is not known on this page."}
      </p>
      {tickets.length ? (
        <ul className="mt-2 flex flex-col gap-1 text-body-sm" data-supervisor-waits={tickets.length}>
          {tickets.map((t) => (
            <li key={t}>
              <EntityLink to={ref.cell(t)}>{t}</EntityLink>
              <span className="text-ink">
                : stopped, it waits for a person, so the supervisor takes no step on it. A person carries it on with a fix (here or with /mach decide), or starts the Factory with /mach pull, which gives a ticket stopped for its rounds a fresh set of rounds. {running === true ? "The supervisor" : "The Factory"} then takes it up again at the build step.
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}

/** The line supervisor or the scheduler: who it is, the real code that acts, its acts so far, its last decision. */
export function ActorAnatomy({ actor }: { actor: ActorState }) {
  const entity = ref.actor(actor.id);
  const { all, happened } = useEntityEvents(entity);
  const past = useMemo(() => all.slice(0, happened), [all, happened]);
  const byKind = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of past) counts.set(e.event.type, (counts.get(e.event.type) ?? 0) + 1);
    return ACTOR_KINDS[actor.id].map((k) => [k, counts.get(k) ?? 0] as const);
  }, [past, actor.id]);
  const decisionKinds = actor.id === "supervisor" ? ["scheduling.decided"] : ["work.scheduled", "dependency.resolved", "dependency.blocked"];
  const decision = [...past].reverse().find((e) => decisionKinds.includes(e.event.type)) ?? null;
  const held = decision?.event.type === "scheduling.decided" ? ((decision.event as { data?: { held?: Array<{ slice_id?: string | null; ticket_id?: string | null; why: string }> } }).data?.held ?? []) : [];
  const words = ACTOR_WORDS[actor.id];
  return (
    <>
      <Section title="Who it is">
        <p className="mb-3 text-body-sm text-ink-muted">{words.does}</p>
        <Facts
          facts={[
            ["Code", <Mono key="c">{actor.code}</Mono>],
            ["Acts so far", actor.acts],
            ["Last acted", at(actor.lastActedAt)],
            actor.lastKind ? ["Last event", <Mono key="k">{actor.lastKind}</Mono>] : null,
          ]}
        />
        <p className="mt-3 text-caption text-ink-subtle">Not a Claude agent: part of MACH that runs inside the supervisor's tick and writes events of its own.</p>
      </Section>
      {actor.id === "supervisor" ? <SupervisorWaits /> : null}
      <Section title="Last decision">
        {decision ? (
          <div className="border-l-2 border-factory-select pl-3">
            <p className="font-mono text-[11px] text-ink-subtle tabular">
              {decision.event.type}, <When t={decision.t} precision="second" />
            </p>
            <p className="mt-0.5 text-body-sm text-ink">
              <EventWords entry={decision} labelled={held.length > 0} />
            </p>
            {held.length ? (
              <>
                <ul className="mt-1 list-disc pl-4 text-caption text-ink-muted">
                  {held.map((h) => (
                    <li key={`${h.slice_id ?? h.ticket_id}`}>
                      <span className="font-mono">{h.slice_id ?? h.ticket_id}</span>: <FreeText field="heldWhy" text={h.why} labelled />
                    </li>
                  ))}
                </ul>
                <FreeTextLabel what="Why each is held" />
              </>
            ) : null}
          </div>
        ) : (
          <Empty>No decision yet.</Empty>
        )}
      </Section>
      <Section title="What it writes">
        <ul className="flex flex-col gap-1">
          {byKind.map(([kind, n]) => (
            <li key={kind} className="flex items-center justify-between gap-3 text-body-sm">
              <span className="font-mono text-[12px] text-ink">{kind}</span>
              <span className="tabular text-ink-muted">{n}</span>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- the kinds real history adds (contract 5.2)

/** One station visit: when it began and ended, what the station said, and its round. */
export function VisitAnatomy({ visit }: { visit: VisitEntity }) {
  const kind = visit.station as StationKind;
  const status = visitStatusOf(visit);
  const cellOfVisit = useScene((s) => s.cells[visit.ticketId] ?? null);
  const recurs = (visit.station === "review" || visit.station === "verify") && status.state === "ended" && outcomeState(visit.outcome) === "failed" ? visit.station : null;
  return (
    <>
      <Section
        title="Facts"
        aside={
          <span className="flex flex-col items-end gap-1">
            <VisitHistoryLink visit={visit} />
            {recurs ? <RecurrenceLink kind={recurs} /> : null}
          </span>
        }
      >
        <Facts
          facts={[
            // The station is a link to every visit of this ticket to it (the ticket is the header's link).
            ["Station", <EntityLink key="st" to={ref.station(visit.station, visit.ticketId)} label={`Every visit to ${STATION_WORDS[kind] ?? visit.station} in ${visit.ticketId}`}>{STATION_WORDS[kind] ?? visit.station}</EntityLink>],
            ["Cell", <Mono key="c">{visit.ticketId}</Mono>],
            ["Round", roundAgainstLimit(cellOfVisit ?? { round: visit.round, stage: "building" }, visit.round)],
            ["Step", isKnown(visit.meta, "action") ? visit.action : <NotRecorded key="a" />],
            ["Entered", at(visit.enteredAt)],
            ["State", visitStateWords(visit)],
            ["Left", status.state === "ended" ? at(visit.leftAt) : visitLeftWords(visit, status, (t) => timecodeInline(t, true))],
            visit.interrupted ? ["Not continuous", interruptionWords(visit, (t) => timecodeInline(t, true))] : null,
            [
              "Duration",
              visit.durationMs !== null ? (
                // The recorded length, as it is: a length that is not measured says so (the branches below).
                durationOf(visit.durationMs)
              ) : visit.leftAt === null ? (
                <Elapsed key="e" startedAt={visit.enteredAt} finishedAt={null} mode={status.state === "waiting-person" ? "wait" : "work"} />
              ) : status.state === "ended-unrecorded" ? (
                <Elapsed key="e" startedAt={visit.enteredAt} finishedAt={visit.leftAt} mode="ended-unrecorded" />
              ) : visit.interrupted ? (
                <Elapsed key="e" startedAt={visit.enteredAt} finishedAt={visit.leftAt} mode="interrupted" />
              ) : (
                // Entered and left are both recorded: the length is theirs, in the words "In time" uses (one source of truth).
                <Elapsed key="e" startedAt={visit.enteredAt} finishedAt={visit.leftAt} mode="work" />
              ),
            ],
            ["The station said", visit.outcomeWord ? <Mono key="o">{visit.outcomeWord}</Mono> : visit.leftAt === null ? "not yet" : <NotRecorded key="o" />],
            status.detail ? ["Why", status.detail] : null,
          ]}
        />
      </Section>
    </>
  );
}

/** One review seat: it exists from its round's start, whether or not its reviewer is seen. */
/**
 * The reviewer as the record names it: its seat and model, the agent's id only as a quiet second line
 * (an opaque hex id is not a name).
 */
function ReviewerWords({ seat }: { seat: SeatEntity }) {
  return (
    <span className="flex min-w-0 flex-col">
      {/* A link to the reviewer agent (it is shown by its seat and model, never its id). */}
      <span>{seat.agentId ? <EntityLink to={ref.agent(seat.agentId)}>{reviewerWords(seat.seat, seatModelName(seat.model))}</EntityLink> : reviewerWords(seat.seat, seatModelName(seat.model))}</span>
      <span className="font-mono text-[11px] text-ink-subtle [overflow-wrap:anywhere]" title="The reviewer agent's id">
        <span className="sr-only">Agent id: </span>
        {seat.agentId}
      </span>
    </span>
  );
}

export function SeatAnatomy({ seat }: { seat: SeatEntity }) {
  const cellOfSeat = useScene((s) => s.cells[seat.ticketId] ?? null);
  return (
    <>
      <Section title="Facts">
        <Facts
          facts={[
            ["Seat", seat.seat],
            ["Cell", <Mono key="c">{seat.ticketId}</Mono>],
            ["Round", roundAgainstLimit(cellOfSeat ?? { round: seat.round, stage: "building" }, seat.round)],
            ["Review", <EntityLink key="g" to={ref.gate(`${seat.ticketId}/review#${seat.round}`)}>Review, round {seat.round}</EntityLink>],
            ["Model", seatModelName(seat.model) ?? <NotRecorded key="m" />],
            ["Vote", seat.vote ? outcomeStateWords(seat.vote) : "not yet"],
            seat.votedAt !== null ? ["Voted", at(seat.votedAt)] : null,
            seat.votedLate ? ["Arrived", "late: recorded after events that come after it"] : null,
            ["Findings", seat.findings],
            ["Reviewer", seat.agentId ? <ReviewerWords key="r" seat={seat} /> : "not seen"],
          ]}
        />
      </Section>
    </>
  );
}

/** A Dynamic Workflow: its recorded status, declared phases and agents. Its agents' tool calls are counts only. */
export function WorkflowAnatomy({ workflow }: { workflow: WorkflowEntity }) {
  return (
    <>
      <Section title="Facts">
        <Facts
          facts={[
            ["Workflow", workflow.name ? <Mono key="n">{workflow.name}</Mono> : <NotRecorded key="n" />],
            // A workflow's id does not name its ticket: the execution and the ticket are linked here.
            ["Execution", <IdLink key="x" to={ref.execution(workflow.executionId)} id={workflow.executionId} />],
            ["Ticket", workflow.ticketId ? <IdLink key="t" to={ref.cell(workflow.ticketId)} id={workflow.ticketId} /> : <NotRecorded key="t" />],
            ["Status", workflow.status === null ? <NotRecorded key="s" /> : workflow.status === "running" ? "Running" : workflow.status],
            workflow.stopReason ? ["Stopped by", workflow.stopReason] : null,
            ["Ended", workflow.finishedAt === null ? "not yet" : at(workflow.finishedAt)],
            ["Declared phases", workflow.phases.length ? <DeclaredPhases key="p" phases={workflow.phases} /> : <NotRecorded key="p" />],
            ["Agents started", workflow.agentIds.length],
            workflow.queued ? ["Queued, not started", workflow.queued] : null,
          ]}
        />
        <p className="mt-3 text-caption text-ink-subtle">A phase list is declared, not entered: when the belt is in a phase is not recorded.</p>
      </Section>
    </>
  );
}

/** The project: what the history holds about it. */
export function ProjectAnatomy({ project }: { project: ProjectEntity }) {
  const f = project.factory;
  return (
    <Section title="Facts">
      <Facts
        facts={[
          ["Project", <Mono key="p">{project.id}</Mono>],
          ["Name", project.name ?? <NotRecorded key="n" />],
          ["Integration branch", project.integrationBranch ? <Mono key="b">{project.integrationBranch}</Mono> : <NotRecorded key="b" />],
          ["Factory", f.enabled ? `${f.paused ? "Paused" : "Enabled"}${f.autonomy ? `, ${f.autonomy}` : ""}` : "Not enabled in the history received"],
          ["Slices", project.slices],
          ["Cells", project.cells],
          ["Executions", project.executions],
        ]}
      />
    </Section>
  );
}
