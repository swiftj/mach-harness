/**
 * The contextual inspector (spec f.9): follows the store's selection. A header (glyph, name, ID with
 * a link back to the ticket that owns it, state now), why it looks like this, one anatomy per entity
 * type (each linking what it relates to where that reads naturally), the record behind it and its
 * evidence. With nothing selected: the run now.
 */
import { Crosshair, X } from "lucide-react";
import { type ReactNode } from "react";
import { stations as stationLooks, type FactoryMarkShape, type FactoryState, type StationKind } from "@mach/ui";
import {
  executionStatusOf,
  finalScene,
  visitStatusOf,
  whyOf,
  refId,
  SCENARIO,
  type ActorState,
  type AgentState,
  type AnyRef,
  type ArtifactState,
  type CellState,
  type DependencyState,
  type ExecutionState,
  type FindingState,
  type GateState,
  type ProjectEntity,
  type Scene,
  type SeatEntity,
  type SliceState,
  type ToolCallState,
  type VisitEntity,
  type WorkflowEntity,
  executionEndedAt,
  holdOf,
  type SupervisorState,
} from "../../sim";
import { historyEndedAt, useScene, useSceneStore, useStore } from "../../scene";
import { ActorGlyph, AgentGlyph, ArtifactGlyph, CellGlyph, DependencyGlyph, ExecutionGlyph, GateGlyphSmall, SliceGlyph, StateWord, StationGlyph, ToolGlyph, ProjectGlyph } from "../glyphs";
import { IconButton } from "../IconButton";
import { artifactOf, selectable, gateOf, kindOf, gateState, outcomeState, roleOf, runState, schedulerLook, stageLook, tierOf, toolFamily, getTimeBase } from "../vocab";
import {
  ActorAnatomy,
  AgentAnatomy,
  ArtifactAnatomy,
  CellAnatomy,
  DependencyAnatomy,
  ExecutionAnatomy,
  FindingAnatomy,
  GateAnatomy,
  ProjectAnatomy,
  SeatAnatomy,
  SliceAnatomy,
  StationAnatomy,
  ToolAnatomy,
  VisitAnatomy,
  WorkflowAnatomy,
} from "./anatomies";
import { identityOf, parseStation, pickedVisitOf, selectEntity } from "./entity";
import { ownerOfId, ownerRefOf } from "./owner";
import { When } from "../When";
import { AuthorityBadge, EntityLink, Evidence, StationHistoryLink, timeCaveatWords, useEntityEvents } from "./parts";
import { analyticsStationOf } from "../../scene/analytics";
import { Provenance } from "./Provenance";
import { stationAcrossWords } from "./words";
import { RunNow } from "./RunNow";
import { EventWords, FreeText, FreeTextLabel } from "./FreeText";
import { gatePositionWords, visitStateWords } from "./outcomes";
import { cellTiming, stationAcrossTiming, stationTiming, timingWords, type Timing } from "./timing";

interface Look extends Timing {
  glyph: ReactNode;
  state: FactoryState;
  mark?: FactoryMarkShape;
  word: string;
}

/** The kinds named by free text (I-05): an agent by its label, a slice or cell by its title. */
function proseName(kind: string): "agentLabel" | "sliceTitle" | null {
  return kind === "agent" ? "agentLabel" : kind === "slice" || kind === "cell" ? "sliceTitle" : null;
}

