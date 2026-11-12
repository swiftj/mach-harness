/**
 * The stage: the two views, and the interface transition between them (spec c.6, "the drawing folds
 * flat").
 *
 * Both views stay mounted once prepared. The active one mounts at once; the other is rendered while
 * the browser is idle, in a React transition (time-sliced), and then kept laid out but invisible
 * (`visibility: hidden`, `inert`), so a switch never mounts a view or computes its layout inside the
 * transition (findings D4: the first switch to the Blueprint spent 92 ms of script on that).
 *
 * The transition touches only compositor properties (opacity and transform), run by the Web
 * Animations API so they play on the compositor thread. Each view's layer stays promoted
 * (`will-change`), as the old motion wrapper's was: promoting it only for the switch made Atlas
 * playback GPU-bound at rest (measured). Before it starts, the incoming view is shown at 1% opacity for two frames, so its
 * drawing is rasterised before it has to move. The outgoing Atlas folds down as the Blueprint is laid
 * over it, and unfolds on the way back, in the spec's 700 ms and its phases (0–300 ms the outgoing
 * view loses height, 300–700 ms the incoming one fades in). The fold is a 2D squash, not a rotation
 * in perspective: a 3D fold of a 2,300-element drawing re-rasterised on the GPU every frame.
 *
 * Under reduced motion the switch is a cut (spec c.6, f.12): the prepared view replaces the old one in
 * the same frame, and the announcer's live region says which view is up.
 *
 * The Atlas's optional WebGL light layer (src/effects) is passed in only when the person switches it
 * on in the help sheet; its code is a separate chunk, loaded the first time it is switched on.
 */
import { lazy, memo, startTransition, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AtlasView, type AtlasEffects } from "../atlas";
import { BlueprintView } from "../blueprint";
import { SceneStoreProvider, useSceneStore, useStore, type SceneStore, type ViewMode } from "../scene";

const MODES: readonly ViewMode[] = ["atlas", "blueprint"];
const EASE = "cubic-bezier(0.2, 0, 0, 1)";
/** The Atlas folded: squashed towards its front edge and sunk a little, as if laid down onto the sheet. */
const FOLDED = "translateY(24px) scaleY(0.86)";
const FLAT = "translateY(0px) scaleY(1)";

/** Outgoing (0–300 ms) and incoming (from 200 or 300 ms) keyframes per view. */
function leaving(mode: ViewMode): { frames: Keyframe[]; options: KeyframeAnimationOptions } {
  return mode === "atlas"
    ? { frames: [{ opacity: 1, transform: FLAT }, { opacity: 0, transform: FOLDED }], options: { duration: 300, easing: EASE, fill: "forwards" } }
    : { frames: [{ opacity: 1 }, { opacity: 0 }], options: { duration: 300, easing: EASE, fill: "forwards" } };
}
function entering(mode: ViewMode): { frames: Keyframe[]; options: KeyframeAnimationOptions } {
  return mode === "atlas"
    ? { frames: [{ opacity: 0, transform: FOLDED }, { opacity: 1, transform: FLAT }], options: { duration: 500, delay: 200, easing: EASE, fill: "both" } }
    : { frames: [{ opacity: 0, transform: "scale(0.985)" }, { opacity: 1, transform: "scale(1)" }], options: { duration: 400, delay: 300, easing: EASE, fill: "both" } };
}

const LazyLight = lazy(() => import("../effects").then((m) => ({ default: m.PixiEffects })));
/** The light layer behind a Suspense boundary, so the Atlas draws at once while the chunk loads. */
const LightLayer: AtlasEffects = (props) => (
  <Suspense fallback={null}>
    <LazyLight {...props} />
  </Suspense>
);

const View = memo(function View({ mode, light }: { mode: ViewMode; light: boolean }) {
  return mode === "atlas" ? <AtlasView effects={light ? LightLayer : undefined} /> : <BlueprintView />;
});

/**
 * The store as one view sees it. While the view is hidden its updates are batched, at most one every
 * HIDDEN_MS, so a prepared view costs a fraction of a shown one during playback; reading the store
 * gives the state as of the last batch, so its renders stay consistent. Shown again, it is brought up
 * to date at once and then follows every change as before. Actions go straight to the one store.
 */
