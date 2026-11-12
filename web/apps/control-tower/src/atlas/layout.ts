/**
 * The plant's fixed layout: where every region, bay, machine, gate, pad and track stands, in plan
 * units (M6_0_VISUAL_SPEC.md b.2 and b.3). Computed once per fixture from its product definitions
 * and the slice.materialized events, so a bay keeps its place for the whole run (spatial memory) and
 * nothing reflows while playing. Pure; no React.
 */
import { cellAnatomy, factoryTokens, type PlanBox, type Vec3 } from "@mach/ui";
import type { Fixture } from "../sim";

const SIZE = factoryTokens.size;
export const PLATE_Z: number = factoryTokens.elevation.regionPlate; // 8
export const FLOOR_Z = PLATE_Z + 4; // a cell's floor top
const GAP = SIZE.regionGap; // 56

export interface Rect {
  x: number;
  y: number;
  w: number;
  d: number;
}

export interface BaySlot {
  sliceId: string;
  ticketId: string;
  index: number;
  col: number;
  row: number;
  origin: { x: number; y: number };
  /** Plan y of the bay's conveyor rail. */
  railY: number;
  /** Where the dispatch spur reaches the bay (its entrance, left end of the rail). */
  entrance: Vec3;
  /** Exit door and the verification gate standing just outside it. */
  door: Vec3;
  gate: Vec3;
  /** The aisle track the door opens onto. */
  aisleX: number;
  pads: { intent: Vec3; build: Vec3; verify: Vec3 };
  /** The line console at the entrance where the belt's clerk stands. */
  console: Vec3;
  clerkSpot: Vec3;
  /** Holding pad in intake, before dispatch. */
  pad: Vec3;
}

export interface PlantLayout {
  D: number;
  W: number;
  /** Plan y of the intake's centre line (dock, hopper, outbound track). */
  mid: number;
  /** Plan y of the review chamber's centre line; x of the column that drops through the gatehouse to the yard. */
  ry: number;
  cx: number;
  regions: { intake: Rect; floor: Rect; review: Rect; human: Rect; integration: Rect; archive: Rect };
  dock: Rect;
  bays: readonly BaySlot[];
  /** Bay slots on the floor no slice uses (the floor is laid out in whole columns). */
  freeBays: readonly { x: number; y: number; index: number }[];
  bayByTicket: ReadonlyMap<string, BaySlot>;
  bayBySlice: ReadonlyMap<string, BaySlot>;
  waveIds: readonly string[];
  intake: {
    hopper: Vec3;
    dockEdge: Vec3;
    manifest: Vec3;
    supervisor: Vec3;
    scheduler: Vec3;
    schedulerDesk: Vec3;
    audit: Vec3;
    auditGate: Vec3;
  };
  floor: { spineX: number; transferY: number; riserX: number; conduitX: number };
  review: { entry: Vec3; seats: Record<"architecture" | "security" | "product", Vec3>; gate: Vec3; exit: Vec3; packetTable: Vec3 };
  human: { gate: Vec3; booth: Vec3; parked: Vec3 };
  /** The yard: revalidation gate and merge machine on the column; the main line runs along x across the plant's front. */
  integration: { entry: Vec3; gate: Vec3; merge: Vec3; mergeSpot: Vec3; trunkY: number; trunkFrom: number; trunkTo: number };
  archive: { cleanup: Vec3; cleanupSpot: Vec3; observe: Vec3; stack: Vec3 };
  /** Every track, named, in plan coordinates on plate tops. */
  tracks: Record<string, Vec3[]>;
  /** Bridges across the 56 pu aisles between regions. */
  bridges: PlanBox[];
  /** Overall plan extent (for the ground and camera fit). */
  extent: Rect;
}

const cache = new WeakMap<Fixture, PlantLayout>();

/** Slices in wave order with their tickets, from the fixture's definitions and intake events. */
function slots(fixture: Fixture): { sliceId: string; ticketId: string }[] {
  const ticketOf = new Map<string, string>();
  for (const e of fixture.events) if (e.type === "slice.materialized" && e.slice_id && e.ticket_id) ticketOf.set(e.slice_id, e.ticket_id);
  return Object.values(fixture.definitions.slices).map((s) => ({ sliceId: s.id, ticketId: ticketOf.get(s.id) ?? s.id }));
}

/**
 * The plant as a U (M6_0_VISUAL_SPEC.md b.2, pass 2): the back row flows along +x (intake, the
 * construction floor, the review chamber); the column drops along +y from the chamber through the
 * approval gatehouse into the integration yard, whose main line runs back along -x across the front
 * to the archive. Any plan rectangle projects to about 2:1, so a near-square plan fills the stage.
 */
