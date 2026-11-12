/**
 * The Factory Atlas: the whole simulated factory as one continuous axonometric plant drawing that
 * comes alive (M6_0_VISUAL_SPEC.md, sections b, d, e, f, g). It fills its container, takes no
 * required props and reads everything from the scene store. It keeps only interface state of its
 * own: the camera, the level of detail and which entity has keyboard focus.
 *
 *   viewport (pointer, wheel, keys)
 *   ├ camera wrapper (one CSS transform)
 *   │ ├ L1 <svg> scene: ground, plates, tracks, bays, works, air
 *   │ └ L3 <svg> overlay: brackets, focus ring, labels, callouts (pointer-events: none)
 *   ├ effects slot: aligned to the same camera, empty in this pass (see `AtlasEffects`)
 *   └ L4 DOM: zoom controls, dev frame meter
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { FactoryScene, factoryTokens, lodForZoom, screenBounds, type Lod, type RegionKind } from "@mach/ui";
import { useScene, useSceneActions, useSceneStore, useStore } from "../scene";
import { refKind, sceneAt, type EntityRef, type Scene } from "../sim";
import { AtlasContext, useHighlight, type AtlasContextValue } from "./context";
import { createCamera, frame, visibleRect, zoomAt, type Camera, type CameraStore, type ScreenRect } from "./camera";
import { plantLayout, type PlantLayout } from "./layout";
import { Plant } from "./Plant";
import { Bay, FreeBay } from "./Bay";
import { ArchiveWorks, AwayAgents, ChamberWorks, GatehouseWorks, IntakeWorks, IntegrationWorks } from "./Stations";
import { Dependencies, LiveConduits, Transit } from "./Air";
import { Overlay } from "./Overlay";
import { Meter } from "./Meter";
import { activeBoxes, locateScreen } from "./locate";
import "./atlas.css";

/** A later light layer (WebGL) mounts here: it gets the camera store and must stay decoration only. */
export type AtlasEffects = ComponentType<{ camera: CameraStore; layout: PlantLayout }>;

export interface AtlasViewProps {
  /** Optional decoration layer drawn between the scene and the overlay, aligned to the same camera. */
  effects?: AtlasEffects;
  /** Show the development frame meter (default: development builds with `?meter`). */
  meter?: boolean;
}

const Z = factoryTokens.zoom;
const SVG_PAD = 120;

function captionsOf(scene: Scene): { captions: Partial<Record<RegionKind, string>>; active: Partial<Record<RegionKind, boolean>> } {
  const cells = Object.values(scene.cells);
  const working = cells.filter((c) => c.station && ["plan", "groom", "build", "verify", "audit"].includes(c.station) && c.activeAgentIds.length > 0);
  const waiting = Object.values(scene.slices).filter((s) => s.scheduler === "waiting-on-dependency").length;
  const wave = Object.values(scene.waves)[0];
  const merged = cells.filter((c) => c.merged).length;
  const archived = cells.filter((c) => c.archived).length;
  const reviewing = cells.find((c) => c.station === "review");
  const lastDecided = cells
    .flatMap((c) => c.reviews.filter((r) => r.decidedAt !== null).map((r) => ({ c, r })))
    .sort((a, b) => (b.r.decidedAt ?? 0) - (a.r.decidedAt ?? 0))[0];
  const human = cells.find((c) => c.stage === "awaiting-human");
  return {
    captions: {
      intake: wave ? `${wave.id} · ${wave.sliceIds.length} slices · ${waiting} waiting` : "Waiting for an approved wave",
      floor: `${cells.length} cell${cells.length === 1 ? "" : "s"} · ${working.length} working`,
      review: reviewing ? `${reviewing.ticketId} under review` : lastDecided ? `Last: ${lastDecided.c.ticketId} ${lastDecided.r.outcome?.toLowerCase().replace("_", " ")}` : "No panel sitting yet",
      human: human ? `${human.ticketId} held` : "Clear",
      integration: `main · ${merged} merged`,
      archive: `${archived} archived`,
    },
    active: {
      floor: working.length > 0,
      review: Boolean(reviewing),
      human: Boolean(human),
      integration: cells.some((c) => c.station === "merge"),
      archive: cells.some((c) => c.station === "cleanup"),
    },
  };
}

