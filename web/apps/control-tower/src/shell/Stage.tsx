/**
 * The stage: the active view, and the interface transition between the two (spec c.6, "the drawing
 * folds flat"). The shell can only move the views as wholes; per-entity FLIP travel would need both
 * views' layouts, which they keep to themselves. So the Atlas folds down onto the sheet as the
 * Blueprint is laid over it, and unfolds again on the way back, in the spec's 700 ms and its phases
 * (0–300 ms the outgoing view loses height, 300–700 ms the incoming one fades in).
 *
 * Only the active view is mounted; during the 700 ms both exist, then the outgoing one unmounts, so
 * an inactive view costs nothing. Under reduced motion the switch is the spec's 160 ms cross-fade
 * (f.12, c.6): opacity only, no travel.
 *
 * The Atlas's optional WebGL light layer (src/effects) is passed in only when the person switches it
 * on in the help sheet; its code is a separate chunk, loaded the first time it is switched on.
 */
import { AnimatePresence, motion, type Variants } from "motion/react";
import { lazy, memo, Suspense } from "react";
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

const fade: Variants = {
  enter: { opacity: 0 },
  shown: { opacity: 1, transition: { duration: 0.16, ease: "linear" } },
  leave: { opacity: 0, transition: { duration: 0.16, ease: "linear" } },
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
  return (
    <div className="absolute inset-0 [perspective:1600px]">
      <AnimatePresence initial={false}>
        <motion.div
          key={view}
          custom={view}
          variants={reduced ? fade : variants}
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
