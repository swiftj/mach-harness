/**
 * The Execution Blueprint: the same run as the Atlas, drawn as an engineering sheet that fills in as
 * the playhead moves (M6_0_VISUAL_SPEC.md c). Fills its container, takes no props, and reads
 * everything from the scene store. What it keeps of its own: the camera, hover, which lanes are open,
 * and which tree item holds the keyboard's tab stop. Nothing about what has happened.
 *
 * Why one SVG with a CSS-transform camera, and ELK only for the column template, rather than React
 * Flow: the Blueprint is a drawing, not a node graph. Its marks are the grammar's (bubbles, diamonds,
 * lanes, dimension lines, loops that run between round rows) and they share one coordinate system
 * with rulers, gutters and a title block; React Flow would wrap every mark in an HTML node with its
 * own layout, selection and focus model, and its edges would have to be re-taught every path the
 * grammar already draws. The spec's camera (f.1) is one transform on one wrapper, which keeps text
 * crisp, hit-testing exact and lets the pinned gutter and column head follow by a CSS variable with
 * no React work per frame. ELK does what it is best at, once: a layered layout of the belt's columns
 * in their static order (with the review seats as one layer); the columns are then fixed for good, so
 * nothing re-lays out as time passes. What we give up: React Flow's built-in minimap, controls and
 * edge routing, which are drawn here instead, to the grammar.
 *
 * Live, replay and simulation (M6.2) are drawn by the same view from the store's log: nothing is laid
 * out from the whole run. Waves, slices, executions, visits and rounds are added as their first event
 * is applied, after what is drawn; the sheet grows (in steps) and never shrinks under the camera; when
 * rows above what the camera shows change, the camera is moved by the same amount, so what is in view
 * stays where it is (`anchorShift`).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { animate } from "motion/react";
import { BlueprintSheet, FactoryScene, fc } from "@mach/ui";
import type { EntityRef, WaveState } from "../sim";
import { isKnown, refKind } from "../sim";
import { cameraFollows, isStale, useScene, useSceneActions, useSceneStore, useStore } from "../scene";
import { spreadTemplate, useColumns, type ColumnTemplate } from "./columns";
import { computeLayout, drawingWidthFor, SHEET, SHEET_BASE_HEIGHT, SHEET_STEP, type Lane, type Layout, type Rect, type WaveBand } from "./layout";
import { DependencyLayer, LaneView } from "./Lane";
import { clamp, fitCamera, focusCamera, type Camera, type Reserve } from "./camera";
import { leafBounds } from "./bounds";
import { PlayheadFact, sheetFacts, StaleNote } from "./TitleBlock";
import { ancestors, nodeForRef, treeOf, type Tree, type TreeNode } from "./tree";
import { BandContext, Chevron, Item, SelectBar, ToggleTarget, TreeContext, type TreeCtx } from "./treeitem";
import { CameraContext, ClearContext, createCameraStore, createHitRegistry, HitContext, LayersContext, LodContext, nearestHit, SimulatedContext, useCamera, type ClearArea, type ClearAreaSource } from "./context";
import { ColumnHead, furnitureBox, HEAD_H, Legend, Revisions } from "./furniture";
import { Minimap, PinnedTitle, RULER, rulersShown, ZoneRulers, zoneCounts } from "./overlays";
import { Gutter } from "./gutter";
import { PlaceholderBelt } from "./Placeholder";
import "./blueprint.css";

const DEEP = new Set(["agent", "tool", "artifact", "finding"]);

/** Levels of detail by camera zoom, with hysteresis: overview swaps fine text for large lettering. */
const LOD = { overviewIn: 0.55, overviewOut: 0.6, near: 1.4 } as const;

/** Screen px between a ruler and the pinned part below or beside it. */
const PIN_GAP = 1;

/** The column head's top on the sheet: under the wave header. */
const headTopOf = (L: Layout): number => L.waveY + 48;

/**
 * Where the pinned gutter and column head stand for a camera, as the offsets (in sheet units) the CSS
 * variables carry. Once the sheet's edge has scrolled off, a pinned part sits just inside the ruler that
 * then appears on that edge (never under it: defect D13, where the ruler cut the stage names in half).
 */
function pinOffsets(c: Camera, L: Layout): { gx: number; hy: number } {
  const shown = rulersShown(c);
  const leftAt = shown.left ? RULER + PIN_GAP : 2;
  const topAt = shown.top ? RULER + PIN_GAP : 2;
  // The gutter's backing starts 4 units left of SHEET.left; the head's at its own top.
  const gx = Math.min(Math.max(0, (leftAt - c.x) / c.k - SHEET.left + 4), L.width - SHEET.gutter - 40);
  const headTop = headTopOf(L);
  const hy = Math.max(0, Math.min((topAt - c.y) / c.k - headTop, L.height - headTop - 200));
  return { gx, hy };
}

/**
 * The stage's bottom-right corner (findings N3): the overview, the playhead chip and the zoom toolbar
 * stack there (`.bp-corner`), never over one another. The camera may take the sheet this far past its
 * right edge, so the last column can always be brought out from under the corner.
 */
const CORNER_W = 196;

/**
 * How much of the stage's right side an overlay drawer covers, in px: the Shell's inspector, which on a
 * window under 1280 px is a fixed panel over the stage rather than a column beside it. Measured from
 * the page (the Shell exposes no variable for it): any fixed or absolute `aside` outside the stage
 * whose box reaches the stage's right edge. A closed drawer is translated off the edge and covers 0.
 */
function coveredRight(vp: HTMLElement): number {
  const box = vp.getBoundingClientRect();
  let cover = 0;
  for (const el of document.querySelectorAll<HTMLElement>("aside")) {
    if (el.contains(vp) || el.inert) continue;
    const cs = getComputedStyle(el);
    if ((cs.position !== "fixed" && cs.position !== "absolute") || cs.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.left >= box.right - 1 || r.right < box.right - 1 || r.bottom <= box.top || r.top >= box.bottom) continue;
    cover = Math.max(cover, box.right - Math.max(r.left, box.left));
  }
  return Math.round(cover);
}

/**
 * What a framed target must stay clear of: the top ruler and the pinned column head, and (for a target
 * in the drawing, right of the gutters) the pinned gutter with the left ruler.
 */
function reserveFor(L: Layout): Reserve {
  return { topPx: RULER + PIN_GAP + 6, top: HEAD_H, leftPx: RULER + PIN_GAP + 6, left: L.ax - 14 - SHEET.left + 4, leftFrom: L.ax - 14 };
}

