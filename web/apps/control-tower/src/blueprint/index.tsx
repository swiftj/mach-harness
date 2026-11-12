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
 * as the fixture uses them (with the review seats as one layer); the columns are then fixed for the
 * whole run, so nothing re-lays out as time passes. What we give up: React Flow's built-in minimap,
 * controls and edge routing, which are drawn here instead, to the grammar.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { animate } from "motion/react";
import { BlueprintSheet, FactoryScene, fc } from "@mach/ui";
import type { EntityRef, Scene, WaveState } from "../sim";
import { finalScene, refKind } from "../sim";
import { cameraFollows, useScene, useSceneActions, useSceneStore, useStore } from "../scene";
import { spreadTemplate, useColumns, type ColumnTemplate } from "./columns";
import { computeLayout, drawingWidthFor, SHEET, type Lane, type Layout, type Rect } from "./layout";
import { DependencyLayer, LaneView } from "./Lane";
import { clamp, fitCamera, focusCamera, type Camera } from "./camera";
import { leafBounds } from "./bounds";
import { PlayheadFact } from "./TitleBlock";
import { ancestors, nodeForRef, treeOf, type Tree, type TreeNode } from "./tree";
import { BandContext, Chevron, Item, SelectBar, ToggleTarget, TreeContext, type TreeCtx } from "./treeitem";
import { CameraContext, createCameraStore, createHitRegistry, HitContext, LayersContext, LodContext, nearestHit, useCamera } from "./context";
import { ColumnHead, furnitureBox, Legend, Revisions } from "./furniture";
import { Minimap, PinnedTitle, ZoneRulers, zoneCounts } from "./overlays";
import { Gutter } from "./gutter";
import { PlaceholderBelt } from "./Placeholder";
import "./blueprint.css";

const DEEP = new Set(["agent", "tool", "artifact", "finding"]);

/** Levels of detail by camera zoom, with hysteresis: overview swaps fine text for large lettering. */
const LOD = { overviewIn: 0.55, overviewOut: 0.6, near: 1.4 } as const;

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

function defaultOpen(tree: Tree): Set<string> {
  const out = new Set<string>();
  if (tree.root) {
    out.add(tree.root.id);
    for (const lane of tree.root.children) out.add(lane.id);
  }
  return out;
}

