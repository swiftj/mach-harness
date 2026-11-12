/**
 * Layer 6 of spec b.4, things that belong to the air and to travel: dependency cables between
 * slices, the review's return-to-build loop over the plant, work in transit (packets and handed
 * artifacts, each for one named event), work parked at a station outside its bay, escalation
 * risers, and the supervisor's conduits lit for each running execution.
 */
import { ArtifactCard, DependencyLink, Escalation, Packet, RetryLoop, RoutePath, fc, pointAlong, project, round, type Vec3 } from "@mach/ui";
import { ref, type CellState } from "../sim";
import { useScene, useSceneStore } from "../scene";
import { Hit, isDimmed, useAtlas, useHighlight, usePlayheadKeyed } from "./context";
import { animating, anim, legsInFlight, onFloor, q, workStation } from "./derive";
import { FLOOR_Z, PLATE_Z, type PlantLayout } from "./layout";
import { conduitPath } from "./Plant";

function sliceAnchor(L: PlantLayout, cells: Readonly<Record<string, CellState>>, sliceId: string): Vec3 | null {
  const bay = L.bayBySlice.get(sliceId);
  if (!bay) return null;
  if (cells[bay.ticketId]) return { x: bay.origin.x + 30, y: bay.origin.y + 74, z: FLOOR_Z + 14 };
  return { ...bay.pad, x: bay.pad.x + 6, z: PLATE_Z + 4 };
}

export function Dependencies() {
  const { layout: L } = useAtlas();
  const t = usePlayheadKeyed((s) => (animating(s.fixture, s.playhead, (e) => e.type === "dependency.resolved" || e.type === "slice.integrated") ? s.playhead : "settled"));
  const reduced = useSceneStore((s) => s.reducedMotion);
  const deps = useScene((s) => s.dependencies);
  const cells = useScene((s) => s.cells);
  const highlight = useHighlight();
  return (
    <g>
      {Object.values(deps).map((d) => {
        const from = sliceAnchor(L, cells, d.to);
        const to = sliceAnchor(L, cells, d.from);
        if (!from || !to) return null;
        const dref = ref.dependency(d.from, d.to);
        const p = d.state === "satisfied" && d.satisfiedAt !== null ? q(anim("dependencyUnlock", t - d.satisfiedAt, reduced)) : 0;
        const lift = 40 + Math.min(40, Math.hypot(from.x - to.x, from.y - to.y) * 0.08);
        return (
          <Hit key={d.id} entity={dref} label={`Dependency: ${d.from} waits for ${d.to}, ${d.state}`}>
            <DependencyLink from={from} to={to} state={d.state} progress={p} lift={lift} highlighted={highlight.has(dref)} dimmed={isDimmed(highlight, dref)} />
          </Hit>
        );
      })}
    </g>
  );
}

