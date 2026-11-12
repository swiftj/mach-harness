/**
 * One anatomy per entity type (spec f.9, item 3 and 5): the facts that matter for that kind of
 * thing at the playhead, and links to what it relates to. Each reads its entity's own object from
 * the scene, so it re-renders when that entity changes, not on every tick.
 */
import { useMemo, type ReactNode } from "react";
import { stations as stationLooks, type StationKind } from "@mach/ui";
import {
  ACTOR_KINDS,
  describe,
  MAX_ROUNDS,
  ref,
  type ActorState,
  type AgentState,
  type ArtifactState,
  type CellState,
  type DependencyState,
  type ExecutionState,
  type FindingState,
  type GateState,
  type SliceState,
  type ToolCallState,
  type WaveState,
} from "../../sim";
import { useScene } from "../../scene";
import { AgentGlyph, ArtifactGlyph, CellGlyph, DependencyGlyph, ExecutionGlyph, GateGlyphSmall, SliceGlyph, StateGlyph, StateWord, StationGlyph, ToolGlyph } from "../glyphs";
import {
  ACTOR_WORDS,
  artifactOf,
  GATE_STATE_WORDS,
  GATE_WORDS,
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
import { Elapsed, Facts, JumpButton, Mono, RefLink, RefList, Section, useEntityEvents } from "./parts";
import { parseStation } from "./entity";
import { reviewTally } from "./timing";

const at = (t: number | null | undefined) => (t === null || t === undefined ? "not yet" : <Mono>{timecode(t, false)}</Mono>);

function AgentLink({ agent }: { agent: AgentState }) {
  const word = agent.role === "reviewer" && agent.seat ? `Reviewer, ${agent.seat}` : ROLE_WORDS[agent.role];
  return (
    <RefLink to={ref.agent(agent.id)} glyph={<AgentGlyph tier={tierOf(agent.model)} agentRole={roleOf(agent.role)} size={20} state={runState(agent.status)} />} detail={agent.status === "running" ? "working" : timecode(agent.startedAt, false)}>
      {word} <span className="text-ink-subtle">{agent.label}</span>
    </RefLink>
  );
}

function ArtifactLink({ artifact }: { artifact: ArtifactState }) {
  return (
    <RefLink to={ref.artifact(artifact.id)} glyph={<ArtifactGlyph kind={artifactOf(artifact.kind)} size={18} failed={/findings/.test(artifact.kind)} />} detail={timecode(artifact.writtenAt, false)}>
      <span className="font-mono text-[12px]">{artifact.label}</span>
    </RefLink>
  );
}

function GateLink({ gate }: { gate: GateState }) {
  return (
    <RefLink to={ref.gate(gate.id)} glyph={<GateGlyphSmall kind={gateOf(gate.gate)} size={18} state={gateState(gate.state)} />} detail={GATE_STATE_WORDS[gate.state]}>
      {GATE_WORDS[gate.gate]}
      {gate.round ? `, round ${gate.round}` : ""}
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
            ["Epic", wave.epicTitle],
            ["Approved by", `${wave.approvedBy}, ${wave.approvedAt.slice(11, 16)} UTC`],
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
            ["Risk", slice.risk],
            ["Ticket", <Mono key="t">{slice.ticketId}</Mono>],
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
        <p className="mt-3 text-body-sm text-ink-muted">{slice.summary}</p>
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
  const cellGates = Object.values(gates).filter((g) => g.ticketId === cell.ticketId);
  return (
    <>
      <Section title="Facts">
        <Facts
          facts={[
            ["Stage", <StateWord key="s" state={look.state} mark={look.mark} label={look.label} />],
            ["Round", `${cell.round} of ${MAX_ROUNDS}`],
            ["Slice", <Mono key="sl">{cell.sliceId}</Mono>],
            ["Risk", cell.risk],
            ["App type", cell.appType],
            ["Worktree", <Mono key="w" muted>{`.factory/worktrees/${cell.ticketId}/repo`}</Mono>],
            ["Branch", <Mono key="b" muted>{cell.branch}</Mono>],
            ["At station", cell.station ? <span key="st">{STATION_WORDS[cell.station as StationKind]}, <Elapsed startedAt={cell.stationSince ?? 0} finishedAt={null} /></span> : "Between stations"],
            ["Suite", cell.lastTest ? `${cell.suite}, ${cell.lastTest.passed} passed, ${cell.lastTest.failed} failed` : cell.suite],
            ["Agents", `${active.length} working, ${cell.agentOrder.length} so far`],
            ["Artifacts", cell.artifacts.length],
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
        {cellGates.length ? (
          <RefList>
            {cellGates.map((g) => (
              <GateLink key={g.id} gate={g} />
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
            const state = v.leftAt === null ? "active" : outcomeState(v.outcome);
            return (
              <li key={v.enteredSeq} className="flex items-start gap-2.5 rounded-sm border border-line px-3 py-2">
                <StationGlyph kind={kind} size={22} state={state} />
                <div className="min-w-0 flex-1">
                  <p className="text-body-sm text-ink">
                    Round {v.round}, {v.action}
                    <span className="text-ink-muted">
                      {" "}
                      {v.leftAt === null ? "at work" : v.outcome ?? "ended"}, <Elapsed startedAt={v.enteredAt} finishedAt={v.leftAt} />
                    </span>
                  </p>
                  <p className="font-mono text-[11px] text-ink-subtle tabular">
                    {timecode(v.enteredAt, false)} to {v.leftAt === null ? "now" : timecode(v.leftAt, false)}
                  </p>
                </div>
                <JumpButton seq={v.enteredSeq} label="Go" />
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

export function AgentAnatomy({ agent }: { agent: AgentState }) {
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
  return (
    <>
      <Section title="Facts">
        <Facts
          facts={[
            ["Role", ROLE_WORDS[agent.role]],
            agent.seat ? ["Seat", agent.seat] : null,
            ["Model", `${modelName(agent.model)} (${agent.tier} tier)`],
            ["Effort", agent.effort],
            agent.agentType ? ["Agent type", <Mono key="t">{agent.agentType}</Mono>] : null,
            ["Working on", agent.label],
            ["Belt phase", agent.phase],
            agent.station ? ["Station", STATION_WORDS[agent.station as StationKind]] : null,
            ["Started", at(agent.startedAt)],
            ["Finished", agent.finishedAt === null ? "not yet" : at(agent.finishedAt)],
            ["Time at work", <Elapsed key="e" startedAt={agent.startedAt} finishedAt={agent.finishedAt} />],
            agent.summary ? ["Reported", agent.summary] : null,
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
            ["Tool", call.tool],
            ["Family", toolFamily(call.tool, call.target)],
            ["Started", at(call.startedAt)],
            ["Time", <Elapsed key="e" startedAt={call.startedAt} finishedAt={call.finishedAt} />],
            ["Outcome", call.status === "running" ? "Running" : call.status === "ok" ? "Returned" : "Returned an error"],
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
            ["Written by", writer ? `${ROLE_WORDS[writer.role]} (${writer.label})` : artifact.writer.script ? <Mono key="w">{artifact.writer.script}</Mono> : "unknown"],
          ]}
        />
        <p className="mt-3 text-body-sm text-ink-muted">{artifact.summary}</p>
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
            ["Gate", GATE_WORDS[gate.gate]],
            ["Position", <StateWord key="p" state={state} label={GATE_STATE_WORDS[gate.state]} />],
            gate.round ? ["Round", `${gate.round} of ${MAX_ROUNDS}`] : null,
            ["Reached", at(gate.openedAt)],
            ["Decided", gate.decidedAt === null ? "not yet" : at(gate.decidedAt)],
            waitingFor !== null ? ["Waiting", <Elapsed key="w" startedAt={waitingFor} finishedAt={null} />] : null,
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
        {dependency.satisfiedSeq !== null ? (
          <div className="mt-2">
            <JumpButton seq={dependency.satisfiedSeq} label="Go to when it cleared" />
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

export function ExecutionAnatomy({ execution }: { execution: ExecutionState }) {
  const agents = useScene((s) => s.cells);
  const count = useMemo(() => allAgentsOf(agents, execution.id), [agents, execution.id]);
  return (
    <>
      <Section title="Facts">
        <Facts
          facts={[
            ["Ticket", <Mono key="t">{execution.ticketId}</Mono>],
            ["State", execution.state],
            ["Attempt", execution.attempt],
            ["Asked to", execution.next],
            execution.workflow ? ["Workflow", <Mono key="w">{execution.workflow}</Mono>] : null,
            execution.phase ? ["Belt phase", execution.phase] : null,
            ["Claimed", at(execution.claimedAt)],
            ["Started", at(execution.startedAt)],
            ["Ended", at(execution.endedAt)],
            execution.outcome ? ["Outcome", `${execution.outcome.stage ?? "?"}, next ${execution.outcome.next}${execution.outcome.waitingFor ? `, waiting for ${execution.outcome.waitingFor}` : ""}`] : null,
            execution.outcome ? ["Cost", `$${execution.outcome.costUsd.toFixed(2)}`] : null,
            ["Agents", count],
          ]}
        />
      </Section>
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
    for (const e of past) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    return ACTOR_KINDS[actor.id].map((k) => [k, counts.get(k) ?? 0] as const);
  }, [past, actor.id]);
  const decisionKinds = actor.id === "supervisor" ? ["scheduling.decided"] : ["work.scheduled", "dependency.resolved", "dependency.blocked"];
  const decision = [...past].reverse().find((e) => decisionKinds.includes(e.type)) ?? null;
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
              {decision.type}, {timecode(decision.t)}
            </p>
            <p className="mt-0.5 text-body-sm text-ink">{describe(decision)}</p>
            {decision.type === "scheduling.decided" && decision.data.held.length ? (
              <ul className="mt-1 list-disc pl-4 text-caption text-ink-muted">
                {decision.data.held.map((h) => (
                  <li key={`${h.slice_id ?? h.ticket_id}`}>
                    <span className="font-mono">{h.slice_id ?? h.ticket_id}</span>: {h.why}
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="mt-1">
              <JumpButton seq={decision.seq} />
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
