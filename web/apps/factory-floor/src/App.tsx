/**
 * MACH Factory Floor: the Line, the Floor and Analytics over real execution, with the M6.0
 * simulation kept as an explicit, always-labelled source.
 *
 * At start-up the app asks one question of the page: does an observer answer here
 * (`GET /api/v1/session`, same origin, the session cookie the observer's one-time link set)?
 * - It does: the Live Factory. The Floor shows only the present: there is no replay.
 * - An observer answers but does not know this browser: say so, and how to get a session.
 * - Nothing answers (a static build, the dev server with no observer): the simulation, with
 *   "No observer: showing the simulation" on screen.
 * `?simulation` (or the source menu) shows the simulation whatever answers. The choice is kept in the
 * address; switching makes a new store, and the view and selection carry over through the hash.
 *
 * No command, no setting: nothing the person chooses can make a simulation read as real execution.
 * Everything here reads; the observer serves GET only and the Factory Floor has no control that
 * starts, pauses, schedules or approves anything.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSceneStore, SceneStoreProvider, type SceneStore } from "./scene";
import { Shell } from "./shell";
import { createBrowserLive, observerClient, probeObserver, requestedSource, urlFor, type Probe, type SourceChoice } from "./shell/source/boot";
import { SourceContext, useSourceInfo, type ObserverPresence } from "./shell/source/context";
import { NoSession, Probing } from "./shell/source/Gate";
import { setTimeBase } from "./shell/vocab";

type Target = "pending" | "no-session" | SourceChoice;

const reducedMotionNow = () => (typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)").matches : false);

/** What to show, from what was asked for and what answered. */
function targetOf(want: SourceChoice | null, probe: Probe | null): Target {
  if (want === "simulation") return "simulation";
  if (probe === null) return "pending";
  if (probe.kind === "observer") return want ?? "live";
  if (probe.kind === "no-session") return "no-session";
  return "simulation";
}

export function App() {
  const client = useMemo(() => observerClient(), []);
  const [want, setWant] = useState<SourceChoice | null>(() => requestedSource(window.location.search));
  const [probe, setProbe] = useState<{ attempt: number; probe: Probe } | null>(null);
  // Bumped by "Try again" and by every switch: a new store (and a fresh load) each time.
  const [generation, setGeneration] = useState(0);

  // Does an observer answer here? Asked again on "Try again".
  useEffect(() => {
    let cancelled = false;
    void probeObserver(client).then((p) => {
      if (!cancelled) setProbe({ attempt: generation, probe: p });
    });
    return () => {
      cancelled = true;
    };
  }, [client, generation]);

  const answer = probe && probe.attempt === generation ? probe.probe : null;
  const target = targetOf(want, answer);
  // Every `timecode` in the shell prints the source's own kind of time.
  setTimeBase(target === "simulation" ? "scenario" : "wall");

  // The Live Factory: a store and its source, made once per switch; the source runs while it is shown.
  const live = useMemo(() => (target === "live" ? createBrowserLive(client, reducedMotionNow()) : null), [target, client, generation]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useRef<SceneStore | null>(null);
  useEffect(() => {
    if (!live) return;
    void live.source.start();
    return () => {
      live.source.stop();
      // Disposed once it is no longer the one shown (not on React's development double mount).
      window.setTimeout(() => {
        if (shown.current !== live.store) live.store.dispose();
      }, 0);
    };
  }, [live]);

  const store: SceneStore | null = target === "simulation" ? getSceneStore() : target === "live" ? (live?.store ?? null) : null;
  useEffect(() => {
    shown.current = store;
  }, [store]);

  // Reduced motion follows the system for the live store too (the simulation's store listens itself).
  useEffect(() => {
    if (!store || typeof matchMedia !== "function") return;
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const on = (e: MediaQueryListEvent) => store.setReducedMotion(e.matches);
    media.addEventListener("change", on);
    return () => media.removeEventListener("change", on);
  }, [store]);

  const switchTo = useCallback((choice: SourceChoice) => {
    window.history.replaceState(null, "", urlFor(choice, window.location));
    setWant(choice === "live" ? null : choice);
    if (choice !== "simulation") setGeneration((n) => n + 1);
  }, []);
  const retry = useCallback(() => setGeneration((n) => n + 1), []);

  const observer: ObserverPresence = answer?.kind === "observer" ? "answered" : answer?.kind === "no-session" ? "no-session" : "none";
  const notice = target === "simulation" && want !== "simulation" && answer?.kind === "none" ? "No observer: showing the simulation" : null;
  const info = useSourceInfo({
    requested: want,
    observer,
    notice,
    project: answer?.kind === "observer" ? answer.session.project : null,
    switchTo,
    // The evidence catalog is read for real history only (free-text labels, R1).
    client: target === "live" ? client : null,
  });

  if (target === "pending") return <Probing label="Looking for the observer" />;
  if (target === "no-session") return <NoSession message={answer?.kind === "no-session" ? answer.message : ""} onRetry={retry} onSimulation={() => switchTo("simulation")} />;
  if (!store) return <Probing label="Connecting to the observer" />;
  return (
    <SourceContext.Provider value={info}>
      <SceneStoreProvider store={store} key={target === "simulation" ? "simulation" : `${target}-${generation}`}>
        <Shell />
      </SceneStoreProvider>
    </SourceContext.Provider>
  );
}
