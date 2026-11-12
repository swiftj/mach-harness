/**
 * The contextual inspector (spec f.9): follows the store's selection. A header (glyph, name, ID,
 * state as of the playhead), why it looks like this, one anatomy per entity type, the evidence
 * behind it, and links to related entities. With nothing selected: the run at the playhead.
 */
import { Crosshair, X } from "lucide-react";
import { type ReactNode } from "react";
import { stations as stationLooks, type FactoryMarkShape, type FactoryState, type StationKind } from "@mach/ui";
import {
  describe,
  eventsFor,
  refId,
  refKind,
  SCENARIO,
  type AgentState,
  type ArtifactState,
  type CellState,
  type DependencyState,
  type EntityRef,
  type ExecutionState,
  type FindingState,
  type GateState,
  type SliceState,
  type ToolCallState,
  type WaveState,
} from "../../sim";
import { useScene, useSceneStore, useStore } from "../../scene";
import { AgentGlyph, ArtifactGlyph, CellGlyph, DependencyGlyph, ExecutionGlyph, GateGlyphSmall, SliceGlyph, StateWord, StationGlyph, ToolGlyph, WaveGlyph } from "../glyphs";
import { IconButton } from "../timeline/Transport";
import { artifactOf, gateOf, GATE_STATE_WORDS, gateState, outcomeState, roleOf, runState, schedulerLook, stageLook, tierOf, timecode, toolFamily } from "../vocab";
import {
  AgentAnatomy,
  ArtifactAnatomy,
  CellAnatomy,
  DependencyAnatomy,
  ExecutionAnatomy,
  FindingAnatomy,
  GateAnatomy,
  SliceAnatomy,
  StationAnatomy,
  ToolAnatomy,
  WaveAnatomy,
} from "./anatomies";
import { identityOf, parseStation, selectEntity } from "./entity";
import { Evidence, JumpButton, useEntityEvents } from "./parts";
import { RunNow } from "./RunNow";

interface Look {
  glyph: ReactNode;
  state: FactoryState;
  mark?: FactoryMarkShape;
  word: string;
  /** Where it stands in time at the playhead. */
  phase: "running" | "finished";
  since: number | null;
}

/** Glyph, state and phase of an entity that exists at the playhead. */
function lookOf(entity: EntityRef, value: unknown): Look {
  const id = refId(entity);
  switch (refKind(entity)) {
    case "wave": {
      const w = value as WaveState;
      return { glyph: <WaveGlyph size={28} />, state: w.state === "validated" ? "succeeded" : "active", word: w.state === "validated" ? "Verified" : "Arrived", phase: "finished", since: w.discoveredAt };
    }
    case "slice": {
      const s = value as SliceState;
      const l = schedulerLook(s.scheduler);
      return { glyph: <SliceGlyph size={28} state={l.state} mark={l.mark} />, state: l.state, mark: l.mark, word: l.label, phase: s.scheduler === "integrated" ? "finished" : "running", since: s.since };
    }
    case "cell": {
      const c = value as CellState;
      const l = stageLook(c.stage);
      return { glyph: <CellGlyph size={28} state={l.state} />, state: l.state, mark: l.mark, word: l.label, phase: c.merged ? "finished" : "running", since: c.openedAt };
    }
    case "station": {
      const { station } = parseStation(id);
      const cell = (value as CellState).visits ? (value as CellState) : null;
      const visits = cell ? cell.visits.filter((v) => v.station === station) : [];
      const last = visits[visits.length - 1];
      const state: FactoryState = !last ? "idle" : last.leftAt === null ? "active" : outcomeState(last.outcome);
      return { glyph: <StationGlyph kind={station as StationKind} size={28} state={state} />, state, word: !last ? "Not visited" : last.leftAt === null ? "Working" : (last.outcome ?? "ended").replace(/^./, (c) => c.toUpperCase()), phase: last && last.leftAt === null ? "running" : "finished", since: last?.enteredAt ?? null };
    }
    case "agent": {
      const a = value as AgentState;
      const state = runState(a.status);
      return { glyph: <AgentGlyph tier={tierOf(a.model)} agentRole={roleOf(a.role)} size={28} state={state} />, state, word: a.status === "running" ? "Working" : a.status === "error" ? "Failed" : "Finished", phase: a.status === "running" ? "running" : "finished", since: a.status === "running" ? a.startedAt : a.finishedAt };
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
      return { glyph: <GateGlyphSmall kind={gateOf(g.gate)} size={28} state={state} />, state, word: GATE_STATE_WORDS[g.state], phase: g.decidedAt === null ? "running" : "finished", since: g.decidedAt ?? g.openedAt };
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
      const state: FactoryState = x.state === "running" || x.state === "claimed" ? "active" : x.state === "failed" ? "failed" : "succeeded";
      return { glyph: <ExecutionGlyph size={28} state={state} />, state, word: x.state, phase: state === "active" ? "running" : "finished", since: x.endedAt ?? x.startedAt };
    }
  }
}

