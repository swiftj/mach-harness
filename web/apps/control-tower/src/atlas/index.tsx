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
 *   ├ L2 effects slot (optional, src/effects): a light layer between scene and overlay, given the camera
 *   ├ overlay wrapper (the same transform)
 *   └ L4 DOM: zoom controls, dev frame meter
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { FactoryScene, factoryTokens, lodForZoom, screenBounds, type Lod, type RegionKind } from "@mach/ui";
import { cameraFollows, useScene, useSceneActions, useSceneStore, useStore } from "../scene";
import { refKind, sceneAt, type EntityRef, type Scene } from "../sim";
import { AtlasContext, useHighlight, type AtlasContextValue } from "./context";
import { createCamera, frame, visibleRect, zoomAt, type Camera, type CameraStore, type ScreenRect } from "./camera";
import { PLATE_Z, plantLayout, type PlantLayout } from "./layout";
import { Plant } from "./Plant";
import { Bay, FreeBay } from "./Bay";
import { ArchiveWorks, AwayAgents, ChamberWorks, GatehouseWorks, IntakeWorks, IntegrationWorks } from "./Stations";
import { Dependencies, LiveConduits, Transit } from "./Air";
import { Overlay } from "./Overlay";
import { Meter } from "./Meter";
import { locateScreen } from "./locate";
import { activeMembers, followDecision, withGrace } from "./follow";
import { Sheet } from "./Sheet";
import "./atlas.css";

