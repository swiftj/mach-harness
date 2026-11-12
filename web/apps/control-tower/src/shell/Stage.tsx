/**
 * The stage: the active view, and the interface transition between the two (spec c.6, "the drawing
 * folds flat"). The shell can only move the views as wholes; per-entity FLIP travel would need both
 * views' layouts, which they keep to themselves. So the Atlas folds down onto the sheet as the
 * Blueprint is laid over it, and unfolds again on the way back, in the spec's 700 ms and its phases
 * (0–300 ms the outgoing view loses height, 300–700 ms the incoming one fades in).
 *
 * Only the active view is mounted; during the 700 ms both exist, then the outgoing one unmounts, so
 * an inactive view costs nothing. Under reduced motion the switch is a cut (spec c.6, f.12): the new
 * view replaces the old in one frame, and the announcer's live region says which view is up.
 *
 * The Atlas's optional WebGL light layer (src/effects) is passed in only when the person switches it
 * on in the help sheet; its code is a separate chunk, loaded the first time it is switched on.
 */
import { AnimatePresence, motion, type Variants } from "motion/react";
import { lazy, memo, Suspense, useEffect, useRef } from "react";
import { AtlasView, type AtlasEffects } from "../atlas";
import { BlueprintView } from "../blueprint";
import { useSceneStore, type ViewMode } from "../scene";

const STANDARD = [0.2, 0, 0, 1] as const;

const variants: Variants = {
  enter: (mode: ViewMode) =>
    mode === "atlas"
      ? { opacity: 0, rotateX: 38, scaleY: 0.86, y: 24 }
      : { opacity: 0, scale: 0.985 },
  shown: (mode: ViewMode) => ({
    opacity: 1,
    rotateX: 0,
    scaleY: 1,
    scale: 1,
    y: 0,
    transition: mode === "atlas" ? { duration: 0.5, delay: 0.2, ease: STANDARD } : { duration: 0.4, delay: 0.3, ease: STANDARD },
  }),
  leave: (mode: ViewMode) =>
    mode === "atlas"
      ? { opacity: 0, rotateX: 38, scaleY: 0.86, y: 24, transition: { duration: 0.3, ease: STANDARD } }
      : { opacity: 0, transition: { duration: 0.3, ease: STANDARD } },
};

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

export function Stage({ light = false }: { light?: boolean }) {
  const view = useSceneStore((s) => s.view);
  const reduced = useSceneStore((s) => s.reducedMotion);
  const root = useRef<HTMLDivElement>(null);
  const shown = useRef(view);
  // Focus follows the switch (spec c.6): when it was in the outgoing view (or had fallen to the page),
  // it moves to the incoming view's canvas, which lands it on the selection.
  useEffect(() => {
    if (shown.current === view) return;
    shown.current = view;
    const active = document.activeElement;
    if (active && active !== document.body && !root.current?.contains(active)) return;
    let frame = 0;
    let tries = 0;
    const place = () => {
      const canvas = root.current?.querySelector<HTMLElement>(`[data-stage-view="${view}"] [tabindex="0"]`);
      if (canvas) canvas.focus({ preventScroll: true });
      else if (tries++ < 30) frame = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(frame);
  }, [view]);
  if (reduced) {
    // A cut: no travel and no cross-fade.
    return (
      <div ref={root} className="absolute inset-0">
        <div key={view} data-stage-view={view} className="absolute inset-0">
          <View mode={view} light={light} />
        </div>
      </div>
    );
  }
  return (
    <div ref={root} className="absolute inset-0 [perspective:1600px]">
      <AnimatePresence initial={false}>
        <motion.div
          key={view}
          custom={view}
          variants={variants}
          initial="enter"
          animate="shown"
          exit="leave"
          data-stage-view={view}
          className="absolute inset-0 origin-[50%_85%]"
        >
          <View mode={view} light={light} />
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