/** Glyph, state and phase of an entity that exists now. */
function lookOf(entity: AnyRef, value: unknown, historyEnd: number | null = null, holds: SupervisorState["holds"] = undefined): Look {
  const id = refId(entity);
  switch (kindOf(entity)) {
    case "actor": {
      const a = value as ActorState;
      return { glyph: <ActorGlyph actor={a.id} size={28} />, state: "idle", word: a.acts ? `${a.acts} acts so far` : "Not acted yet", phase: "running", since: a.lastActedAt };
    }
    case "slice": {
      const s = value as SliceState;
      // M6.6 D2: held by the line supervisor (its words are in the Scheduler section), since that decision.
      const hold = holdOf(holds, s);
      const l = hold ? { label: "Eligible, held by the supervisor", state: "waiting" as const, mark: undefined } : schedulerLook(s.scheduler);
      return { glyph: <SliceGlyph size={28} state={l.state} mark={l.mark} />, state: l.state, mark: l.mark, word: l.label, phase: s.scheduler === "integrated" ? "finished" : "running", since: hold ? hold.since : s.since };
    }
    case "cell": {
      const c = value as CellState;
      const l = stageLook(c.stage);
      return { glyph: <CellGlyph size={28} state={l.state} />, state: l.state, mark: l.mark, word: l.label, ...cellTiming(c) };
    }
    case "station": {
      const { station, ticketId } = parseStation(id);
      if (!ticketId) {
        // The station on its own: its visits across every cell (I-22), never "Not visited" when a cell has been there.
        const across = stationAcrossWords(value as Readonly<Record<string, CellState>>, station);
        return { glyph: <StationGlyph kind={station as StationKind} size={28} state={across.working ? "active" : "idle"} />, state: across.working ? "active" : "idle", word: across.word, ...stationAcrossTiming(across.working, across.last) };
      }
      const cell = (value as CellState).visits ? (value as CellState) : null;
      const visits = cell ? cell.visits.filter((v) => v.station === station) : [];
      const last = visits[visits.length - 1];
      const status = last ? visitStatusOf(last) : null;
      const state: FactoryState = !last || !status ? "idle" : status.state === "working" ? "active" : status.state === "waiting-person" ? "human" : status.state === "ended-unrecorded" ? "idle" : outcomeState(last.outcome);
      return { glyph: <StationGlyph kind={station as StationKind} size={28} state={state} />, state, word: last ? visitStateWords(last) : "Not visited", ...stationTiming(last) };
    }
    case "agent": {
      const a = value as AgentState;
      // The honest lifecycle: queued, running, done, error, or ended with no record of how.
      const state: FactoryState = a.lifecycle === "queued" ? "waiting" : a.lifecycle === "unknown" ? "idle" : runState(a.status);
      const word = a.lifecycle === "queued" ? "Queued in its workflow" : a.lifecycle === "unknown" ? "Ended; how is not recorded" : a.status === "running" ? "Working" : a.status === "error" ? "Failed" : "Finished";
      return { glyph: <AgentGlyph tier={tierOf(a.model)} agentRole={roleOf(a.role)} size={28} state={state} />, state, word, phase: a.status === "running" || a.lifecycle === "queued" ? "running" : "finished", since: a.status === "running" ? a.startedAt : a.finishedAt };
    }
    case "tool": {
      const c = value as ToolCallState;
      const state = runState(c.status);
      return { glyph: <ToolGlyph family={toolFamily(c.tool, c.target)} size={28} state={state} />, state, word: c.status === "running" ? "Running" : c.status === "ok" ? "Returned" : "Error", phase: c.status === "running" ? "running" : "finished", since: c.status === "running" ? c.startedAt : c.finishedAt };
    }
    case "artifact": {
      const a = value as ArtifactState;
      return { glyph: <ArtifactGlyph kind={artifactOf(a.kind)} size={28} failed={/findings/.test(a.kind)} />, state: "succeeded", word: `Written, version ${a.version}`, phase: "finished", since: a.writtenAt };
    }
    case "gate": {
      const g = value as GateState;
      const state = gateState(g.state);
      // The verdict alone: the Decision section below says the reason, once.
      return { glyph: <GateGlyphSmall kind={gateOf(g.gate)} size={28} state={state} />, state, word: gatePositionWords({ ...g, reasonCode: null }), phase: g.decidedAt === null ? "running" : "finished", since: g.decidedAt ?? g.openedAt };
    }
    case "dependency": {
      const d = value as DependencyState;
      return { glyph: <DependencyGlyph size={28} satisfied={d.state === "satisfied"} />, state: d.state === "satisfied" ? "succeeded" : "waiting", word: d.state === "satisfied" ? "Satisfied" : "Blocking", phase: d.state === "satisfied" ? "finished" : "running", since: d.satisfiedAt };
    }
    case "finding": {
      const f = value as FindingState;
      return { glyph: <ArtifactGlyph kind="findings" size={28} failed={f.severity === "blocker"} />, state: f.severity === "blocker" ? "failed" : "idle", word: f.severity === "blocker" ? (f.outvoted ? "Blocker, outvoted" : "Blocker") : "Note", phase: "finished", since: f.at };
    }
    case "execution": {
      const x = value as ExecutionState;
      // Its process may have ended before the supervisor recorded it (R6): ended, outcome not recorded yet.
      const status = executionStatusOf(x, historyEnd);
      const state: FactoryState = status.running ? "active" : x.state === "failed" ? "failed" : x.state === "completed" ? "succeeded" : "idle";
      // No end recorded on a history that is no longer live: started then, nothing says it finished.
      if (historyEnd !== null && status.word === "No end recorded") return { glyph: <ExecutionGlyph size={28} state={state} />, state, mark: "ring-query", word: status.word, phase: "finished", since: x.startedAt ?? x.claimedAt, sinceWord: "Started at" };
      return { glyph: <ExecutionGlyph size={28} state={state} />, state, word: status.word, phase: status.running ? "running" : "finished", since: executionEndedAt(x) ?? x.startedAt };
    }
    case "visit": {
      const v = value as VisitEntity;
      const status = visitStatusOf(v);
      const state: FactoryState = status.state === "working" ? "active" : status.state === "waiting-person" ? "human" : status.state === "ended-unrecorded" ? "idle" : outcomeState(v.outcome);
      return { glyph: <StationGlyph kind={v.station as StationKind} size={28} state={state} />, state, word: visitStateWords(v), phase: v.leftAt === null ? "running" : "finished", since: v.leftAt ?? v.enteredAt };
    }
    case "seat": {
      const v = value as SeatEntity;
      const state: FactoryState = v.vote === "APPROVE" ? "succeeded" : v.vote === "REJECT" ? "failed" : "waiting";
      return { glyph: <GateGlyphSmall kind={gateOf("review")} size={28} state={state} />, state, word: v.vote === "APPROVE" ? "Approved" : v.vote === "REJECT" ? "Rejected" : "No vote yet", phase: v.vote ? "finished" : "running", since: v.votedAt };
    }
    case "workflow": {
      const v = value as WorkflowEntity;
      const state: FactoryState = v.status === "running" ? "active" : v.status === "completed" ? "succeeded" : v.status === "killed" ? "failed" : "idle";
      return { glyph: <ExecutionGlyph size={28} state={state} />, state, word: v.status === "running" ? "Running" : v.status === "completed" ? "Completed" : v.status === "killed" ? "Killed" : "Not recorded", phase: v.status === "running" ? "running" : "finished", since: v.finishedAt };
    }
    case "project":
      return { glyph: <ProjectGlyph size={28} />, state: "idle", word: "Project", phase: "running", since: null };
  }
}

