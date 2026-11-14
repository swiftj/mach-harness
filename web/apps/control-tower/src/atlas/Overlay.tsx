/**
 * Layer 7 (spec b.4, g: L3): never depth-sorted, never occluded. Selection brackets, the hover
 * outline and its label, the keyboard focus ring, agents' labels at near zoom, and callouts for
 * the beats a person must not miss (a failed verification, a rejected review, an outvoted blocker,
 * a person's gate, a dependency unlocking). Text is counter-scaled against the camera so it stays
 * legible at every zoom.
 *
 * The upright labels (callouts, the selection's label, agents' labels) are placed in one
 * deterministic pass per frame (`placeUpright`, findings D7): in priority order, each takes the first
 * of its allowed positions that covers no label already placed and stays on the stage. Callouts go
 * first (their anchors are fixed machines, so they hold still), then the selection's label, then
 * agents' labels, whose first choice is still centred under the agent's floor disc.
 */
import { memo, type ReactNode } from "react";
import { Callout, SelectionBrackets, fc, modelTiers, project, regions, round, screenBounds, type Lod, type PlanBox, type RegionKind } from "@mach/ui";
import { isKnown, refId, refKind, sliceHoldOf, type EntityRef, type Scene } from "../sim";
import { useScene, useSceneStore } from "../scene";
import { useAtlas, usePlayheadKeyed } from "./context";
import { AFTERGLOW, agentsElapsedKey, animating, anim, fmtElapsed, fmtElapsedKnown, chamberOccupant, latestGate, ticketOfRef, placeAgents, q, uiTier, type ViewMode } from "./derive";
import { agentName } from "./Bay";
import { containedWords } from "../text/fields";
import { PLATE_Z, FLOOR_Z, boxAt, type PlantLayout } from "./layout";
import { locateScreen } from "./locate";
import { placeUpright, type Box, type Slot, type Stage, type Upright } from "./place";

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
      return `${id} · ${sliceHoldOf(scene, scene.slices[id]) ? "held by the supervisor" : (scene.slices[id]?.scheduler ?? "")}`;
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
        if (a) return `${containedWords("agentLabel", a.label, 40)} · ${isKnown(a.meta, "model") ? modelTiers[uiTier(a.model)].label : "model not recorded"}`;
      }
      return id;
    }
    default:
      return id;
  }
}

/** The stage as seen by the camera, in projected units, inset by the sheet's margin; what labels must stay inside. */
export type OverlayView = Stage;

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

/** A label offered to the placement pass, with how to draw it in the slot it is given. */
interface Offer extends Upright {
  draw: (slot: number) => ReactNode;
}

