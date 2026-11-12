/**
 * Layer 7 (spec b.4, g: L3): never depth-sorted, never occluded. Selection brackets, the hover
 * outline and its label, the keyboard focus ring, agents' labels at near zoom, and callouts for
 * the beats a person must not miss (a failed verification, a rejected review, an outvoted blocker,
 * a person's gate, a dependency unlocking). Text is counter-scaled against the camera so it stays
 * legible at every zoom.
 *
 * Agent labels follow one deterministic rule, so they never collide with the next machine on the
 * rail: a label sits centred under its agent's floor disc (where the floor in front of a machine is
 * always clear), never beside the head; agents sharing a spot stack their labels in seat order.
 */
import { memo, type ReactNode } from "react";
import { Callout, SelectionBrackets, fc, modelTiers, project, round, screenBounds, type Lod, type PlanBox } from "@mach/ui";
import { refId, refKind, sceneAt, type EntityRef, type Scene } from "../sim";
import { useScene, useSceneStore } from "../scene";
import { useAtlas, usePlayheadKeyed } from "./context";
import { AFTERGLOW, animating, anim, fmtElapsed, chamberOccupant, latestGate, placeAgents, q, uiTier } from "./derive";
import { agentName } from "./Bay";
import { PLATE_Z, FLOOR_Z, boxAt, type PlantLayout } from "./layout";
import { locateScreen } from "./locate";

/** Text and callouts keep a readable size: scaled by 1/zoom, within limits. */
function Scaled({ x, y, k, children }: { x: number; y: number; k: number; children: ReactNode }) {
  return <g transform={`translate(${round(x)} ${round(y)}) scale(${round(k)})`}>{children}</g>;
}

function shortName(scene: Scene, entity: EntityRef): string {
  const id = refId(entity);
  switch (refKind(entity)) {
    case "cell":
      return `${id} · ${scene.cells[id]?.stage ?? ""}`;
    case "slice":
      return `${id} · ${scene.slices[id]?.scheduler ?? ""}`;
    case "gate":
      return id.replace("/", " · ");
    case "dependency":
      return id.replace("->", " waits for ");
    case "station":
      return id.replace("/", " · ");
    case "artifact":
      return id.split(":").slice(1).join(":");
    case "agent": {
      for (const c of Object.values(scene.cells)) {
        const a = c.agents[id];
        if (a) return `${a.label} · ${modelTiers[uiTier(a.model)].label}`;
      }
      return id;
    }
    default:
      return id;
  }
}

export interface OverlayProps {
  zoom: number;
  lod: Lod;
  focused: EntityRef | null;
  /** Theater Mode: no hover outlines or labels, no agent labels below near zoom (spec f.7). */
  theater?: boolean;
}

/** Text scale per zoom level (the inverse of a zoom near the level's lower bound, at least 0.9). */
const LEVEL_K: Record<Lod, number> = { far: 2.2, mid: 1.33, near: 0.9 };

