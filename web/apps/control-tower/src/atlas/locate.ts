/**
 * Where an entity is on the plant, as plan boxes: for selection brackets, the focus ring and camera
 * framing. Pure, from the layout and the scene at the playhead.
 */
import { factoryTokens, screenBounds, type PlanBox } from "@mach/ui";
import { entityAt, findAgent, findArtifact, findToolCall, ref, refId, refKind, type EntityRef, type Scene } from "../sim";
import { SIM_MODE, chamberOccupant, placeAgents, type ViewMode } from "./derive";
import { FLOOR_Z, PLATE_Z, boxAt, type BaySlot, type PlantLayout } from "./layout";
import type { ScreenRect } from "./camera";

const CELL = factoryTokens.size.cell;

function bayBox(b: BaySlot): PlanBox {
  return { x: b.origin.x, y: b.origin.y, w: CELL.x, d: CELL.y, z: PLATE_Z, h: 18 };
}

function regionBox(r: { x: number; y: number; w: number; d: number }): PlanBox {
  return { ...r, z: 0, h: PLATE_Z };
}

/**
 * Ids are opaque (contract 5.1): nothing here reads a ticket or a station out of an agent's,
 * artifact's or tool call's id. They are found in the scene and placed from its fields.
 */
export function locate(L: PlantLayout, scene: Scene, t: number, entity: EntityRef, mode: ViewMode = SIM_MODE): PlanBox[] {
  const id = refId(entity);
  switch (refKind(entity)) {
    // actor:scheduler and actor:supervisor (the simulation's non-agent actors).
    case "actor":
      return id === "scheduler" ? [boxAt(L.intake.scheduler, 18, 18, 26), boxAt(L.intake.schedulerDesk, 28, 18, 8)] : [boxAt(L.intake.supervisor, 32, 24, 12)];
    case "wave":
      return [{ ...L.dock, z: 0, h: 20 }, { x: 40, y: L.mid - 30, w: 40, d: 60, z: PLATE_Z, h: 16 }];
    case "slice": {
      const bay = L.bayBySlice.get(id);
      if (!bay) return [];
      return scene.cells[bay.ticketId] ? [bayBox(bay)] : [boxAt(bay.pad, 40, 40, 20)];
    }
    case "cell":
    case "execution": {
      const ticket = refKind(entity) === "cell" ? id : scene.executions[id]?.ticketId;
      const bay = ticket ? L.bayByTicket.get(ticket) : undefined;
      return bay ? [bayBox(bay)] : [];
    }
    case "station": {
      const [ticket, station] = id.includes("/") ? id.split("/") : [null, id];
      const bay = ticket ? L.bayByTicket.get(ticket) : undefined;
      if (bay && (station === "plan" || station === "groom")) return [boxAt(bay.pads.intent, 40, 40, 22)];
      if (bay && (station === "build" || station === "audit")) return [boxAt(bay.pads.build, 40, 40, 26)];
      if (bay && station === "verify") return [boxAt(bay.pads.verify, 40, 40, 24)];
      switch (station) {
        case "intake":
          return [boxAt(L.intake.hopper, 40, 40, 20)];
        case "audit":
          return [boxAt(L.intake.audit, 40, 40, 18)];
        case "review":
          return [regionBox(L.regions.review)];
        case "human-approval":
          return [regionBox(L.regions.human)];
        case "merge":
          return [boxAt(L.integration.merge, 40, 40, 20)];
        case "cleanup":
          return [boxAt(L.archive.cleanup, 40, 40, 14)];
        case "observe":
          return [boxAt(L.archive.observe, 40, 40, 24)];
        default:
          return bay ? [bayBox(bay)] : [];
      }
    }
    case "agent": {
      const agent = findAgent(scene, id);
      if (!agent) return [];
      const cell = scene.cells[agent.ticketId];
      if (!cell) return [];
      const placed = placeAgents(L, cell, t, true, mode).find((p) => p.agent.id === id);
      return placed ? [boxAt(placed.at, 18, 18, 34)] : [];
    }
    case "artifact":
    case "tool": {
      const artifact = refKind(entity) === "artifact" ? findArtifact(scene, id) : null;
      if (artifact?.kind === "merge-commit") return [{ x: L.integration.trunkTo, y: L.integration.trunkY - 12, w: L.integration.trunkFrom - L.integration.trunkTo, d: 24, z: PLATE_Z, h: 18 }];
      if (artifact?.kind === "archive") return [boxAt(L.archive.stack, 30, 30, 20)];
      // A tool call is found in the scene by its identity, never parsed for a ticket.
      const call = refKind(entity) === "tool" ? findToolCall(scene, id) : null;
      const ticket = artifact?.ticketId ?? call?.ticketId;
      const bay = ticket ? L.bayByTicket.get(ticket) : undefined;
      if (!bay) return [];
      if (refKind(entity) === "tool") return [{ x: bay.origin.x + 10, y: bay.origin.y + CELL.y - 36, w: CELL.x - 24, d: 10, z: FLOOR_Z, h: 14 }];
      return [{ x: bay.origin.x + 24, y: bay.origin.y + 12, w: 140, d: 12, z: FLOOR_Z, h: 20 }];
    }
    case "gate": {
      // The gate's own fields where the scene holds it; the ref's documented shape only for a gate
      // not reached yet (`<ticket>/<kind>#<round>`, model.gateId).
      const g = scene.gates[id];
      const [refTicket = "", rest = ""] = id.split("/");
      const ticket = g?.ticketId ?? refTicket;
      const kind = g?.gate ?? rest.split("#")[0];
      const bay = L.bayByTicket.get(ticket);
      switch (kind) {
        case "verification":
          return bay ? [boxAt(bay.gate, 10, 48, 36)] : [];
        case "red-before-green":
          return bay ? [{ x: bay.origin.x + 60, y: bay.origin.y + 80, w: 40, d: 20, z: FLOOR_Z, h: 4 }] : [];
        case "plan-check":
          return bay ? [boxAt(bay.pads.intent, 40, 40, 22)] : [];
        case "review":
          return [boxAt(L.review.gate, 10, 48, 40)];
        case "human-approval":
          return [boxAt(L.human.gate, 10, 48, 50)];
        case "merge-revalidation":
          return [boxAt(L.integration.gate, 10, 48, 36)];
        case "audit":
          return [boxAt(L.intake.auditGate, 10, 48, 36)];
        default:
          return bay ? [bayBox(bay)] : [];
      }
    }
    case "dependency": {
      const [from = "", to = ""] = id.split("->");
      return [...locate(L, scene, t, `slice:${from}`, mode), ...locate(L, scene, t, `slice:${to}`, mode)];
    }
    case "finding": {
      let seat: string | undefined;
      for (const c of Object.values(scene.cells)) for (const r of c.reviews) for (const f of r.findings) if (f.id === id) seat = f.seat;
      seat ??= id.split("/")[2];
      if (seat && seat in L.review.seats) return [boxAt(L.review.seats[seat as keyof PlantLayout["review"]["seats"]], 40, 30, 20)];
      return [regionBox(L.regions.review)];
    }
    // The kinds real history adds: found in the scene by identity, placed where what they belong to is.
    case "visit": {
      const found = entityAt(scene, entity);
      return found?.kind === "visit" ? locate(L, scene, t, ref.station(found.value.station, found.value.ticketId), mode) : [];
    }
    case "seat": {
      const found = entityAt(scene, entity);
      if (found?.kind !== "seat") return [];
      const seat = found.value.seat;
      return seat in L.review.seats ? [boxAt(L.review.seats[seat as keyof PlantLayout["review"]["seats"]], 40, 30, 20)] : [regionBox(L.regions.review)];
    }
    case "workflow": {
      const found = entityAt(scene, entity);
      return found?.kind === "workflow" ? locate(L, scene, t, ref.execution(found.value.executionId), mode) : [];
    }
    case "project":
      return [{ ...L.extent, z: 0, h: PLATE_Z }];
  }
}

export function locateScreen(L: PlantLayout, scene: Scene, t: number, entity: EntityRef, pad = 0, mode: ViewMode = SIM_MODE): ScreenRect | null {
  const boxes = locate(L, scene, t, entity, mode);
  if (!boxes.length) return null;
  return screenBounds(boxes, pad);
}

/** The active set for follow mode: bays at work, the chamber when a panel sits, work in the gatehouse or at merge. */
export function activeBoxes(L: PlantLayout, scene: Scene, t: number): PlanBox[] {
  const out: PlanBox[] = [];
  for (const cell of Object.values(scene.cells)) {
    const bay = L.bayByTicket.get(cell.ticketId);
    if (!bay || cell.archived) continue;
    if (cell.activeAgentIds.length > 0 || cell.station) out.push(bayBox(bay));
    if (cell.station === "review") out.push(regionBox(L.regions.review));
    if (cell.station === "human-approval" || cell.stage === "awaiting-human") out.push(regionBox(L.regions.human));
    if (cell.station === "merge" || cell.station === "cleanup") out.push(regionBox(L.regions.integration));
  }
  if (chamberOccupant(scene, t)) out.push(regionBox(L.regions.review));
  return out;
}
