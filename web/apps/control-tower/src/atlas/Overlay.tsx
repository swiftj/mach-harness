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
import { Callout, SelectionBrackets, fc, modelTiers, project, round, type Lod } from "@mach/ui";
import { refId, refKind, sceneAt, type EntityRef, type Scene } from "../sim";
import { useScene, useSceneStore } from "../scene";
import { useAtlas, usePlayheadKeyed } from "./context";
import { AFTERGLOW, animating, anim, chamberOccupant, latestGate, placeAgents, q, uiTier } from "./derive";
import { agentName } from "./Bay";
import { PLATE_Z, FLOOR_Z, type PlantLayout } from "./layout";
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
}

export const Overlay = memo(function Overlay({ zoom, lod, focused }: OverlayProps) {
  const { layout: L } = useAtlas();
  const t = usePlayheadKeyed((s) => {
    const now = s.playhead;
    if (animating(s.fixture, now, (e) => e.type === "verification.verdict" || e.type === "review.decided" || e.type === "human.approval_recorded" || e.type === "dependency.resolved")) return now;
    if (lod === "near" && animating(s.fixture, now, (e) => e.type === "agent.started" || e.type === "agent.finished")) return now;
    const occ = chamberOccupant(sceneAt(s.fixture, now), now);
    // Unlock callouts expire after their afterglow.
    const deps = Object.values(sceneAt(s.fixture, now).dependencies).filter((d) => d.satisfiedAt !== null && now - d.satisfiedAt <= AFTERGLOW * 3).length;
    return `${occ ? occ.cell.ticketId + occ.roundIndex : "-"}|${deps}`;
  });
  const reduced = useSceneStore((s) => s.reducedMotion);
  const selection = useSceneStore((s) => s.selection);
  const hovered = useSceneStore((s) => s.hovered);
  const scene = useScene();
  const k = Math.min(2.4, Math.max(0.9, 1 / zoom));
  const sel = selection ? locateScreen(L, scene, t, selection) : null;
  const hov = hovered && hovered !== selection ? locateScreen(L, scene, t, hovered, 3) : null;
  const foc = focused ? locateScreen(L, scene, t, focused, 5) : null;
  return (
    <g>
      {lod === "near" ? <AgentLabels L={L} scene={scene} t={t} k={Math.min(1.1, k)} /> : null}
      <Callouts L={L} scene={scene} t={t} reduced={reduced} k={k} lod={lod} />
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

function AgentLabels({ L, scene, t, k }: { L: PlantLayout; scene: Scene; t: number; k: number }) {
  const out: ReactNode[] = [];
  for (const cell of Object.values(scene.cells)) {
    for (const a of placeAgents(scene, L, cell, t, true)) {
      if (a.leave > 0.5) continue;
      const base = project(a.at);
      const line = `${agentName(a)} · ${modelTiers[uiTier(a.agent.model)].label}`;
      out.push(
        <Scaled key={a.agent.id} x={base.x} y={base.y + 11 + a.stack * 11 * k} k={k}>
          <text textAnchor="middle" className="atlas-halo" style={{ fill: a.state === "active" ? "var(--mach-ink)" : "var(--mach-ink-muted)", fontSize: 9.5, fontWeight: a.state === "active" ? 600 : 400 }}>
            {line.length > 26 ? `${line.slice(0, 25)}…` : line}
          </text>
        </Scaled>,
      );
    }
  }
  return <g aria-hidden="true">{out}</g>;
}

function Callouts({ L, scene, t, reduced, k, lod }: { L: PlantLayout; scene: Scene; t: number; reduced: boolean; k: number; lod: Lod }) {
  const out: ReactNode[] = [];
  const put = (key: string, at: { x: number; y: number; z?: number }, text: string, detail: string | undefined, tone: "ink" | "fail" | "human" | "select", opacity = 1, dx = 26, dy = -30) => {
    const p = project(at);
    out.push(
      <g key={key} style={{ opacity }}>
        <Scaled x={p.x} y={p.y} k={k}>
          <g className="atlas-halo-group">
            <Callout x={0} y={0} dx={dx} dy={dy} text={text} detail={detail} tone={tone} />
          </g>
        </Scaled>
      </g>,
    );
  };
  if (lod !== "far") {
    // Verification failed: at the verdict gate, until the next verification starts.
    for (const cell of Object.values(scene.cells)) {
      const v = cell.verifications[cell.verifications.length - 1];
      const bay = L.bayByTicket.get(cell.ticketId);
      if (!v || !bay || v.status !== "FAIL_WITH_EVIDENCE" || v.decidedAt === null) continue;
      const failed = v.checks.filter((c) => c.result === "fail");
      put(`vf-${cell.ticketId}`, { ...bay.gate, z: PLATE_Z + 36 }, `Verification failed · ${failed.map((c) => c.targetId).join(", ")}`, `${v.checks.length - failed.length} of ${v.checks.length} proven; back to build, round ${v.round + 1} of 3`, "fail", q(anim("stateChange", t - v.decidedAt, reduced)));
    }
  }
  // The chamber: a rejection, an outvoted blocker.
  const occ = chamberOccupant(scene, t);
  const r = occ ? occ.cell.reviews[occ.roundIndex] : undefined;
  if (occ && r && r.decidedAt !== null) {
    const op = q(anim("stateChange", t - r.decidedAt, reduced));
    if (r.outcome === "REJECTED") {
      const b = r.findings.find((f) => f.severity === "blocker");
      put(`rej-${occ.cell.ticketId}`, { ...L.review.gate, z: PLATE_Z + 40 }, `Rejected · ${b?.seat ?? ""} blocker ${b?.rule ?? ""}`, b ? trim(b.title, 58) : undefined, "fail", op);
    } else {
      put(`dec-${occ.cell.ticketId}`, { ...L.review.gate, z: PLATE_Z + 40 }, `${r.outcome === "AWAITING_HUMAN" ? "Passed panel · needs a person" : "Approved"} · ${r.approvals} of ${r.seats.length}`, `${occ.cell.ticketId}, round ${r.round}${r.delta ? ", delta review" : ""}`, r.outcome === "AWAITING_HUMAN" ? "human" : "ink", op);
    }
    for (const f of r.findings.filter((x) => x.outvoted)) {
      if (f.seat === "general") continue;
      put(`out-${f.id}`, { ...L.review.seats[f.seat], z: PLATE_Z + 14 }, `Blocker outvoted · ${f.seat} seat ${f.rule ?? ""}`, `${trim(f.title, 50)} (reported, not hidden)`, "fail", op, 30, 44);
    }
  }
  // The person's gate: held (still, no pulsing), then released by name.
  const hg = latestGate(scene, "human-approval");
  if (hg) {
    const cell = scene.cells[hg.ticketId];
    const at = { ...L.human.gate, z: PLATE_Z + 50 };
    if (hg.state === "waiting") {
      const reasons = cell?.reviews[cell.reviews.length - 1]?.humanApprovalReasons ?? [];
      put("hw", at, `${hg.ticketId} waits for a person`, reasons.length ? `Because ${reasons.join("; ")}` : "Human approval required", "human", 1, 24, -40);
    } else if (hg.state === "passed" && hg.decidedAt !== null && !(cell?.archived)) {
      const by = cell?.reviews.find((x) => x.humanApproval)?.humanApproval?.by ?? "a person";
      put("ha", at, `Approved by ${by}`, `${hg.ticketId} released to merge`, "human", q(anim("humanRelease", t - hg.decidedAt, reduced)), 24, -40);
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
      put(`dep-${d.id}`, anchor, text, detail, still.length ? "ink" : "ink", q(anim("dependencyUnlock", t - d.satisfiedAt, reduced)), -26, -30);
    }
  }
  return <g aria-hidden="true">{out}</g>;
}

function trim(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