/** Plates and tracks re-render only when a caption, an active rule, the level of detail or dimming changes. */
function PlantLayer({ layout, lod }: { layout: PlantLayout; lod: Lod }) {
  const scene = useScene();
  const highlight = useHighlight();
  const { captions, active } = captionsOf(scene);
  const key = JSON.stringify([captions, active]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the caption text, not object identity
  const stable = useMemo(() => ({ captions, active }), [key]);
  return <Plant layout={layout} lod={lod} captions={stable.captions} active={stable.active} dimRoutes={highlight.size > 0} />;
}

function FreeBays({ layout }: { layout: PlantLayout }) {
  const max = useScene((s) => s.factory.limits?.max_parallel ?? null);
  return (
    <>
      {layout.freeBays.map((slot) => (
        <FreeBay key={slot.index} slot={slot} maxParallel={max} />
      ))}
    </>
  );
}

export function AtlasView({ effects: Effects, meter }: AtlasViewProps = {}) {
  const store = useStore();
  const fixture = useSceneStore((s) => s.fixture);
  const layout = useMemo(() => plantLayout(fixture), [fixture]);
  const { select, hover, focusOn } = useSceneActions();

  // Projected bounds of the whole plant: the SVGs' coordinate frame.
  const bounds = useMemo<ScreenRect>(() => {
    const e = layout.extent;
    return screenBounds([{ x: e.x, y: e.y, w: e.w, d: e.d, z: 0, h: 60 }], SVG_PAD);
  }, [layout]);
  const camera = useMemo(() => createCamera(bounds), [bounds]);

  const viewportRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [lod, setLod] = useState<Lod>("mid");
  const [visibleBays, setVisibleBays] = useState<string>("*");
  const [focused, setFocused] = useState<EntityRef | null>(null);
  const [dragging, setDragging] = useState(false);
  const followSuspended = useRef(false);

  // The camera writes its transform straight to the wrapper: panning never re-renders React.
  useEffect(() => {
    let lodNow: Lod = "mid";
    let raf = 0;
    const apply = (cam: Camera) => {
      const w = wrapperRef.current;
      if (w) w.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.zoom})`;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        lodNow = lodForZoom(cam.zoom, lodNow);
        setLod(lodNow);
        setZoom(Math.round(cam.zoom * 100) / 100);
        const view = visibleRect(cam, camera.viewport);
        const m = 64 / cam.zoom;
        const vis = layout.bays
          .filter((b) => {
            const r = screenBounds([{ x: b.origin.x, y: b.origin.y, w: 216, d: 148, z: 8, h: 60 }]);
            return r.x + r.width > view.x - m && r.x < view.x + view.width + m && r.y + r.height > view.y - m && r.y < view.y + view.height + m;
          })
          .map((b) => b.ticketId)
          .join(",");
        setVisibleBays(vis);
      });
    };
    const off = camera.subscribe((cam, user) => {
      if (user) followSuspended.current = true;
      apply(cam);
    });
    apply(camera.get());
    return () => {
      off();
      cancelAnimationFrame(raf);
    };
  }, [camera, layout]);

  const fitAll = useCallback(
    (ms: number) => {
      const r = screenBounds([{ ...layout.extent, x: layout.extent.x + 30, w: layout.extent.w - 60, z: 0, h: 40 }]);
      camera.animateTo(frame(r, camera.viewport, 1.6), ms);
    },
    [camera, layout],
  );

  // Size: track the viewport; the first measurement frames the whole plant.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    let first = true;
    const ro = new ResizeObserver(() => {
      camera.viewport = { width: el.clientWidth, height: el.clientHeight };
      if (first) {
        first = false;
        fitAll(0);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [camera, fitAll]);

  // Focus requests from the store: frame the target (650 ms standard; reduced motion cuts).
  useEffect(() => {
    let lastNonce = store.getState().focus?.nonce ?? -1;
    let wasFollowing = store.getState().following;
    let lastFollowCheck = 0;
    return store.subscribe(() => {
      const s = store.getState();
      const ms = s.reducedMotion ? 0 : factoryTokens.motion.cameraFocus;
      if (s.following && !wasFollowing) followSuspended.current = false;
      wasFollowing = s.following;
      if (s.focus && s.focus.nonce !== lastNonce) {
        lastNonce = s.focus.nonce;
        if (s.focus.reason === "follow") followSuspended.current = false;
        if (s.focus.target === "overview") {
          fitAll(ms);
        } else {
          const scene = sceneAt(s.fixture, s.playhead);
          const kind = refKind(s.focus.target);
          const pad = kind === "cell" || kind === "slice" ? 40 * 0.9 : 8;
          const r = locateScreen(layout, scene, s.playhead, s.focus.target, pad);
          if (r) {
            const minZoom = kind === "cell" || kind === "slice" || kind === "wave" || kind === "dependency" ? Z.far + 0.06 : kind === "gate" ? Z.far + 0.06 : Z.near + 0.06;
            camera.animateTo(frame(r, camera.viewport, 2.2, Math.min(minZoom, camera.get().zoom > minZoom ? camera.get().zoom : minZoom)), ms);
          }
        }
        if (s.focus.reason !== "follow") followSuspended.current = s.focus.reason === "select" ? true : followSuspended.current;
      }
      // Follow mode: keep the active set inside the inner 70% of the viewport, re-framing at most every 2 s (4 s reduced).
      if (s.playing && s.following && !followSuspended.current) {
        const now = performance.now();
        if (now - lastFollowCheck < (s.reducedMotion ? 4000 : 2000)) return;
        lastFollowCheck = now;
        const boxes = activeBoxes(layout, sceneAt(s.fixture, s.playhead), s.playhead);
        if (!boxes.length) return;
        const r = screenBounds(boxes, 20);
        const cam = camera.get();
        const vw = camera.viewport.width;
        const vh = camera.viewport.height;
        const sx = r.x * cam.zoom + cam.x;
        const sy = r.y * cam.zoom + cam.y;
        const inside = sx >= vw * 0.15 && sy >= vh * 0.15 && sx + r.width * cam.zoom <= vw * 0.85 && sy + r.height * cam.zoom <= vh * 0.85;
        if (inside) return;
        const fit = frame(r, { width: vw * 0.7 + 128, height: vh * 0.7 + 128 }, cam.zoom, Z.min);
        const zoom = Math.min(cam.zoom, fit.zoom);
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        camera.animateTo({ zoom, x: vw / 2 - cx * zoom, y: vh / 2 - cy * zoom }, s.reducedMotion ? 0 : 900);
      }
    });
  }, [store, camera, layout, fitAll]);

  // Wheel: zoom to the cursor (spec f.1). Native, so it can prevent the page from scrolling.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      if (e.shiftKey && !e.ctrlKey) {
        const c = camera.get();
        camera.set({ ...c, x: c.x - (e.deltaX || dy), y: c.y }, { user: true });
        return;
      }
      camera.set(zoomAt(camera.get(), Math.pow(1.0015, -dy * (e.ctrlKey ? 4 : 1)), e.clientX - rect.left, e.clientY - rect.top), { user: true });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [camera]);

  // Drag to pan; two pointers pinch to zoom. A drag never also counts as a click.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ x: number; y: number; cam: Camera; moved: boolean; pinch?: number } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    drag.current = { x: e.clientX, y: e.clientY, cam: camera.get(), moved: false, pinch: pts.length === 2 ? Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y) : undefined };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId) || !drag.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const d = drag.current;
    const pts = [...pointers.current.values()];
    if (pts.length === 2 && d.pinch) {
      const dist = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
      const rect = e.currentTarget.getBoundingClientRect();
      const cx = (pts[0]!.x + pts[1]!.x) / 2 - rect.left;
      const cy = (pts[0]!.y + pts[1]!.y) / 2 - rect.top;
      camera.set(zoomAt(d.cam, dist / d.pinch, cx, cy), { user: true });
      d.moved = true;
      return;
    }
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved) {
      d.moved = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(true);
    }
    camera.set({ ...d.cam, x: d.cam.x + dx, y: d.cam.y + dy }, { user: true });
  };
  const endPointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) setDragging(false);
  };
  const onClickCapture = (e: ReactMouseEvent) => {
    if (drag.current?.moved) {
      e.stopPropagation();
      e.preventDefault();
    }
    drag.current = null;
  };

  const zoomBy = (factor: number) => {
    const c = camera.get();
    camera.set(zoomAt(c, factor, camera.viewport.width / 2, camera.viewport.height / 2), { user: true });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const onCanvas = e.target === e.currentTarget;
    const pan = 80;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [pan, 0], ArrowRight: [-pan, 0], ArrowUp: [0, pan], ArrowDown: [0, -pan] };
    const arrow = arrows[e.key];
    if (arrow && (onCanvas || e.shiftKey)) {
      const c = camera.get();
      camera.set({ ...c, x: c.x + arrow[0], y: c.y + arrow[1] }, { user: true });
    } else if (e.key === "+" || e.key === "=") zoomBy(Z.step);
    else if (e.key === "-" || e.key === "_") zoomBy(1 / Z.step);
    else if (e.key === "0") fitAll(store.getState().reducedMotion ? 0 : factoryTokens.motion.cameraFocus);
    else if ((e.key === "f" || e.key === "F") && !e.shiftKey && store.getState().selection) focusOn(store.getState().selection as EntityRef, "select");
    else if (e.key === "Escape") {
      const s = store.getState();
      if (s.hovered) hover(null);
      else if (s.selection) select(null, { focus: false });
      else return;
    } else return;
    e.preventDefault();
  };

  const ctx = useMemo<AtlasContextValue>(() => ({ lod, layout }), [lod, layout]);
  const showMeter = meter ?? (import.meta.env.DEV && typeof location !== "undefined" && new URLSearchParams(location.search).has("meter"));
  const visible = useMemo(() => new Set(visibleBays === "*" ? layout.bays.map((b) => b.ticketId) : visibleBays.split(",")), [visibleBays, layout]);

  return (
    <AtlasContext.Provider value={ctx}>
      {/* The canvas is one tab stop with its own keys (pan, zoom, fit); its entities follow in reading order, region by region (spec f.11). */}
      {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
      <div
        ref={viewportRef}
        className="atlas-viewport h-full w-full"
        data-view="atlas"
        data-lod={lod}
        data-dragging={dragging}
        role="application"
        aria-label="Factory Atlas, a simulation: the plant drawn in axonometric. Arrow keys pan, plus and minus zoom, 0 fits, Tab moves through the plant region by region."
        aria-roledescription="plant drawing"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onClickCapture={onClickCapture}
        onClick={() => select(null, { focus: false })}
        onKeyDown={onKeyDown}
        onFocus={(e) => setFocused(((e.target as Element).getAttribute?.("data-ref") as EntityRef | null) ?? null)}
        onBlur={() => setFocused(null)}
      >
        {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
        <div ref={wrapperRef} className="atlas-camera">
          <FactoryScene
            label="Factory Atlas (simulation)"
            interactive
            ground={false}
            width={bounds.width}
            height={bounds.height}
            viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`}
            style={{ left: bounds.x, top: bounds.y }}
          >
            <PlantLayer layout={layout} lod={lod} />
            <LiveConduits />
            <IntakeWorks />
            <FreeBays layout={layout} />
            {layout.bays.map((b) => (
              <Bay key={b.ticketId} bay={b} visible={visible.has(b.ticketId)} />
            ))}
            <ChamberWorks />
            <GatehouseWorks />
            <IntegrationWorks />
            <ArchiveWorks />
            <AwayAgents />
            <Transit />
            <Dependencies />
          </FactoryScene>
          <svg className="atlas-overlay" aria-hidden="true" width={bounds.width} height={bounds.height} viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`} style={{ left: bounds.x, top: bounds.y }}>
            <Overlay zoom={zoom} lod={lod} focused={focused} />
          </svg>
        </div>
        <div className="atlas-effects" aria-hidden="true">
          {Effects ? <Effects camera={camera} layout={layout} /> : null}
        </div>
        <div className="atlas-controls" role="toolbar" aria-label="Atlas camera">
          <button type="button" aria-label="Zoom out" onClick={(e) => (e.stopPropagation(), zoomBy(1 / Z.step))} onPointerDown={(e) => e.stopPropagation()}>
            −
          </button>
          <span className="atlas-lod" aria-live="polite">
            {lod === "far" ? "Far" : lod === "near" ? "Near" : "Mid"} · {Math.round(zoom * 100)}%
          </span>
          <button type="button" aria-label="Zoom in" onClick={(e) => (e.stopPropagation(), zoomBy(Z.step))} onPointerDown={(e) => e.stopPropagation()}>
            +
          </button>
          <button type="button" aria-label="Fit the whole plant" onClick={(e) => (e.stopPropagation(), fitAll(store.getState().reducedMotion ? 0 : factoryTokens.motion.cameraFocus))} onPointerDown={(e) => e.stopPropagation()}>
            Fit
          </button>
        </div>
        {showMeter ? <Meter /> : null}
      </div>
    </AtlasContext.Provider>
  );
}

export type { CameraStore, Camera } from "./camera";