export function Transit() {
  const { layout: L, lod } = useAtlas();
  const fixture = useSceneStore((s) => s.fixture);
  const t = usePlayheadKeyed((s) => {
    const now = s.playhead;
    if (legsInFlight(s.fixture, now, s.reducedMotion).length > 0) return now;
    return animating(s.fixture, now, (e) => e.type === "review.decided" || e.type === "build.revised") ? now : "settled";
  });
  const reduced = useSceneStore((s) => s.reducedMotion);
  const cells = useScene((s) => s.cells);
  const highlight = useHighlight();
  const legs = legsInFlight(fixture, t, reduced);
  const moving = new Set(legs.filter((l) => l.leg.kind === "travel" || l.leg.kind === "return" || l.leg.kind === "integrate").map((l) => l.leg.ticketId));

  // Work parked at a station outside its bay: a carriage standing still, no motion.
  const parked: { ticket: string; at: Vec3; state: "active" | "human"; angle: number }[] = [];
  for (const cell of Object.values(cells)) {
    if (moving.has(cell.ticketId) || cell.archived) continue;
    const st = workStation(cell);
    if (onFloor(st) || st === "cleanup") continue;
    if (st === "review") parked.push({ ticket: cell.ticketId, at: { ...L.review.entry, x: L.review.entry.x + 18 }, state: "active", angle: 0 });
    else if (st === "human-approval") parked.push({ ticket: cell.ticketId, at: L.human.parked, state: "human", angle: 0 });
    else if (st === "merge" && !cell.merged) parked.push({ ticket: cell.ticketId, at: L.integration.entry, state: "active", angle: 0 });
  }

  // The review's return to build: one arc over the plant per rejected round, until the next review starts.
  const returns = Object.values(cells).flatMap((cell) => {
    const bay = L.bayByTicket.get(cell.ticketId);
    if (!bay) return [];
    let i = -1;
    cell.reviews.forEach((r, k) => {
      if (r.outcome === "REJECTED" && r.decidedAt !== null) i = k;
    });
    if (i < 0 || i < cell.reviews.length - 1) return [];
    const r = cell.reviews[i]!;
    return [{ cell, bay, r, p: q(anim("verifyReturn", t - (r.decidedAt as number), reduced)) }];
  });

  return (
    <g>
      {returns.map(({ cell, bay, r, p }) => (
        <g key={`ret-${cell.ticketId}`} style={{ opacity: isDimmed(highlight, ref.cell(cell.ticketId)) ? 0.28 : 1 }}>
          <RetryLoop from={L.review.entry} to={{ ...bay.pads.build, z: FLOOR_Z }} round={r.round + 1} progress={p} lift={92} lod={lod} />
        </g>
      ))}
      {legs.map(({ leg, p }) => {
        const pos = pointAlong(leg.route, p);
        const dim = isDimmed(highlight, ref.cell(leg.ticketId), ref.wave(leg.ticketId));
        const name = `${leg.label}`;
        if (leg.card) {
          return (
            <g key={leg.id} role="img" aria-label={name} style={{ opacity: dim ? 0.28 : 1 }}>
              <RoutePath points={leg.route} kind="handoff" state="active" progress={1} />
              <ArtifactCard kind={leg.card} state="active" at={pos.point} lod={lod} showLabel={false} />
            </g>
          );
        }
        return (
          <g key={leg.id} role="img" aria-label={name} style={{ opacity: dim ? 0.28 : 1 }}>
            {leg.kind !== "return" ? <RoutePath points={leg.route} state={leg.state === "succeeded" ? "succeeded" : "active"} progress={1} lod={lod} chevrons={false} /> : null}
            <Packet at={pos.point} angle={pos.angle} state={leg.state} ticket={leg.ticketId} lod={lod} />
          </g>
        );
      })}
      {parked.map((k) => (
        <g key={`park-${k.ticket}`} style={{ opacity: isDimmed(highlight, ref.cell(k.ticket)) ? 0.28 : 1 }}>
          <Hit entity={ref.cell(k.ticket)} label={`${k.ticket}'s work, at ${k.state === "human" ? "the approval gate, waiting for a person" : "its station"}`}>
            <Packet at={k.at} angle={k.angle} state={k.state} ticket={k.ticket} lod={lod} />
          </Hit>
        </g>
      ))}
      {Object.values(cells)
        .filter((c) => c.stage === "blocked")
        .map((c) => {
          const bay = L.bayByTicket.get(c.ticketId);
          const at = c.stageHistory[c.stageHistory.length - 1]?.at ?? t;
          return bay ? <Escalation key={`esc-${c.ticketId}`} from={{ x: bay.origin.x + 10, y: bay.origin.y + 10, z: FLOOR_Z + 34 }} progress={q(anim("verifyReturn", t - at, reduced))} label={`${c.ticketId} escalated: blocked-requires-sme`} /> : null;
        })}
    </g>
  );
}

/** The supervisor's conduit lit, from its console to each bay with a running execution. */
export function LiveConduits() {
  const { layout: L } = useAtlas();
  const executions = useScene((s) => s.executions);
  const running = new Set(Object.values(executions).filter((e) => e.state === "running" || e.state === "claimed").map((e) => e.ticketId));
  if (running.size === 0) return null;
  const base = conduitPath(L);
  return (
    <g aria-hidden="true">
      {[...running].map((ticket) => {
        const bay = L.bayByTicket.get(ticket);
        if (!bay) return null;
        const tapY = bay.origin.y + 10;
        // Along the back catwalk to the bay's column, then down its left wall to the mast.
        const pts: Vec3[] =
          bay.col === 0
            ? [...base.slice(0, 3), { x: L.floor.conduitX, y: tapY, z: PLATE_Z + 1 }, { x: bay.origin.x + 2, y: tapY, z: FLOOR_Z + 2 }]
            : [...base.slice(0, 2), { x: bay.origin.x - 6, y: 7, z: PLATE_Z + 1 }, { x: bay.origin.x - 6, y: tapY, z: PLATE_Z + 1 }, { x: bay.origin.x + 2, y: tapY, z: FLOOR_Z + 2 }];
        const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${round(project(p).x)} ${round(project(p).y)}`).join("");
        return <path key={ticket} d={d} style={{ fill: "none", stroke: fc("live"), strokeWidth: 0.9, strokeLinejoin: "round", opacity: 0.85 }} />;
      })}
    </g>
  );
}
