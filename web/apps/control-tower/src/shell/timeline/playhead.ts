/**
 * Frame-rate updates without React renders: the playhead cursor, the live edge and the time code
 * are moved by writing to DOM nodes from a store subscription. Components that use this never
 * re-render on a tick.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { useStore, type SceneStoreState } from "../../scene";

/** Calls `onFrame` with the store state whenever the playhead or the live edge moves (and once at mount). */
export function usePlayheadEffect(onFrame: (s: SceneStoreState) => void, deps: readonly unknown[]): void {
  const store = useStore();
  const latest = useRef(onFrame);
  useLayoutEffect(() => {
    latest.current = onFrame;
  });
  useEffect(() => {
    let playhead = Number.NaN;
    let liveAt = Number.NaN;
    const run = () => {
      const s = store.getState();
      if (s.playhead === playhead && s.liveAt === liveAt) return;
      playhead = s.playhead;
      liveAt = s.liveAt;
      latest.current(s);
    };
    run();
    const off = store.subscribe(run);
    return () => {
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, ...deps]);
}
