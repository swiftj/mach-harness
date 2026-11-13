/**
 * The synchronized execution timeline, docked at the bottom (spec f.8): transport, the scrubber with
 * chapters (or real landmarks) and moments, and the tracks. It starts low, with every track folded
 * into one summary row, so the stage keeps the room; the person opens the tracks (or drags the
 * timeline taller) to see each slice and its agents. Its size, collapse, time window, whether the
 * tracks are open and which are expanded are the shell's own interface state; time, selection and
 * focus are the store's.
 *
 * Simulation: the whole recorded run, computed once, with the future hatched beyond the live edge.
 * Live and replay: the history received so far, rebuilt as events arrive but at most every
 * REBUILD_MS (one model per few frames, never one per event); the live edge is the right end and
 * there is nothing beyond it. Unless the person zoomed, the window is everything held, and grows with
 * the live edge in steps of about two pixels, so the tracks redraw a few times a second at most.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSceneStore, useStore } from "../../scene";
import { historyIndexOf } from "../history";
import { Ruler } from "./Ruler";
import { Tracks, type TimeWindow } from "./Tracks";
import { Transport } from "./Transport";
import { liveTimelineModel, timelineModel, type TimelineModel } from "./model";

/** The fewest milliseconds between two rebuilds of a live model. */
const REBUILD_MS = 250;
/** A live window never spans less than this, so the first seconds of history do not fill the width. */
const MIN_SPAN_MS = 60_000;

/** The live edge rounded up to a step of about 1/500 of what is held: changes a few times a second at most. */
export function quantizedEdge(start: number, liveAt: number): number {
  const span = Math.max(MIN_SPAN_MS, liveAt - start);
  const step = Math.max(1000, Math.ceil(span / 500 / 1000) * 1000);
  return Math.max(start + MIN_SPAN_MS, Math.ceil(liveAt / step) * step);
}

/** The model for the store's source: the fixture's once, or the received history's, rebuilt as it grows. */
function useTimelineModel(): TimelineModel {
  const store = useStore();
  const source = useSceneStore((s) => s.source);
  const logVersion = useSceneStore((s) => s.logVersion);
  const build = useCallback((): TimelineModel => {
    const s = store.getState();
    return s.source === "simulation" ? timelineModel() : liveTimelineModel(s.log, s.liveAt, historyIndexOf(s.log));
  }, [store]);
  const [model, setModel] = useState<TimelineModel>(build);
  const last = useRef(0);
  useEffect(() => {
    if (source === "simulation") return;
    const wait = Math.max(0, last.current + REBUILD_MS - performance.now());
    const id = window.setTimeout(() => {
      last.current = performance.now();
      setModel(build());
    }, wait);
    return () => window.clearTimeout(id);
  }, [source, logVersion, build]);
  return model;
}

export function Timeline({ collapsed, onCollapse, tracksOpen, onTracks }: { collapsed: boolean; onCollapse: () => void; tracksOpen: boolean; onTracks: (open: boolean) => void }) {
  const model = useTimelineModel();
  const soFar = model.kind === "so-far";
  // The time the ruler and an unzoomed window span: the run (simulation) or start to the live edge.
  const extentStart = useSceneStore((s) => s.extent.start);
  const edge = useSceneStore((s) => (s.source === "simulation" ? s.extent.end : quantizedEdge(s.extent.start, s.liveAt)));
  const whole: TimeWindow = soFar ? { v0: extentStart, v1: edge } : { v0: 0, v1: model.duration };
  // null: the whole extent, following the live edge; a window: the person zoomed or panned.
  const [zoom, setZoom] = useState<TimeWindow | null>(null);
  const win = zoom ?? whole;
  const onWindow = useCallback(
    (w: TimeWindow) => {
      // Back to the whole extent is "not zoomed", so a live window grows with the edge again.
      if (w.v0 <= whole.v0 + 1 && w.v1 >= whole.v1 - 1) setZoom(null);
      else setZoom(w);
    },
    [whole.v0, whole.v1],
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const onToggle = useCallback((id: string, open?: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      const want = open ?? !prev.has(id);
      if (want === prev.has(id)) return prev;
      if (want) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Transport collapsed={collapsed} onCollapse={onCollapse} />
      {collapsed ? null : (
        <>
          <Ruler extent={whole} window={win} zoomed={zoom !== null} onWindow={onWindow} />
          <Tracks model={model} extent={whole} zoomed={zoom !== null} window={win} onWindow={onWindow} expanded={expanded} onToggle={onToggle} summary={!tracksOpen} onSummary={(summary) => onTracks(!summary)} />
        </>
      )}
    </div>
  );
}
