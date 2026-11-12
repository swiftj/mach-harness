/**
 * Reading the selected entity from the scene at the playhead, with selectors that return the
 * scene's own (stable) objects, so the inspector re-renders only when that entity changes.
 */
import type { StationKind } from "@mach/ui";
import {
  finalScene,
  findAgent,
  findArtifact,
  findToolCall,
  refId,
  refKind,
  SCENARIO,
  type EntityKind,
  type EntityRef,
  type FindingState,
  type Scene,
  type StationId,
} from "../../sim";
import { GATE_WORDS, KIND_WORDS, ROLE_WORDS, STATION_WORDS } from "../vocab";

export function findFinding(scene: Scene, id: string): FindingState | null {
  const ticket = id.split("/")[0] ?? "";
  const cell = scene.cells[ticket];
  if (!cell) return null;
  for (const round of cell.reviews) {
    const f = round.findings.find((x) => x.id === id);
    if (f) return f;
  }
  return null;
}

export function parseStation(id: string): { ticketId: string | null; station: StationId } {
  return id.includes("/") ? { ticketId: id.split("/")[0] ?? null, station: id.split("/")[1] as StationId } : { ticketId: null, station: id as StationId };
}

/** The entity's own object at the playhead (stable while it does not change), or null if it does not exist yet. */
export function selectEntity(scene: Scene, entity: EntityRef): unknown {
  const id = refId(entity);
  switch (refKind(entity)) {
    case "wave":
      return scene.waves[id] ?? null;
    case "slice":
      return scene.slices[id] ?? null;
    case "cell":
      return scene.cells[id] ?? null;
    case "execution":
      return scene.executions[id] ?? null;
    case "gate":
      return scene.gates[id] ?? null;
    case "dependency":
      return scene.dependencies[id] ?? null;
    case "agent":
      return findAgent(scene, id);
    case "tool":
      return findToolCall(scene, id);
    case "artifact":
      return findArtifact(scene, id);
    case "finding":
      return findFinding(scene, id);
    case "station": {
      const { ticketId } = parseStation(id);
      if (ticketId) {
        const cell = scene.cells[ticketId];
        return cell && cell.visits.length ? cell : null;
      }
      return scene.cells;
    }
  }
}

export interface Identity {
  kind: EntityKind;
  kindWord: string;
  name: string;
  id: string;
}

/** What an entity is called. Names are fixed for the whole run, so they come from the final scene. */
export function identityOf(entity: EntityRef): Identity {
  const kind = refKind(entity);
  const id = refId(entity);
  const scene = finalScene(SCENARIO);
  const base = { kind, kindWord: KIND_WORDS[kind], id };
  switch (kind) {
    case "wave":
      return { ...base, name: scene.waves[id]?.title ?? id };
    case "slice":
      return { ...base, name: scene.slices[id]?.title ?? id };
    case "cell":
      return { ...base, name: scene.cells[id]?.title ?? id };
    case "execution":
      return { ...base, name: `Execution of ${scene.executions[id]?.ticketId ?? "a ticket"}` };
    case "gate": {
      const g = scene.gates[id];
      return { ...base, name: g ? `${GATE_WORDS[g.gate]}${g.round ? `, round ${g.round}` : ""}` : id };
    }
    case "dependency": {
      const [from, to] = id.split("->");
      return { ...base, name: `${from} waits for ${to}` };
    }
    case "agent": {
      const a = findAgent(scene, id);
      return { ...base, name: a ? (a.role === "reviewer" && a.seat ? `Reviewer, ${a.seat} seat` : ROLE_WORDS[a.role]) : id };
    }
    case "tool": {
      const c = findToolCall(scene, id);
      return { ...base, name: c ? `${c.tool} call` : id };
    }
    case "artifact": {
      const a = findArtifact(scene, id);
      return { ...base, name: a?.label ?? id };
    }
    case "finding": {
      const f = findFinding(scene, id);
      return { ...base, name: f ? `${f.severity === "blocker" ? "Blocker" : "Note"} from the ${f.seat} seat` : id };
    }
    case "station": {
      const { ticketId, station } = parseStation(id);
      return { ...base, kindWord: ticketId ? "Station visit" : "Station", name: `${STATION_WORDS[station as StationKind] ?? station}${ticketId ? ` in ${ticketId}` : ""}` };
    }
  }
}