function Anatomy({ entity, value }: { entity: AnyRef; value: unknown }) {
  switch (kindOf(entity)) {
    case "actor":
      return <ActorAnatomy actor={value as ActorState} />;
    case "slice":
      return <SliceAnatomy slice={value as SliceState} />;
    case "cell":
      return <CellAnatomy cell={value as CellState} />;
    case "station":
      return parseStation(refId(entity)).ticketId ? <StationAnatomy id={refId(entity)} cell={value as CellState} /> : <GlobalStation id={refId(entity)} />;
    case "agent":
      return <AgentAnatomy agent={value as AgentState} />;
    case "tool":
      return <ToolAnatomy call={value as ToolCallState} />;
    case "artifact":
      return <ArtifactAnatomy artifact={value as ArtifactState} />;
    case "gate":
      return <GateAnatomy gate={value as GateState} />;
    case "dependency":
      return <DependencyAnatomy dependency={value as DependencyState} />;
    case "finding":
      return <FindingAnatomy finding={value as FindingState} />;
    case "execution":
      return <ExecutionAnatomy execution={value as ExecutionState} />;
    case "visit":
      return <VisitAnatomy visit={value as VisitEntity} />;
    case "seat":
      return <SeatAnatomy seat={value as SeatEntity} />;
    case "workflow":
      return <WorkflowAnatomy workflow={value as WorkflowEntity} />;
    case "project":
      return <ProjectAnatomy project={value as ProjectEntity} />;
  }
}