/**
 * The camera that frames a target (focus, a chapter, the overview's lane buttons): clear of the pinned
 * parts, and never so far out that the target drops to the overview's simplified drawing.
 */
function frameOf(view: { w: number; h: number }, L: Layout, rect: Rect): Camera {
  return focusCamera(view, rect, reserveFor(L), LOD.overviewOut + 0.02);
}

/** Follow (spec f.3), made calm. See `followMove` for the rule. */
const FOLLOW = { everyMs: 4000, everyReducedMs: 6000, graceMs: 90_000, inner: 0.15, minMove: 0.12, easeMs: 900 } as const;

/** Tree ids to open so an entity can be seen: its ancestors, and for deep things the whole path. */
function opensFor(tree: Tree, entity: EntityRef): string[] {
  const id = nodeForRef(tree, entity);
  if (!id) return [];
  const path = ancestors(tree, id);
  const node = tree.byId.get(id);
  if (!node) return path;
  if (DEEP.has(node.kind)) return path;
  // A visit or a gate is drawn in its cell's workflow: open the lane, not the execution.
  return path.filter((p) => p.startsWith("w:") || p.startsWith("s:"));
}

/**
 * Lanes open by default while the sheet holds at most this many (spec c.2, c.5). Each lane's default is
 * decided once, the first time the view sees it: a lane that arrives when the sheet already holds more
 * is closed (its strip carries its state), and lanes already open stay open, so the sheet never folds
 * up under the person when the seventh slice arrives. Twelve cells at once are twelve strips.
 */
const LANE_OPEN_LIMIT = 6;

/** Every lane's default, decided the first time it is seen (see LANE_OPEN_LIMIT). Mutated, never replaced. */
type LaneDefaults = Map<string, boolean>;

function noteLanes(tree: Tree, seen: LaneDefaults): void {
  const lanes = tree.roots.flatMap((r) => r.children);
  const fresh = lanes.filter((l) => !seen.has(l.id));
  if (!fresh.length) return;
  const open = lanes.length <= LANE_OPEN_LIMIT;
  for (const l of fresh) seen.set(l.id, open);
}

/** The default expansion: every wave, and the lanes whose default is open. */
function defaultOpen(tree: Tree, seen: LaneDefaults): Set<string> {
  const out = new Set<string>();
  for (const root of tree.roots) {
    out.add(root.id);
    for (const lane of root.children) if (seen.get(lane.id) !== false) out.add(lane.id);
  }
  return out;
}

/**
 * The sheet's planned height: what the history so far needs at the default expansion, in whole steps,
 * never less than the base sheet and never less than it was (the paper does not shrink under the
 * camera, and grows a step at a time, not per event).
 */
function plannedFrom(height: number, before: number): number {
  const over = Math.max(0, height - SHEET_BASE_HEIGHT);
  return Math.max(before, SHEET_BASE_HEIGHT + Math.ceil(over / SHEET_STEP) * SHEET_STEP);
}

/** The drawing's width: fixed, so no column ever moves (it is the width of the base sheet cut landscape). */
const drawingWidth = (template: ColumnTemplate): number => drawingWidthFor(SHEET_BASE_HEIGHT, template.width);

/**
 * How far what the camera shows has moved between two layouts, in sheet units: the selection's item,
 * else the focused item, else the topmost lane in view. Rows that appear below it move nothing; a lane
 * above it that grows or a late event inserted above moves it, and the camera follows by that much.
 */
function anchorShift(prev: Layout, next: Layout, ids: readonly (string | null)[], viewTop: number): number {
  for (const id of ids) {
    if (!id) continue;
    const a = prev.bounds.get(id);
    const b = next.bounds.get(id);
    if (a && b && a.y + a.h >= viewTop) return b.y - a.y;
  }
  const lane = prev.lanes.find((l) => l.y + l.h > viewTop);
  const now = lane ? next.lanes.find((l) => l.id === lane.id) : undefined;
  if (lane && now) return now.y - lane.y;
  const wave = prev.waves.find((w) => w.y + w.h > viewTop);
  const after = wave ? next.waves.find((w) => w.id === wave.id) : undefined;
  return wave && after ? after.y - wave.y : 0;
}

/**
 * The follow rule (spec f.3), as a pure decision on the current frame:
 * 1. The active set is where work is now: the node of each cell's current station visit (or the human
 *    gate it waits at), kept for 90 factory seconds after the visit ends so the set does not flicker
 *    between stations. Collapsed lanes stand in with their strip.
 * 2. If every member already sits inside the inner 70% of the stage, nothing moves.
 * 3. If the whole set fits inside the inner 70% at the viewer's zoom, the camera eases to centre it.
 *    It never changes the zoom.
 * 4. Otherwise it centres one primary member, which is sticky: it stays the target while it is
 *    active, so several active cells never pull the camera back and forth.
 * 5. Moves smaller than 12% of the stage are skipped; at most one re-frame every 4 s of wall time
 *    (6 s and a cut instead of an ease under reduced motion). It runs only while the store says the
 *    camera follows (cameraFollows: the shared follow flag is on and the playhead is live) and the
 *    camera is not showing the whole sheet. A pan or zoom here turns the shared flag off; the Shell's
 *    Follow control, Shift+F and going live turn it back on.
 */
