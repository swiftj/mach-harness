/**
 * The Execution Blueprint: the same run as the Atlas, drawn as an engineering sheet that fills in as
 * the playhead moves (M6_0_VISUAL_SPEC.md c). Fills its container, takes no props, and reads
 * everything from the scene store. What it keeps of its own: the camera, hover, which lanes are open,
 * and which tree item holds the keyboard's tab stop. Nothing about what has happened.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { animate } from "motion/react";
import { BlueprintSheet, FactoryScene, fc } from "@mach/ui";
import type { EntityRef } from "../sim";
import { refKind } from "../sim";
import { useScene, useSceneActions, useSceneStore, useStore } from "../scene";
import { useColumns } from "./columns";
import { computeLayout, SHEET, type Layout, type Rect } from "./layout";
import { DependencyLayer, LaneView } from "./Lane";
import { clamp, fitCamera, focusCamera, type Camera } from "./camera";
import { leafBounds } from "./bounds";
import { PlayheadFact } from "./TitleBlock";
import { ancestors, nodeForRef, treeOf, type Tree } from "./tree";
import { BandContext, Chevron, Item, SelectBar, ToggleTarget, TreeContext, type TreeCtx } from "./treeitem";
import type { TreeNode } from "./tree";
import type { WaveState } from "../sim";
import type { ColumnTemplate } from "./columns";
import "./blueprint.css";

const DEEP = new Set(["agent", "tool", "artifact", "finding"]);

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

function initialExpanded(tree: Tree): Set<string> {
  const out = new Set<string>();
  if (tree.root) {
    out.add(tree.root.id);
    for (const lane of tree.root.children) out.add(lane.id);
  }
  return out;
}

export function BlueprintView() {
  const store = useStore();
  const actions = useSceneActions();
  const fixture = useSceneStore((s) => s.fixture);
  const scene = useScene();
  const tree = treeOf(scene);
  const template = useColumns(fixture);
  const reduced = useSceneStore((s) => s.reducedMotion);
  const focusReq = useSceneStore((s) => s.focus);
  const selection = useSceneStore((s) => s.selection);

  // Which lanes are open. Lanes that appear later (a slice dispatched mid-run) open by default.
  const [userOpen, setUserOpen] = useState<ReadonlySet<string>>(() => initialExpanded(tree));
  const [userClosed, setUserClosed] = useState<ReadonlySet<string>>(() => new Set());
  const expanded = useMemo(() => {
    const out = new Set(userOpen);
    if (tree.root) {
      if (!userClosed.has(tree.root.id)) out.add(tree.root.id);
      for (const lane of tree.root.children) if (!userClosed.has(lane.id)) out.add(lane.id);
    }
    return out;
  }, [userOpen, userClosed, tree]);

  // Expand to what the store names: a focus request or a selection made elsewhere (the inspector, the Atlas).
  const [seen, setSeen] = useState<{ nonce: number | null; selection: EntityRef | null }>({ nonce: null, selection: null });
  const pendingFocus = useRef<{ target: EntityRef | "overview"; nonce: number } | null>(null);
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

  const layout: Layout | null = useMemo(() => (template ? computeLayout(scene, tree, expanded, template) : null), [scene, tree, expanded, template]);

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
  const [zoomWord, setZoomWord] = useState("100%");

  const [band, setBand] = useState<readonly [number, number]>([-Infinity, Infinity]);
  const apply = useCallback((c: Camera) => {
    cam.current = c;
    if (stage.current) stage.current.style.transform = `translate(${c.x}px, ${c.y}px) scale(${c.k})`;
    setZoomWord(`${Math.round(c.k * 100)}%`);
    const h = viewport.current?.clientHeight ?? 1000;
    const top = Math.floor((-c.y / c.k - h / c.k) / 400) * 400;
    const bottom = Math.ceil((-c.y / c.k + (2 * h) / c.k) / 400) * 400;
    setBand((b) => (b[0] === top && b[1] === bottom ? b : [top, bottom]));
  }, []);
  const size = useCallback(() => ({ w: viewport.current?.clientWidth ?? 0, h: viewport.current?.clientHeight ?? 0 }), []);
  const moveTo = useCallback(
    (target: Camera, smooth: boolean) => {
      anim.current?.stop();
      const sheet = layout ? { w: layout.width, h: layout.height } : { w: 1, h: 1 };
      const goal = clamp(target, size(), sheet);
      if (!smooth || reduced) {
        apply(goal);
        return;
      }
      const from = cam.current;
      anim.current = animate(0, 1, {
        duration: 0.65,
        ease: [0.2, 0, 0, 1],
        onUpdate: (p) => {
          const k = Math.exp(Math.log(from.k) + (Math.log(goal.k) - Math.log(from.k)) * p);
          apply({ x: from.x + (goal.x - from.x) * p, y: from.y + (goal.y - from.y) * p, k });
        },
      });
    },
    [apply, layout, reduced, size],
  );

  // First placement: fit the sheet's width, top aligned.
  useLayoutEffect(() => {
    if (!layout || placed.current) return;
    const v = size();
    if (!v.w) return;
    const k = Math.min(1, Math.max(0.35, v.w / layout.width));
    const first = clamp({ x: (v.w - layout.width * k) / 2, y: 0, k }, v, { w: layout.width, h: layout.height });
    if (stage.current) stage.current.style.transform = `translate(${first.x}px, ${first.y}px) scale(${first.k})`;
    const id = requestAnimationFrame(() => {
      placed.current = true;
      apply(first);
    });
    return () => cancelAnimationFrame(id);
  }, [layout, apply, size]);

  // Honour focus requests once the layout shows the target.
  useLayoutEffect(() => {
    if (focusReq && pendingFocus.current?.nonce !== focusReq.nonce) pendingFocus.current = { target: focusReq.target, nonce: focusReq.nonce };
  }, [focusReq]);
  const handledFocus = useRef<number | null>(null);
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending || !layout || handledFocus.current === pending.nonce) return;
    const v = size();
    if (!v.w) return;
    if (pending.target === "overview") {
      handledFocus.current = pending.nonce;
      moveTo(fitCamera(v, { x: 0, y: 0, w: layout.width, h: layout.height }), true);
      return;
    }
    const rect = boundsFor(layout, tree, pending.target, store.getState().playhead);
    if (!rect) return;
    handledFocus.current = pending.nonce;
    moveTo(focusCamera(v, rect), true);
  });

  // Wheel: pinch or Ctrl/Cmd + wheel zooms to the cursor; plain wheel and two-finger scroll pan.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      anim.current?.stop();
      const c = cam.current;
      const sheet = layout ? { w: layout.width, h: layout.height } : { w: 1, h: 1 };
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
  }, [apply, layout, size]);

  const zoomBy = useCallback(
    (f: number) => {
      const v = size();
      const c = cam.current;
      const k = Math.min(3, Math.max(0.35, c.k * f));
      moveTo({ x: v.w / 2 - (v.w / 2 - c.x) * (k / c.k), y: v.h / 2 - (v.h / 2 - c.y) * (k / c.k), k }, true);
    },
    [moveTo, size],
  );
  const fit = useCallback(() => {
    if (layout) moveTo(fitCamera(size(), { x: 0, y: 0, w: layout.width, h: layout.height }), true);
  }, [layout, moveTo, size]);

  // ---------------------------------------------------------------- pointer: pan, select, hover, toggle
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean; id: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    anim.current?.stop();
    drag.current = { x: e.clientX, y: e.clientY, cx: cam.current.x, cy: cam.current.y, moved: false, id: e.pointerId };
  };
  const hovered = useRef<EntityRef | null>(null);
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d) {
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) > 4) {
        d.moved = true;
        viewport.current?.setPointerCapture(d.id);
      }
      if (d.moved && layout) apply(clamp({ x: d.cx + dx, y: d.cy + dy, k: cam.current.k }, size(), { w: layout.width, h: layout.height }));
      return;
    }
    const el = (e.target as Element).closest?.("[data-ref]");
    let next = (el?.getAttribute("data-ref") as EntityRef | null | undefined) ?? null;
    // A lane (or the wave) is hovered from its gutter only: hovering the empty floor of a lane must not dim the sheet.
    const tid = el?.getAttribute("data-tid") ?? "";
    if (next && (tid.startsWith("s:") || tid.startsWith("w:")) && layout && viewport.current) {
      const box = viewport.current.getBoundingClientRect();
      const sx = (e.clientX - box.left - cam.current.x) / cam.current.k;
      if (sx > layout.ax - 16) next = null;
    }
    if (next !== hovered.current) {
      hovered.current = next;
      actions.hover(next);
    }
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved) {
      viewport.current?.releasePointerCapture(d.id);
      return;
    }
    const target = e.target as Element;
    const item = target.closest?.("[data-tid]");
    const tid = item?.getAttribute("data-tid") ?? null;
    if (target.closest?.("[data-toggle]") && tid) {
      toggle(tid);
      setActiveId(tid);
      return;
    }
    const hit = target.closest?.("[data-ref]")?.getAttribute("data-ref") as EntityRef | null | undefined;
    if (hit) {
      actions.select(hit, { focus: false });
      if (tid) setActiveId(tid);
      else {
        const id = nodeForRef(tree, hit);
        if (id) setActiveId(id);
      }
    } else actions.select(null);
  };
  const onPointerLeave = () => {
    if (hovered.current) {
      hovered.current = null;
      actions.hover(null);
    }
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    const hit = (e.target as Element).closest?.("[data-ref]")?.getAttribute("data-ref") as EntityRef | null | undefined;
    if (hit) actions.select(hit);
  };

  // ---------------------------------------------------------------- keyboard: ARIA tree navigation
  const focusItem = useCallback((id: string) => setActiveId(id), []);
  const lastFocused = useRef<string | null>(null);
  useEffect(() => {
    if (!activeId || lastFocused.current === activeId) return;
    const el = elements.current.get(activeId);
    if (!el && layout && viewport.current?.contains(document.activeElement)) {
      // A leaf of a lane the camera is far from is not mounted yet: bring its lane on screen first.
      const node = tree.byId.get(activeId);
      const r = layout.bounds.get(activeId) ?? (node?.parent ? layout.bounds.get(node.parent) : undefined);
      if (r) moveTo({ ...cam.current, y: size().h * 0.35 - r.y * cam.current.k }, false);
      return;
    }
    if (el && viewport.current?.contains(document.activeElement)) {
      lastFocused.current = activeId;
      el.focus({ preventScroll: true });
      // Keep the focused item on screen without moving the camera more than needed.
      const r = layout?.bounds.get(activeId);
      if (r && layout) {
        const v = size();
        const c = cam.current;
        const top = c.y + r.y * c.k;
        const bottom = c.y + (r.y + Math.min(r.h, 120)) * c.k;
        if (top < 40 || bottom > v.h - 40) moveTo({ ...c, y: v.h * 0.35 - r.y * c.k }, true);
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
      case "Escape":
        // Clear the selection (and with it the highlight); with nothing selected, let the shell have Escape.
        if (store.getState().selection) actions.select(null);
        else handled = false;
        break;
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
      moveTo({ x: c.x + dx, y: c.y + dy, k: c.k }, true);
      handled = true;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // ---------------------------------------------------------------- render
  const title = tree.root?.data.kind === "wave" ? tree.root.data.wave.title : "Waiting for a wave";
  const waveId = tree.root?.data.kind === "wave" ? tree.root.data.wave.id : "";
  const facts: ReadonlyArray<readonly [string, string]> = [
    ["Wave", waveId || "none yet"],
    ["Project", scene.project.name],
    ["Playhead", ""],
    ["Run", fixture.id],
  ];
  return (
    <div
      ref={viewport}
      className="bp-viewport"
      data-view="blueprint"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
      onDoubleClick={onDoubleClick}
      role="presentation"
    >
      <div ref={stage} className="bp-stage">
        {layout && template ? (
          <FactoryScene label="Execution Blueprint (simulation)" interactive width={layout.width} height={layout.height} ground={false}>
            <BlueprintSheet
              width={layout.width}
              height={layout.height}
              title="Execution Blueprint"
              subtitle={`${waveId} · ${title}`}
              simulationLabel="Simulation"
              zonesX={Math.max(8, Math.round(layout.width / 196))}
              zonesY={Math.max(4, Math.round(layout.height / 260))}
              facts={facts}
            >
              <BandContext.Provider value={band}>
              <TreeContext.Provider value={ctx}>
                <g role="tree" aria-label="Execution hierarchy: wave, slices, executions, station visits, agents, tool calls" onKeyDown={onKeyDown} onFocus={(e) => setFocusedId((e.target as Element).getAttribute("data-tid"))} onBlur={() => setFocusedId(null)}>
                  {tree.root ? <WaveItem layout={layout} tree={tree} template={template} animate={animating} /> : null}
                </g>
              </TreeContext.Provider>
              </BandContext.Provider>
              <DependencyLayer scene={scene} lanes={layout.lanes} ax={layout.ax} aw={layout.aw} template={template} />
            </BlueprintSheet>
            <PlayheadFact width={layout.width} height={layout.height} factIndex={2} factCount={facts.length} />
          </FactoryScene>
        ) : (
          <p className="bp-pending">Laying out the drawing…</p>
        )}
      </div>
      <div className="bp-controls" role="toolbar" aria-label="Blueprint camera">
        <button type="button" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out">
          −
        </button>
        <span className="bp-zoom tabular" aria-live="off">
          {zoomWord}
        </span>
        <button type="button" onClick={() => zoomBy(1.2)} aria-label="Zoom in">
          +
        </button>
        <button type="button" onClick={fit} aria-label="Fit the sheet">
          Fit
        </button>
      </div>
    </div>
  );
}

function WaveItem({ layout, tree, template, animate }: { layout: Layout; tree: Tree; template: ColumnTemplate; animate: boolean }) {
  const root = tree.root!;
  const selected = useSceneStore((s) => s.selection === root.ref);
  const wave = root.data.kind === "wave" ? root.data.wave : null;
  const ring = { x: SHEET.left, y: layout.waveY + 4, w: 420, h: SHEET.waveHeader - 12 };
  return (
    <WaveTreeItem node={root} expanded={layout.waveExpanded} ring={ring} layout={layout} selected={selected} wave={wave} template={template} animate={animate} />
  );
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
      group={lanes.map((lane, i) => (
        <LaneView key={lane.id} lane={lane} pos={i + 1} size={lanes.length} rows={lane.rows} layout={layout} template={template} animate={animate} />
      ))}
    >
      <line x1={x} y1={y} x2={x + w} y2={y} aria-hidden="true" style={{ stroke: fc("ink-soft"), strokeWidth: 1.75 }} />
      {selected ? <SelectBar x={x - 2} y={y + 1} h={SHEET.waveHeader - 2} /> : null}
      <ToggleTarget x={x + 8} y={y + 26} />
      <Chevron x={x + 8} y={y + 26} open={expanded} />
      <text x={x + 20} y={y + 30} style={{ fill: "var(--mach-ink)", fontFamily: "var(--mach-font-serif)", fontSize: 18, fontWeight: 450 }}>
        {wave?.title ?? ""}
      </text>
      <text x={x + 20} y={y + 46} style={{ fill: "var(--mach-ink-muted)", fontFamily: "var(--mach-font-mono)", fontSize: 9.5 }} className="notranslate">
        {wave?.id} · {wave?.sliceIds.length} slices · approved by {wave?.approvedBy}
      </text>
      {/* Column heads: the belt's stations along the top of the drawing, as on a process sheet. */}
      <ColumnHeads layout={layout} template={template} y={y + 58} />
    </Item>
  );
}

const HEADS: Array<[keyof ColumnTemplate["x"], string]> = [
  ["start", "Open"],
  ["plan", "Plan"],
  ["build", "Build"],
  ["verify", "Verify"],
  ["review", "Review"],
  ["human-approval", "Person"],
  ["merge", "Merge"],
  ["cleanup", "Clean"],
  ["end", "Main"],
];

function ColumnHeads({ layout, template, y }: { layout: Layout; template: ColumnTemplate; y: number }) {
  return (
    <g aria-hidden="true">
      {HEADS.map(([k, word]) =>
        template.x[k] !== undefined ? (
          <text key={k} x={layout.ax + (template.x[k] ?? 0)} y={y} textAnchor="middle" style={{ fill: "var(--mach-ink-subtle)", fontSize: 9, fontWeight: 600, letterSpacing: "0.08em" }}>
            {word.toUpperCase()}
          </text>
        ) : null,
      )}
    </g>
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