function GlobalStation({ id }: { id: string }) {
  const kind = id as StationKind;
  const cells = useScene((s) => s.cells);
  const here = Object.values(cells).filter((c) => c.station === kind);
  return (
    <div className="border-t border-line px-5 py-4 text-body-sm text-ink-muted">
      <p>
        <span className="font-mono text-[12px] text-ink">{stationLooks[kind]?.skill}</span>. {here.length ? `At work now for ${here.map((c) => c.ticketId).join(", ")}.` : "No cell is here now."}
      </p>
      {analyticsStationOf(kind) ? (
        <p className="mt-2">
          <StationHistoryLink kind={kind} />
        </p>
      ) : null}
    </div>
  );
}

/**
 * The entity's id under its name. An id that starts with the ticket owning it ("LOCAL-001/groom.finalize",
 * "LOCAL-001:evidence/run.log") makes that ticket a link back to it (its cell, or its slice before it
 * has one), so a person who followed a gate or a file can return and pick another; the rest stays text.
 */
function IdLine({ entity, id }: { entity: AnyRef; id: string }) {
  const owner = useScene((s) => ownerRefOf(s, entity));
  const parts = owner ? ownerOfId(entity) : null;
  return (
    // Wrapped, never cut off: a cut-off line would also clip the link's focus ring.
    <p className="mt-0.5 font-mono text-[12px] text-ink-muted [overflow-wrap:anywhere]" title={id} data-inspector-id="">
      {parts && owner ? (
        <>
          <EntityLink to={owner} label={`Back to ${parts.ticketId}`}>
            {parts.ticketId}
          </EntityLink>
          {parts.rest}
        </>
      ) : (
        id
      )}
    </p>
  );
}

/** Where the entity stands now: not seen yet, in progress, or finished. */
function TimeStatus({ look }: { look: Look | null }) {
  if (!look) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm border border-dashed border-line-strong px-3 py-2 text-body-sm">
        <span className="text-ink">Nothing recorded for it yet.</span>
      </div>
    );
  }
  return (
    <p className="mt-2 text-caption text-ink-muted">
      {look.since !== null ? (
        <>
          {getTimeBase() === "wall" ? timingWords(look).replace(/ at$/, "") : timingWords(look)} <When t={look.since} inline className="font-mono text-ink" />
        </>
      ) : look.phase === "running" ? (
        "In progress"
      ) : (
        "Finished"
      )}
      .
    </p>
  );
}

function Why({ entity }: { entity: AnyRef }) {
  const { all, happened } = useEntityEvents(entity);
  // Among records at the same moment, the deciding one explains it: authoritative > observed > reconstructed (D24).
  const latest = whyOf(all, happened);
  if (!latest) return null;
  return (
    <div className="mx-5 mb-4 rounded-sm bg-surface-sunken px-3 py-2.5">
      <p className="text-caption text-ink-subtle">Why it looks like this</p>
      <p className="mt-0.5 text-body-sm text-ink">
        <EventWords entry={latest} />
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-[11px] text-ink-subtle tabular">
          {latest.event.type}, <When t={latest.t} precision="second" />
        </span>
        {latest.event.schema_version === 3 ? <AuthorityBadge authority={latest.authority} /> : null}
        {latest.event.schema_version === 3 && timeCaveatWords(latest.precision) ? <span className="text-caption text-ink-subtle">{timeCaveatWords(latest.precision)}</span> : null}
      </div>
    </div>
  );
}