function followMove(layout: Layout, t: number, cam: Camera, view: { w: number; h: number }, primary: string | null): { camera: Camera | null; primary: string | null } {
  const members: { id: string; r: Rect }[] = [];
  for (const lane of layout.lanes) {
    const cell = lane.cell;
    if (!cell || cell.archived || !lane.flow) continue;
    const idx = cell.visits.length - 1;
    const v = cell.visits[idx];
    if (!v || (v.leftAt !== null && t - v.leftAt > FOLLOW.graceMs)) continue;
    if (!lane.expanded) {
      members.push({ id: lane.id, r: { x: layout.ax, y: lane.y, w: layout.aw, h: lane.h } });
      continue;
    }
    const n = lane.flow.nodes.find((f) => f.visitIndex === idx) ?? (v.station === "human-approval" ? lane.flow.nodes.find((f) => f.col === "human-approval" && f.kind === "gate") : undefined);
    if (!n) continue;
    members.push({ id: lane.id, r: { x: layout.ax + n.x - 80, y: lane.row0 + n.y - 70, w: 160, h: 150 } });
  }
  if (!members.length) return { camera: null, primary: null };
  const toScreen = (r: Rect): Rect => ({ x: cam.x + r.x * cam.k, y: cam.y + r.y * cam.k, w: r.w * cam.k, h: r.h * cam.k });
  const ix = view.w * FOLLOW.inner;
  const iy = view.h * FOLLOW.inner;
  const inside = (r: Rect): boolean => r.x >= ix && r.y >= iy && r.x + r.w <= view.w - ix && r.y + r.h <= view.h - iy;
  if (members.every((m) => inside(toScreen(m.r)))) return { camera: null, primary };
  const union = members.reduce((u, m) => ({ x: Math.min(u.x, m.r.x), y: Math.min(u.y, m.r.y), w: Math.max(u.x + u.w, m.r.x + m.r.w) - Math.min(u.x, m.r.x), h: Math.max(u.y + u.h, m.r.y + m.r.h) - Math.min(u.y, m.r.y) }), members[0]!.r);
  const fits = union.w * cam.k <= view.w - 2 * ix && union.h * cam.k <= view.h - 2 * iy;
  const keep = members.find((m) => m.id === primary) ?? members[0]!;
  const target = fits ? union : keep.r;
  const camera = { x: view.w / 2 - (target.x + target.w / 2) * cam.k, y: view.h / 2 - (target.y + target.h / 2) * cam.k, k: cam.k };
  if (Math.abs(camera.x - cam.x) < view.w * FOLLOW.minMove && Math.abs(camera.y - cam.y) < view.h * FOLLOW.minMove) return { camera: null, primary: keep.id };
  return { camera, primary: fits ? null : keep.id };
}