export function plantLayout(fixture: Fixture): PlantLayout {
  const hit = cache.get(fixture);
  if (hit) return hit;
  const list = slots(fixture);
  const n = Math.max(1, list.length);
  // Columns of three (up to nine bays), then four.
  const rows = n <= 3 ? n : n <= 9 ? 3 : 4;
  const cols = Math.ceil(n / rows);
  const C = SIZE.cell;
  const W = 48 + cols * C.x + (cols - 1) * SIZE.aisle;
  const D = 48 + 40 + rows * C.y + (rows - 1) * SIZE.cellGap; // the extra 40 is the lettering strip
  const mid = D / 2;

  const intake: Rect = { x: 0, y: 0, w: 240, d: D };
  const floor: Rect = { x: intake.x + intake.w + GAP, y: 0, w: W, d: D };
  const review: Rect = { x: floor.x + W + GAP, y: 0, w: 220, d: 232 };
  const ry = review.y + 116;
  const cx = review.x + review.w - 30;
  const human: Rect = { x: review.x + 40, y: review.d + GAP, w: 180, d: 180 };
  const yardY = Math.max(D, human.y + human.d) + GAP;
  const integration: Rect = { x: floor.x + 120, y: yardY, w: review.x + review.w - floor.x - 120, d: 132 };
  const archive: Rect = { x: integration.x - 256, y: yardY, w: 200, d: 132 };
  const dock: Rect = { x: -72, y: mid - 40, w: 72, d: 80 };

  const spineX = floor.x + 12;
  const transferY = 24 + rows * C.y + (rows - 1) * SIZE.cellGap + 12;
  const riserX = floor.x + W - 12;
  const conduitX = floor.x + 4;

  const padY = (i: number) => mid + (i - (n - 1) / 2) * 56;
  const bays: BaySlot[] = list.map((s, index) => {
    const col = Math.floor(index / rows);
    const row = index % rows;
    const origin = { x: floor.x + 24 + col * (C.x + SIZE.aisle), y: 24 + row * (C.y + SIZE.cellGap) };
    const a = cellAnatomy(origin, PLATE_Z);
    const railY = origin.y + 58;
    const aisleX = col < cols - 1 ? origin.x + C.x + SIZE.aisle / 2 : riserX;
    return {
      ...s,
      index,
      col,
      row,
      origin,
      railY,
      entrance: { x: origin.x + 6, y: railY, z: FLOOR_Z },
      door: { ...a.door },
      gate: { x: origin.x + C.x + (col < cols - 1 ? 14 : 6), y: railY, z: PLATE_Z },
      aisleX,
      pads: a.pads,
      console: { x: origin.x + 16, y: origin.y + 26, z: FLOOR_Z },
      clerkSpot: { x: origin.x + 16, y: origin.y + 42, z: FLOOR_Z },
      pad: { x: 150, y: padY(index), z: PLATE_Z },
    };
  });

  const hopper = { x: 70, y: mid, z: PLATE_Z };
  const auditGate = { x: 226, y: mid, z: PLATE_Z };
  const entry = { x: review.x + 4, y: ry, z: PLATE_Z };
  const consensus = { x: review.x + 166, y: ry, z: PLATE_Z };
  const humanGate = { x: cx, y: human.y + human.d / 2, z: PLATE_Z };
  const mainY = yardY + 48;
  const ig = { x: cx, y: yardY + 14, z: PLATE_Z };
  const merge = { x: cx, y: mainY, z: PLATE_Z };
  const cleanup = { x: archive.x + 140, y: mainY, z: PLATE_Z };
  const observe = { x: archive.x + 60, y: mainY, z: PLATE_Z };

  const tracks: Record<string, Vec3[]> = {};
  const P = (x: number, y: number, z = PLATE_Z): Vec3 => ({ x, y, z });
  tracks.inbound = [P(dock.x + 6, mid), P(hopper.x - 22, mid)];
  tracks.outbound = [P(186, mid), P(floor.x + 12, mid)];
  tracks.collector = [P(186, padY(0)), P(186, padY(n - 1))];
  const firstRail = bays[0]?.railY ?? mid;
  const col0 = bays.filter((b) => b.col === 0);
  const lastRail = col0[col0.length - 1]?.railY ?? mid;
  tracks.spine = [P(spineX, Math.min(firstRail, mid)), P(spineX, Math.max(lastRail, mid))];
  for (const b of bays) {
    if (b.col === 0) tracks[`spur:${b.ticketId}`] = [P(spineX, b.railY), P(b.entrance.x, b.railY)];
    else {
      const prevAisle = b.origin.x - SIZE.aisle / 2;
      tracks[`spur:${b.ticketId}`] = [P(spineX, firstRail), P(spineX, 12), P(prevAisle, 12), P(prevAisle, b.railY), P(b.entrance.x, b.railY)];
    }
    tracks[`exit:${b.ticketId}`] = [P(b.door.x, b.railY), P(b.aisleX, b.railY)];
  }
  const aisles = [...new Set(bays.map((b) => b.aisleX))];
  for (const x of aisles) {
    const top = Math.min(...bays.filter((b) => b.aisleX === x).map((b) => b.railY));
    tracks[`aisle:${x}`] = [P(x, top), P(x, transferY)];
  }
  tracks.transfer = [P(Math.min(...aisles), transferY), P(riserX, transferY), P(riserX, ry), P(entry.x, ry)];
  // The column: out of the chamber, down through the gatehouse, into the yard to the merge machine.
  tracks.column = [P(consensus.x, ry), P(cx, ry), P(cx, human.y), P(cx, human.y + human.d), P(cx, merge.y - 22)];
  // The main line runs back along the front, over the bridge, and on through the archive.
  tracks.trunk = [P(cx - 22, mainY, PLATE_Z), P(integration.x + 10, mainY, PLATE_Z)];
  tracks.toArchive = [P(integration.x + 10, mainY), P(cleanup.x + 22, mainY)];

  const bridge = (x0: number, x1: number, y: number): PlanBox => ({ x: x0, y: y - 10, w: x1 - x0, d: 20, z: 0, h: PLATE_Z });
  const bridgeY = (x: number, y0: number, y1: number): PlanBox => ({ x: x - 10, y: y0, w: 20, d: y1 - y0, z: 0, h: PLATE_Z });
  const bridges: PlanBox[] = [
    bridge(intake.x + intake.w, floor.x, mid),
    bridge(floor.x + W, review.x, ry),
    bridgeY(cx, review.y + review.d, human.y),
    bridgeY(cx, human.y + human.d, yardY),
    bridge(archive.x + archive.w, integration.x, mainY),
    // The catwalk carrying the supervisor's conduit from intake to the floor.
    { x: intake.x + intake.w, y: 2, w: GAP, d: 10, z: 0, h: PLATE_Z },
  ];

  const layout: PlantLayout = {
    D,
    W,
    mid,
    ry,
    cx,
    regions: { intake, floor, review, human, integration, archive },
    dock,
    bays,
    freeBays: Array.from({ length: rows * cols - n }, (_, k) => {
      const index = n + k;
      return { x: floor.x + 24 + Math.floor(index / rows) * (C.x + SIZE.aisle), y: 24 + (index % rows) * (C.y + SIZE.cellGap), index };
    }),
    bayByTicket: new Map(bays.map((b) => [b.ticketId, b])),
    bayBySlice: new Map(bays.map((b) => [b.sliceId, b])),
    waveIds: Object.keys(fixture.definitions.waves),
    intake: {
      hopper,
      dockEdge: P(dock.x + 6, mid),
      manifest: P(dock.x + 30, mid + 4),
      supervisor: P(60, mid - 150),
      scheduler: P(70, mid + 50),
      schedulerDesk: P(40, mid + 50),
      audit: P(170, mid - 90),
      auditGate,
    },
    floor: { spineX, transferY, riserX, conduitX },
    review: {
      entry,
      // The three seats stand on one screen-horizontal line (equal x + y), so no seat is in front of
      // another and each reviewer's label under its disc is clear of its neighbours (see the report).
      seats: { architecture: P(review.x + 44, ry + 40), security: P(review.x + 84, ry), product: P(review.x + 124, ry - 40) },
      gate: consensus,
      exit: P(cx, ry),
      packetTable: P(review.x + 40, ry - 56),
    },
    human: { gate: humanGate, booth: P(human.x + 60, humanGate.y), parked: P(cx, humanGate.y - 44) },
    integration: { entry: P(cx, yardY + 4), gate: ig, merge, mergeSpot: P(cx - 30, mainY + 30), trunkY: mainY, trunkFrom: cx - 22, trunkTo: integration.x + 10 },
    archive: { cleanup, cleanupSpot: P(cleanup.x - 6, mainY + 34), observe, stack: P(archive.x + 104, mainY + 44) },
    tracks,
    bridges,
    extent: { x: dock.x - 96, y: -96, w: review.x + review.w + 96 - (dock.x - 96), d: yardY + 132 + 192 },
  };
  cache.set(fixture, layout);
  return layout;
}

/** Plan box for a point thing of a given footprint and height (for framing and brackets). */
export function boxAt(p: Vec3, w: number, d: number, h: number): PlanBox {
  return { x: p.x - w / 2, y: p.y - d / 2, w, d, z: p.z ?? 0, h };
}