/** The scene names are read from: the simulation's final scene, or the newest scene received. */
function namingScene(s: { source: string; log: { head(): Scene } }): Scene {
  return s.source === "simulation" ? finalScene(SCENARIO) : s.log.head();
}

function Selected({ entity }: { entity: AnyRef }) {
  const store = useStore();
  // A simulated visit named by its ref is read through its station (pickedVisitOf).
  const picked = useScene((s) => pickedVisitOf(s, entity));
  const own = useScene((s) => selectEntity(s, entity));
  const value = picked ?? own;
  // Strings, so a new event re-renders the header only when the name itself changes.
  const name = useSceneStore((s) => identityOf(entity, namingScene(s)).name);
  const kindWord = useSceneStore((s) => identityOf(entity, namingScene(s)).kindWord);
  const identity = { name, kindWord, id: refId(entity) };
  const focusable = selectable(entity);
  const historyEnd = useSceneStore(historyEndedAt);
  const holds = useScene((s) => s.supervisor.holds);
  const look = value ? lookOf(entity, value, historyEnd, holds) : null;
  const { all } = useEntityEvents(entity);
  const unknown = all.length === 0 && !value;
  return (
    <div>
      <header className="sticky top-0 z-10 border-b border-line bg-surface px-5 pb-4 pt-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-sm border border-line bg-factory-ground">{look?.glyph ?? <span className="size-4 rounded-full border border-dashed border-line-strong" />}</span>
          <div className="min-w-0 flex-1">
            <p className="text-caption text-ink-subtle">{identity.kindWord}</p>
            <h2 tabIndex={-1} data-inspector-heading="" className="font-sans text-title-3 font-bold leading-snug text-ink outline-none [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-[var(--mach-focus)]">
              {/* An agent is named by its label (agent.started data.label): prose, contained. */}
              {proseName(kindOf(entity)) && !identity.name.endsWith(refId(entity)) ? <FreeText field={proseName(kindOf(entity))!} text={identity.name} /> : identity.name}
            </h2>
            <IdLine entity={entity} id={identity.id} />
          </div>
          <div className="-mr-2 -mt-1 flex shrink-0 items-center">
            {focusable ? (
              <IconButton label="Focus in the view" shortcut="F" onClick={() => store.focusOn(focusable, "api")}>
                <Crosshair aria-hidden="true" />
              </IconButton>
            ) : null}
            <IconButton label="Clear the selection" shortcut="Escape" onClick={() => store.select(null)}>
              <X aria-hidden="true" />
            </IconButton>
          </div>
        </div>
        {look ? (
          <div className="mt-2.5">
            <StateWord state={look.state} mark={look.mark} label={look.word} />
          </div>
        ) : null}
        <TimeStatus look={look} />
      </header>
      {unknown ? <p className="px-5 py-4 text-body-sm text-ink-muted">No record of that entity has been received. If it appears, this shows it.</p> : null}
      {value ? (
        <div className="pt-4">
          <Why entity={entity} />
          <Anatomy entity={entity} value={value} />
        </div>
      ) : null}
      {value || all.length ? <Provenance entity={entity} value={value} /> : null}
      <Evidence entity={entity} />
      {/* One label for the panel (C3): titles and labels in its links are contained without a label each. */}
      <p className="px-5 pb-4">
        <FreeTextLabel what="Titles, labels and reasons from the record" />
      </p>
    </div>
  );
}

export function Inspector() {
  const selection = useSceneStore((s) => s.selection);
  return (
    <div className="h-full overflow-y-auto overscroll-contain" data-inspector={selection ?? "run"}>
      {selection ? <Selected key={selection} entity={selection} /> : <RunNow />}
    </div>
  );
}
