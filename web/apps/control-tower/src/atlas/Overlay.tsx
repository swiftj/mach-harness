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
import { AFTERGLOW, agentsElapsedKey, animating, anim, fmtElapsed, chamberOccupant, latestGate, placeAgents, q, uiTier } from "./derive";
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

/** The stage as seen by the camera, in projected units, inset by the sheet's margin; what callouts must stay inside. */
export interface OverlayView {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** The camera toolbar in the stage's corner, which callouts must not sit under. */
  controls: { x0: number; y0: number; x1: number; y1: number } | null;
}

export interface OverlayProps {
  zoom: number;
  lod: Lod;
  focused: EntityRef | null;
  /** Theater Mode: no hover outlines or labels, no agent labels below near zoom (spec f.7). */
  theater?: boolean;
  /** The visible stage (quantised by the view), so callouts and labels are kept inside it. */
  view?: OverlayView | null;
}

/** Text scale per zoom level (the inverse of a zoom near the level's lower bound, at least 0.9). */
const LEVEL_K: Record<Lod, number> = { far: 2.2, mid: 1.33, near: 0.9 };

export const Overlay = memo(function Overlay({ zoom, lod, focused, theater, view }: OverlayProps) {
  const { layout: L } = useAtlas();
  const t = usePlayheadKeyed((s) => {
    const now = s.playhead;
    if (animating(s.fixture, now, (e) => e.type === "verification.verdict" || e.type === "review.decided" || e.type === "human.approval_recorded" || e.type === "dependency.resolved")) return now;
    if (lod === "near" && animating(s.fixture, now, (e) => e.type === "agent.started" || e.type === "agent.finished")) return now;
    const scene = sceneAt(s.fixture, now);
    // At near zoom the agents' elapsed time is lettered: re-render exactly when one of them changes
    // (keyed on each agent's own elapsed second, not the playhead's, so no route can leave it stale).
    const elapsedKey = lod === "near" ? agentsElapsedKey(scene, now) : "";
    const occ = chamberOccupant(scene, now);
    // Unlock callouts expire after their afterglow.
    const deps = Object.values(scene.dependencies).filter((d) => d.satisfiedAt !== null && now - d.satisfiedAt <= AFTERGLOW * 3).length;
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
  const labelK = Math.min(1.1, LEVEL_K[lod]);
  // One placement pass, in priority order: agent labels, then callouts (clear of the labels), then the
  // selection's own label (clear of both). Every box is in projected units.
  const labels = lod === "near" ? agentLabels(L, scene, t, labelK) : { nodes: [], boxes: [] };
  const callouts = layoutCallouts(L, scene, t, reduced, LEVEL_K[lod], lod, labels.boxes, view ?? null);
  const selText = sel && selection ? shortName(scene, selection) : "";
  const selLabel = sel && selection ? placeSelectionLabel(sel, selText, k, zoom, [...callouts.obstacles, ...callouts.boxes], view ?? null) : null;
  return (
    <g>
      {labels.nodes.length ? <g aria-hidden="true">{labels.nodes}</g> : null}
      {/* Callouts and their obstacles use one scale per zoom level, so they never move while the camera moves within a level. */}
      <g aria-hidden="true">{callouts.nodes}</g>
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
      {sel && selection && selLabel ? (
        <g aria-hidden="true">
          <SelectionBrackets bounds={sel} pad={5} arm={Math.max(8, 10 / zoom)} />
          <Scaled x={selLabel.x} y={selLabel.y} k={k}>
            <rect className="atlas-chip" x={-3} y={-10.5} width={selLabel.w + 6} height={14} rx={2} />
            <text className="atlas-halo" style={{ fill: fc("select"), fontSize: 10.5, fontWeight: 600 }}>
              {selText}
            </text>
          </Scaled>
        </g>
      ) : null}
      {foc ? <rect aria-hidden="true" x={foc.x} y={foc.y} width={foc.width} height={foc.height} rx={4} style={{ fill: "none", stroke: "var(--mach-focus)", strokeWidth: 2 / zoom }} /> : null}
    </g>
  );
});

/**
 * The selection's label: above its brackets at the left by default; if that would cover an agent, a
 * label, a callout, a machine or a findings flag, or leave the stage, below them, then right-aligned
 * above, then right-aligned below (findings D7). Deterministic, and only a function of what is drawn.
 */
function placeSelectionLabel(sel: { x: number; y: number; width: number; height: number }, text: string, k: number, zoom: number, obstacles: Box[], view: OverlayView | null): { x: number; y: number; w: number } {
  const w = text.length * 6.2;
  const cx = sel.x + sel.width / 2;
  const cy = sel.y + sel.height / 2;
  // Obstacles that are the selected thing itself (its own machine or gate box) do not count.
  const others = obstacles.filter((o) => !(o.x0 <= cx && cx <= o.x1 && o.y0 <= cy && cy <= o.y1));
  const above = sel.y - 10 / zoom;
  const below = sel.y + sel.height + 8 / zoom + 10.5 * k;
  const left = sel.x - 5;
  const right = sel.x + sel.width + 5 - w * k;
  // Slid along its line to stay on the stage when the selection sits at an edge.
  const clampX = (x: number) => (view ? Math.max(view.x0 + 3 * k, Math.min(view.x1 - (w + 3) * k, x)) : x);
  const candidates: Array<[number, number]> = [
    [clampX(left), above],
    [clampX(left), below],
    [clampX(right), above],
    [clampX(right), below],
  ];
  const boxOf = ([x, y]: [number, number]): Box => ({ x0: x - 3 * k, y0: y - 11 * k, x1: x + (w + 3) * k, y1: y + 4 * k });
  const fits = (b: Box) => !view || inside(b, view);
  const pick = candidates.find((c) => fits(boxOf(c)) && !others.some((o) => hits(o, boxOf(c)))) ?? candidates.find((c) => fits(boxOf(c))) ?? candidates[0]!;
  return { x: pick[0], y: pick[1], w };
}

/**
 * Agent labels (spec b.7, "Agent labels in the overlay"): two lines, role (sans 10 semibold) and tier
 * (sans 9 muted), 16 px under the floor disc. Agents sharing a machine stack under its agent spot,
 * ordered left to right on screen, 24 px apart, left-aligned on a common x, at most three and then
 * "+n more"; a stacked label more than 20 px from its disc gets a hairline leader. The tier line also
 * carries how long the agent has worked (known, never a fraction): our one addition to the rule. Each
 * label sits on a ground-coloured chip, so a post, a gate or a route behind it cannot strike through
 * its text (findings D7). Returns the drawn labels and their boxes, for the callouts to avoid.
 */
function agentLabels(L: PlantLayout, scene: Scene, t: number, k: number): { nodes: ReactNode[]; boxes: Box[] } {
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
  const boxes: Box[] = [];
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
      const name = agentName(a);
      const tier = `${modelTiers[uiTier(a.agent.model)].label}${a.state === "active" ? ` · ${fmtElapsed(a.elapsed)}` : ""}`;
      const w = Math.max(name.length * 6, tier.length * 5.2);
      const left = single ? -w / 2 : 0;
      boxes.push({ x0: lx + (left - 3) * k, y0: ly - 10.5 * k, x1: lx + (left + w + 3) * k, y1: ly + 14.5 * k });
      out.push(
        <g key={a.agent.id}>
          {!single && far ? <line x1={base.x} y1={base.y + 3 * k} x2={lx} y2={ly - 9 * k} style={{ stroke: fc("plate-edge"), strokeWidth: 0.75 * k }} /> : null}
          <Scaled x={lx} y={ly} k={k}>
            <rect className="atlas-chip" x={left - 3} y={-10.5} width={w + 6} height={25} rx={2} />
            <text textAnchor={single ? "middle" : "start"} className="atlas-halo" style={{ fill: "var(--mach-ink)", fontSize: 10, fontWeight: 600 }}>
              {name}
            </text>
            <text y={11} textAnchor={single ? "middle" : "start"} className="atlas-halo" style={{ fill: "var(--mach-ink-muted)", fontSize: 9 }}>
              {tier}
            </text>
          </Scaled>
        </g>,
      );
    });
    if (list.length > 3) {
      boxes.push({ x0: x0 - 9 * k, y0: y0 + 3 * 24 * k - 10 * k, x1: x0 + 60 * k, y1: y0 + 3 * 24 * k + 4 * k });
      out.push(
        <Scaled key={`${key}-more`} x={x0 - 6 * k} y={y0 + 3 * 24 * k} k={k}>
          <text className="atlas-halo" style={{ fill: "var(--mach-ink-muted)", fontSize: 9 }}>{`+${list.length - 3} more`}</text>
        </Scaled>,
      );
    }
  }
  return { nodes: out, boxes };
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const hits = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const inside = (b: Box, v: OverlayView) => b.x0 >= v.x0 && b.x1 <= v.x1 && b.y0 >= v.y0 && b.y1 <= v.y1 && !(v.controls && hits(b, v.controls));

