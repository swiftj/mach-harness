/**
 * React glue, as the Timeline's (timeline/data/react.ts): one AnalyticsData per store, chosen by the
 * store's source (the observer's client for live and replay, the seeded fixture for the simulation),
 * and `useAnalyticsSnapshot`, one snapshot per view that is begun again only when the view asks
 * (a refresh, a new "as of" time, the live edge advancing past it, read with `shouldRefresh`).
 */
import { useEffect, useMemo } from "react";
import type { ObserverClient } from "../../live/observer";
import { useStore } from "../../scene/react";
import type { SceneStore } from "../../scene/store";
import { useSource } from "../../shell/source/context";
import { observerAnalytics } from "./observer";
import type { AnalyticsData } from "./provider";
import { simulatedAnalytics } from "./simulation";
import { beginSnapshot, type AnalyticsSnapshotSession } from "./snapshot";

const held = new WeakMap<SceneStore, { client: ObserverClient | null; data: AnalyticsData }>();

/** The provider for a store, made once and kept (a new store, a new source, gets a new one). */
export function analyticsDataFor(store: SceneStore, client: ObserverClient | null): AnalyticsData {
  const found = held.get(store);
  if (found && found.client === client) return found.data;
  const source = store.getState().source;
  const data = source !== "simulation" && client ? observerAnalytics(client) : simulatedAnalytics();
  held.set(store, { client, data });
  return data;
}

export function useAnalyticsData(): AnalyticsData {
  const store = useStore();
  const { client = null } = useSource();
  return analyticsDataFor(store, client);
}

/**
 * One snapshot for a view. `refresh` is any value the view changes to begin again (a counter the
 * person's Refresh button or the live-edge check bumps); `asOfMs` is a replay's playhead or null.
 * The previous snapshot's requests are aborted when a new one begins or the view unmounts.
 */
export function useAnalyticsSnapshot(data: AnalyticsData, refresh: unknown, asOfMs: number | null): AnalyticsSnapshotSession {
  const session = useMemo(() => {
    void refresh; // a new value begins a new snapshot
    return beginSnapshot(data, { asOfMs });
  }, [data, refresh, asOfMs]);
  useEffect(() => () => session.abort(), [session]);
  return session;
}
