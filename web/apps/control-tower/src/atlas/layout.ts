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
 * The plant is composed as a U so it projects compactly (any plan rectangle projects to a 2:1 box,
 * so a near-square plan fills the viewport): the back row flows along +x (intake, the construction
 * floor, the review chamber); the chamber drops along +y through the approval gatehouse into the
 * integration yard, whose main line runs along the whole front of the plant to the archive corner.
 */
export function plantLayout(fixture: Fixture): PlantLayout {
  const hit = cache.get(fixture);
  if (hit) return hit;
  const list = slots(fixture);
  const n = Math.max(1, list.length);
  // Bays fill columns of up to 4 rows; five or more slices use two columns so the floor stays square.
  const rows = n <= 4 ? n : Math.min(4, Math.ceil(n / 2));
  const cols = Math.ceil(n / rows);
  const C = SIZE.cell;
  const W = 48 + cols * C.x + (cols - 1) * SIZE.aisle;
  const D = 48 + rows * C.y + (rows - 1) * SIZE.cellGap;
  const mid = D / 2;

  const intake: Rect = { x: 0, y: 0, w: 240, d: D };
  const floor: Rect = { x: intake.x + intake.w + GAP, y: 0, w: W, d: D };
  const review: Rect = { x: floor.x + W + GAP, y: 0, w: 220, d: 220 };
  const ry = review.y + review.d / 2;
  const cx = review.x + review.w - 24;
  const human: Rect = { x: review.x + 50, y: review.y + review.d + GAP, w: 170, d: 170 };
  const yardY = Math.max(D, human.y + human.d) + GAP;
  // A compact yard under the chamber's column, the archive corner at the main line's far end.
  const integration: Rect = { x: review.x + review.w - 560, y: yardY, w: 560, d: 132 };
  const archive: Rect = { x: integration.x - GAP - 200, y: yardY, w: 200, d: 132 };
  const dock: Rect = { x: -72, y: mid - 40, w: 72, d: 80 };

  const spineX = floor.x + 12;
  const transferY = D - 12;
  const riserX = floor.x + W - 12;
  const conduitX = floor.x + 4;

  const padY = (i: number) => mid + (i - (n - 1) / 2) * 56;
  const bays: BaySlot[] = list.map((s, index) => {
    const col = Math.floor(index / rows);
    const row = index % rows;
    const origin = { x: floor.x + 24 + col * (C.x + SIZE.aisle), y: 24 + row * (C.y + SIZE.cellGap) };
    const a = cellAnatomy(origin, PLATE_Z);
    const railY = origin.y + 58;
    const door = { ...a.door };
    const aisleX = col < cols - 1 ? origin.x + C.x + SIZE.aisle / 2 : riserX;
    return {
      ...s,
      index,
      col,
      row,
      origin,
      railY,
      entrance: { x: origin.x + 6, y: railY, z: FLOOR_Z },
      door,
      gate: { x: origin.x + C.x + (col < cols - 1 ? 14 : 6), y: railY, z: PLATE_Z },
      aisleX,
      pads: a.pads,
      console: { x: origin.x + 16, y: origin.y + 26, z: FLOOR_Z },
      clerkSpot: { x: origin.x + 16, y: origin.y + 42, z: FLOOR_Z },
      pad: { x: 150, y: padY(index), z: PLATE_Z },
    };
  });

  const hopper = { x: 60, y: mid, z: PLATE_Z };
  const auditGate = { x: 236, y: mid, z: PLATE_Z };
  const entry = { x: review.x + 4, y: ry, z: PLATE_Z };
  const consensus = { x: review.x + 190, y: ry, z: PLATE_Z };
  const humanGate = { x: cx, y: human.y + human.d - 52, z: PLATE_Z };
  const ig = { x: cx, y: yardY + 20, z: PLATE_Z };
  const merge = { x: cx, y: yardY + 58, z: PLATE_Z };
  const trunkY = yardY + integration.d - 22;
  const cleanup = { x: archive.x + 64, y: merge.y, z: PLATE_Z };

  const tracks: Record<string, Vec3[]> = {};
  const P = (x: number, y: number, z = PLATE_Z): Vec3 => ({ x, y, z });
  // The wave comes in over the dock to the hopper.
  tracks.inbound = [P(dock.x + 6, mid), P(hopper.x - 22, mid)];
  // Out of intake: through the audit gate, over the bridge, to the floor's spine.
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
  // Aisles run toward the viewer to the front transfer, which carries work to the riser and the chamber.
  const aisles = [...new Set(bays.map((b) => b.aisleX))];
  for (const x of aisles) {
    const top = Math.min(...bays.filter((b) => b.aisleX === x).map((b) => b.railY));
    tracks[`aisle:${x}`] = [P(x, top), P(x, transferY)];
  }
  tracks.transfer = [P(Math.min(...aisles), transferY), P(riserX, transferY), P(riserX, ry), P(entry.x, ry)];
  // The column: out of the chamber, down through the gatehouse, into the yard to the merge machine.
  tracks.column = [P(consensus.x, ry), P(cx, ry), P(cx, human.y), P(cx, human.y + human.d), P(cx, merge.y - 22)];
  tracks.toTrunk = [P(cx, merge.y + 22), P(cx, trunkY, PLATE_Z - 6)];
  // The main line: the integration branch, running along the whole front of the plant.
  tracks.trunk = [P(cx + 12, trunkY, PLATE_Z - 6), P(integration.x + 14, trunkY, PLATE_Z - 6)];
  // The service track: finished cells to cleanup and the archive.
  tracks.toArchive = [P(cx - 22, merge.y), P(cleanup.x + 22, merge.y)];

  const bridge = (x0: number, x1: number, y: number): PlanBox => ({ x: x0, y: y - 10, w: x1 - x0, d: 20, z: 0, h: PLATE_Z });
  const bridgeY = (x: number, y0: number, y1: number): PlanBox => ({ x: x - 10, y: y0, w: 20, d: y1 - y0, z: 0, h: PLATE_Z });
  const bridges: PlanBox[] = [
    bridge(intake.x + intake.w, floor.x, mid),
    bridge(floor.x + W, review.x, ry),
    bridgeY(cx, review.y + review.d, human.y),
    bridgeY(cx, human.y + human.d, yardY),
    bridge(archive.x + archive.w, integration.x, merge.y),
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
      supervisor: P(60, mid - 92),
      scheduler: P(96, mid + 64),
      schedulerDesk: P(66, mid + 64),
      audit: P(196, mid - 64),
      auditGate,
    },
    floor: { spineX, transferY, riserX, conduitX },
    review: {
      entry,
      // The three seats stand on one screen-horizontal line (equal x + y), so no seat is in front of another
      // and each reviewer's label under its disc is clear of its neighbours.
      seats: { architecture: P(review.x + 52, ry + 42), security: P(review.x + 94, ry), product: P(review.x + 136, ry - 42) },
      gate: consensus,
      exit: P(cx, ry),
      packetTable: P(review.x + 40, ry - 46),
    },
    human: { gate: humanGate, booth: P(human.x + 46, humanGate.y - 34), parked: P(cx, humanGate.y - 42) },
    integration: { entry: P(cx, yardY + 4), gate: ig, merge, mergeSpot: P(cx - 36, merge.y + 8), trunkY, trunkFrom: cx + 12, trunkTo: integration.x + 14 },
    archive: { cleanup, cleanupSpot: P(cleanup.x + 8, cleanup.y + 36), observe: P(archive.x + 150, yardY + 30), stack: P(archive.x + 140, yardY + 104) },
    tracks,
    bridges,
    extent: { x: dock.x - 40, y: -50, w: review.x + review.w + 40 - (dock.x - 40), d: yardY + 132 + 60 },
  };
  cache.set(fixture, layout);
  return layout;
}

/** Plan box for a point thing of a given footprint and height (for framing and brackets). */
export function boxAt(p: Vec3, w: number, d: number, h: number): PlanBox {
  return { x: p.x - w / 2, y: p.y - d / 2, w, d, z: p.z ?? 0, h };
}