export function BlueprintView() {
  const store = useStore();
  const actions = useSceneActions();
  const scene = useScene();
  const tree = treeOf(scene);
  const baseTemplate = useColumns();
  const reduced = useSceneStore((s) => s.reducedMotion);
  const theater = useSceneStore((s) => s.theater);
  const focusReq = useSceneStore((s) => s.focus);
  const selection = useSceneStore((s) => s.selection);

  // Which lanes are open: what the person opened, and the defaults (every wave; each lane as decided
  // when it was first seen) less what the person closed.
  const [laneDefaults] = useState<LaneDefaults>(() => new Map());
  noteLanes(tree, laneDefaults);
  const [userOpen, setUserOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [userClosed, setUserClosed] = useState<ReadonlySet<string>>(() => new Set());
  const defaults = useMemo(() => defaultOpen(tree, laneDefaults), [tree, laneDefaults]);
  const expanded = useMemo(() => {
    const out = new Set(userOpen);
    for (const id of defaults) if (!userClosed.has(id)) out.add(id);
    return out;
  }, [userOpen, userClosed, defaults]);

  // Expand to what the store names: a focus request or a selection made elsewhere (the inspector, the
  // Atlas, the Shell bringing this view up with a selection).
  const [seen, setSeen] = useState<{ nonce: number | null; selection: EntityRef | null }>({ nonce: null, selection: null });
  if (focusReq && focusReq.nonce !== seen.nonce) {
    setSeen({ nonce: focusReq.nonce, selection: seen.selection });
    if (focusReq.target !== "overview") {
      const open = opensFor(tree, focusReq.target);
      if (open.some((o) => !expanded.has(o))) {
        setUserOpen(new Set([...userOpen, ...open]));
        setUserClosed(new Set([...userClosed].filter((c) => !open.includes(c))));
      }
    }
  }
  if (selection !== seen.selection) {
    setSeen({ nonce: focusReq?.nonce ?? seen.nonce, selection });
    if (selection && DEEP.has(refKind(selection))) {
      const open = opensFor(tree, selection);
      if (open.some((o) => !expanded.has(o))) {
        setUserOpen(new Set([...userOpen, ...open]));
        setUserClosed(new Set([...userClosed].filter((c) => !open.includes(c))));
      }
    }
  }

  // The sheet: its width fixed (landscape at the base height), the belt's columns spread across it; its
  // height planned from the history so far at the default expansion, growing in steps, never shrinking.
  const template = useMemo(() => (baseTemplate ? spreadTemplate(baseTemplate, drawingWidth(baseTemplate)) : null), [baseTemplate]);
  const needed = useMemo(() => (template ? computeLayout(scene, tree, defaults, template).height : 0), [scene, tree, defaults, template]);
  const [peak, setPeak] = useState(0);
  const planned = template ? plannedFrom(needed, peak) : 0;
  if (planned > peak) setPeak(planned);
  const layout: Layout | null = useMemo(() => (template ? computeLayout(scene, tree, expanded, template, planned) : null), [scene, tree, expanded, template, planned]);
  const layoutRef = useRef<Layout | null>(layout);
  useLayoutEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  // ---------------------------------------------------------------- the tree's keyboard state
  const [activeId, setActiveId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const elements = useRef(new Map<string, SVGGElement>());
  const register = useCallback((id: string, el: SVGGElement | null) => {
    if (el) elements.current.set(id, el);
    else elements.current.delete(id);
  }, []);
  const tabStop = activeId && layout?.visible.includes(activeId) ? activeId : (layout?.visible[0] ?? null);
  const ctx: TreeCtx = useMemo(() => ({ activeId: tabStop, focusedId, register }), [tabStop, focusedId, register]);

  // ---------------------------------------------------------------- expansion animation (interface motion)
  const [animating, setAnimating] = useState(false);
  useEffect(() => {
    if (!animating) return;
    const id = window.setTimeout(() => setAnimating(false), 460);
    return () => window.clearTimeout(id);
  }, [animating]);

  const toggle = useCallback(
    (id: string, open?: boolean) => {
      const isOpen = expanded.has(id);
      const next = open ?? !isOpen;
      if (next === isOpen) return;
      if (!reduced) setAnimating(true);
      if (next) {
        setUserOpen((s) => new Set(s).add(id));
        setUserClosed((s) => {
          const c = new Set(s);
          c.delete(id);
          return c;
        });
      } else {
        setUserOpen((s) => {
          const c = new Set(s);
          c.delete(id);
          return c;
        });
        setUserClosed((s) => new Set(s).add(id));
      }
    },
    [expanded, reduced],
  );

  // ---------------------------------------------------------------- camera (interface state)
  const viewport = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const cam = useRef<Camera>({ x: 0, y: 0, k: 1 });
  const anim = useRef<{ stop(): void } | null>(null);
  const placed = useRef(false);
  /** True while the camera shows the composed whole sheet: then a resized stage re-fits. */
  const fitted = useRef(false);
  const lod = useRef<"overview" | "detail" | "near">("detail");
  /** The last focus request the camera honoured (the Shell's request at mount counts as honoured by the first placement). */
  const handledFocus = useRef<number | null>(null);
  const size = useCallback(() => ({ w: viewport.current?.clientWidth ?? 0, h: viewport.current?.clientHeight ?? 0 }), []);
  /** Px of the stage's right side under a drawer (the narrow-window inspector). */
  const cover = useRef(0);
  /** The part of the stage nothing covers: where a framed target is centred and the follow camera aims. */
  const open = useCallback(() => {
    const v = size();
    return { w: Math.max(1, v.w - cover.current), h: v.h };
  }, [size]);
  /**
   * Keep the sheet readable (camera.ts `clamp`) in the part of the stage nothing covers, with room past
   * its right edge for the corner, so the last column can be brought clear of it.
   */
  const keep = useCallback(
    (c: Camera): Camera => {
      const L = layoutRef.current;
      return clamp(c, open(), L ? { w: L.width, h: L.height } : { w: 1, h: 1 }, CORNER_W);
    },
    [open],
  );
  const [camStore] = useState(() => createCameraStore());
  // The overlays see the part of the stage a drawer leaves: the overview's view frame, the rulers' length
  // and whether the sheet's own title block is in view are about what can be seen.
  useLayoutEffect(() => camStore.setSize(open), [camStore, open]);
  const [hits] = useState(() => createHitRegistry());
  const [band, setBand] = useState<readonly [number, number]>([-Infinity, Infinity]);
  const [lodState, setLodState] = useState<"overview" | "detail" | "near">("detail");

  const apply = useCallback(
    (c: Camera) => {
      cam.current = c;
      const el = stage.current;
      const L = layoutRef.current;
      if (el) {
        el.style.transform = `translate(${c.x}px, ${c.y}px) scale(${c.k})`;
        // Pinned gutter and column head: how far the sheet's left edge and the head have scrolled off.
        const { gx, hy } = L ? pinOffsets(c, L) : { gx: 0, hy: 0 };
        el.style.setProperty("--bp-gx", `${gx}px`);
        el.style.setProperty("--bp-hy", `${hy}px`);
        const prev = lod.current;
        const next = c.k > LOD.near ? "near" : prev === "overview" ? (c.k > LOD.overviewOut ? "detail" : "overview") : c.k < LOD.overviewIn ? "overview" : "detail";
        if (next !== prev || !el.dataset.lod) {
          lod.current = next;
          el.dataset.lod = next;
          setLodState(next);
        }
      }
      camStore.set(c);
      const h = viewport.current?.clientHeight ?? 1000;
      // The band of the sheet that is rendered in full: the view and half a screen either side, in steps of 200.
      const top = Math.floor((-c.y / c.k - (0.5 * h) / c.k) / 200) * 200;
      const bottom = Math.ceil((-c.y / c.k + (1.5 * h) / c.k) / 200) * 200;
      setBand((b) => (b[0] === top && b[1] === bottom ? b : [top, bottom]));
    },
    [camStore],
  );
  const moveTo = useCallback(
    (target: Camera, smooth: boolean, ms = 650) => {
      anim.current?.stop();
      const goal = keep(target);
      if (!smooth || reduced) {
        apply(goal);
        return;
      }
      const from = cam.current;
      anim.current = animate(0, 1, {
        duration: ms / 1000,
        ease: [0.2, 0, 0, 1],
        onUpdate: (p) => {
          const k = Math.exp(Math.log(from.k) + (Math.log(goal.k) - Math.log(from.k)) * p);
          apply({ x: from.x + (goal.x - from.x) * p, y: from.y + (goal.y - from.y) * p, k });
        },
      });
    },
    [apply, reduced, keep],
  );
  /** The establishing view: the whole sheet, composed in the part of the stage nothing covers. */
  const fitCam = useCallback((L: Layout) => {
    const v = open();
    return fitCamera(v, { x: 0, y: 0, w: L.width, h: L.height });
  }, [open]);
  const fit = useCallback(() => {
    const L = layoutRef.current;
    if (!L) return;
    fitted.current = true;
    moveTo(fitCam(L), true);
  }, [fitCam, moveTo]);
  const manual = useCallback(() => {
    fitted.current = false;
    if (store.getState().follow) store.setFollow(false);
  }, [store]);

  // Keep what the camera shows where it is when the history changes the layout (anchorShift). A change
  // the person made (opening or closing a lane) is left to the lanes' own transition; a fitted camera
  // re-fits when the sheet has grown a step.
  const shown = useRef<{ layout: Layout | null; userOpen: ReadonlySet<string>; userClosed: ReadonlySet<string> }>({ layout: null, userOpen, userClosed });
  useLayoutEffect(() => {
    const prev = shown.current;
    shown.current = { layout, userOpen, userClosed };
    if (!layout || !prev.layout || prev.layout === layout || !placed.current) return;
    if (prev.userOpen !== userOpen || prev.userClosed !== userClosed) return;
    if (fitted.current) {
      if (prev.layout.height !== layout.height || prev.layout.width !== layout.width) moveTo(fitCam(layout), true);
      return;
    }
    const c = cam.current;
    const viewTop = (RULER + PIN_GAP + HEAD_H * c.k - c.y) / c.k;
    const sel = store.getState().selection;
    const dy = anchorShift(prev.layout, layout, [sel ? nodeForRef(tree, sel) : null, focusedId, activeId], viewTop);
    if (Math.abs(dy) < 0.5) return;
    anim.current?.stop();
    apply(keep({ ...c, y: c.y - dy * c.k }));
  }, [layout, userOpen, userClosed, tree, focusedId, activeId, store, apply, keep, moveTo, fitCam]);

  // First placement: framed on the selection the Shell brings us up with, else the whole sheet.
  useLayoutEffect(() => {
    if (!layout || placed.current) return;
    const v = open();
    if (!size().w) return;
    const sel = store.getState().selection;
    const rect = sel ? boundsFor(layout, tree, sel, store.getState().playhead) : null;
    const first = keep(rect ? frameOf(v, layout, rect) : fitCam(layout));
    fitted.current = !rect;
    if (stage.current) stage.current.style.transform = `translate(${first.x}px, ${first.y}px) scale(${first.k})`;
    const id = requestAnimationFrame(() => {
      placed.current = true;
      handledFocus.current = store.getState().focus?.nonce ?? null;
      apply(first);
    });
    return () => cancelAnimationFrame(id);
  }, [layout, apply, size, open, keep, fitCam, store, tree]);

  // Keep the composition when the stage resizes (inspector, timeline, Theater): re-fit if fitted, else
  // keep the sheet point at the centre where it was.
  useEffect(() => {
    const el = viewport.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let last = { w: el.clientWidth, h: el.clientHeight };
    const observer = new ResizeObserver(() => {
      const now = { w: el.clientWidth, h: el.clientHeight };
      const L = layoutRef.current;
      if (!L || !placed.current || (now.w === last.w && now.h === last.h)) return;
      const c = cam.current;
      if (fitted.current) apply(keep(fitCam(L)));
      else apply(keep({ x: c.x + (now.w - last.w) / 2, y: c.y + (now.h - last.h) / 2, k: c.k }));
      last = now;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [apply, keep, fitCam]);

  // A drawer over the stage (the inspector below 1280 px): the corner moves left of it as it slides
  // (`--bp-cover-r`, every frame of its transition), notes re-place themselves, and once it has settled
  // the camera keeps what it framed in the part the drawer leaves: a fitted sheet is re-fitted, and a
  // selection whose mark is now under the drawer is brought out from under it.
  const treeRef = useRef(tree);
  useLayoutEffect(() => {
    treeRef.current = tree;
  }, [tree]);
  useEffect(() => {
    const vp = viewport.current;
    if (!vp) return;
    let raf = 0;
    let until = 0;
    let settled = cover.current;
    const react = (): void => {
      const L = layoutRef.current;
      const prev = settled;
      settled = cover.current;
      if (!L || !placed.current || settled === prev) return;
      if (fitted.current) {
        moveTo(fitCam(L), true);
        return;
      }
      const sel = store.getState().selection;
      const rect = sel && settled > prev ? boundsFor(L, treeRef.current, sel, store.getState().playhead) : null;
      if (!rect) return;
      const c = cam.current;
      const v = open();
      const markX = c.x + (rect.x + rect.w / 2) * c.k;
      const markY = c.y + (rect.y + Math.min(rect.h, 160) / 2) * c.k;
      if (markX <= v.w - 48 || markX > v.w + settled || markY < 0 || markY > v.h) return;
      moveTo({ ...c, x: c.x + (v.w * 0.6 - markX) }, true);
    };
    const measure = (): void => {
      raf = 0;
      const next = coveredRight(vp);
      if (next !== cover.current) {
        cover.current = next;
        vp.style.setProperty("--bp-cover-r", `${next}px`);
        camStore.set(cam.current);
      }
      if (performance.now() < until) raf = requestAnimationFrame(measure);
      else react();
    };
    const kick = (): void => {
      until = performance.now() + 700;
      if (!raf) raf = requestAnimationFrame(measure);
    };
    const watch = new MutationObserver(kick);
    for (const aside of document.querySelectorAll("aside")) if (!aside.contains(vp)) watch.observe(aside, { attributes: true, attributeFilter: ["class", "style", "inert"] });
    window.addEventListener("resize", kick);
    kick();
    return () => {
      watch.disconnect();
      window.removeEventListener("resize", kick);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [camStore, fitCam, moveTo, open, store]);

  /** Where a note on the drawing can be read (callout.tsx), in client px. */
  const clearArea: ClearAreaSource = useMemo(
    () => ({
      subscribe: camStore.subscribe,
      get(): ClearArea | null {
        const vp = viewport.current;
        const L = layoutRef.current;
        if (!vp || !L) return null;
        const box = vp.getBoundingClientRect();
        const c = cam.current;
        const { gx, hy } = pinOffsets(c, L);
        const left = box.left + c.x + (L.ax - 14 + gx) * c.k + 4;
        const top = box.top + c.y + (headTopOf(L) + hy + HEAD_H) * c.k + 2;
        const corner = vp.querySelector(".bp-corner")?.getBoundingClientRect();
        return {
          left: Math.max(box.left, left),
          top: Math.max(box.top, top),
          right: box.right - cover.current,
          bottom: box.bottom,
          corner: corner && corner.height > 0 ? { left: corner.left - 6, top: corner.top - 6 } : null,
        };
      },
    }),
    [camStore],
  );

  // Honour focus requests once the layout shows the target.
  useLayoutEffect(() => {
    if (!focusReq || !layout || !placed.current || handledFocus.current === focusReq.nonce) return;
    const v = open();
    if (!size().w) return;
    if (focusReq.reason === "follow") {
      handledFocus.current = focusReq.nonce;
      return;
    }
    if (focusReq.target === "overview") {
      handledFocus.current = focusReq.nonce;
      fitted.current = true;
      moveTo(fitCam(layout), true);
      return;
    }
    const rect = boundsFor(layout, tree, focusReq.target, store.getState().playhead);
    if (!rect) {
      // The supervisor and the scheduler have no mark on the sheet: nothing to frame, so no camera move.
      if (focusReq.target.startsWith("actor:")) handledFocus.current = focusReq.nonce;
      return;
    }
    handledFocus.current = focusReq.nonce;
    fitted.current = false;
    moveTo(frameOf(v, layout, rect), true);
  });

  // Follow during live playback (rule above), checked against the store, never more than every 4 s.
  useEffect(() => {
    let lastCheck = 0;
    let primary: string | null = null;
    return store.subscribe(() => {
      const s = store.getState();
      // Moving: playback, or a live view pinned to the edge. Never while the connection is stale (a held frame).
      const moving = s.playing || (s.source === "live" && s.following && !isStale(s.connection));
      if (!moving || !cameraFollows(s) || fitted.current) return;
      const now = performance.now();
      if (now - lastCheck < (s.reducedMotion ? FOLLOW.everyReducedMs : FOLLOW.everyMs)) return;
      lastCheck = now;
      const L = layoutRef.current;
      if (!L) return;
      const d = followMove(L, s.playhead, cam.current, open(), primary);
      primary = d.primary;
      if (d.camera) moveTo(d.camera, !s.reducedMotion, FOLLOW.easeMs);
    });
  }, [store, open, moveTo]);

  // Wheel: pinch or Ctrl/Cmd + wheel zooms to the cursor; plain wheel and two-finger scroll pan.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      anim.current?.stop();
      manual();
      const c = cam.current;
      if (e.ctrlKey || e.metaKey) {
        const box = el.getBoundingClientRect();
        const cx = e.clientX - box.left;
        const cy = e.clientY - box.top;
        const k = Math.min(3, Math.max(0.35, c.k * Math.pow(1.0015, -e.deltaY * (e.deltaMode === 1 ? 16 : 1))));
        apply(keep({ x: cx - (cx - c.x) * (k / c.k), y: cy - (cy - c.y) * (k / c.k), k }));
      } else {
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
        apply(keep({ x: c.x - dx, y: c.y - dy, k: c.k }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [apply, keep, manual]);

  const zoomBy = useCallback(
    (f: number) => {
      manual();
      const v = open();
      const c = cam.current;
      const k = Math.min(3, Math.max(0.35, c.k * f));
      moveTo({ x: v.w / 2 - (v.w / 2 - c.x) * (k / c.k), y: v.h / 2 - (v.h / 2 - c.y) * (k / c.k), k }, true);
    },
    [moveTo, open, manual],
  );

  /** +, - and 0 (spec f.10, "in a view"). True when the key was one of them. */
  const zoomKey = useCallback(
    (key: string): boolean => {
      if (key === "+" || key === "=") zoomBy(1.2);
      else if (key === "-") zoomBy(1 / 1.2);
      else if (key === "0") fit();
      else return false;
      return true;
    },
    [zoomBy, fit],
  );

  // The zoom keys are the view's, as in the Shell's map: they act when focus is in the Blueprint (its
  // tree handles them itself; this covers its toolbar and overview buttons), or when nothing holds focus
  // (the page or the stage itself) and the Blueprint is the view on the stage. Never from a text field,
  // a dialog, the timeline, the inspector or the top bar: there focus is elsewhere, so the key is theirs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const vp = viewport.current;
      if (!vp) return;
      const active = document.activeElement;
      const inside = Boolean(active && vp.contains(active));
      const idle = !active || active === document.body || active.id === "stage";
      if (!inside && !(idle && store.getState().view === "blueprint")) return;
      if (active instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) || active.isContentEditable)) return;
      if (document.querySelector("dialog[open], [aria-modal='true']")) return;
      if (zoomKey(e.key)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomKey, store]);

  // ---------------------------------------------------------------- pointer: pan, select, hover, toggle
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean; id: number } | null>(null);
  /** The entity under the pointer: a mark, or a call found by x on a batched tick trace. */
  const hitAt = (e: ReactPointerEvent | React.MouseEvent): { ref: EntityRef | null; tid: string | null; toggle: boolean } => {
    const target = e.target as Element;
    const ticks = target.closest?.("[data-ticks]");
    if (ticks && viewport.current) {
      const list = hits.get(ticks.getAttribute("data-ticks") ?? "");
      const box = viewport.current.getBoundingClientRect();
      const sx = (e.clientX - box.left - cam.current.x) / cam.current.k;
      const i = list ? nearestHit(list, sx, 5 / Math.min(1, cam.current.k)) : null;
      if (list && i !== null) return { ref: list.refs[i] ?? null, tid: list.tids[i] ?? null, toggle: false };
    }
    const el = target.closest?.("[data-ref]");
    const tid = target.closest?.("[data-tid]")?.getAttribute("data-tid") ?? null;
    return { ref: (el?.getAttribute("data-ref") as EntityRef | null) ?? null, tid, toggle: Boolean(target.closest?.("[data-toggle]")) };
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as Element).closest?.(".bp-chrome")) return;
    anim.current?.stop();
    drag.current = { x: e.clientX, y: e.clientY, cx: cam.current.x, cy: cam.current.y, moved: false, id: e.pointerId };
  };
  const hovered = useRef<EntityRef | null>(null);
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d) {
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) > 4) {
        d.moved = true;
        manual();
        viewport.current?.setPointerCapture(d.id);
      }
      const L = layoutRef.current;
      if (d.moved && L) apply(keep({ x: d.cx + dx, y: d.cy + dy, k: cam.current.k }));
      return;
    }
    if ((e.target as Element).closest?.(".bp-chrome")) return;
    const hit = hitAt(e);
    let next = hit.ref;
    // A lane (or the wave) is hovered from its gutter only: hovering a lane's empty floor must not dim the sheet.
    if (next && hit.tid && (hit.tid.startsWith("s:") || hit.tid.startsWith("w:")) && !(e.target as Element).closest?.("[data-gutter]")) next = null;
    if (next !== hovered.current) {
      hovered.current = next;
      actions.hover(next);
    }
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved) {
      viewport.current?.releasePointerCapture(d.id);
      return;
    }
    const hit = hitAt(e);
    if (hit.toggle && hit.tid) {
      toggle(hit.tid);
      setActiveId(hit.tid);
      return;
    }
    if (hit.ref) {
      actions.select(hit.ref, { focus: false });
      const id = hit.tid ?? nodeForRef(tree, hit.ref);
      if (id) setActiveId(id);
    } else actions.select(null);
  };
  const onPointerLeave = () => {
    if (hovered.current) {
      hovered.current = null;
      actions.hover(null);
    }
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as Element).closest?.(".bp-chrome")) return;
    const hit = hitAt(e);
    if (hit.ref) actions.select(hit.ref);
  };

  // ---------------------------------------------------------------- keyboard: ARIA tree navigation
  const focusItem = useCallback((id: string) => setActiveId(id), []);
  const lastFocused = useRef<string | null>(null);
  useEffect(() => {
    if (!activeId || lastFocused.current === activeId) return;
    const el = elements.current.get(activeId);
    if (!el && layout && viewport.current?.contains(document.activeElement)) {
      // An item of a lane the camera is far from is not mounted yet: bring its lane on screen first.
      const node = tree.byId.get(activeId);
      const r = layout.bounds.get(activeId) ?? (node?.parent ? layout.bounds.get(node.parent) : undefined);
      if (r) {
        manual();
        moveTo({ ...cam.current, y: size().h * 0.35 - r.y * cam.current.k }, false);
      }
      return;
    }
    if (el && viewport.current?.contains(document.activeElement)) {
      lastFocused.current = activeId;
      el.focus({ preventScroll: true });
      const r = layout?.bounds.get(activeId);
      if (r && layout) {
        const v = size();
        const c = cam.current;
        const top = c.y + r.y * c.k;
        const bottom = c.y + (r.y + Math.min(r.h, 120)) * c.k;
        // Clear of the ruler and the pinned column head, which cover the top of the stage.
        const clear = RULER + PIN_GAP + HEAD_H * c.k + 12;
        if (top < clear || bottom > v.h - 40) {
          manual();
          moveTo({ ...c, y: Math.max(clear + 8, v.h * 0.35) - r.y * c.k }, true);
        }
      }
    }
  });

  const onKeyDown = (e: ReactKeyboardEvent<SVGGElement>) => {
    if (!layout) return;
    const current = (e.target as Element).closest?.("[data-tid]")?.getAttribute("data-tid") ?? tabStop;
    if (!current) return;
    const vis = layout.visible;
    const i = vis.indexOf(current);
    const node = tree.byId.get(current);
    let handled = true;
    switch (e.key) {
      case "ArrowDown":
        if (e.shiftKey) handled = false;
        else if (i < vis.length - 1) focusItem(vis[i + 1] as string);
        break;
      case "ArrowUp":
        if (e.shiftKey) handled = false;
        else if (i > 0) focusItem(vis[i - 1] as string);
        break;
      case "ArrowRight":
        if (e.shiftKey) {
          handled = false;
          break;
        }
        if (node && node.children.length) {
          if (!expanded.has(current)) toggle(current, true);
          else if (!e.altKey) focusItem(node.children[0]!.id);
        }
        break;
      case "ArrowLeft":
        if (e.shiftKey) {
          handled = false;
          break;
        }
        if (node && node.children.length && expanded.has(current)) toggle(current, false);
        else if (node?.parent && !e.altKey) focusItem(node.parent);
        break;
      case "Home":
        focusItem(vis[0] as string);
        break;
      case "End":
        focusItem(vis[vis.length - 1] as string);
        break;
      case "Enter":
      case " ":
        if (node) actions.select(node.ref, { focus: false });
        break;
      case "*": {
        const siblings = node?.parent ? (tree.byId.get(node.parent)?.children ?? []) : [];
        setUserOpen(new Set([...userOpen, ...siblings.filter((s) => s.children.length).map((s) => s.id)]));
        setUserClosed(new Set([...userClosed].filter((c) => !siblings.some((s) => s.id === c))));
        if (!reduced) setAnimating(true);
        break;
      }
      case "Escape": {
        // As the Shell's map has it: clear the hover highlight, then the selection; then let the Shell have it.
        const s = store.getState();
        if (s.hovered) actions.hover(null);
        else if (s.selection) actions.select(null);
        else handled = false;
        break;
      }
      default:
        // + - 0, unless with Ctrl or Meta: those are the browser's own zoom, not the view's.
        handled = !e.metaKey && !e.ctrlKey && !e.altKey && zoomKey(e.key);
    }
    if (!handled && e.shiftKey && e.key.startsWith("Arrow") && layout) {
      const c = cam.current;
      const step = 80;
      const dx = e.key === "ArrowLeft" ? step : e.key === "ArrowRight" ? -step : 0;
      const dy = e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0;
      manual();
      moveTo({ x: c.x + dx, y: c.y + dy, k: c.k }, true);
      handled = true;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // ---------------------------------------------------------------- overview actions
  const centreOn = useCallback(
    (x: number, y: number) => {
      manual();
      const v = open();
      const c = cam.current;
      moveTo({ x: v.w / 2 - x * c.k, y: v.h / 2 - y * c.k, k: c.k }, false);
    },
    [manual, moveTo, open],
  );
  const frameLane = useCallback(
    (laneId: string) => {
      const L = layoutRef.current;
      const lane = L?.lanes.find((l) => l.id === laneId);
      if (!L || !lane) return;
      manual();
      moveTo(frameOf(open(), L, { x: SHEET.left, y: lane.y, w: L.width - SHEET.left * 2, h: lane.h }), true);
      setActiveId(laneId);
    },
    [manual, moveTo, open],
  );

  // ---------------------------------------------------------------- render
  const [gutterEl, setGutterEl] = useState<SVGGElement | null>(null);
  const [rowsEl, setRowsEl] = useState<SVGGElement | null>(null);
  const layers = useMemo(() => ({ gutter: gutterEl, rows: rowsEl, animate: animating }), [gutterEl, rowsEl, animating]);
  const sheet = sheetFacts(scene, tree.roots.flatMap((r) => (r.data.kind === "wave" ? [r.data.wave] : [])));
  const facts = sheet.facts;
  const furniture = layout ? furnitureBox(layout) : null;
  const hasWaves = tree.roots.length > 0;
  return (
    <CameraContext.Provider value={camStore}>
      <ClearContext.Provider value={clearArea}>
      <HitContext.Provider value={hits}>
        <div
          ref={viewport}
          className="bp-viewport"
          data-view="blueprint"
          data-theater={theater ? "1" : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerLeave}
          onDoubleClick={onDoubleClick}
          role="presentation"
        >
          <div ref={stage} className="bp-stage">
            {layout && template && furniture ? (
              <FactoryScene label={`Execution Blueprint (${scene.provenance.label.toLowerCase()})`} interactive width={layout.width} height={layout.height} ground={false}>
                <BlueprintSheet
                  width={layout.width}
                  height={layout.height}
                  title="Execution Blueprint"
                  subtitle={sheet.subtitle}
                  simulationLabel={sheet.stamp}
                  zonesX={zoneCounts(layout).zx}
                  zonesY={zoneCounts(layout).zy}
                  facts={facts}
                  titleBlock="strip"
                >
                  <SimulatedContext.Provider value={scene.provenance.source === "simulation"}>
                  <LodContext.Provider value={lodState}>
                  <LayersContext.Provider value={layers}>
                    <BandContext.Provider value={band}>
                      <TreeContext.Provider value={ctx}>
                        <g role="tree" aria-label={hasWaves ? "Execution hierarchy: waves, slices, executions, station visits, agents, tool calls" : "Execution hierarchy: empty, no wave has arrived yet"} tabIndex={hasWaves ? undefined : 0} onKeyDown={onKeyDown} onFocus={(e) => setFocusedId((e.target as Element).getAttribute("data-tid"))} onBlur={() => setFocusedId(null)}>
                          {layout.waves.map((band, i) => (
                            <WaveItem key={band.id} band={band} pos={i + 1} size={layout.waves.length} layout={layout} template={template} animate={animating} />
                          ))}
                          {!hasWaves ? <PlaceholderBelt layout={layout} template={template} /> : null}
                        </g>
                        <DependencyLayer scene={scene} lanes={layout.lanes} ax={layout.ax} aw={layout.aw} template={template} />
                        {/* Pinned layers, drawn last: the gutters, then the column head above them. */}
                        <g ref={setGutterEl} />
                        <g ref={setRowsEl} />
                        <ColumnHead layout={layout} template={template} y={layout.waveY + 48} />
                      </TreeContext.Provider>
                    </BandContext.Provider>
                  </LayersContext.Provider>
                  </LodContext.Provider>
                  </SimulatedContext.Provider>
                  <Legend x={furniture.legend.x} y={furniture.legend.y} overview={lodState === "overview" || (theater && lodState !== "near")} />
                  <Revisions x={furniture.rev.x} y={furniture.rev.y} w={furniture.rev.w} h={furniture.rev.h} overview={lodState === "overview"} />
                </BlueprintSheet>
                <PlayheadFact width={layout.width} height={layout.height} factIndex={2} factCount={facts.length} />
                <StaleNote width={layout.width} height={layout.height} factCount={facts.length} />
              </FactoryScene>
            ) : (
              <p className="bp-pending">Laying out the drawing…</p>
            )}
          </div>
          {layout && template ? (
            <div className="bp-chrome" aria-hidden={theater ? true : undefined}>
              <ZoneRulers layout={layout} />
            </div>
          ) : null}
          {/* The corner: overview, playhead chip and zoom toolbar stacked, never over one another, and
              kept left of a drawer that covers the stage (--bp-cover-r). */}
          <div className="bp-corner bp-chrome">
            {layout && template && !theater ? <Minimap layout={layout} template={template} centreOn={centreOn} frameLane={frameLane} /> : null}
            {layout ? <PinnedTitle layout={layout} theater={theater} stamp={sheet.stamp} /> : null}
            {theater ? null : (
              <div className="bp-controls" role="toolbar" aria-label="Blueprint camera">
                <button type="button" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out">
                  −
                </button>
                <ZoomWord />
                <button type="button" onClick={() => zoomBy(1.2)} aria-label="Zoom in">
                  +
                </button>
                <button type="button" onClick={fit} aria-label="Fit the whole sheet">
                  Fit
                </button>
              </div>
            )}
          </div>
        </div>
      </HitContext.Provider>
      </ClearContext.Provider>
    </CameraContext.Provider>
  );
}

function ZoomWord() {
  const cam = useCamera();
  return (
    <span className="bp-zoom tabular" aria-live="off">
      {Math.round(cam.k * 100)}%
    </span>
  );
}

function WaveItem({ band, pos, size, layout, template, animate }: { band: WaveBand; pos: number; size: number; layout: Layout; template: ColumnTemplate; animate: boolean }) {
  const node = band.node;
  const selected = useSceneStore((s) => s.selection === node.ref);
  const wave = node.data.kind === "wave" ? node.data.wave : null;
  const ring = { x: SHEET.left, y: band.y + 4, w: 420, h: SHEET.waveHeader - 12 };
  return <WaveTreeItem node={node} pos={pos} size={size} band={band} ring={ring} layout={layout} selected={selected} wave={wave} template={template} animate={animate} />;
}

function WaveTreeItem({ node, pos, size, band, ring, layout, selected, wave, template, animate }: { node: TreeNode; pos: number; size: number; band: WaveBand; ring: Rect; layout: Layout; selected: boolean; wave: WaveState | null; template: ColumnTemplate; animate: boolean }) {
  const x = SHEET.left;
  const y = band.y;
  const w = layout.width - SHEET.left * 2;
  const lanes = band.lanes;
  // A wave the history names without its definition: its id stands as its title, and the line says so.
  const titled = wave ? isKnown(wave.meta, "title") : false;
  const meta = wave ? `${wave.id} · ${lanes.length} slice${lanes.length === 1 ? "" : "s"}${titled ? "" : " · title not recorded"} · approved by ${wave.approvedBy}` : "";
  return (
    <Item
      node={node}
      pos={pos}
      size={size}
      expanded={band.expanded}
      ring={ring}
      group={lanes.map((lane: Lane, i) => (
        <LaneView key={lane.id} lane={lane} pos={i + 1} size={lanes.length} rows={lane.rows} layout={layout} template={template} animate={animate} />
      ))}
    >
      <line x1={x} y1={y} x2={x + w} y2={y} style={{ stroke: fc("ink-soft"), strokeWidth: 1.75 }} />
      <Gutter id={node.id} entity={node.ref} y={y + 2} h={44} ax={layout.ax} band={0}>
        {selected ? <SelectBar x={x - 2} y={0} h={42} /> : null}
        <ToggleTarget x={x + 8} y={22} />
        <Chevron x={x + 8} y={22} open={band.expanded} />
        <text x={x + 20} y={27} className="bp-fine" style={{ fill: "var(--mach-ink)", fontFamily: "var(--mach-font-sans)", fontSize: 21, fontWeight: 700 }}>
          {wave?.title ?? ""}
        </text>
        <text x={x + 20} y={41} className="bp-fine notranslate" style={{ fill: "var(--mach-ink-muted)", fontFamily: "var(--mach-font-mono)", fontSize: 9.5 }}>
          {meta}
        </text>
        <text x={x + 20} y={36} className="bp-over" style={{ fill: "var(--mach-ink)", fontFamily: "var(--mach-font-sans)", fontSize: 44, fontWeight: 700 }}>
          {wave?.title ?? ""}
        </text>
      </Gutter>
    </Item>
  );
}

/** Sheet units framed around a focused station or gate: the node and two or three columns either side. */
const NEIGHBOURHOOD = 760;

/** Where an entity is on the sheet, for the camera. */
function boundsFor(layout: Layout, tree: Tree, entity: EntityRef, playhead: number): Rect | null {
  const id = nodeForRef(tree, entity);
  if (!id) return null;
  const node = tree.byId.get(id);
  if (!node) return null;
  const direct = layout.bounds.get(id);
  if (node.kind === "visit" || node.kind === "gate" || node.kind === "execution" || node.kind === "relay") {
    const lane = layout.lanes.find((l) => l.cell?.ticketId === node.ticketId);
    if (lane) {
      const h = Math.max(140, lane.dimsY + lane.dimRows * SHEET.dimBand - lane.y);
      // A station visit or a gate: its node in the lane's drawing with the columns either side, so it
      // is read at a working zoom rather than as one mark in a whole-width lane.
      const d = node.data;
      const n = lane.expanded ? lane.flow?.nodes.find((f) => (d.kind === "gate" ? f.gate?.id === d.gate.id : d.kind === "visit" ? f.visitIndex === d.index : false)) : undefined;
      if (n) return { x: layout.ax + n.x - NEIGHBOURHOOD / 2, y: lane.y, w: NEIGHBOURHOOD, h };
      return { x: SHEET.left, y: lane.y, w: layout.width - SHEET.left * 2, h };
    }
  }
  if (node.kind === "tool" || node.kind === "artifact" || node.kind === "finding") return leafBounds(layout, tree, node, playhead) ?? direct ?? null;
  if (node.kind === "slice") {
    const lane = layout.lanes.find((l) => l.id === id);
    if (lane) return { x: SHEET.left, y: lane.y, w: layout.width - SHEET.left * 2, h: lane.h };
  }
  if (direct) return direct;
  return null;
}