/** What a callout must not cover: machines, gates, agents, findings flags and the agents' labels, in projected units. */
function obstacles(L: PlantLayout, scene: Scene, t: number, labelBoxes: Box[]): Box[] {
  const out: Box[] = [...labelBoxes];
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
    }
  }
  // The chamber's findings flags (pole 22, flag and rule lettered to the right of the pole).
  const occ = chamberOccupant(scene, t);
  const round_ = occ ? occ.cell.reviews[occ.roundIndex] : undefined;
  if (occ && round_) {
    const counts = new Map<string, number>();
    for (const f of round_.findings) {
      if (f.seat === "general") continue;
      const n = counts.get(f.seat) ?? 0;
      counts.set(f.seat, n + 1);
      const seat = L.review.seats[f.seat];
      const foot = project({ x: seat.x - 20 - n * 8, y: seat.y - 14, z: PLATE_Z });
      out.push({ x0: foot.x - 4, y0: foot.y - 26, x1: foot.x + 16 + (f.rule ? f.rule.length * 5.2 : 0), y1: foot.y + 3 });
    }
  }
  return out;
}

/**
 * Callouts (spec b.7, "Callout placement"), deterministic: placed in priority order (escalation,
 * failure, waiting for a person, then the event under the playhead); for each, try leader directions
 * up-right (45°), up-left, right, left, down-right, down-left, with leader lengths 36 then 64 px, and
 * take the first whose leader and label box (6.2 px per character, two lines 30 px tall, 4 px padding)
 * stays inside the visible stage and meets no machine, gate, agent, agent label, findings flag or
 * callout already placed. Then, in order: the first that stays inside the stage; the first that is
 * clear (the anchor itself is off the stage); up-right at 64 px. Keeping the label inside the stage
 * (flipping it left at the right edge, spec c.5) is what stops "Rejected · security bl…" being cut off
 * at the stage edge (findings D6); the view is quantised, so a callout re-places only when the camera
 * brings an edge across it, never with every pixel of a pan. Sizes are in screen px at the zoom
 * level's own scale.
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

function layoutCallouts(L: PlantLayout, scene: Scene, t: number, reduced: boolean, k: number, lod: Lod, labelBoxes: Box[], view: OverlayView | null): { nodes: ReactNode[]; boxes: Box[]; obstacles: Box[] } {
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
  const fixed = lod === "far" ? [] : obstacles(L, scene, t, labelBoxes);
  const placed: Box[] = [];
  const pad = 4 * k;
  const out: ReactNode[] = [];
  for (const c of [...pending].sort((a, b) => a.priority - b.priority)) {
    const p = project(c.at);
    const width = Math.max(c.text.length, c.detail?.length ?? 0) * 6.2 + 18;
    const blocked = [...fixed, ...placed];
    const options: Array<{ d: [number, number]; box: Box; clear: boolean; within: boolean }> = [];
    for (const len of [36, 64]) {
      for (const [ux, uy] of DIRECTIONS) {
        const dx = ux * len;
        const dy = uy * len;
        const ex = p.x + dx * k;
        const ey = p.y + dy * k;
        const left = dx < -0.01;
        const box: Box = { x0: (left ? ex - width * k : ex) - pad, y0: ey - 12 * k - pad, x1: (left ? ex : ex + width * k) + pad, y1: ey + 18 * k + pad };
        const leader: Box = { x0: Math.min(p.x, ex), y0: Math.min(p.y, ey), x1: Math.max(p.x, ex), y1: Math.max(p.y, ey) };
        const clear = !blocked.some((o) => hits(o, box) || (Math.abs(dx) > 1 && Math.abs(dy) > 1 && hits(o, shrink(leader, 6 * k))));
        options.push({ d: [dx, dy], box, clear, within: !view || inside(box, view) });
      }
    }
    const pick = options.find((o) => o.clear && o.within) ?? options.find((o) => o.within) ?? options.find((o) => o.clear) ?? options[DIRECTIONS.length]!;
    placed.push(pick.box);
    out.push(
      <g key={c.key} style={{ opacity: c.opacity }}>
        <Scaled x={p.x} y={p.y} k={k}>
          <g className="atlas-halo-group">
            <Callout x={0} y={0} dx={pick.d[0]} dy={pick.d[1]} text={c.text} detail={c.detail} tone={c.tone} />
          </g>
        </Scaled>
      </g>,
    );
  }
  return { nodes: out, boxes: placed, obstacles: fixed };
}

function shrink(b: Box, by: number): Box {
  return { x0: b.x0 + by, y0: b.y0 + by, x1: b.x1 - by, y1: b.y1 - by };
}

function trim(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
