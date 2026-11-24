/**
 * "Needs you" for the whole shell (design M23 4.2): MACH's own list, read from the observer and read again
 * when the event stream brings a new record, what each decision made in this page answered, the person's
 * name (kept in this browser), and the two acts: a decision and the stop. Provided by the Shell; the Line's
 * strip and side panel and the top bar read it.
 *
 * Only on the Live Factory, and only where the observer can reach MACH's run.py (`can.decide`): otherwise
 * `enabled` is false, nothing is fetched, and the page shows the commands to copy as before. In the
 * Simulation nothing can be decided: the controls are absent.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSceneStore } from "../scene";
import { useSource } from "../shell/source/context";
import { ObserverError, type DecisionBody } from "../live/observer";
import { loadName, readDecided, readNeeds, saveName, type Decided, type NeedsList, type NeedTicket } from "./model";

/** What one decision made here answered: shown in its row until the event stream has caught up. */
export interface Outcome {
  readonly decided: Decided | null;
  /** MACH's refusal, or why the observer could not record it, as it came. */
  readonly refusal: string | null;
  /** How many records the page held when it was answered: the outcome stays until a later record is read. */
  readonly logSize: number;
  /** When it was answered (ms): it stays at least OUTCOME_MS, so a record that has nothing to do with it cannot hide it at once. */
  readonly at: number;
}

/** The least time a decision's answer stays in its row. */
export const OUTCOME_MS = 60_000;

export type ActResult = { readonly ok: true; readonly decided: Decided } | { readonly ok: false; readonly message: string };

export interface NeedsState {
  readonly enabled: boolean;
  readonly canStop: boolean;
  /** Null until read (and when not enabled). */
  readonly list: NeedsList | null;
  readonly error: string | null;
  readonly outcomes: Readonly<Record<string, Outcome>>;
  readonly name: string;
  setName(name: string): void;
  find(ticket: string | null): NeedTicket | null;
  decide(ticket: string, option: string, body: DecisionBody): Promise<ActResult>;
  stop(): Promise<{ readonly ok: true; readonly note: string | null } | { readonly ok: false; readonly message: string }>;
}

const OFF: NeedsState = {
  enabled: false,
  canStop: false,
  list: null,
  error: null,
  outcomes: {},
  name: "",
  setName: () => undefined,
  find: () => null,
  decide: async () => ({ ok: false, message: "Decisions cannot be recorded here." }),
  stop: async () => ({ ok: false, message: "The Factory cannot be stopped from here." }),
};

const NeedsContext = createContext<NeedsState>(OFF);

export function useNeeds(): NeedsState {
  return useContext(NeedsContext);
}

const browserStorage = (): Storage | null => {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
};

const words = (error: unknown): string => (error instanceof ObserverError || error instanceof Error ? error.message : "The observer did not answer.");

/** Re-read at most this often while records arrive, and at least this often when none do. */
const SETTLE_MS = 1500;
const EVERY_MS = 30_000;

export function NeedsProvider({ children }: { children: ReactNode }) {
  const { client, can } = useSource();
  const source = useSceneStore((s) => s.source);
  const logSize = useSceneStore((s) => s.log.size());
  const enabled = source === "live" && can?.decide === true && !!client?.needs && !!client.decide;
  const canStop = source === "live" && can?.stop === true && !!client?.stopFactory;
  const [list, setList] = useState<NeedsList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [name, setNameState] = useState(() => loadName(browserStorage()));
  const sizeRef = useRef(logSize);
  useEffect(() => {
    sizeRef.current = logSize;
  }, [logSize]);

  const read = useCallback(
    async (signal?: AbortSignal) => {
      if (!enabled || !client?.needs) return;
      try {
        const data = await client.needs(signal);
        if (signal?.aborted) return;
        setList(readNeeds(data));
        setError(null);
        // An outcome stays until a record that came after it has been read with the list.
        const now = sizeRef.current;
        setOutcomes((prev) => {
          const next: Record<string, Outcome> = {};
          const wall = Date.now();
          for (const [t, o] of Object.entries(prev)) if (o.logSize >= now || wall - o.at < OUTCOME_MS) next[t] = o;
          return Object.keys(next).length === Object.keys(prev).length ? prev : next;
        });
      } catch (e) {
        if (signal?.aborted) return;
        setError(words(e));
      }
    },
    [enabled, client],
  );

  // Read when enabled, again shortly after new records (settled), and on a slow timer.
  useEffect(() => {
    if (!enabled) return;
    const ctl = new AbortController();
    const t = window.setTimeout(() => void read(ctl.signal), list ? SETTLE_MS : 0);
    return () => {
      window.clearTimeout(t);
      ctl.abort();
    };
  }, [enabled, read, logSize]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!enabled) return;
    const t = window.setInterval(() => void read(), EVERY_MS);
    return () => window.clearInterval(t);
  }, [enabled, read]);

  const setName = useCallback((v: string) => {
    setNameState(v);
    saveName(browserStorage(), v);
  }, []);

  const decide = useCallback(
    async (ticket: string, option: string, body: DecisionBody): Promise<ActResult> => {
      if (!enabled || !client?.decide) return { ok: false, message: "Decisions cannot be recorded here." };
      try {
        const decided = readDecided(await client.decide(ticket, option, body));
        setOutcomes((prev) => ({ ...prev, [ticket]: { decided, refusal: null, logSize: sizeRef.current, at: Date.now() } }));
        void read();
        return { ok: true, decided };
      } catch (e) {
        const message = words(e);
        setOutcomes((prev) => ({ ...prev, [ticket]: { decided: null, refusal: message, logSize: sizeRef.current, at: Date.now() } }));
        return { ok: false, message };
      }
    },
    [enabled, client, read],
  );

  const stop = useCallback(async () => {
    if (!canStop || !client?.stopFactory) return { ok: false as const, message: "The Factory cannot be stopped from here." };
    try {
      const d = await client.stopFactory();
      void read();
      return { ok: true as const, note: typeof d.note === "string" ? d.note : null };
    } catch (e) {
      return { ok: false as const, message: words(e) };
    }
  }, [canStop, client, read]);

  const value = useMemo<NeedsState>(() => {
    if (!enabled && !canStop) return OFF;
    const byTicket = new Map((list?.tickets ?? []).map((t) => [t.ticketId, t]));
    return {
      enabled,
      canStop,
      list: enabled ? list : null,
      error: enabled ? error : null,
      outcomes,
      name,
      setName,
      find: (ticket) => (ticket && enabled ? (byTicket.get(ticket) ?? null) : null),
      decide,
      stop,
    };
  }, [enabled, canStop, list, error, outcomes, name, setName, decide, stop]);
  return <NeedsContext.Provider value={value}>{children}</NeedsContext.Provider>;
}