export const Overlay = memo(function Overlay({ zoom, lod, focused, theater, view }: OverlayProps) {
  const { layout: L, mode } = useAtlas();
  const t = usePlayheadKeyed((s) => {
    const now = s.playhead;
    if (animating(s.log, now, (e) => e.event.type === "verification.verdict" || e.event.type === "gate.evaluated" || e.event.type === "review.decided" || e.event.type === "human.approval_recorded" || e.event.type === "dependency.resolved")) return now;
    if (lod === "near" && animating(s.log, now, (e) => e.event.type === "agent.started" || e.event.type === "agent.finished")) return now;
    const scene = s.log.sceneAt(now);
    // At near zoom the agents' elapsed time is lettered: re-render exactly when one of them changes
    // (keyed on each agent's own elapsed second, not the playhead's, so no route can leave it stale).
    // A count-only agent's label also carries its tool-call count and last tool: re-render when one changes.
    const elapsedKey = lod === "near" ? `${agentsElapsedKey(scene, now)}${mode.live ? countsKey(scene) : ""}` : "";
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
  const sel = selection ? locateScreen(L, scene, t, selection, 0, mode) : null;
  const hov = hovered && hovered !== selection && !theater ? locateScreen(L, scene, t, hovered, 3, mode) : null;
  const foc = focused ? locateScreen(L, scene, t, focused, 5, mode) : null;
  const stage = view ?? null;
  const labelK = Math.min(1.1, LEVEL_K[lod]);

  // What labels should leave clear when they can: machines, gates, agents and findings flags.
  const prefer = ticketOfRef(scene, selection);
  const fixed = lod === "far" ? [] : obstacles(L, scene, t, mode, prefer);
  const agents = lod === "near" ? agentOffers(L, scene, t, labelK, mode) : { offers: [], home: [] };
  // Callouts also leave each agent's own label spot (under its disc) to the agent, when they can.
  const callouts = calloutOffers(L, scene, t, reduced, LEVEL_K[lod], lod, [...fixed, ...agents.home], prefer);
  const selText = sel && selection ? shortName(scene, selection) : "";
  const selOffer = sel && selection ? selectionOffer(sel, selText, k, zoom, fixed) : null;
  const offers: Offer[] = [...callouts, ...(selOffer ? [selOffer] : []), ...agents.offers];
  const slots = placeUpright(offers, stage);
  const drawn = new Map(offers.map((o, i) => [o.key, o.draw(slots[i]!)]));
  const pick = (list: Offer[]) => list.map((o) => drawn.get(o.key));

  return (
    <g>
      {agents.offers.length ? <g aria-hidden="true">{pick(agents.offers)}</g> : null}
      {/* Callouts use one scale per zoom level, so they never move while the camera moves within a level. */}
      <g aria-hidden="true">{pick(callouts)}</g>
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
      {sel && selOffer ? (
        <g aria-hidden="true">
          <SelectionBrackets bounds={sel} pad={5} arm={Math.max(8, 10 / zoom)} />
          {drawn.get(selOffer.key)}
        </g>
      ) : null}
      {foc ? <rect aria-hidden="true" x={foc.x} y={foc.y} width={foc.width} height={foc.height} rx={4} style={{ fill: "none", stroke: "var(--mach-focus)", strokeWidth: 2 / zoom }} /> : null}
    </g>
  );
});

/** Width of upright sans text, per character at its size (Source Sans 3 semibold runs about 0.45 em; this keeps a margin). */
const EM = 0.59;

/**
 * The selection's label: above its brackets at the left by default; then below, right-aligned above,
 * right-aligned below, beside on the right, beside on the left. It sits on an opaque ground-coloured
 * chip, so floor lettering under it never reads through (findings D7).
 */
function selectionOffer(sel: { x: number; y: number; width: number; height: number }, text: string, k: number, zoom: number, fixed: Box[]): Offer {
  const w = text.length * 10.5 * EM;
  const cx = sel.x + sel.width / 2;
  const cy = sel.y + sel.height / 2;
  const above = sel.y - 10 / zoom;
  const below = sel.y + sel.height + 8 / zoom + 10.5 * k;
  const left = sel.x - 5;
  const right = sel.x + sel.width + 5 - w * k;
  const positions: Array<[number, number]> = [
    [left, above],
    [left, below],
    [right, above],
    [right, below],
    [sel.x + sel.width + 10 / zoom + 3 * k, cy + 3.5 * k],
    [sel.x - 10 / zoom - (w + 3) * k, cy + 3.5 * k],
  ];
  const boxOf = ([x, y]: [number, number]): Box => ({ x0: x - 3 * k, y0: y - 11 * k, x1: x + (w + 3) * k, y1: y + 4 * k });
  return {
    key: "selection",
    anchor: { x: cx, y: cy },
    slots: positions.map((p) => ({ box: boxOf(p) })),
    // Obstacles that are the selected thing itself (its own machine or gate box) do not count.
    soft: fixed.filter((o) => !(o.x0 <= cx && cx <= o.x1 && o.y0 <= cy && cy <= o.y1)),
    draw: (i) => {
      const [x, y] = positions[i]!;
      return (
        <Scaled key="selection" x={x} y={y} k={k}>
          <rect className="atlas-chip atlas-chip-solid" x={-3} y={-11} width={w + 6} height={15} rx={2} />
          <text data-label="selection" className="atlas-halo" style={{ fill: fc("select"), fontSize: 10.5, fontWeight: 600 }}>
            {text}
          </text>
        </Scaled>
      );
    },
  };
}

/**
 * Agent labels (spec b.7, "Agent labels in the overlay"): two lines, role (sans 10 semibold) and tier
 * (sans 9 muted), 16 px under the floor disc. Agents sharing a machine stack under its agent spot,
 * ordered left to right on screen, left-aligned on a common x, at most three and then "+n more"; a
 * stacked label more than 20 px from its disc gets a hairline leader. The tier line also carries how
 * long the agent has worked (known, never a fraction): our one addition to the rule. Each label sits
 * on a ground-coloured chip, so a post, a gate or a route behind it cannot strike through its text.
 *
 * Under the disc is the first choice; when a callout or the selection's label already holds that
 * floor, the label (or the whole stack) goes above the agent's head, then beside it. The tier line's
 * box reserves its widest elapsed time, so the label never shifts as seconds pass. Returns the offers
 * and each label's first-choice box (the floor callouts leave to agents when they can).
 */
const ROW = 27;
const ELAPSED_RESERVE = " · 59 min".length;

function agentOffers(L: PlantLayout, scene: Scene, t: number, k: number, mode: ViewMode): { offers: Offer[]; home: Box[] } {
  const groups = new Map<string, { base: { x: number; y: number }; head: number; a: ReturnType<typeof placeAgents>[number] }[]>();
  for (const cell of Object.values(scene.cells)) {
    for (const a of placeAgents(L, cell, t, true, mode)) {
      if (a.leave > 0.5) continue;
      const key = a.at.z === FLOOR_Z ? `${cell.ticketId}:${Math.round(a.at.x / 40)}:${Math.round(a.at.y)}` : `${a.agent.id}`;
      const list = groups.get(key) ?? [];
      list.push({ base: project(a.at), head: project({ ...a.at, z: (a.at.z ?? 0) + 40 }).y, a });
      groups.set(key, list);
    }
  }
  const offers: Offer[] = [];
  const home: Box[] = [];
  for (const [key, list] of groups) {
    list.sort((m, n) => m.base.x - n.base.x || m.a.agent.startedAt - n.a.agent.startedAt);
    const shown = list.slice(0, 3);
    const more = list.length - shown.length;
    const rows = shown.map(({ base, a }) => {
      const name = mode.live ? (a.agent.label ? containedWords("agentLabel", a.agent.label, 30) : agentName(a)) : agentName(a);
      const tierLabel = a.tierKnown ? modelTiers[uiTier(a.agent.model)].label : "model not recorded";
      const active = a.state === "active";
      if (!mode.live) {
        const tier = `${tierLabel}${active ? ` · ${fmtElapsed(a.elapsed)}` : ""}`;
        const w = Math.max(name.length * 10 * EM, (tierLabel.length + (active ? ELAPSED_RESERVE : 0)) * 9 * EM);
        return { base, a, name, tier, tools: null as string | null, w };
      }
      // Live and replay: the label, the model, the phase and how long it has run (measured, placed
      // "≈", or not recorded); then what is known of its tools: a count and the last tool's name.
      const phase = isKnown(a.agent.meta, "phase") && a.agent.phase ? ` · ${containedWords("agentPhase", a.agent.phase, 24)}` : "";
      const when = active ? ` · ${fmtElapsedKnown(a.elapsed, a.elapsedKnown, a.elapsedInferred)}` : a.state === "stale" ? " · as last seen" : "";
      const tier = `${tierLabel}${phase}${when}`;
      const n = a.agent.toolCallCount;
      const tools = `${n === null ? "tool calls not reported" : `${n} tool call${n === 1 ? "" : "s"}`}${a.agent.lastTool ? ` · last ${a.agent.lastTool}` : ""}`;
      const w = Math.max(name.length * 10 * EM, (tier.length + (active ? 3 : 0)) * 9 * EM, tools.length * 9 * EM);
      return { base, a, name, tier, tools, w };
    });
    const bx0 = Math.min(...list.map((m) => m.base.x));
    const bx1 = Math.max(...list.map((m) => m.base.x));
    const by = Math.max(...list.map((m) => m.base.y));
    const head = Math.min(...list.map((m) => m.head));
    const single = list.length === 1;
    const wMax = Math.max(...rows.map((r) => r.w), more ? 9 * 9 * EM : 0);
    const nRows = rows.length + (more ? 1 : 0);
    // Live labels carry a third line (the tool count): a taller chip and a longer pitch.
    const extra = mode.live ? 11 : 0;
    const pitch = ROW + extra;
    const height = (nRows - 1) * pitch + 25 + extra; // from the first row's chip top to the last row's chip bottom
    // A slot: where the first row's baseline sits, and how the text is aligned to x.
    type Place = { x: number; y: number; align: "middle" | "start" | "end" };
    const places: Place[] = single
      ? [
          { x: bx0, y: by + 16 * k, align: "middle" },
          { x: bx0, y: head - (25 - 10.5 + 4) * k, align: "middle" },
          { x: bx1 + 16 * k, y: by - 4 * k, align: "start" },
          { x: bx0 - 16 * k, y: by - 4 * k, align: "end" },
        ]
      : [
          { x: bx0 - 6 * k, y: by + 16 * k, align: "start" },
          { x: bx0 - 6 * k, y: head - (height - 10.5 + 4) * k, align: "start" },
          { x: bx1 + 16 * k, y: by - 10.5 * k, align: "start" },
          { x: bx0 - 16 * k, y: by - 10.5 * k, align: "end" },
        ];
    const boxOf = (p: Place): Box => {
      const left = p.align === "middle" ? -wMax / 2 : p.align === "end" ? -wMax : 0;
      return { x0: p.x + (left - 3) * k, y0: p.y - 10.5 * k, x1: p.x + (left + wMax + 3) * k, y1: p.y + (height - 10.5) * k };
    };
    const slots: Slot[] = places.map((p) => ({ box: boxOf(p) }));
    home.push(slots[0]!.box);
    offers.push({
      key: `agents-${key}`,
      anchor: { x: (bx0 + bx1) / 2, y: by },
      slots,
      soft: [],
      draw: (i) => {
        const p = places[i]!;
        return (
          <g key={`agents-${key}`}>
            {rows.map(({ base, a, name, tier, tools, w }, r) => {
              const ly = p.y + r * pitch * k;
              const far = !single && Math.hypot(p.x - base.x, ly - base.y) > 20 * k;
              const chipX = p.align === "middle" ? -w / 2 : p.align === "end" ? -w : 0;
              return (
                <g key={a.agent.id}>
                  {far ? <line x1={base.x} y1={base.y + 3 * k} x2={p.x} y2={ly - 9 * k} style={{ stroke: fc("plate-edge"), strokeWidth: 0.75 * k }} /> : null}
                  <Scaled x={p.x} y={ly} k={k}>
                    <rect className="atlas-chip" x={chipX - 3} y={-10.5} width={w + 6} height={25 + extra} rx={2} />
                    <text textAnchor={p.align} className="atlas-halo" style={{ fill: "var(--mach-ink)", fontSize: 10, fontWeight: 600 }}>
                      {name}
                    </text>
                    <text y={11} textAnchor={p.align} className="atlas-halo" style={{ fill: "var(--mach-ink-muted)", fontSize: 9 }}>
                      {tier}
                    </text>
                    {tools !== null ? (
                      <text y={22} textAnchor={p.align} className="atlas-halo notranslate" style={{ fill: "var(--mach-ink-muted)", fontSize: 9, fontFamily: "var(--mach-font-mono)" }}>
                        {tools}
                      </text>
                    ) : null}
                  </Scaled>
                </g>
              );
            })}
            {more ? (
              <Scaled x={p.x} y={p.y + rows.length * pitch * k} k={k}>
                <text textAnchor={p.align} className="atlas-halo" style={{ fill: "var(--mach-ink-muted)", fontSize: 9 }}>{`+${more} more`}</text>
              </Scaled>
            ) : null}
          </g>
        );
      },
    });
  }
  return { offers, home };
}

/** The regions' names as Plant letters them (RegionPlate: Source Sans 3, 19 at 650, along the plate's front edge). */
const REGION_TITLES: Array<[keyof PlantLayout["regions"], RegionKind, string?]> = [
  ["intake", "intake"],
  ["floor", "floor"],
  ["review", "review"],
  ["human", "human", "Approval"],
  ["integration", "integration", "Integration yard"],
  ["archive", "archive", "Archive"],
];

/**
 * What a label should not cover when it can: machines, gates, agents, findings flags, and the regions'
 * floor names with their captions, in projected units. A name runs diagonally on screen, so it is
 * offered as short pieces along its run rather than one box around the whole diagonal.
 */
function obstacles(L: PlantLayout, scene: Scene, t: number, mode: ViewMode, prefer: string | null): Box[] {
  const out: Box[] = [];
  const add = (b: PlanBox) => {
    const r = screenBounds([b]);
    out.push({ x0: r.x, y0: r.y, x1: r.x + r.width, y1: r.y + r.height });
  };
  for (const [key, kind, title] of REGION_TITLES) {
    const box = L.regions[key];
    const run = (title ?? regions[kind].label).length * 19 * EM;
    const front = box.y + box.d - 8;
    for (let x = box.x + 18; x < box.x + 18 + run; x += 24) add({ x, y: front - 22 - 17, w: Math.min(24, box.x + 18 + run - x), d: 22 + 17 + 2, z: PLATE_Z, h: 0 });
  }
  for (const bay of L.bays) {
    if (!scene.cells[bay.ticketId]) continue;
    add(boxAt(bay.pads.intent, 40, 40, 14));
    add(boxAt(bay.pads.build, 40, 40, 24));
    add(boxAt(bay.pads.verify, 40, 40, 20));
    add(boxAt(bay.gate, 8, 46, 36));
  }
  for (const p of [L.review.gate, L.human.gate, L.integration.gate, L.integration.merge, L.intake.auditGate, L.intake.hopper]) add(boxAt(p, 40, 40, 40));
  for (const cell of Object.values(scene.cells)) {
    for (const a of placeAgents(L, cell, t, true, mode)) {
      if (a.leave > 0.5) continue;
      add(boxAt(a.at, 18, 18, 34));
    }
  }
  // The chamber's findings flags (pole 22, flag and rule lettered to the right of the pole).
  const occ = chamberOccupant(scene, t, prefer);
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
 * Callouts (spec b.7, "Callout placement"): offered in priority order (escalation, failure, waiting
 * for a person, then the event under the playhead). Each may take a leader up-right (45°), up-left,
 * right, left, down-right, down-left, straight up or straight down, at 36, 64 then 96 px; its label box
 * is 6.2 px per character, two lines 30 px tall, 4 px padding. Keeping the label inside the stage
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
  [0, -1],
  [0, 1],
];
const LEADERS = [36, 64, 96];

function calloutOffers(L: PlantLayout, scene: Scene, t: number, reduced: boolean, k: number, lod: Lod, soft: Box[], prefer: string | null): Offer[] {
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
  const occ = chamberOccupant(scene, t, prefer);
  const r = occ ? occ.cell.reviews[occ.roundIndex] : undefined;
  if (occ && r && r.decidedAt !== null) {
    const op = q(anim("stateChange", t - r.decidedAt, reduced));
    if (r.outcome === "REJECTED") {
      const b = r.findings.find((f) => f.severity === "blocker");
      put(`rej-${occ.cell.ticketId}`, { ...L.review.gate, z: PLATE_Z + 40 }, `Rejected · ${b?.seat ?? ""} blocker ${b?.rule ?? ""}`, b ? containedWords("findingTitle", b.title, 58) : undefined, "fail", op, 1);
    } else {
      put(`dec-${occ.cell.ticketId}`, { ...L.review.gate, z: PLATE_Z + 40 }, `${r.outcome === "AWAITING_HUMAN" ? "Passed panel · needs a person" : "Approved"} · ${r.approvals} of ${r.seats.length}`, `${occ.cell.ticketId}, round ${r.round}${r.delta ? ", delta review" : ""}`, r.outcome === "AWAITING_HUMAN" ? "human" : "ink", op);
    }
    for (const f of r.findings.filter((x) => x.outvoted)) {
      if (f.seat === "general") continue;
      put(`out-${f.id}`, { ...L.review.seats[f.seat], z: PLATE_Z + 14 }, `Blocker outvoted · ${f.seat} seat ${f.rule ?? ""}`, `${containedWords("findingTitle", f.title, 50)} (reported, not hidden)`, "fail", op, 1);
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
      put(`dep-${d.id}`, anchor, text, detail, "ink", q(anim("dependencyUnlock", t - d.satisfiedAt, reduced)));
    }
  }
  const pad = 4 * k;
  // Stable sort: equal priorities keep the order above.
  return [...pending]
    .sort((a, b) => a.priority - b.priority)
    .map((c): Offer => {
      const p = project(c.at);
      const width = Math.max(c.text.length, c.detail?.length ?? 0) * 6.2 + 18;
      const dirs: Array<[number, number]> = [];
      const slots: Slot[] = [];
      for (const len of LEADERS) {
        for (const [ux, uy] of DIRECTIONS) {
          const dx = ux * len;
          const dy = uy * len;
          const ex = p.x + dx * k;
          const ey = p.y + dy * k;
          const left = dx < -0.01;
          dirs.push([dx, dy]);
          slots.push({
            box: { x0: (left ? ex - width * k : ex) - pad, y0: ey - 12 * k - pad, x1: (left ? ex : ex + width * k) + pad, y1: ey + 18 * k + pad },
            leader: { x0: p.x, y0: p.y, x1: ex, y1: ey },
          });
        }
      }
      return {
        key: c.key,
        anchor: p,
        slots,
        // The machine the callout points at is not in its way.
        soft: soft.filter((o) => !(o.x0 <= p.x && p.x <= o.x1 && o.y0 <= p.y && p.y <= o.y1)),
        draw: (i) => {
          const [dx, dy] = dirs[i]!;
          return (
            <g key={c.key} data-label="callout" style={{ opacity: c.opacity }}>
              <Scaled x={p.x} y={p.y} k={k}>
                <g className="atlas-halo-group">
                  <Callout x={0} y={0} dx={dx} dy={dy} text={c.text} detail={c.detail} tone={c.tone} />
                </g>
              </Scaled>
            </g>
          );
        },
      };
    });
}

/** Each agent's reported tool count and last tool (live): a label's third line changes with them. */
function countsKey(scene: Scene): string {
  let k = "";
  for (const c of Object.values(scene.cells)) {
    for (const id of c.activeAgentIds) {
      const a = c.agents[id];
      if (a) k += `${a.toolCallCount ?? "-"}${a.lastTool ?? ""},`;
    }
  }
  return k;
}

