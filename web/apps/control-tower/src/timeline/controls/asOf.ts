/**
 * `useAsOf()`: whether the playhead is behind the live edge and whether what happened after it is
 * revealed (T6, M6.6 I-04), for every part of the Timeline that says so (the toolbar, the table, the
 * lenses). Re-renders only when the answer changes or, while behind, when the playhead moves a second.
 */
import { useSceneStore } from "../../scene";
import { asOfPlayhead, asOfShort, type AsOf } from "./frame";

const AT_EDGE = "edge";

export function useAsOf(): AsOf & { readonly caption: string | null } {
  // One string per answer, so the selector is stable while following (no re-render per frame).
  const key = useSceneStore((s) => {
    const a = asOfPlayhead(s);
    return a.behind ? `${Math.floor(a.playhead / 1000)}:${Math.floor(a.liveAt / 1000)}:${a.revealed ? 1 : 0}` : AT_EDGE;
  });
  if (key === AT_EDGE) return { behind: false, playhead: Number.NaN, liveAt: Number.NaN, revealed: false, caption: null };
  const [p, l, r] = key.split(":").map(Number) as [number, number, number];
  const a: AsOf = { behind: true, playhead: p * 1000, liveAt: l * 1000, revealed: r === 1 };
  return { ...a, caption: asOfShort(a) };
}