export const Overlay = memo(function Overlay({ zoom, lod, focused, theater }: OverlayProps) {
  const { layout: L } = useAtlas();
  const t = usePlayheadKeyed((s) => {
    const now = s.playhead;
    if (animating(s.fixture, now, (e) => e.type === "verification.verdict" || e.type === "review.decided" || e.type === "human.approval_recorded" || e.type === "dependency.resolved")) return now;
    if (lod === "near" && animating(s.fixture, now, (e) => e.type === "agent.started" || e.type === "agent.finished")) return now;
    // At near zoom the agents' elapsed time is lettered: re-render as each second of it passes (lettered to the second below a minute, then to the minute).
    const elapsedKey = lod === "near" ? Math.floor(now / 1000) : 0;
    const occ = chamberOccupant(sceneAt(s.fixture, now), now);
    // Unlock callouts expire after their afterglow.
    const deps = Object.values(sceneAt(s.fixture, now).dependencies).filter((d) => d.satisfiedAt !== null && now - d.satisfiedAt <= AFTERGLOW * 3).length;
    return `${occ ? occ.cell.ticketId + occ.roundIndex : "-"}|${deps}|${elapsedKey}`;
  });
  const reduced = useSceneStore((s) => s.reducedMotion);
  const selection = useSceneStore((s) => s.selection);
  const hovered = useSceneStore((s) => s.hovered);
  const scene = useScene();
  const k = Math.min(2.4, Math.max(0.9, 1 / zoom));
  const sel = selection ? locateScreen(L, scene, t, selection) : null;
  const hov = hovered && hovered !== selection && !theater ? locateScreen(L, scene, t, hovered, 3) : null;
  const foc = focused ? locateScreen(L, scene, t, focused, 5) : null;
  return (
    <g>
      {lod === "near" ? <AgentLabels L={L} scene={scene} t={t} k={Math.min(1.1, LEVEL_K[lod])} /> : null}
      {/* Callouts and their obstacles use one scale per zoom level, so they never move while the camera moves within a level. */}
      <Callouts L={L} scene={scene} t={t} reduced={reduced} k={LEVEL_K[lod]} lod={lod} labelK={Math.min(1.1, LEVEL_K[lod])} />
      {hov && hovered ? (
        <g aria-hidden="true">
          <rect x={hov.x} y={hov.y} width={hov.width} height={hov.height} rx={3} style={{ fill: "none", stroke: "var(--mach-ink-muted)", strokeWidth: 0.9 / zoom, strokeDasharray: `${3 / zoom} ${2 / zoom}` }} />
          <Scaled x={hov.x} y={hov.y - 4 / zoom} k={k}>
            <text className="atlas-halo" style={{ fill: "var(--mach-ink)", fontSize: 11, fontWeight: 600 }}>
              {shortName(scene, hovered)}
            </text>
          </Scaled>
        </g>
      ) : null}
      {sel && selection ? (
        <g aria-hidden="true">
          <SelectionBrackets bounds={sel} pad={5} arm={Math.max(8, 10 / zoom)} />
          <Scaled x={sel.x - 5} y={sel.y - 10 / zoom} k={k}>
            <text className="atlas-halo" style={{ fill: fc("select"), fontSize: 10.5, fontWeight: 600 }}>
              {shortName(scene, selection)}
            </text>
          </Scaled>
        </g>
      ) : null}
      {foc ? <rect aria-hidden="true" x={foc.x} y={foc.y} width={foc.width} height={foc.height} rx={4} style={{ fill: "none", stroke: "var(--mach-focus)", strokeWidth: 2 / zoom }} /> : null}
    </g>
  );
});

/**
 * Agent labels (spec b.7, "Agent labels in the overlay"): two lines, role (sans 10 semibold) and tier
 * (sans 9 muted), 16 px under the floor disc. Agents sharing a machine stack under its agent spot,
 * ordered left to right on screen, 24 px apart, left-aligned on a common x, at most three and then
 * "+n more"; a stacked label more than 20 px from its disc gets a hairline leader. The tier line also
 * carries how long the agent has worked (known, never a fraction): our one addition to the rule.
 */