/** A later light layer (WebGL) mounts here: it gets the camera store and must stay decoration only. */
export type AtlasEffects = ComponentType<{ camera: CameraStore; layout: PlantLayout; onActive?: (on: boolean) => void }>;

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
  const overlayRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [lod, setLod] = useState<Lod>("mid");
  const [visibleBays, setVisibleBays] = useState<string>("*");
  const [focused, setFocused] = useState<EntityRef | null>(null);
  const [dragging, setDragging] = useState(false);
  // Follow is the store's one flag (cameraFollows); the Atlas keeps only how it follows: the sticky
  // primary, the zoom the person chose, which places were active lately, and the framing it asked for.
  const followPrimary = useRef<string | null>(null);
  const pendingFollow = useRef<Camera | null>(null);
  const followBase = useRef<number | null>(null);
  const followSeen = useRef(new Map<string, { t: number; rect: ScreenRect }>());
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [lightLayer, setLightLayer] = useState(false);
  const [atFit, setAtFit] = useState(true);

  // The camera writes its transform straight to the wrapper: panning never re-renders React.
  useEffect(() => {
    let lodNow: Lod = "mid";
    let raf = 0;
    let latest = camera.get();
    // One React update per frame at most, always with the latest camera (never starved by an easing).
    const apply = (cam: Camera) => {
      const transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.zoom})`;
      if (wrapperRef.current) wrapperRef.current.style.transform = transform;
      if (overlayRef.current) overlayRef.current.style.transform = transform;
      latest = cam;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const cam = latest;
        setAtFit(camera.fitted);
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
      if (user) {
        camera.setFitted(false);
        // A person panned or zoomed: camera follow goes off for every view (store.follow).
        if (store.getState().follow) store.setFollow(false);
        followBase.current = null;
      }
      apply(cam);
    });
    apply(camera.get());
    return () => {
      off();
      cancelAnimationFrame(raf);
    };
  }, [camera, layout, store]);

  // Fit (spec b.2): frame the plates, not the ground, in this container (the scene area the shell
  // leaves): zoom = min((w - 64) / bounds w, (h - 48) / bounds h), capped at 1.4; centred across,
  // with the vertical margin split 40% above and 60% below so the plant sits slightly high.
  const fitAll = useCallback(
    (ms: number) => {
      const R = layout.regions;
      const r = screenBounds([R.intake, R.floor, R.review, R.human, R.integration, R.archive, layout.dock].map((b) => ({ ...b, z: 0, h: b === R.intake || b === R.floor || b === R.review ? 60 : PLATE_Z })));
      const { width: vw, height: vh } = camera.viewport;
      const zoom = Math.min(1.4, (vw - 64) / r.width, (vh - 48) / r.height);
      const spare = vh - r.height * zoom;
      camera.animateTo({ zoom, x: vw / 2 - (r.x + r.width / 2) * zoom, y: spare * 0.4 - r.y * zoom }, ms);
      camera.setFitted(true);
    },
    [camera, layout],
  );

  // Size: track the container. The first measurement opens on the store's selection if there is one
  // (the shell switches modes and expects the view on it), else on the fit. Later resizes (inspector,
  // timeline, Theater Mode) re-fit if the camera was at fit, else keep the same point at the centre.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    let first = true;
    const ro = new ResizeObserver(() => {
      const before = camera.viewport;
      const next = { width: el.clientWidth, height: el.clientHeight };
      if (next.width === before.width && next.height === before.height) return;
      camera.setViewport(next);
      setViewportSize(next);
      if (first) {
        first = false;
        fitAll(0);
        const sel = store.getState().selection;
        if (sel) store.focusOn(sel, "api");
        return;
      }
      if (camera.fitted) {
        fitAll(0);
        return;
      }
      const c = camera.get();
      const cx = (before.width / 2 - c.x) / c.zoom;
      const cy = (before.height / 2 - c.y) / c.zoom;
      camera.set({ zoom: c.zoom, x: next.width / 2 - cx * c.zoom, y: next.height / 2 - cy * c.zoom });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [camera, fitAll, store]);

  // Focus requests from the store: frame the target (650 ms standard; reduced motion cuts). Requests
  // with reason "follow" come from the follow camera (this view's or the shell's) and leave follow on.
  useEffect(() => {
    let lastNonce = store.getState().focus?.nonce ?? -1;
    let lastFollowCheck = 0;
    let wasFollowing = cameraFollows(store.getState());
    const followNow = (s: ReturnType<typeof store.getState>) => {
      followBase.current ??= camera.get().zoom;
      const members = withGrace(activeMembers(layout, sceneAt(s.fixture, s.playhead), s.playhead), s.playhead, followSeen.current);
      const d = followDecision(camera.get(), camera.viewport, members, followPrimary.current, followBase.current);
      followPrimary.current = d.primary;
      return { d, members };
    };
    return store.subscribe(() => {
      const s = store.getState();
      const ms = s.reducedMotion ? 0 : factoryTokens.motion.cameraFocus;
      const follows = cameraFollows(s);
      if (follows && !wasFollowing) {
        // Follow came back on (followLive, setFollow(true)): follow from the zoom the person is at.
        followBase.current = camera.get().zoom;
        lastFollowCheck = 0;
      }
      wasFollowing = follows;
      if (s.focus && s.focus.nonce !== lastNonce) {
        lastNonce = s.focus.nonce;
        if (s.focus.reason === "follow") {
          // Our own follow framing, or the shell's "Follow": apply the follow rule's framing.
          const target = pendingFollow.current ?? followNow(s).d.target;
          pendingFollow.current = null;
          if (target) camera.animateTo(target, s.reducedMotion ? 0 : 900);
        } else if (s.focus.target === "overview") {
          fitAll(ms);
        } else {
          camera.setFitted(false);
          const scene = sceneAt(s.fixture, s.playhead);
          const kind = refKind(s.focus.target);
          const pad = kind === "cell" || kind === "slice" ? 40 * 0.9 : 8;
          const r = locateScreen(layout, scene, s.playhead, s.focus.target, pad);
          if (r) {
            const minZoom = kind === "cell" || kind === "slice" || kind === "wave" || kind === "dependency" ? Z.far + 0.06 : kind === "gate" ? Z.far + 0.06 : Z.near + 0.06;
            camera.animateTo(frame(r, camera.viewport, 2.2, Math.min(minZoom, camera.get().zoom > minZoom ? camera.get().zoom : minZoom)), ms);
          }
        }
      }
      // The follow camera (follow.ts has the rule): only while cameraFollows and playing, at most every 4 s (6 s reduced).
      if (follows && s.playing) {
        const now = performance.now();
        if (now - lastFollowCheck < (s.reducedMotion ? 6000 : 4000)) return;
        lastFollowCheck = now;
        const { d } = followNow(s);
        if (!d.target) return;
        pendingFollow.current = d.target;
        const ref: EntityRef | "overview" = d.primary?.startsWith("cell:") ? (d.primary as EntityRef) : d.primary === "review" ? "station:review" : d.primary === "human" ? "station:human-approval" : d.primary === "integration" ? "station:merge" : "overview";
        store.focusOn(ref, "follow");
      }
    });
  }, [store, camera, layout, fitAll]);

  // Development and capture only: read and drive the camera (the follow check in the capture script).
  useEffect(() => {
    const env = (import.meta as { env?: { DEV?: boolean; MODE?: string } }).env;
    if (!env || !(env.DEV || env.MODE === "capture")) return;
    const hook = {
      get: () => camera.get(),
      set: (c: Camera) => camera.set(c),
      zoomTo: (zoom: number) => camera.set(zoomAt(camera.get(), zoom / camera.get().zoom, camera.viewport.width / 2, camera.viewport.height / 2)),
      fit: () => fitAll(0),
      follow: () => {
        followBase.current = camera.get().zoom;
        store.setFollow(true);
      },
      lod: () => viewportRef.current?.dataset.lod,
    };
    Object.defineProperty(window, "__atlasCamera", { value: hook, configurable: true });
    return () => {
      delete (window as { __atlasCamera?: unknown }).__atlasCamera;
    };
  }, [camera, fitAll, store]);

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

  // Roving focus (spec f.11): the view is one tab stop; inside it, arrows move between entities in
  // reading order (region by region; within a cell: cell, machines, agents, artifacts). Shift+arrows pan.
  const lastEntity = useRef<EntityRef | null>(null);
  const entities = () => [...(viewportRef.current?.querySelectorAll<SVGGElement>('[data-ref][role="button"]') ?? [])];
  const moveFocus = (step: number) => {
    const list = entities();
    if (!list.length) return;
    const active = document.activeElement as Element | null;
    let i = list.findIndex((el) => el === active);
    if (i < 0) {
      const remembered = lastEntity.current ? list.findIndex((el) => el.getAttribute("data-ref") === lastEntity.current) : -1;
      i = remembered >= 0 ? remembered - step : step > 0 ? -1 : list.length;
    }
    const next = list[Math.max(0, Math.min(list.length - 1, i + step))];
    if (!next) return;
    next.focus({ preventScroll: true });
    lastEntity.current = next.getAttribute("data-ref") as EntityRef;
    // Keep the focused entity in view: pan just enough, at the current zoom.
    const vp = viewportRef.current?.getBoundingClientRect();
    const r = next.getBoundingClientRect();
    if (vp) {
      const m = 48;
      const dx = r.left < vp.left + m ? vp.left + m - r.left : r.right > vp.right - m ? vp.right - m - r.right : 0;
      const dy = r.top < vp.top + m ? vp.top + m - r.top : r.bottom > vp.bottom - m ? vp.bottom - m - r.bottom : 0;
      if (dx || dy) {
        const c = camera.get();
        if (store.getState().follow) store.setFollow(false);
        camera.setFitted(false);
        camera.animateTo({ ...c, x: c.x + dx, y: c.y + dy }, store.getState().reducedMotion ? 0 : 240);
      }
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey) return;
    const pan = 80;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [pan, 0], ArrowRight: [-pan, 0], ArrowUp: [0, pan], ArrowDown: [0, -pan] };
    const arrow = arrows[e.key];
    if (arrow && e.shiftKey) {
      const c = camera.get();
      camera.set({ ...c, x: c.x + arrow[0], y: c.y + arrow[1] }, { user: true });
    } else if (arrow) moveFocus(e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1);
    else if (e.key === "+" || e.key === "=") zoomBy(Z.step);
    else if (e.key === "-" || e.key === "_") zoomBy(1 / Z.step);
    else if (e.key === "0") fitAll(store.getState().reducedMotion ? 0 : factoryTokens.motion.cameraFocus);
    else if ((e.key === "f" || e.key === "F") && !e.shiftKey && store.getState().selection) focusOn(store.getState().selection as EntityRef, "select");
    else if (e.key === "Escape") {
      const s = store.getState();
      if (s.hovered) hover(null);
      else if (s.selection) select(null, { focus: false });
      else if (e.target !== e.currentTarget) viewportRef.current?.focus();
      else return;
    } else return;
    // Handled here: the shell skips events whose default is prevented.
    e.preventDefault();
  };


  const theater = useSceneStore((s) => s.theater);
  const ctx = useMemo<AtlasContextValue>(() => ({ lod, layout, lightLayer: Boolean(Effects) && lightLayer }), [lod, layout, lightLayer, Effects]);
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
        aria-label="Factory Atlas, a simulation: the plant drawn in axonometric. Arrow keys move between its parts, region by region; Enter selects; Shift with arrows pans; plus and minus zoom; 0 fits."
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
        </div>
        {/* L2: the optional light layer, between the scene and the overlay; it takes the camera itself. */}
        <div className="atlas-effects" aria-hidden="true">
          {Effects ? <Effects camera={camera} layout={layout} onActive={setLightLayer} /> : null}
        </div>
        <div ref={overlayRef} className="atlas-camera atlas-camera-overlay">
          <svg className="atlas-overlay" aria-hidden="true" width={bounds.width} height={bounds.height} viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`} style={{ left: bounds.x, top: bounds.y }}>
            <Overlay zoom={zoom} lod={lod} focused={focused} theater={theater} />
          </svg>
        </div>
        <Sheet width={viewportSize.width} height={viewportSize.height} lod={lod} fixture={fixture} titled={atFit && !theater} />
        {theater ? null : (
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
        )}
        {showMeter ? <Meter /> : null}
      </div>
    </AtlasContext.Provider>
  );
}

export type { CameraStore, Camera } from "./camera";
