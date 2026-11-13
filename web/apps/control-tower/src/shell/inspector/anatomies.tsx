/**
 * One anatomy per entity type (spec f.9, item 3 and 5): the facts that matter for that kind of
 * thing at the playhead, and links to what it relates to. Each reads its entity's own object from
 * the scene, so it re-renders when that entity changes, not on every tick.
 */
import { useMemo, type ReactNode } from "react";
import { stations as stationLooks, type StationKind } from "@mach/ui";
import {
  ACTOR_KINDS,
  activityOf,
  artifactCountsOf,
  costCompletenessOf,
  describeEntry,
  cellGateList,
  executionStatusOf,
  isKnown,
  sourceRuntimeOf,
  streamObservationOf,
  visitStatusOf,
  type Scene,
  MAX_ROUNDS,
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
  type WaveState,
  type WorkflowEntity,
} from "../../sim";
import { useScene } from "../../scene";
import { AgentGlyph, ArtifactGlyph, CellGlyph, DependencyGlyph, ExecutionGlyph, GateGlyphSmall, SliceGlyph, StateGlyph, StateWord, StationGlyph, ToolGlyph } from "../glyphs";
import {
  ACTOR_WORDS,
  artifactOf,
  gateStateWords,
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
  timecode,
  toolFamily,
} from "../vocab";
import { Elapsed, Facts, JumpButton, Mono, NotRecorded, RefLink, RefList, Section, useEntityEvents } from "./parts";
import { parseStation } from "./entity";
import { reviewTally } from "./timing";
import { activityNote, agentsWords, interruptionWords, planWords, runtimeWords, visitLeftWords } from "./words";
import { useFreeTextLabel } from "./catalog";
import { useSceneStore } from "../../scene";
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

const at = (t: number | null | undefined) => (t === null || t === undefined ? "not yet" : <Mono>{timecode(t, false)}</Mono>);

function AgentLink({ agent }: { agent: AgentState }) {
  const word = agent.role === "reviewer" && agent.seat ? `Reviewer, ${agent.seat}` : ROLE_WORDS[agent.role];
  return (
    <RefLink to={ref.agent(agent.id)} glyph={<AgentGlyph tier={tierOf(agent.model)} agentRole={roleOf(agent.role)} size={20} state={runState(agent.status)} />} detail={agent.status === "running" ? "working" : timecode(agent.startedAt, false)}>
      {word} <span className="text-ink-subtle">{agent.label}</span>
    </RefLink>
  );
}

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
    <RefLink to={ref.artifact(artifact.id)} glyph={<ArtifactGlyph kind={artifactOf(artifact.kind)} size={18} failed={/findings/.test(artifact.kind)} />} detail={timecode(artifact.writtenAt, false)}>
      <span className="font-mono text-[12px]">{artifact.label}</span>
      {freeText ? <FreeTextNote label={freeText} /> : null}
    </RefLink>
  );
}

function GateLink({ gate, to }: { gate: GateState; to?: EntityRef }) {
  return (
    <RefLink to={to ?? ref.gate(gate.id)} glyph={<GateGlyphSmall kind={gateOf(gate.gate)} size={18} state={gateState(gate.state)} />} detail={gateStateWords(gate)}>
      {gateName(gate)}
      {gate.round ? `, round ${gate.round}` : ""}
      {gate.recorded && gate.recorded.evaluations.at(-1)?.subject ? <span className="text-ink-subtle">, {gate.recorded.evaluations.at(-1)?.subject}</span> : null}
    </RefLink>
  );
}

