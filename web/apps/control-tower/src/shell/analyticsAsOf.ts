/**
 * What history Factory Analytics describes, for its caption and its queries (M6.5 design section 4).
 * Analytics shows no transport, but it reads the one playhead: when the playhead is held behind the
 * live edge (a replay paused at a point in time, live history being reviewed), it describes the
 * history through the playhead and never a later outcome; otherwise everything recorded up to the
 * edge. The source mode is said with it, so a simulation is never passed off as real.
 *
 * `analyticsAsOf` is pure (unit-tested); `useAnalyticsAsOf` is the hook the workspace calls.
 */
import { playbackLabel, type SceneStoreState } from "../scene/store";
import { useSceneStore } from "../scene/react";
import type { SceneSource } from "../sim/provenance";
import { asOfClock, asOfPlayhead } from "../timeline/controls/frame";

export interface AnalyticsAsOf {
  readonly source: SceneSource;
  /** "Simulation", "Live", "Live, reviewing an earlier moment", "Historical replay" (the store's words). */
  readonly sourceLabel: string;
  /** `edge`: everything recorded up to the live edge (a replay's last event); `playhead`: only what happened up to the playhead. */
  readonly through: "edge" | "playhead";
  /** The upper bound for queries (`to_ms`): the playhead when `through` is `playhead`, else null (no bound: up to the edge). Source time: scenario ms or Unix ms. */
  readonly toMs: number | null;
  /** One line for the workspace's caption. */
  readonly caption: string;
}

type AsOfInput = Pick<SceneStoreState, "source" | "following" | "playhead" | "liveAt" | "connection">;

export function analyticsAsOf(s: AsOfInput, clock: (t: number) => string = asOfClock): AnalyticsAsOf {
  const behind = asOfPlayhead(s).behind;
  const sourceLabel = playbackLabel(s);
  if (behind) {
    const t = Math.floor(s.playhead / 1000) * 1000;
    return { source: s.source, sourceLabel, through: "playhead", toMs: t, caption: throughCaption(t, clock) };
  }
  return { source: s.source, sourceLabel, through: "edge", toMs: null, caption: edgeCaption(s.source) };
}

const throughCaption = (t: number, clock: (t: number) => string): string => `Through the playhead at ${clock(t)}; nothing after it is counted`;
const edgeCaption = (source: SceneSource): string =>
  source === "simulation" ? "The simulated run up to its current moment" : source === "replay" ? "The whole recorded history" : "Everything recorded up to the live edge";

/**
 * The hook: re-renders only when the answer changes (the playhead is read to the second while
 * behind, and not at all while following, so no re-render per frame).
 */
export function useAnalyticsAsOf(): AnalyticsAsOf {
  const key = useSceneStore((s) => {
    const a = analyticsAsOf(s, () => "");
    return `${s.source}|${a.sourceLabel}|${a.through}|${a.toMs ?? ""}`;
  });
  const [source, sourceLabel, through, to] = key.split("|") as [SceneSource, string, "edge" | "playhead", string];
  const toMs = to === "" ? null : Number(to);
  if (through === "playhead" && toMs !== null) return { source, sourceLabel, through, toMs, caption: throughCaption(toMs, asOfClock) };
  return { source, sourceLabel, through: "edge", toMs: null, caption: edgeCaption(source) };
}