const HIDDEN_MS = 500;
interface GatedStore extends SceneStore {
  setShown(shown: boolean): void;
}
function gatedStore(store: SceneStore): GatedStore {
  const listeners = new Set<() => void>();
  let shown = true;
  let state = store.getState();
  let timer = 0;
  const notify = () => {
    state = store.getState();
    for (const l of [...listeners]) l();
  };
  const flush = () => {
    timer = 0;
    notify();
  };
  const onChange = () => {
    if (shown) notify();
    else if (!timer) timer = window.setTimeout(flush, HIDDEN_MS);
  };
  // Listens to the one store only while the view has listeners of its own.
  let unsubscribe: (() => void) | null = null;
  return {
    ...store,
    getState: () => (shown ? store.getState() : state),
    subscribe(listener) {
      listeners.add(listener);
      unsubscribe ??= store.subscribe(onChange);
      return () => {
        listeners.delete(listener);
        if (!listeners.size && unsubscribe) {
          unsubscribe();
          unsubscribe = null;
          window.clearTimeout(timer);
          timer = 0;
        }
      };
    },
    setShown(next) {
      if (next === shown) return;
      shown = next;
      if (shown) {
        window.clearTimeout(timer);
        timer = 0;
        if (state !== store.getState()) notify();
      }
    },
  };
}

type IdleWindow = Window & { requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };

/** Run `fn` when the browser is idle (or after `timeout` ms at the latest). Returns a cancel function. */
function whenIdle(fn: () => void, timeout: number): () => void {
  const w = window as IdleWindow;
  if (w.requestIdleCallback && w.cancelIdleCallback) {
    const id = w.requestIdleCallback(fn, { timeout });
    return () => w.cancelIdleCallback?.(id);
  }
  const id = window.setTimeout(fn, Math.min(timeout, 600));
  return () => window.clearTimeout(id);
}

function clearLayer(el: HTMLElement | null) {
  if (!el) return;
  for (const a of el.getAnimations()) a.cancel();
  el.style.opacity = "";
}