function AgentLabels({ L, scene, t, k }: { L: PlantLayout; scene: Scene; t: number; k: number }) {
  const groups = new Map<string, { base: { x: number; y: number }; a: ReturnType<typeof placeAgents>[number] }[]>();
  for (const cell of Object.values(scene.cells)) {
    for (const a of placeAgents(scene, L, cell, t, true)) {
      if (a.leave > 0.5) continue;
      const key = a.at.z === FLOOR_Z ? `${cell.ticketId}:${Math.round(a.at.x / 40)}:${Math.round(a.at.y)}` : `${a.agent.id}`;
      const list = groups.get(key) ?? [];
      list.push({ base: project(a.at), a });
      groups.set(key, list);
    }
  }
  const out: ReactNode[] = [];
  for (const [key, list] of groups) {
    list.sort((m, n) => m.base.x - n.base.x || m.a.agent.startedAt - n.a.agent.startedAt);
    const x0 = Math.min(...list.map((m) => m.base.x));
    const y0 = Math.max(...list.map((m) => m.base.y)) + 16 * k;
    const shown = list.slice(0, 3);
    const single = list.length === 1;
    shown.forEach(({ base, a }, i) => {
      const lx = single ? base.x : x0 - 6 * k;
      const ly = single ? base.y + 16 * k : y0 + i * 24 * k;
      const far = Math.hypot(lx - base.x, ly - base.y) > 20 * k;
      out.push(
        <g key={a.agent.id}>
          {!single && far ? <line x1={base.x} y1={base.y + 3 * k} x2={lx} y2={ly - 9 * k} style={{ stroke: fc("plate-edge"), strokeWidth: 0.75 * k }} /> : null}
          <Scaled x={lx} y={ly} k={k}>
            <text textAnchor={single ? "middle" : "start"} className="atlas-halo" style={{ fill: "var(--mach-ink)", fontSize: 10, fontWeight: 600 }}>
              {agentName(a)}
            </text>
            <text y={11} textAnchor={single ? "middle" : "start"} className="atlas-halo" style={{ fill: "var(--mach-ink-muted)", fontSize: 9 }}>
              {`${modelTiers[uiTier(a.agent.model)].label}${a.state === "active" ? ` · ${fmtElapsed(a.elapsed)}` : ""}`}
            </text>
          </Scaled>
        </g>,
      );
    });
    if (list.length > 3) {
      out.push(
        <Scaled key={`${key}-more`} x={x0 - 6 * k} y={y0 + 3 * 24 * k} k={k}>
          <text className="atlas-halo" style={{ fill: "var(--mach-ink-muted)", fontSize: 9 }}>{`+${list.length - 3} more`}</text>
        </Scaled>,
      );
    }
  }
  return <g aria-hidden="true">{out}</g>;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const hits = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** What a callout must not cover: machines, gates and agents (with their labels at near zoom), in projected units. */
function obstacles(L: PlantLayout, scene: Scene, t: number, lod: Lod, labelK: number): Box[] {
  const out: Box[] = [];
  const add = (b: PlanBox) => {
    const r = screenBounds([b]);
    out.push({ x0: r.x, y0: r.y, x1: r.x + r.width, y1: r.y + r.height });
  };
  for (const bay of L.bays) {
    if (!scene.cells[bay.ticketId]) continue;
    add(boxAt(bay.pads.intent, 40, 40, 14));
    add(boxAt(bay.pads.build, 40, 40, 24));
    add(boxAt(bay.pads.verify, 40, 40, 20));
    add(boxAt(bay.gate, 8, 46, 36));
  }
  for (const p of [L.review.gate, L.human.gate, L.integration.gate, L.integration.merge, L.intake.auditGate, L.intake.hopper]) add(boxAt(p, 40, 40, 40));
  for (const cell of Object.values(scene.cells)) {
    for (const a of placeAgents(scene, L, cell, t, true)) {
      if (a.leave > 0.5) continue;
      add(boxAt(a.at, 18, 18, 34));
      if (lod === "near") {
        const base = project(a.at);
        const w = 130 * labelK;
        const y = base.y + 16 * labelK + a.stack * 24 * labelK;
        out.push({ x0: base.x - w / 2, y0: y - 10 * labelK, x1: base.x + w / 2, y1: y + 14 * labelK });
      }
    }
  }
  return out;
}

/**
 * Callouts (spec b.7, "Callout placement"), deterministic: placed in priority order (escalation,
 * failure, waiting for a person, then the event under the playhead); for each, try leader directions
 * up-right (45°), up-left, right, left, down-right, down-left, with leader lengths 36 then 64 px, and
 * take the first whose leader and label box (6.2 px per character, two lines 30 px tall, 4 px padding)
 * meet no machine, gate, agent, agent label or callout already placed; if none is clear, up-right at
 * 64 px. Sizes are in screen px at the zoom level's own scale, so a callout never moves while the
 * camera moves within a level.
 */
type Priority = 0 | 1 | 2 | 3;
interface Pending {
  key: string;
  at: { x: number; y: number; z?: number };
  text: string;
  detail: string | undefined;
  tone: "ink" | "fail" | "human" | "select";
  opacity: number;
  priority: Priority;
}
const DIRECTIONS: Array<[number, number]> = [
  [Math.SQRT1_2, -Math.SQRT1_2],
  [-Math.SQRT1_2, -Math.SQRT1_2],
  [1, 0],
  [-1, 0],
  [Math.SQRT1_2, Math.SQRT1_2],
  [-Math.SQRT1_2, Math.SQRT1_2],
];

function Callouts({ L, scene, t, reduced, k, lod, labelK }: { L: PlantLayout; scene: Scene; t: number; reduced: boolean; k: number; lod: Lod; labelK: number }) {
  const pending: Pending[] = [];
  const put = (key: string, at: Pending["at"], text: string, detail: string | undefined, tone: Pending["tone"], opacity = 1, priority: Priority = 3) => {
    pending.push({ key, at, text, detail, tone, opacity, priority });
  };
  if (lod !== "far") {
    // Verification failed: at the verdict gate, until the next verification starts.
    for (const cell of Object.values(scene.cells)) {
      const v = cell.verifications[cell.verifications.length - 1];
      const bay = L.bayByTicket.get(cell.ticketId);
      if (!v || !bay || v.status !== "FAIL_WITH_EVIDENCE" || v.decidedAt === null) continue;
      const failed = v.checks.filter((c) => c.result === "fail");
      put(`vf-${cell.ticketId}`, { ...bay.gate, z: PLATE_Z + 36 }, `Verification failed · ${failed.map((c) => c.targetId).join(", ")}`, `${v.checks.length - failed.length} of ${v.checks.length} proven; back to build, round ${v.round + 1} of 3`, "fail", q(anim("stateChange", t - v.decidedAt, reduced)), 1);
    }
  }
  // The chamber: a rejection, an outvoted blocker.
  const occ = chamberOccupant(scene, t);
  const r = occ ? occ.cell.reviews[occ.roundIndex] : undefined;
  if (occ && r && r.decidedAt !== null) {
    const op = q(anim("stateChange", t - r.decidedAt, reduced));
    if (r.outcome === "REJECTED") {
      const b = r.findings.find((f) => f.severity === "blocker");
      put(`rej-${occ.cell.ticketId}`, { ...L.review.gate, z: PLATE_Z + 40 }, `Rejected · ${b?.seat ?? ""} blocker ${b?.rule ?? ""}`, b ? trim(b.title, 58) : undefined, "fail", op, 1);
    } else {
      put(`dec-${occ.cell.ticketId}`, { ...L.review.gate, z: PLATE_Z + 40 }, `${r.outcome === "AWAITING_HUMAN" ? "Passed panel · needs a person" : "Approved"} · ${r.approvals} of ${r.seats.length}`, `${occ.cell.ticketId}, round ${r.round}${r.delta ? ", delta review" : ""}`, r.outcome === "AWAITING_HUMAN" ? "human" : "ink", op);
    }
    for (const f of r.findings.filter((x) => x.outvoted)) {
      if (f.seat === "general") continue;
      put(`out-${f.id}`, { ...L.review.seats[f.seat], z: PLATE_Z + 14 }, `Blocker outvoted · ${f.seat} seat ${f.rule ?? ""}`, `${trim(f.title, 50)} (reported, not hidden)`, "fail", op, 1);
    }
  }
  // The person's gate: held (still, no pulsing), then released by name.
  const hg = latestGate(scene, "human-approval");
  if (hg) {
    const cell = scene.cells[hg.ticketId];
    const at = { ...L.human.gate, z: PLATE_Z + 50 };
    if (hg.state === "waiting") {
      const reasons = cell?.reviews[cell.reviews.length - 1]?.humanApprovalReasons ?? [];
      put("hw", at, `${hg.ticketId} waits for a person`, reasons.length ? `Because ${reasons.join("; ")}` : "Human approval required", "human", 1, 2);
    } else if (hg.state === "passed" && hg.decidedAt !== null && !(cell?.archived)) {
      const by = cell?.reviews.find((x) => x.humanApproval)?.humanApproval?.by ?? "a person";
      put("ha", at, `Approved by ${by}`, `${hg.ticketId} released to merge`, "human", q(anim("humanRelease", t - hg.decidedAt, reduced)));
    }
  }
  // A dependency unlocking: the waiting slice becomes eligible.
  if (lod !== "far") {
    for (const d of Object.values(scene.dependencies)) {
      if (d.state !== "satisfied" || d.satisfiedAt === null || t - d.satisfiedAt > AFTERGLOW * 3) continue;
      const bay = L.bayBySlice.get(d.from);
      if (!bay) continue;
      const anchor = scene.cells[bay.ticketId] ? { x: bay.origin.x + 30, y: bay.origin.y + 74, z: FLOOR_Z + 30 } : { ...bay.pad, z: PLATE_Z + 20 };
      const still = Object.values(scene.dependencies).filter((o) => o.from === d.from && o.state === "blocking").map((o) => o.to);
      const text = still.length ? `${d.to} done · ${d.from} still waits` : `${d.from} unblocked`;
      const detail = still.length ? `${d.to} integrated; ${d.from} waits for ${still.join(", ")}` : `${d.to} integrated; ${d.from} is eligible`;
      put(`dep-${d.id}`, anchor, text, detail, still.length ? "ink" : "ink", q(anim("dependencyUnlock", t - d.satisfiedAt, reduced)));
    }
  }
  const blocked = lod === "far" ? [] : obstacles(L, scene, t, lod, labelK);
  const pad = 4 * k;
  const out: ReactNode[] = [];
  for (const c of [...pending].sort((a, b) => a.priority - b.priority)) {
    const p = project(c.at);
    const width = Math.max(c.text.length, c.detail?.length ?? 0) * 6.2 + 18;
    let chosen: [number, number] = [64 * Math.SQRT1_2, -64 * Math.SQRT1_2];
    let chosenBox: Box | null = null;
    search: for (const len of [36, 64]) {
      for (const [ux, uy] of DIRECTIONS) {
        const dx = ux * len;
        const dy = uy * len;
        const ex = p.x + dx * k;
        const ey = p.y + dy * k;
        const left = dx < -0.01;
        const box: Box = { x0: (left ? ex - width * k : ex) - pad, y0: ey - 12 * k - pad, x1: (left ? ex : ex + width * k) + pad, y1: ey + 18 * k + pad };
        const leader: Box = { x0: Math.min(p.x, ex), y0: Math.min(p.y, ey), x1: Math.max(p.x, ex), y1: Math.max(p.y, ey) };
        if (!blocked.some((o) => hits(o, box) || (Math.abs(dx) > 1 && Math.abs(dy) > 1 && hits(o, shrink(leader, 6 * k))))) {
          chosen = [dx, dy];
          chosenBox = box;
          break search;
        }
      }
    }
    if (!chosenBox) chosenBox = { x0: p.x, y0: p.y - 60 * k, x1: p.x + width * k + 60 * k, y1: p.y };
    blocked.push(chosenBox);
    out.push(
      <g key={c.key} style={{ opacity: c.opacity }}>
        <Scaled x={p.x} y={p.y} k={k}>
          <g className="atlas-halo-group">
            <Callout x={0} y={0} dx={chosen[0]} dy={chosen[1]} text={c.text} detail={c.detail} tone={c.tone} />
          </g>
        </Scaled>
      </g>,
    );
  }
  return <g aria-hidden="true">{out}</g>;
}

function shrink(b: Box, by: number): Box {
  return { x0: b.x0 + by, y0: b.y0 + by, x1: b.x1 - by, y1: b.y1 - by };
}

function trim(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
