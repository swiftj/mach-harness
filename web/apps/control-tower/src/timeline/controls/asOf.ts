/**
 * `useAsOf()`: whether the playhead is behind the live edge (T6), for every part of the Timeline that
 * speaks as of the live edge (the tracks, the table, the lenses) while the inspector speaks as of the
 * playhead. Re-renders only when the answer changes or, while behind, when the playhead moves.
 */
import { useSceneStore } from "../../scene";
import { asOfPlayhead, asOfShort, type AsOf } from "./frame";

const AT_EDGE = "edge";

export function useAsOf(): AsOf & { readonly caption: string | null } {
  // One string per answer, so the selector is stable while following (no re-render per frame).
  const key = useSceneStore((s) => {
    const a = asOfPlayhead(s);
    return a.behind ? `${Math.floor(a.playhead / 1000)}:${Math.floor(a.liveAt / 1000)}` : AT_EDGE;
  });
  if (key === AT_EDGE) return { behind: false, playhead: Number.NaN, liveAt: Number.NaN, caption: null };
  const [p, l] = key.split(":").map((x) => Number(x) * 1000) as [number, number];
  const a: AsOf = { behind: true, playhead: p, liveAt: l };
  return { ...a, caption: asOfShort(a) };
}