function CellLink({ cell }: { cell: CellState }) {
  const look = stageLook(cell.stage);
  return (
    <RefLink to={ref.cell(cell.ticketId)} glyph={<CellGlyph size={18} state={look.state} />} detail={look.label}>
      <span className="font-mono text-[12px]">{cell.ticketId}</span> {cell.title}
    </RefLink>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-body-sm text-ink-muted">{children}</p>;
}

// ---------------------------------------------------------------- wave

export function WaveAnatomy({ wave }: { wave: WaveState }) {
  const slices = useScene((s) => s.slices);
  return (
    <>
      <Section title="Facts">
        <Facts
          facts={[
            ["Epic", isKnown(wave.meta, "epicTitle") && wave.epicTitle ? wave.epicTitle : <NotRecorded key="e" />],
            ["Approved by", wave.approvedAt ? `${wave.approvedBy}, ${wave.approvedAt.slice(11, 16)} UTC` : <span key="a">{wave.approvedBy}, time <NotRecorded /></span>],
            ["Intake", wave.state === "validated" ? "Verified against its source commit" : "Seen, not yet verified"],
            ["Arrived", at(wave.discoveredAt)],
            ["Slices", wave.sliceIds.length],
          ]}
        />
      </Section>
      <Section title="Slices">
        <RefList>
          {wave.sliceIds.map((id) => {
            const slice = slices[id];
            if (!slice) return null;
            const look = schedulerLook(slice.scheduler);
            return (
              <RefLink key={id} to={ref.slice(id)} glyph={<SliceGlyph size={18} state={look.state} mark={look.mark} />} detail={look.label}>
                <span className="font-mono text-[12px]">{id}</span> {slice.title}
              </RefLink>
            );
          })}
        </RefList>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- slice

export function SliceAnatomy({ slice }: { slice: SliceState }) {
  const deps = useScene((s) => s.dependencies);
  const cell = useScene((s) => s.cells[slice.ticketId] ?? null);
  const waitsFor = Object.values(deps).filter((d) => d.from === slice.id);
  const blocks = Object.values(deps).filter((d) => d.to === slice.id);
  const look = schedulerLook(slice.scheduler);
  return (
    <>
      <Section title="Scheduler">
        <Facts
          facts={[
            ["State", <StateWord key="s" state={look.state} mark={look.mark} label={look.label} />],
            ["Since", at(slice.since)],
            ["Risk", isKnown(slice.meta, "risk") ? slice.risk : <NotRecorded key="r" />],
            ["Ticket", slice.ticketId ? <Mono key="t">{slice.ticketId}</Mono> : <NotRecorded key="t" />],
            slice.integratedCommit ? ["Integrated", <Mono key="c">{slice.integratedCommit.slice(0, 7)}</Mono>] : null,
          ]}
        />
        {slice.reasons.length ? (
          <div className="mt-3 rounded-sm border border-dashed border-factory-wait bg-factory-wait-soft px-3 py-2">
            <p className="text-caption font-semibold text-ink">Why it waits, in the scheduler's words</p>
            <ul className="mt-1 list-disc pl-4 text-body-sm text-ink-muted">
              {slice.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {slice.summary ? <p className="mt-3 text-body-sm text-ink-muted">{slice.summary}</p> : null}
      </Section>
      <Section title="Related">
        <RefList>
          {cell ? <CellLink cell={cell} /> : null}
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
          <RefLink to={ref.wave(slice.waveId)} detail="wave">
            <span className="font-mono text-[12px]">{slice.waveId}</span>
          </RefLink>
        </RefList>
      </Section>
      <Section title="History">
        <ol className="flex flex-col gap-1 text-body-sm">
          {slice.history.map((h) => {
            const l = schedulerLook(h.state);
            return (
              <li key={h.seq} className="flex items-center gap-2">
                <StateGlyph state={l.state} mark={l.mark} size={11} />
                <span className="flex-1 text-ink">{l.label}</span>
                <Mono muted>{timecode(h.at, false)}</Mono>
              </li>
            );
          })}
        </ol>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- cell

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
  // Live: what the cell is doing now, from what is recorded (the nine states; idle between two
  // executions is said as such, never "working"). A string, so the selector is stable.
  const live = cell.meta.authority !== "simulated";
  const stale = useSceneStore((s) => isStale(s.connection));
  const now = useScene((s) => (live ? activityOf(s, ref.cell(cell.ticketId), { stale }).reason : null));
  return (
    <>
      <Section title="Facts">
        <Facts
          facts={[
            ["Stage", <StateWord key="s" state={look.state} mark={look.mark} label={look.label} />],
            ["Round", `${cell.round} of ${MAX_ROUNDS}`],
            ["Slice", <Mono key="sl">{cell.sliceId}</Mono>],
            now ? ["Now", now] : null,
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
            cell.merged ? ["Merged", <Mono key="m">{`${cell.merged.commit.slice(0, 7)} at ${timecode(cell.merged.at, false)}`}</Mono>] : null,
          ]}
        />
      </Section>
      <Section title="Rounds">
        {cell.verifications.length === 0 && cell.reviews.length === 0 ? <Empty>No verification or review yet.</Empty> : null}
        <ol className="flex flex-col gap-3">
          {Array.from({ length: cell.round }, (_, i) => i + 1).map((n) => {
            const v = cell.verifications.find((x) => x.round === n);
            const r = cell.reviews.find((x) => x.round === n);
            if (!v && !r) return null;
            const passed = v ? v.checks.filter((c) => c.result === "pass").length : 0;
            return (
              <li key={n} className="rounded-sm border border-line px-3 py-2">
                <p className="mb-1 text-caption font-semibold text-ink">Round {n}</p>
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
                <Mono muted>{timecode(h.at, false)}</Mono>
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
        ) : (
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
      <Section title="Facts">
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
                      {status.state === "ended" ? `${v.outcomeWord ?? v.outcome ?? "ended"}, ` : status.state === "ended-unrecorded" ? "" : `${status.word.toLowerCase()}, `}<Elapsed startedAt={v.enteredAt} finishedAt={v.leftAt} mode={status.state === "waiting-person" ? "wait" : status.state === "ended-unrecorded" ? "ended-unrecorded" : v.interrupted ? "interrupted" : "work"} />
                    </span>
                  </p>
                  <p className="font-mono text-[11px] text-ink-subtle tabular">
                    {timecode(v.enteredAt, false)} to {v.leftAt === null ? "now" : `${status.state === "ended-unrecorded" ? "at most " : ""}${timecode(v.leftAt, false)}`}
                  </p>
                  {v.interrupted ? <p className="text-[11px] text-ink-subtle">Not continuous: {interruptionWords(v, (t) => timecode(t, false))}.</p> : null}
                </div>
                <JumpButton t={v.enteredAt} label="Go" />
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
            ["Label", agent.label || <NotRecorded key="l" />],
            ["Phase", known("phase") && agent.phase ? agent.phase : <NotRecorded key="p" />],
            ["Model", known("model") ? `${modelName(agent.model)}${agent.modelName && agent.modelName !== agent.model ? ` (${agent.modelName})` : ""}` : agent.modelName ? <Mono key="m">{agent.modelName}</Mono> : <NotRecorded key="m" />],
            agent.agentType ? ["Agent type", <Mono key="t">{agent.agentType}</Mono>] : null,
            ["State", agent.lifecycle === "queued" ? "Queued in its workflow" : agent.lifecycle === "unknown" ? "Ended; how is not recorded" : agent.lifecycle === "running" ? "Running" : agent.lifecycle === "error" ? "Ended in an error" : "Finished"],
            agent.lifecycle === "queued" ? null : ["Started", known("startedAt") ? at(agent.startedAt) : <NotRecorded key="s" />],
            agent.lifecycle === "queued" ? null : ["Elapsed", agent.durationMs !== null ? `took ${durationOf(agent.durationMs)} (measured)` : <Elapsed key="e" startedAt={agent.startedAt} finishedAt={agent.finishedAt} />],
            ["Tokens", agent.tokens !== null ? agent.tokens.toLocaleString("en-GB") : <NotRecorded key="k" />],
            ["Tool calls", agent.toolCallCount !== null ? agent.toolCallCount.toLocaleString("en-GB") : <NotRecorded key="c" />],
            ["Last tool", agent.lastTool ? <Mono key="lt">{agent.lastTool}</Mono> : <NotRecorded key="lt" />],
            agent.refused.length ? ["Refused tools", agent.refused.join(", ")] : null,
            note ? ["Read as", note] : null,
          ]}
        />
        <p className="mt-3 text-body-sm text-ink-muted">Individual tool calls are not observable for workflow agents. The count and the last tool's name come from the workflow's progress snapshots.</p>
      </Section>
      <Section title="Related">
        <RefList>
          {cell ? <CellLink cell={cell} /> : null}
          {agent.executionId ? (
            <RefLink to={ref.execution(agent.executionId)} glyph={<ExecutionGlyph size={18} />} detail="execution">
              <span className="font-mono text-[12px]">{agent.executionId}</span>
            </RefLink>
          ) : null}
        </RefList>
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
            ["Working on", agent.label],
            ["Belt phase", isKnown(agent.meta, "phase") ? agent.phase : <NotRecorded key="ph" />],
            agent.station ? ["Station", STATION_WORDS[agent.station as StationKind]] : null,
            ["Started", at(agent.startedAt)],
            ["Finished", agent.finishedAt === null ? "not yet" : at(agent.finishedAt)],
            ["Time at work", <Elapsed key="e" startedAt={agent.startedAt} finishedAt={agent.finishedAt} />],
            agent.summary ? ["Reported", agent.summary] : null,
            note ? ["Read as", note] : null,
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
                <RefLink key={c.id} to={ref.tool(c.id)} glyph={<ToolGlyph family={toolFamily(c.tool, c.target)} size={16} state={runState(c.status)} />} detail={c.status === "running" ? "running" : timecode(c.startedAt, false)}>
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
      <Section title="Related">
        <RefList>
          {cell ? <CellLink cell={cell} /> : null}
          {parent ? <AgentLink agent={parent} /> : null}
          {children.map((a) => (
            <AgentLink key={a.id} agent={a} />
          ))}
          {agent.executionId ? (
            <RefLink to={ref.execution(agent.executionId)} glyph={<ExecutionGlyph size={18} />} detail="execution">
              <span className="font-mono text-[12px]">{agent.executionId}</span>
            </RefLink>
          ) : null}
          {produced.slice(-5).map((a) => (
            <ArtifactLink key={a.id} artifact={a} />
          ))}
        </RefList>
      </Section>
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
          ]}
        />
      </Section>
      <Section title="Related">
        <RefList>
          {agent ? <AgentLink agent={agent} /> : null}
          {cell ? <CellLink cell={cell} /> : null}
          {artifacts.map((a) => (
            <ArtifactLink key={a.id} artifact={a} />
          ))}
        </RefList>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- artifact

export function ArtifactAnatomy({ artifact }: { artifact: ArtifactState }) {
  const cell = useScene((s) => s.cells[artifact.ticketId] ?? null);
  const freeText = useFreeTextLabel(artifact);
  const writer = artifact.writer.agentId && cell ? (cell.agents[artifact.writer.agentId] ?? null) : null;
  const base = artifact.path.split("/").pop() ?? artifact.path;
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
            ["Written by", writer ? `${ROLE_WORDS[writer.role]} (${writer.label})` : artifact.writer.script ? <Mono key="w">{artifact.writer.script}</Mono> : <NotRecorded key="w" />],
            artifact.record ? ["Integrity", `${artifact.record.integrity}, ${artifact.record.nature}${artifact.record.bytes !== null ? `, ${artifact.record.bytes.toLocaleString("en-GB")} bytes` : ""}`] : null,
            freeText ? ["Content", <FreeTextNote key="ft" label={freeText} block />] : null,
          ]}
        />
        {artifact.summary && isKnown(artifact.meta, "summary") ? <p className="mt-3 text-body-sm text-ink-muted">{artifact.summary}</p> : null}
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
            <RefLink key={call.id} to={ref.tool(call.id)} glyph={<ToolGlyph family={toolFamily(call.tool, call.target)} size={16} />} detail={timecode(call.startedAt, false)}>
              {ROLE_WORDS[agent.role]} <span className="font-mono text-[12px] text-ink-muted">{call.tool}</span>
            </RefLink>
          ))}
        </RefList>
        {readers.length === 0 ? <Empty>No later tool call names this file yet.</Empty> : <p className="mt-1 text-caption text-ink-subtle">Readers are tool calls whose target names the file: {readers.length} so far.</p>}
        {cell ? (
          <div className="mt-2">
            <RefList>
              <CellLink cell={cell} />
            </RefList>
          </div>
        ) : null}
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- gate

export function GateAnatomy({ gate }: { gate: GateState }) {
  const cell = useScene((s) => s.cells[gate.ticketId] ?? null);
  const attention = useScene((s) => s.supervisor.attention[gate.ticketId] ?? null);
  const state = gateState(gate.state);
  const verification = gate.gate === "verification" && cell ? cell.verifications.find((v) => v.round === gate.round) : undefined;
  const review = (gate.gate === "review" || gate.gate === "human-approval") && cell ? (gate.gate === "review" ? cell.reviews.find((r) => r.round === gate.round) : [...cell.reviews].reverse().find((r) => r.humanApprovalRequired)) : undefined;
  const waitingFor = gate.state === "waiting" ? Math.max(0, gate.openedAt) : null;
  return (
    <>
      <Section title="Decision">
        <Facts
          facts={[
            ["Gate", gateName(gate)],
            ["Position", <StateWord key="p" state={state} label={gateStateWords(gate)} />],
            gate.round ? ["Round", `${gate.round} of ${MAX_ROUNDS}`] : null,
            ["Reached", at(gate.openedAt)],
            ["Decided", gate.decidedAt === null ? "not yet" : at(gate.decidedAt)],
            waitingFor !== null ? ["Waiting", <Elapsed key="w" startedAt={waitingFor} finishedAt={null} mode="wait" />] : null,
          ]}
        />
        <p className="mt-3 text-body-sm text-ink-muted">{gate.detail}</p>
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
                  <span className="font-mono text-[12px] tabular">{timecode(review.humanApproval.at, false)}</span>
                  {review.humanApproval.note ? `, “${review.humanApproval.note}”` : ", no note"}
                </p>
              </div>
            </div>
          ) : (
            <Empty>{attention ? `Waiting for a person: ${attention.reason}.` : "Waiting for a person to approve this High-risk change."} Nothing moves until they do.</Empty>
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
      <Section title="Related">
        <RefList>
          {cell ? <CellLink cell={cell} /> : null}
          {cell?.merged && gate.gate === "merge-revalidation" ? (
            <RefLink to={ref.station("merge", gate.ticketId)} glyph={<StationGlyph kind="merge" size={18} state="succeeded" />} detail="merged">
              Merge of {gate.ticketId}
            </RefLink>
          ) : null}
        </RefList>
      </Section>
    </>
  );
}

function FindingLink({ finding }: { finding: FindingState }) {
  return (
    <RefLink to={ref.finding(finding.id)} glyph={<ArtifactGlyph kind="findings" size={16} failed={finding.severity === "blocker"} />} detail={finding.severity === "blocker" ? (finding.outvoted ? "blocker, outvoted" : "blocker") : "note"}>
      <span className="text-ink-muted">{finding.seat}:</span> {finding.title}
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
          <blockquote className="text-body text-ink">{finding.title}</blockquote>
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
          ]}
        />
      </Section>
      <Section title="Related">
        <RefList>
          {round ? (
            <RefLink to={ref.gate(`${ticketId}/review#${finding.round}`)} glyph={<GateGlyphSmall kind="consensus" size={18} state={round.outcome === null ? "active" : round.outcome === "APPROVED" ? "succeeded" : round.outcome === "AWAITING_HUMAN" ? "human" : "failed"} />} detail={round.outcome?.toLowerCase().replace("_", " ") ?? "in progress"}>
              Review consensus, round {finding.round}
            </RefLink>
          ) : null}
          {seat?.agentId ? (
            <RefLink to={ref.agent(seat.agentId)} glyph={<AgentGlyph tier={seat.model} agentRole="reviewer" size={20} />} detail={seat.seat}>
              Reviewer, {seat.seat} seat
            </RefLink>
          ) : null}
          <RefLink to={ref.cell(ticketId)} glyph={<CellGlyph size={18} />}>
            <span className="font-mono text-[12px]">{ticketId}</span>
          </RefLink>
        </RefList>
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
              ["Waits", <Mono key="f">{dependency.from}</Mono>],
              ["For", <Mono key="t">{dependency.to}</Mono>],
              ["State", <StateWord key="s" state={satisfied ? "succeeded" : "waiting"} label={satisfied ? "Satisfied" : "Blocking"} />],
              ["Cleared", dependency.satisfiedAt === null ? "not yet" : at(dependency.satisfiedAt)],
            ]}
          />
        </div>
        {dependency.satisfiedAt !== null ? (
          <div className="mt-2">
            <JumpButton t={dependency.satisfiedAt} label="Go to when it cleared" />
          </div>
        ) : null}
      </Section>
      <Section title="Related">
        <RefList>
          {[from, to].map((s) =>
            s ? (
              <RefLink key={s.id} to={ref.slice(s.id)} glyph={<SliceGlyph size={18} state={schedulerLook(s.scheduler).state} mark={schedulerLook(s.scheduler).mark} />} detail={schedulerLook(s.scheduler).label}>
                <span className="font-mono text-[12px]">{s.id}</span> {s.title}
              </RefLink>
            ) : null,
          )}
        </RefList>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- execution

/** Recorded spend per model, from the execution's own usage record (never per agent). */
function useModelCosts(executionId: string): Array<[string, number | null]> {
  const { all } = useEntityEvents(ref.execution(executionId));
  return useMemo(() => {
    const usage = [...all].reverse().find((e) => e.event.type === "execution.usage");
    if (!usage) return [];
    const models = ((usage.event as { data?: { models?: Record<string, { cost_usd?: number | null }> } }).data?.models ?? {}) as Record<string, { cost_usd?: number | null }>;
    return Object.entries(models).map(([name, m]): [string, number | null] => [name, typeof m.cost_usd === "number" ? m.cost_usd : null]);
  }, [all]);
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
  const agentsLine = useScene((s) => agentsOf(s, factory, execution.id, count));
  const runtimeLine = useScene((s) => (execution.meta.authority === "simulated" ? null : runtimeWords(streamObservationOf(s, execution.id, sourceRuntimeOf(factory?.sources, execution.id)))));
  const real = execution.meta.authority !== "simulated";
  const cost = recordedCost(execution);
  const models = useModelCosts(execution.id);
  const under = mayBeUnderReported(execution);
  return (
    <>
      <Section title="Facts">
        <Facts
          facts={[
            ["Ticket", <Mono key="t">{execution.ticketId}</Mono>],
            ["State", executionStatusOf(execution).word],
            ["Attempt", isKnown(execution.meta, "attempt") ? execution.attempt : <NotRecorded key="at" />],
            ["Asked to", isKnown(execution.meta, "next") ? execution.next : <NotRecorded key="n" />],
            execution.workflow ? ["Workflow", <Mono key="w">{execution.workflow}</Mono>] : null,
            execution.workflowStatus ? ["Workflow ended", execution.workflowStatus === "running" ? "Still running" : execution.workflowStatus] : null,
            execution.phase ? ["Belt phase", execution.phase] : null,
            execution.phases.length ? ["Declared phases", execution.phases.join(", ")] : null,
            ["Claimed", isKnown(execution.meta, "claimedAt") ? at(execution.claimedAt) : <NotRecorded key="c" />],
            ["Started", at(execution.startedAt)],
            ["Ended", at(execution.endedAt)],
            real && execution.processStartedAt !== null
              ? ["Process", `${timecode(execution.processStartedAt, false)} to ${execution.processEndedAt === null ? "now" : timecode(execution.processEndedAt, false)}${execution.ended ? `, ${execution.ended}` : ""}${execution.exitCode !== null ? `, exit ${execution.exitCode}` : ""}`]
              : null,
            execution.recovery ? ["Recovery", execution.recovery] : null,
            execution.outcome ? ["Outcome", `${execution.outcome.stage ?? "?"}, next ${execution.outcome.next}${execution.outcome.waitingFor ? `, waiting for ${execution.outcome.waitingFor}` : ""}`] : null,
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
            execution.refused.length ? ["Refused tools", execution.refused.map((r) => r.tool).join(", ")] : null,
          ]}
        />
      </Section>
      {models.length ? (
        <Section title="Cost by model" aside={<span className="text-caption text-ink-subtle">recorded; never per agent</span>}>
          <Facts facts={models.map(([name, cost]): [string, ReactNode] => [name, cost === null ? <NotRecorded key={name} /> : usd(cost)])} />
          {under ? <p className="mt-2 text-caption text-warning-ink">These may be under-reported: {underReportedWhy(execution)}.</p> : null}
        </Section>
      ) : null}
      <Section title="Related">
        <RefList>
          <RefLink to={ref.cell(execution.ticketId)} glyph={<CellGlyph size={18} />}>
            <span className="font-mono text-[12px]">{execution.ticketId}</span>
          </RefLink>
        </RefList>
      </Section>
    </>
  );
}

function allAgentsOf(cells: Readonly<Record<string, CellState>>, executionId: string): number {
  let n = 0;
  for (const cell of Object.values(cells)) for (const id of cell.agentOrder) if (cell.agents[id]?.executionId === executionId) n += 1;
  return n;
}

// ---------------------------------------------------------------- actor

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
        <p className="mt-3 text-caption text-ink-subtle">Not a Claude agent: a script that runs inside the supervisor's tick and writes events of its own.</p>
      </Section>
      <Section title="Last decision">
        {decision ? (
          <div className="border-l-2 border-factory-select pl-3">
            <p className="font-mono text-[11px] text-ink-subtle tabular">
              {decision.event.type}, {timecode(decision.t)}
            </p>
            <p className="mt-0.5 text-body-sm text-ink">{describeEntry(decision)}</p>
            {held.length ? (
              <ul className="mt-1 list-disc pl-4 text-caption text-ink-muted">
                {held.map((h) => (
                  <li key={`${h.slice_id ?? h.ticket_id}`}>
                    <span className="font-mono">{h.slice_id ?? h.ticket_id}</span>: {h.why}
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="mt-1">
              <JumpButton eventId={decision.id} />
            </div>
          </div>
        ) : (
          <Empty>No decision yet at the playhead.</Empty>
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
  return (
    <>
      <Section title="Facts">
        <Facts
          facts={[
            ["Station", STATION_WORDS[kind] ?? visit.station],
            ["Cell", <Mono key="c">{visit.ticketId}</Mono>],
            ["Round", `${visit.round} of ${MAX_ROUNDS}`],
            ["Step", isKnown(visit.meta, "action") ? visit.action : <NotRecorded key="a" />],
            ["Entered", at(visit.enteredAt)],
            ["State", status.word],
            ["Left", status.state === "ended" ? at(visit.leftAt) : visitLeftWords(visit, status, (t) => timecode(t, false))],
            visit.interrupted ? ["Not continuous", interruptionWords(visit, (t) => timecode(t, false))] : null,
            [
              "Duration",
              visit.durationMs !== null ? (
                `${Math.round(visit.durationMs / 1000)} s, measured`
              ) : visit.leftAt === null ? (
                <Elapsed key="e" startedAt={visit.enteredAt} finishedAt={null} mode={status.state === "waiting-person" ? "wait" : "work"} />
              ) : status.state === "ended-unrecorded" ? (
                <Elapsed key="e" startedAt={visit.enteredAt} finishedAt={visit.leftAt} mode="ended-unrecorded" />
              ) : visit.interrupted ? (
                <Elapsed key="e" startedAt={visit.enteredAt} finishedAt={visit.leftAt} mode="interrupted" />
              ) : (
                <NotRecorded key="d" />
              ),
            ],
            ["The station said", visit.outcomeWord ? <Mono key="o">{visit.outcomeWord}</Mono> : visit.leftAt === null ? "not yet" : <NotRecorded key="o" />],
            status.detail ? ["Why", status.detail] : null,
          ]}
        />
      </Section>
      <Section title="Related">
        <RefList>
          <RefLink to={ref.station(visit.station, visit.ticketId)} glyph={<StationGlyph kind={kind} size={18} />}>
            Every visit to this station
          </RefLink>
          <RefLink to={ref.cell(visit.ticketId)} glyph={<CellGlyph size={18} />}>
            <span className="font-mono text-[12px]">{visit.ticketId}</span>
          </RefLink>
        </RefList>
      </Section>
    </>
  );
}

/** One review seat: it exists from its round's start, whether or not its reviewer is seen. */
export function SeatAnatomy({ seat }: { seat: SeatEntity }) {
  return (
    <>
      <Section title="Facts">
        <Facts
          facts={[
            ["Seat", seat.seat],
            ["Cell", <Mono key="c">{seat.ticketId}</Mono>],
            ["Round", `${seat.round} of ${MAX_ROUNDS}`],
            ["Model", seat.model],
            ["Vote", seat.vote ?? "not yet"],
            seat.votedAt !== null ? ["Voted", at(seat.votedAt)] : null,
            seat.votedLate ? ["Arrived", "late: recorded after events that come after it"] : null,
            ["Findings", seat.findings],
            ["Reviewer", seat.agentId ? <Mono key="r">{seat.agentId}</Mono> : "not seen"],
          ]}
        />
        {seat.votedEventId ? <JumpButton eventId={seat.votedEventId} label="Go to the vote" /> : null}
      </Section>
      <Section title="Related">
        <RefList>
          <RefLink to={ref.gate(`${seat.ticketId}/review#${seat.round}`)} glyph={<GateGlyphSmall kind={gateOf("review")} size={18} />}>
            Review, round {seat.round}
          </RefLink>
          {seat.agentId ? (
            <RefLink to={ref.agent(seat.agentId)} glyph={<AgentGlyph tier={tierOf(seat.model)} agentRole={roleOf("reviewer")} size={18} />}>
              The reviewer
            </RefLink>
          ) : null}
        </RefList>
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
            ["Execution", <Mono key="x">{workflow.executionId}</Mono>],
            ["Ticket", workflow.ticketId ? <Mono key="t">{workflow.ticketId}</Mono> : <NotRecorded key="t" />],
            ["Status", workflow.status === null ? <NotRecorded key="s" /> : workflow.status === "running" ? "Running" : workflow.status],
            workflow.stopReason ? ["Stopped by", workflow.stopReason] : null,
            ["Ended", workflow.finishedAt === null ? "not yet" : at(workflow.finishedAt)],
            ["Declared phases", workflow.phases.length ? workflow.phases.join(", ") : <NotRecorded key="p" />],
            ["Agents started", workflow.agentIds.length],
            workflow.queued ? ["Queued, not started", workflow.queued] : null,
          ]}
        />
        <p className="mt-3 text-caption text-ink-subtle">A phase list is declared, not entered: when the belt is in a phase is not recorded.</p>
      </Section>
      <Section title="Related">
        <RefList>
          <RefLink to={ref.execution(workflow.executionId)} glyph={<ExecutionGlyph size={18} />}>
            <span className="font-mono text-[12px]">{workflow.executionId}</span>
          </RefLink>
        </RefList>
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
          ["Waves", project.waves],
          ["Slices", project.slices],
          ["Cells", project.cells],
          ["Executions", project.executions],
        ]}
      />
    </Section>
  );
}
