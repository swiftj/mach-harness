/**
 * The ticket that owns a selected entity, as its id names it, for the link back in the inspector's
 * header ("LOCAL-001" in `LOCAL-001/groom.finalize`). Plain functions over the scene, so they are
 * tested (test/inspector-gate-panel.test.mjs). No React, no design system.
 */
import { refId, type AnyRef, type EntityRef, type Scene } from "../../sim";

/** The kinds whose id starts with the ticket that owns them, and the character after it. */
const OWNED_ID: Readonly<Record<string, "/" | ":">> = { gate: "/", station: "/", visit: "/", seat: "/", finding: "/", artifact: ":" };

/**
 * The ticket an entity's id names first, and the rest of the id: "LOCAL-001" and "/groom.finalize"
 * for the gate `LOCAL-001/groom.finalize`, "LOCAL-001" and ":evidence/run.log" for an artifact. Null
 * for a kind whose id does not start with its ticket (an execution's, an agent's or a tool call's
 * opaque id; a slice or a cell, which is the ticket) and for a station on its own (`station:verify`).
 */
export function ownerOfId(entity: AnyRef): { ticketId: string; rest: string } | null {
  const sep = OWNED_ID[entity.slice(0, entity.indexOf(":"))];
  if (!sep) return null;
  const id = refId(entity);
  const at = id.indexOf(sep);
  if (at <= 0) return null;
  return { ticketId: id.slice(0, at), rest: id.slice(at) };
}

/**
 * What the ticket named in an entity's id selects, as the Line selects a ticket: its cell, or its
 * slice while it has no cell. Null when the scene holds neither: the id is then plain text, never a
 * link to nothing.
 */
export function ownerRefOf(scene: Pick<Scene, "cells" | "slices">, entity: AnyRef): EntityRef | null {
  const owner = ownerOfId(entity);
  if (!owner) return null;
  if (scene.cells[owner.ticketId]) return `cell:${owner.ticketId}`;
  const slice = Object.values(scene.slices).find((s) => s.ticketId === owner.ticketId);
  return slice ? `slice:${slice.id}` : null;
}
