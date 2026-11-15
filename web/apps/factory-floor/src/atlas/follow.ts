/**
 * Follow mode (spec f.3), made calm. Interface behaviour only: it decides where the camera goes,
 * never what the factory does.
 *
 * The rule:
 * 1. The active set is the places where work is now: bays with a station working or agents at
 *    work, the review chamber while a panel sits, the gatehouse while work is held, the yard while
 *    a merge or cleanup runs.
 * 2. If the whole set already sits inside the inner 70% of the viewport, nothing moves.
 * 3. If the whole set fits in the inner 70% at the zoom the viewer chose, or after zooming out from
 *    it by at most a quarter (and never below the mid level), the camera eases to frame the whole
 *    set. It never zooms in past the viewer's zoom, and repeated re-frames never compound a zoom-out.
 * 4. Otherwise the camera keeps its zoom and follows one primary member. The primary is sticky: it
 *    stays the target while it is still active, so several active cells never pull the camera back
 *    and forth. When it goes quiet, the next primary is the active member nearest the current view
 *    centre (the shortest move). The camera moves only when the primary leaves the inner 70%.
 * 5. A place stays in the set for 90 factory seconds after its work stops (the pause between two
 *    stations), so the set does not flicker. Moves smaller than 12% of the viewport are skipped.
 * 6. At most one re-frame every 4 s of wall time (6 s under reduced motion, where it cuts instead of
 *    easing).
 */
import { factoryTokens, screenBounds, type PlanBox } from "@mach/ui";
import type { Scene } from "../sim";
import { chamberOccupant } from "./derive";
import { PLATE_Z, type PlantLayout } from "./layout";
import type { Camera, ScreenRect } from "./camera";

export interface FollowMember {
  id: string;
  rect: ScreenRect;
}

const region = (r: { x: number; y: number; w: number; d: number }): PlanBox => ({ ...r, z: 0, h: PLATE_Z + 30 });

export function activeMembers(L: PlantLayout, scene: Scene, t: number): FollowMember[] {
  const out: FollowMember[] = [];
  const C = factoryTokens.size.cell;
  for (const cell of Object.values(scene.cells)) {
    const bay = L.bayByTicket.get(cell.ticketId);
    if (!bay || cell.archived) continue;
    const onFloor = cell.station === "plan" || cell.station === "groom" || cell.station === "build" || cell.station === "verify" || cell.station === "audit";
    if (onFloor || (cell.station === null && cell.activeAgentIds.length > 0 && !cell.merged)) {
      out.push({ id: `cell:${cell.ticketId}`, rect: screenBounds([{ x: bay.origin.x, y: bay.origin.y, w: C.x, d: C.y, z: PLATE_Z, h: 40 }]) });
    }
    if (cell.station === "human-approval") out.push({ id: "human", rect: screenBounds([region(L.regions.human)]) });
    if (cell.station === "merge" || cell.station === "cleanup") out.push({ id: "integration", rect: screenBounds([region(L.regions.integration)]) });
  }
  if (chamberOccupant(scene, t)) out.push({ id: "review", rect: screenBounds([region(L.regions.review)]) });
  return out;
}

function union(rects: ScreenRect[]): ScreenRect {
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.width));
  const y1 = Math.max(...rects.map((r) => r.y + r.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function insideInner(r: ScreenRect, cam: Camera, vw: number, vh: number): boolean {
  const sx = r.x * cam.zoom + cam.x;
  const sy = r.y * cam.zoom + cam.y;
  return sx >= vw * 0.15 && sy >= vh * 0.15 && sx + r.width * cam.zoom <= vw * 0.85 && sy + r.height * cam.zoom <= vh * 0.85;
}

/** Where the camera should go now, if anywhere, and which member is primary. */
export function followDecision(cam: Camera, viewport: { width: number; height: number }, members: FollowMember[], primary: string | null, baseZoom: number = cam.zoom): { target: Camera | null; primary: string | null } {
  if (members.length === 0) return { target: null, primary: null };
  const { width: vw, height: vh } = viewport;
  const all = union(members.map((m) => m.rect));
  if (insideInner(all, cam, vw, vh)) return { target: null, primary: null };
  const inner = { width: vw * 0.7, height: vh * 0.7 };
  const fitZoom = Math.min(inner.width / Math.max(1, all.width), inner.height / Math.max(1, all.height));
  const floor = Math.max(factoryTokens.zoom.far + 0.06, baseZoom * 0.75);
  if (fitZoom >= floor) {
    const zoom = Math.min(baseZoom, fitZoom);
    const cx = all.x + all.width / 2;
    const cy = all.y + all.height / 2;
    return { target: skipSmall(cam, { zoom, x: vw / 2 - cx * zoom, y: vh / 2 - cy * zoom }, viewport), primary: null };
  }
  // Too spread to frame: keep the zoom and follow one sticky primary.
  const centre = { x: (vw / 2 - cam.x) / cam.zoom, y: (vh / 2 - cam.y) / cam.zoom };
  const dist = (m: FollowMember) => Math.hypot(m.rect.x + m.rect.width / 2 - centre.x, m.rect.y + m.rect.height / 2 - centre.y);
  const keep = members.find((m) => m.id === primary);
  const chosen = keep ?? [...members].sort((a, b) => dist(a) - dist(b))[0]!;
  if (insideInner(chosen.rect, cam, vw, vh)) return { target: null, primary: chosen.id };
  const zoom = baseZoom;
  return { target: skipSmall(cam, { zoom, x: vw / 2 - (chosen.rect.x + chosen.rect.width / 2) * zoom, y: vh / 2 - (chosen.rect.y + chosen.rect.height / 2) * zoom }, viewport), primary: chosen.id };
}

/** A dead zone: a move smaller than 12% of the viewport (and no real zoom change) is not worth making. */
function skipSmall(cam: Camera, target: Camera, viewport: { width: number; height: number }): Camera | null {
  const cx0 = (viewport.width / 2 - cam.x) / cam.zoom;
  const cy0 = (viewport.height / 2 - cam.y) / cam.zoom;
  const cx1 = (viewport.width / 2 - target.x) / target.zoom;
  const cy1 = (viewport.height / 2 - target.y) / target.zoom;
  const moved = Math.hypot(cx1 - cx0, cy1 - cy0) * cam.zoom;
  const zoomed = Math.abs(Math.log(target.zoom / cam.zoom)) > 0.05;
  return moved < Math.min(viewport.width, viewport.height) * 0.12 && !zoomed ? null : target;
}

/** Members seen active within the grace period (factory ms) stay in the set. */
export function withGrace(now: FollowMember[], t: number, lastSeen: Map<string, { t: number; rect: ScreenRect }>, graceMs = 90_000): FollowMember[] {
  for (const m of now) lastSeen.set(m.id, { t, rect: m.rect });
  const out: FollowMember[] = [];
  for (const [id, seen] of lastSeen) {
    if (seen.t > t) lastSeen.delete(id); // scrubbed back past it
    else if (t - seen.t <= graceMs) out.push({ id, rect: seen.rect });
  }
  return out;
}