/** The sheet's planned height: the whole run at the default expansion, so the paper does not grow under a fitted camera. */
const plannedCache = new WeakMap<ColumnTemplate, number>();
function plannedHeight(template: ColumnTemplate, scene: Scene): number {
  let h = plannedCache.get(template);
  if (h === undefined) {
    const tree = treeOf(scene);
    h = computeLayout(scene, tree, defaultOpen(tree), template).height;
    plannedCache.set(template, h);
  }
  return h;
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
  const fixture = useSceneStore((s) => s.fixture);
  const scene = useScene();
  const tree = treeOf(scene);
  const baseTemplate = useColumns(fixture);
  const reduced = useSceneStore((s) => s.reducedMotion);
  const theater = useSceneStore((s) => s.theater);
  const focusReq = useSceneStore((s) => s.focus);
  const selection = useSceneStore((s) => s.selection);

  // Which lanes are open. Lanes that appear later (a slice dispatched mid-run) open by default.
  const [userOpen, setUserOpen] = useState<ReadonlySet<string>>(() => defaultOpen(tree));
  const [userClosed, setUserClosed] = useState<ReadonlySet<string>>(() => new Set());
  const expanded = useMemo(() => {
    const out = new Set(userOpen);
    if (tree.root) {
      if (!userClosed.has(tree.root.id)) out.add(tree.root.id);
      for (const lane of tree.root.children) if (!userClosed.has(lane.id)) out.add(lane.id);
    }
    return out;
  }, [userOpen, userClosed, tree]);

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

  // The sheet is cut once for the whole run: its height from the run at the default expansion, its
  // width landscape to the stage's proportion, and the belt's columns spread across that width.
  const planned = useMemo(() => (baseTemplate ? plannedHeight(baseTemplate, finalScene(fixture)) : 0), [baseTemplate, fixture]);
  const template = useMemo(() => (baseTemplate ? spreadTemplate(baseTemplate, drawingWidthFor(planned, baseTemplate.width)) : null), [baseTemplate, planned]);
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
  const [camStore] = useState(() => createCameraStore());
  useLayoutEffect(() => camStore.setSize(size), [camStore, size]);
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
        const gx = L ? Math.min(Math.max(0, -c.x / c.k - SHEET.left + 6), L.width - SHEET.gutter - 40) : 0;
        const headTop = L ? L.waveY + 48 : 0;
        const hy = L ? Math.min(Math.max(0, -c.y / c.k - headTop + 2), L.height - headTop - 200) : 0;
        el.style.setProperty("--bp-gx", `${gx}px`);
        el.style.setProperty("--bp-hy", `${Math.max(0, hy)}px`);
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
      const L = layoutRef.current;
      const sheet = L ? { w: L.width, h: L.height } : { w: 1, h: 1 };
      const goal = clamp(target, size(), sheet);
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
    [apply, reduced, size],
  );
  /** The establishing view: the whole sheet, composed in the stage (the container, not the window). */
  const fitCam = useCallback((L: Layout) => {
    const v = size();
    return fitCamera(v, { x: 0, y: 0, w: L.width, h: L.height });
  }, [size]);
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

  // First placement: framed on the selection the Shell brings us up with, else the whole sheet.
  useLayoutEffect(() => {
    if (!layout || placed.current) return;
    const v = size();
    if (!v.w) return;
    const sel = store.getState().selection;
    const rect = sel ? boundsFor(layout, tree, sel, store.getState().playhead) : null;
    const first = clamp(rect ? focusCamera(v, rect) : fitCam(layout), v, { w: layout.width, h: layout.height });
    fitted.current = !rect;
    if (stage.current) stage.current.style.transform = `translate(${first.x}px, ${first.y}px) scale(${first.k})`;
    const id = requestAnimationFrame(() => {
      placed.current = true;
      handledFocus.current = store.getState().focus?.nonce ?? null;
      apply(first);
    });
    return () => cancelAnimationFrame(id);
  }, [layout, apply, size, fitCam, store, tree]);

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
      if (fitted.current) apply(clamp(fitCamera(now, { x: 0, y: 0, w: L.width, h: L.height }), now, { w: L.width, h: L.height }));
      else apply(clamp({ x: c.x + (now.w - last.w) / 2, y: c.y + (now.h - last.h) / 2, k: c.k }, now, { w: L.width, h: L.height }));
      last = now;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [apply]);

  // Honour focus requests once the layout shows the target.
  useLayoutEffect(() => {
    if (!focusReq || !layout || !placed.current || handledFocus.current === focusReq.nonce) return;
    const v = size();
    if (!v.w) return;
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
    moveTo(focusCamera(v, rect), true);
  });

  // Follow during live playback (rule above), checked against the store, never more than every 4 s.
  useEffect(() => {
    let lastCheck = 0;
    let primary: string | null = null;
    return store.subscribe(() => {
      const s = store.getState();
      if (!s.playing || !cameraFollows(s) || fitted.current) return;
      const now = performance.now();
      if (now - lastCheck < (s.reducedMotion ? FOLLOW.everyReducedMs : FOLLOW.everyMs)) return;
      lastCheck = now;
      const L = layoutRef.current;
      if (!L) return;
      const d = followMove(L, s.playhead, cam.current, size(), primary);
      primary = d.primary;
      if (d.camera) moveTo(d.camera, !s.reducedMotion, FOLLOW.easeMs);
    });
  }, [store, size, moveTo]);

  // Wheel: pinch or Ctrl/Cmd + wheel zooms to the cursor; plain wheel and two-finger scroll pan.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      anim.current?.stop();
      manual();
      const c = cam.current;
      const L = layoutRef.current;
      const sheet = L ? { w: L.width, h: L.height } : { w: 1, h: 1 };
      if (e.ctrlKey || e.metaKey) {
        const box = el.getBoundingClientRect();
        const cx = e.clientX - box.left;
        const cy = e.clientY - box.top;
        const k = Math.min(3, Math.max(0.35, c.k * Math.pow(1.0015, -e.deltaY * (e.deltaMode === 1 ? 16 : 1))));
        apply(clamp({ x: cx - (cx - c.x) * (k / c.k), y: cy - (cy - c.y) * (k / c.k), k }, size(), sheet));
      } else {
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
        apply(clamp({ x: c.x - dx, y: c.y - dy, k: c.k }, size(), sheet));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [apply, size, manual]);

  const zoomBy = useCallback(
    (f: number) => {
      manual();
      const v = size();
      const c = cam.current;
      const k = Math.min(3, Math.max(0.35, c.k * f));
      moveTo({ x: v.w / 2 - (v.w / 2 - c.x) * (k / c.k), y: v.h / 2 - (v.h / 2 - c.y) * (k / c.k), k }, true);
    },
    [moveTo, size, manual],
  );

  // Keys that belong to the view even when focus is not inside it (+, -, 0). The
  // Shell listens on window too; it skips events already handled (defaultPrevented).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      if (t && t.closest?.("[data-view]") && !t.closest?.('[data-view="blueprint"]')) return;
      if (e.key === "+" || e.key === "=") zoomBy(1.2);
      else if (e.key === "-") zoomBy(1 / 1.2);
      else if (e.key === "0") fit();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomBy, fit]);

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
      if (d.moved && L) apply(clamp({ x: d.cx + dx, y: d.cy + dy, k: cam.current.k }, size(), { w: L.width, h: L.height }));
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
        if (top < 40 || bottom > v.h - 40) {
          manual();
          moveTo({ ...c, y: v.h * 0.35 - r.y * c.k }, true);
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
      case "+":
      case "=":
        zoomBy(1.2);
        break;
      case "-":
        zoomBy(1 / 1.2);
        break;
      case "0":
        fit();
        break;
      default:
        handled = false;
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
      const v = size();
      const c = cam.current;
      moveTo({ x: v.w / 2 - x * c.k, y: v.h / 2 - y * c.k, k: c.k }, false);
    },
    [manual, moveTo, size],
  );
  const frameLane = useCallback(
    (laneId: string) => {
      const L = layoutRef.current;
      const lane = L?.lanes.find((l) => l.id === laneId);
      if (!L || !lane) return;
      manual();
      moveTo(focusCamera(size(), { x: SHEET.left, y: lane.y, w: L.width - SHEET.left * 2, h: lane.h }), true);
      setActiveId(laneId);
    },
    [manual, moveTo, size],
  );

  // ---------------------------------------------------------------- render
  const [gutterEl, setGutterEl] = useState<SVGGElement | null>(null);
  const [rowsEl, setRowsEl] = useState<SVGGElement | null>(null);
  const layers = useMemo(() => ({ gutter: gutterEl, rows: rowsEl, animate: animating }), [gutterEl, rowsEl, animating]);
  const title = tree.root?.data.kind === "wave" ? tree.root.data.wave.title : "Waiting for a wave";
  const waveId = tree.root?.data.kind === "wave" ? tree.root.data.wave.id : "";
  const facts: ReadonlyArray<readonly [string, string]> = [
    ["Wave", waveId || "none yet"],
    ["Project", scene.project.name],
    ["Playhead", ""],
    ["Run", fixture.id],
  ];
  const furniture = layout ? furnitureBox(layout) : null;
  return (
    <CameraContext.Provider value={camStore}>
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
              <FactoryScene label="Execution Blueprint (simulation)" interactive width={layout.width} height={layout.height} ground={false}>
                <BlueprintSheet
                  width={layout.width}
                  height={layout.height}
                  title="Execution Blueprint"
                  subtitle={waveId ? `${waveId} · ${title}` : "Waiting for an approved wave"}
                  simulationLabel="Simulation"
                  zonesX={zoneCounts(layout).zx}
                  zonesY={zoneCounts(layout).zy}
                  facts={facts}
                  titleBlock="strip"
                >
                  <LodContext.Provider value={lodState}>
                  <LayersContext.Provider value={layers}>
                    <BandContext.Provider value={band}>
                      <TreeContext.Provider value={ctx}>
                        <g role="tree" aria-label="Execution hierarchy: wave, slices, executions, station visits, agents, tool calls" onKeyDown={onKeyDown} onFocus={(e) => setFocusedId((e.target as Element).getAttribute("data-tid"))} onBlur={() => setFocusedId(null)}>
                          {tree.root ? <WaveItem layout={layout} tree={tree} template={template} animate={animating} /> : null}
                          {!tree.root ? <PlaceholderBelt layout={layout} template={template} /> : null}
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
                  <Legend x={furniture.legend.x} y={furniture.legend.y} />
                  <Revisions x={furniture.rev.x} y={furniture.rev.y} w={furniture.rev.w} h={furniture.rev.h} />
                </BlueprintSheet>
                <PlayheadFact width={layout.width} height={layout.height} factIndex={2} factCount={facts.length} />
              </FactoryScene>
            ) : (
              <p className="bp-pending">Laying out the drawing…</p>
            )}
          </div>
          {layout && template ? (
            <div className="bp-chrome" aria-hidden={theater ? true : undefined}>
              <ZoneRulers layout={layout} />
              <PinnedTitle layout={layout} theater={theater} />
              {theater ? null : <Minimap layout={layout} template={template} centreOn={centreOn} frameLane={frameLane} />}
            </div>
          ) : null}
          {theater ? null : (
            <div className="bp-controls bp-chrome" role="toolbar" aria-label="Blueprint camera">
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
      </HitContext.Provider>
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

function WaveItem({ layout, tree, template, animate }: { layout: Layout; tree: Tree; template: ColumnTemplate; animate: boolean }) {
  const root = tree.root!;
  const selected = useSceneStore((s) => s.selection === root.ref);
  const wave = root.data.kind === "wave" ? root.data.wave : null;
  const ring = { x: SHEET.left, y: layout.waveY + 4, w: 420, h: SHEET.waveHeader - 12 };
  return <WaveTreeItem node={root} expanded={layout.waveExpanded} ring={ring} layout={layout} selected={selected} wave={wave} template={template} animate={animate} />;
}

function WaveTreeItem({ node, expanded, ring, layout, selected, wave, template, animate }: { node: TreeNode; expanded: boolean; ring: Rect; layout: Layout; selected: boolean; wave: WaveState | null; template: ColumnTemplate; animate: boolean }) {
  const x = SHEET.left;
  const y = layout.waveY;
  const w = layout.width - SHEET.left * 2;
  const lanes = layout.lanes;
  return (
    <Item
      node={node}
      pos={1}
      size={1}
      expanded={expanded}
      ring={ring}
      group={lanes.map((lane: Lane, i) => (
        <LaneView key={lane.id} lane={lane} pos={i + 1} size={lanes.length} rows={lane.rows} layout={layout} template={template} animate={animate} />
      ))}
    >
      <line x1={x} y1={y} x2={x + w} y2={y} style={{ stroke: fc("ink-soft"), strokeWidth: 1.75 }} />
      <Gutter id={node.id} entity={node.ref} y={y + 2} h={44} ax={layout.ax} band={0}>
        {selected ? <SelectBar x={x - 2} y={0} h={42} /> : null}
        <ToggleTarget x={x + 8} y={22} />
        <Chevron x={x + 8} y={22} open={expanded} />
        <text x={x + 20} y={27} className="bp-fine" style={{ fill: "var(--mach-ink)", fontFamily: "var(--mach-font-serif)", fontSize: 21, fontWeight: 450 }}>
          {wave?.title ?? ""}
        </text>
        <text x={x + 20} y={41} className="bp-fine notranslate" style={{ fill: "var(--mach-ink-muted)", fontFamily: "var(--mach-font-mono)", fontSize: 9.5 }}>
          {wave?.id} · {wave?.sliceIds.length} slices · approved by {wave?.approvedBy}
        </text>
        <text x={x + 20} y={36} className="bp-over" style={{ fill: "var(--mach-ink)", fontFamily: "var(--mach-font-serif)", fontSize: 44, fontWeight: 450 }}>
          {wave?.title ?? ""}
        </text>
      </Gutter>
    </Item>
  );
}

/** Where an entity is on the sheet, for the camera. */
function boundsFor(layout: Layout, tree: Tree, entity: EntityRef, playhead: number): Rect | null {
  const id = nodeForRef(tree, entity);
  if (!id) return null;
  const node = tree.byId.get(id);
  if (!node) return null;
  const direct = layout.bounds.get(id);
  if (node.kind === "visit" || node.kind === "gate" || node.kind === "execution" || node.kind === "relay") {
    const lane = layout.lanes.find((l) => l.cell?.ticketId === node.ticketId);
    if (lane) return { x: SHEET.left, y: lane.y, w: layout.width - SHEET.left * 2, h: Math.max(140, lane.dimsY + lane.dimRows * SHEET.dimBand - lane.y) };
  }
  if (node.kind === "tool" || node.kind === "artifact" || node.kind === "finding") return leafBounds(layout, tree, node, playhead) ?? direct ?? null;
  if (node.kind === "slice") {
    const lane = layout.lanes.find((l) => l.id === id);
    if (lane) return { x: SHEET.left, y: lane.y, w: layout.width - SHEET.left * 2, h: lane.h };
  }
  if (direct) return direct;
  return null;
}