export function Stage({ light = false }: { light?: boolean }) {
  const view = useSceneStore((s) => s.view);
  const reduced = useSceneStore((s) => s.reducedMotion);
  const store = useStore();
  const root = useRef<HTMLDivElement>(null);
  const layers = useRef<Record<ViewMode, HTMLDivElement | null>>({ atlas: null, blueprint: null });
  // One gated view of the store per view (made once; the store is the app's one store).
  const [stores] = useState<Record<ViewMode, GatedStore>>(() => ({ atlas: gatedStore(store), blueprint: gatedStore(store) }));

  // Which views are mounted: the active one at once, the other while idle (below).
  const [mounted, setMounted] = useState<ReadonlySet<ViewMode>>(() => new Set([view]));
  if (!mounted.has(view)) setMounted(new Set([...mounted, view]));
  // The view fully on screen; during a transition `view` (the store's) is the incoming one.
  const [settled, setSettled] = useState<ViewMode>(view);
  // Under reduced motion there is no transition to wait for: settled follows the store at once.
  if (reduced && settled !== view) setSettled(view);
  const shown: ViewMode = reduced ? view : settled;

  // Prepare the other view while the browser is idle, as an interruptible (time-sliced) render.
  useEffect(() => {
    if (mounted.size === MODES.length) return;
    return whenIdle(() => startTransition(() => setMounted(new Set(MODES))), 2000);
  }, [mounted]);

  // Once the other view is prepared, paint it once while idle (shown at 1% opacity for a few frames,
  // under the active view): the first paint of a drawing costs far more than the later ones (layers,
  // glyphs, raster tiles), and this keeps that cost out of the first switch.
  const viewRef = useRef(view);
  useLayoutEffect(() => {
    viewRef.current = view;
  }, [view]);
  const primed = useRef<ReadonlySet<ViewMode>>(new Set([view]));
  useEffect(() => {
    const todo = MODES.filter((m) => mounted.has(m) && !primed.current.has(m));
    if (!todo.length) return;
    let frame = 0;
    const cancelIdle = whenIdle(() => {
      for (const m of todo) {
        const el = layers.current[m];
        if (!el || viewRef.current === m) continue;
        primed.current = new Set([...primed.current, m]);
        // On top, or the browser may skip rasterising it as covered by the active view.
        el.style.visibility = "visible";
        el.style.opacity = "0.01";
        el.style.zIndex = "2";
        let left = 3;
        const done = () => {
          if (left-- > 0) {
            frame = requestAnimationFrame(done);
            return;
          }
          // Still the hidden view: put it back as React left it. (A switch since then owns the styles.)
          el.style.zIndex = viewRef.current === m ? "1" : "0";
          if (viewRef.current !== m && !el.getAnimations().length) {
            el.style.opacity = "";
            el.style.visibility = "hidden";
          }
        };
        frame = requestAnimationFrame(done);
      }
    }, 2000);
    return () => {
      cancelIdle();
      cancelAnimationFrame(frame);
    };
  }, [mounted]);

  // The transition: compositor-only animations on the two layers, started once the incoming layer
  // has been rasterised. A new switch while one runs ends it where it is and starts from there.
  useLayoutEffect(() => {
    if (reduced) {
      // A cut: nothing animates and nothing waits.
      for (const m of MODES) clearLayer(layers.current[m]);
      return;
    }
    const incoming = layers.current[view];
    const outgoing = layers.current[settled];
    // The incoming view is brought up to date before it shows (a no-op once it already is).
    stores[view].setShown(true);
    if (settled === view || !incoming || !outgoing) {
      // Settled: the layers carry no animation, no promoted layer and no inline style.
      for (const m of MODES) clearLayer(layers.current[m]);
      return;
    }
    let cancelled = false;
    let frame = 0;
    clearLayer(incoming);
    clearLayer(outgoing);
    // Shown, nearly transparent: the browser rasterises it now, not in the first frame of the motion.
    incoming.style.opacity = "0.01";
    let waits = 2;
    const start = () => {
      if (cancelled) return;
      if (waits-- > 0) {
        frame = requestAnimationFrame(start);
        return;
      }
      const out = leaving(settled);
      const inn = entering(view);
      outgoing.animate(out.frames, out.options);
      const enter = incoming.animate(inn.frames, inn.options);
      incoming.style.opacity = "";
      enter.finished.then(
        () => {
          if (!cancelled) setSettled(view);
        },
        () => undefined,
      );
    };
    frame = requestAnimationFrame(start);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [view, settled, reduced, stores]);

  // A view neither shown nor arriving is hidden: its updates are batched (gatedStore).
  useLayoutEffect(() => {
    for (const m of MODES) stores[m].setShown(m === view || m === shown);
  }, [view, shown, stores]);

  // Focus follows the switch (spec c.6): when it was in the outgoing view (or had fallen to the page),
  // it moves to the incoming view's canvas, which lands it on the selection.
  const focused = useRef(view);
  useEffect(() => {
    if (focused.current === view) return;
    focused.current = view;
    const active = document.activeElement;
    if (active && active !== document.body && !root.current?.contains(active)) return;
    let frame = 0;
    let tries = 0;
    const place = () => {
      const canvas = layers.current[view]?.querySelector<HTMLElement>(`[tabindex="0"]`);
      if (canvas) canvas.focus({ preventScroll: true });
      else if (tries++ < 30) frame = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(frame);
  }, [view]);

  // A view's own window-level keys (+, -, 0 with focus outside any view) must reach only the active
  // view: the hidden, prepared one is still mounted. Swallow them before they reach the hidden view
  // when focus is in no view at all and the active view does not take them that way.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!(e.key === "+" || e.key === "=" || e.key === "-" || e.key === "0")) return;
      const t = e.target as HTMLElement | null;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable || t.closest?.("[data-view]"))) return;
      // Only the Blueprint listens on the window for these; while the Atlas is up, nothing should.
      if (store.getState().view !== "blueprint") e.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [store]);

  return (
    <div ref={root} className="absolute inset-0">
      {MODES.filter((m) => mounted.has(m)).map((m) => {
        const active = m === view;
        const visible = m === shown || m === view;
        return (
          <div
            key={m}
            ref={(el) => {
              layers.current[m] = el;
            }}
            data-stage-view={m}
            data-stage-active={active ? "" : undefined}
            inert={!active}
            aria-hidden={visible ? undefined : true}
            className="absolute inset-0 origin-[50%_85%] [will-change:opacity,transform]"
            style={{ visibility: visible ? "visible" : "hidden", zIndex: active ? 1 : 0 }}
          >
            <SceneStoreProvider store={stores[m]}>
              <View mode={m} light={light} />
            </SceneStoreProvider>
          </div>
        );
      })}
    </div>
  );
}