function Anatomy({ entity, value }: { entity: EntityRef; value: unknown }) {
  switch (refKind(entity)) {
    case "wave":
      return <WaveAnatomy wave={value as WaveState} />;
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
    </div>
  );
}

/** Where the entity stands at the playhead: not yet, in progress, or finished. */
function TimeStatus({ look, entity }: { look: Look | null; entity: EntityRef }) {
  const { all } = useEntityEvents(entity);
  if (!look) {
    const first = all[0];
    return (
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm border border-dashed border-line-strong px-3 py-2 text-body-sm">
        <span className="text-ink">Not started at this moment.</span>
        {first ? <JumpButton seq={first.seq} label={`It starts at ${timecode(first.t, false)}`} /> : null}
      </div>
    );
  }
  return (
    <p className="mt-2 text-caption text-ink-muted">
      {look.phase === "running" ? "In progress" : "Finished"}
      {look.since !== null ? (
        <>
          {look.phase === "running" ? " since " : " at "}
          <span className="font-mono tabular text-ink">{timecode(look.since, false)}</span>
        </>
      ) : null}
      , as of the playhead.
    </p>
  );
}

function Why({ entity }: { entity: EntityRef }) {
  const { all, happened } = useEntityEvents(entity);
  const latest = all[happened - 1];
  if (!latest) return null;
  return (
    <div className="mx-5 mb-4 rounded-sm bg-surface-sunken px-3 py-2.5">
      <p className="text-caption text-ink-subtle">Why it looks like this</p>
      <p className="mt-0.5 text-body-sm text-ink">{describe(latest)}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-[11px] text-ink-subtle tabular">
          {latest.type}, seq {latest.seq}, {timecode(latest.t)}, {latest.source}
        </span>
        <JumpButton seq={latest.seq} label="Go to event" />
      </div>
    </div>
  );
}

function Selected({ entity }: { entity: EntityRef }) {
  const value = useScene((s) => selectEntity(s, entity));
  const store = useStore();
  const identity = identityOf(entity);
  const look = value ? lookOf(entity, value) : null;
  const unknown = eventsFor(SCENARIO, entity).length === 0 && !value;
  return (
    <div>
      <header className="sticky top-0 z-10 border-b border-line bg-surface px-5 pb-4 pt-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-sm border border-line bg-factory-ground">{look?.glyph ?? <span className="size-4 rounded-full border border-dashed border-line-strong" />}</span>
          <div className="min-w-0 flex-1">
            <p className="text-caption text-ink-subtle">{identity.kindWord}</p>
            <h2 className="font-serif text-title-3 leading-snug text-ink [overflow-wrap:anywhere]">{identity.name}</h2>
            <p className="mt-0.5 truncate font-mono text-[12px] text-ink-muted" title={identity.id}>
              {identity.id}
            </p>
          </div>
          <div className="-mr-2 -mt-1 flex shrink-0 items-center">
            <IconButton label="Focus in the view" shortcut="F" onClick={() => store.focusOn(entity, "api")}>
              <Crosshair aria-hidden="true" />
            </IconButton>
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
        <TimeStatus look={look} entity={entity} />
      </header>
      {unknown ? <p className="px-5 py-4 text-body-sm text-ink-muted">This run has no record of that entity.</p> : null}
      {value ? (
        <div className="pt-4">
          <Why entity={entity} />
          <Anatomy entity={entity} value={value} />
        </div>
      ) : null}
      <Evidence entity={entity} />
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
