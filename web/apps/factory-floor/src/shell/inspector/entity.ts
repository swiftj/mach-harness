/**
 * Reading the selected entity from the scene at the playhead, with selectors that return the
 * scene's own (stable) objects, so the inspector re-renders only when that entity changes.
 */
import type { StationKind } from "@mach/ui";
import {
  findAgent,
  findArtifact,
  findToolCall,
  gateOfRef,
  isKnown,
  refId,
  stableEntityAt,
  type ActorId,
  type AnyRef,
  type FindingState,
  type Scene,
  type StationId,
  type VisitEntity,
} from "../../sim";
import { ACTOR_WORDS, gateName, kindOf, KIND_WORDS, ROLE_WORDS, STATION_WORDS, type ShellKind } from "../vocab";

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

/** One VisitEntity per scene visit object, so a React selector gets the same object while the visit does not change. */
const pickedCache = new WeakMap<object, VisitEntity>();

/**
 * The visit the Timeline picked through a station (X3): the selection is `station:T/s` and the detail
 * `visit:T/s#n` (the n-th visit to that station in the cell, as the Timeline numbers them) or the
 * visit's recorded id. Null when the detail names no visit of that station, or it has not begun.
 */
export function pickedVisitOf(scene: Scene, entity: AnyRef, detail: string | null): VisitEntity | null {
  // A visit selected by its own ref that the scene cannot resolve (the simulation's visits carry no
  // recorded id): read it through its station, by the Timeline's numbering.
  if (!detail && kindOf(entity) === "visit") {
    const m = /^visit:([^/]+)\/([^#/]+)#\d+$/.exec(entity);
    if (!m || stableEntityAt(scene, entity)) return null;
    return pickedVisitOf(scene, `station:${m[1]}/${m[2]}` as AnyRef, entity);
  }
  if (!detail || !detail.startsWith("visit:") || kindOf(entity) !== "station") return null;
  const { ticketId, station } = parseStation(refId(entity));
  const cell = ticketId ? scene.cells[ticketId] : undefined;
  if (!cell) return null;
  const vid = detail.slice("visit:".length);
  const mine = cell.visits.filter((v) => v.station === station);
  const m = /^([^/]+)\/([^#/]+)#(\d+)$/.exec(vid);
  const v = mine.find((x) => x.visitId === vid) ?? (m && m[1] === ticketId && m[2] === station ? mine[Number(m[3]) - 1] : undefined);
  if (!v) return null;
  let out = pickedCache.get(v);
  if (!out) pickedCache.set(v, (out = { ...v, ticketId: cell.ticketId, visitId: vid }));
  return out;
}

/** The entity's own object at the playhead (stable while it does not change), or null if it does not exist yet. */
export function selectEntity(scene: Scene, entity: AnyRef): unknown {
  const id = refId(entity);
  switch (kindOf(entity)) {
    case "actor":
      return scene.actors[id as ActorId] ?? null;
    case "wave":
      return scene.waves[id] ?? null;
    case "slice":
      return scene.slices[id] ?? null;
    case "cell":
      return scene.cells[id] ?? null;
    case "execution":
      return scene.executions[id] ?? null;
    case "gate":
      // Either vocabulary: the scene's gate id, or the observer's own ref for an evaluation (R5).
      return gateOfRef(scene, id);
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
    // Assembled from the scene by identity; the same object while it does not change.
    case "visit":
    case "seat":
    case "workflow":
    case "project":
      return stableEntityAt(scene, entity)?.value ?? null;
  }
}

export interface Identity {
  kind: ShellKind;
  kindWord: string;
  name: string;
  id: string;
}

/**
 * What an entity is called, read from a scene: the simulation's final scene (names are fixed for its
 * whole run), or for real history the newest scene received (a name can arrive after the entity
 * does). A name that is not recorded falls back to the entity's own id, never to an invented title.
 */
export function identityOf(entity: AnyRef, scene: Scene): Identity {
  const kind = kindOf(entity);
  const id = refId(entity);
  const base = { kind, kindWord: KIND_WORDS[kind], id };
  switch (kind) {
    case "actor":
      return { ...base, name: ACTOR_WORDS[id as ActorId]?.role ?? id };
    case "wave": {
      const w = scene.waves[id];
      return { ...base, name: w && isKnown(w.meta, "title") ? w.title : `Wave ${id}` };
    }
    case "slice": {
      const sl = scene.slices[id];
      return { ...base, name: sl && sl.title && isKnown(sl.meta, "title") ? sl.title : `Slice ${id}` };
    }
    case "cell": {
      const c = scene.cells[id];
      return { ...base, name: c && isKnown(c.meta, "title") ? c.title : `Cell ${id}` };
    }
    case "execution":
      return { ...base, name: `Execution of ${scene.executions[id]?.ticketId ?? "a ticket"}` };
    case "gate": {
      const g = gateOfRef(scene, id);
      return { ...base, name: g ? `${gateName(g)}${g.round ? `, round ${g.round}` : ""}` : id };
    }
    case "dependency": {
      const [from, to] = id.split("->");
      return { ...base, name: `${from} waits for ${to}` };
    }
    case "agent": {
      const a = findAgent(scene, id);
      if (a && a.observation === "count-only") return { ...base, name: a.label || id };
      return { ...base, name: a ? (a.role === "reviewer" && a.seat ? `Reviewer, ${a.seat} seat` : ROLE_WORDS[a.role]) : id };
    }
    case "tool": {
      const c = findToolCall(scene, id);
      return { ...base, name: c ? `${c.toolName || c.tool} call` : id };
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
    case "visit": {
      const v = stableEntityAt(scene, entity);
      return { ...base, name: v?.kind === "visit" ? `${STATION_WORDS[v.value.station as StationKind] ?? v.value.station}, round ${v.value.round}, in ${v.value.ticketId}` : id };
    }
    case "seat": {
      const v = stableEntityAt(scene, entity);
      return { ...base, name: v?.kind === "seat" ? `The ${v.value.seat} seat, round ${v.value.round}, ${v.value.ticketId}` : id };
    }
    case "workflow": {
      const v = stableEntityAt(scene, entity);
      return { ...base, name: v?.kind === "workflow" ? `Workflow of ${v.value.ticketId || "an execution"}` : id };
    }
    case "project":
      return { ...base, name: scene.project.name || `Project ${id}` };
  }
}
