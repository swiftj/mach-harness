/**
 * `useTimelineData()`: the one TimelineData of the app, chosen by the store's source. Live and replay
 * read through the ObserverClient the shell already holds (SourceContext), so its session cookie and
 * connection are reused and no second client is made; the simulation derives from its scene. One
 * instance per store: a new store (switching source) gets a new provider.
 */
import { useSource } from "../../shell/source/context";
import { useStore } from "../../scene/react";
import type { SceneStore } from "../../scene/store";
import type { ObserverClient } from "../../live/observer";
import type { TimelineData } from "../contract";
import { createObserverTimelineData } from "./observer";
import { createSimulationTimelineData } from "./simulation";

const held = new WeakMap<SceneStore, { client: ObserverClient | null; data: TimelineData }>();

/** The provider for a store (and the observer client, when live or replay), made once and kept. */
export function timelineDataFor(store: SceneStore, client: ObserverClient | null): TimelineData {
  const found = held.get(store);
  if (found && found.client === client) return found.data;
  const source = store.getState().source;
  const data = source !== "simulation" && client ? createObserverTimelineData(client, store) : createSimulationTimelineData(store, { source });
  held.set(store, { client, data });
  return data;
}

export function useTimelineData(): TimelineData {
  const store = useStore();
  const { client = null } = useSource();
  return timelineDataFor(store, client);
}
