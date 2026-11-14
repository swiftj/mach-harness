/**
 * The words for the observer connection and the honest empty and failure notices, as pure functions
 * (SourceBadge.tsx draws them). Round 6, defect 12: the Factory's steady state on this machine (not
 * enabled, paused) is a chip in the top bar, chosen apart from the notice over the stage, so it never
 * covers the Atlas or the Blueprint and never hides an empty or failing stage's notice.
 */
import { isStale, type ConnectionStatus } from "../scene/connection";
import type { SceneSource } from "../sim";
import { isMoment, utcClock } from "./time";

export interface ConnectionLook {
  state: "connecting" | "live" | "reconnecting" | "stale" | "disconnected";
  label: string;
  /** For screen readers and the announcer. */
  sentence: string;
  /** Live, but a source the observer follows is gone or unreadable (M6.6): its kind in words. */
  unavailable?: string;
}

/** A source's kind in words (M6.6): never its path. */
function sourceKindWords(key: string): string {
  if (key === "ledger") return "the intake log";
  if (key === "runs") return "the run records";
  if (key.startsWith("cell/")) return "a cell's lifecycle log";
  if (key.startsWith("stream/")) return "an execution stream";
  if (key.startsWith("exec/")) return "an execution record";
  if (key.startsWith("archive/")) return "the archive";
  return "a Factory file";
}

/** States in which the observer cannot read a source now. */
const UNAVAILABLE_STATES = new Set(["gone", "unreadable", "missing", "error"]);
/** Sources that are never legitimately finished: their "ended" means the file went away. */
const NEVER_ENDS = new Set(["ledger", "runs"]);

/**
 * M6.6 (reliability defect 4): the sources the observer follows that are gone or unreadable, as
 * words by kind ("the intake log", "a cell's lifecycle log"), or null when every source is readable.
 * Read from the status the live source already polls (`/factory/status` and `/health`
 * `freshness.sources`), so it clears on the next poll after the source returns.
 */
export function unavailableSourceWords(sources: readonly { readonly key: string; readonly state: string | null }[] | null | undefined): string | null {
  if (!sources?.length) return null;
  const kinds: string[] = [];
  for (const s of sources) {
    const out = (s.state !== null && UNAVAILABLE_STATES.has(s.state)) || (s.state === "ended" && NEVER_ENDS.has(s.key));
    if (!out) continue;
    const words = sourceKindWords(s.key);
    if (!kinds.includes(words)) kinds.push(words);
  }
  return kinds.length ? kinds.join(", ") : null;
}

/** The words for a connection. Times are factory time (the stream's), never the browser's clock. `unavailable`: unavailableSourceWords. */
export function connectionLook(c: ConnectionStatus, unavailable: string | null = null): ConnectionLook {
  const since = isMoment(c.staleSince) ? utcClock(c.staleSince) : null;
  switch (c.state) {
    case "connecting":
      return { state: "connecting", label: "Connecting", sentence: "Connecting to the observer." };
    case "live":
      if (unavailable)
        return {
          state: "live",
          label: `Live · a source is unavailable: ${unavailable}`,
          sentence: `Connected, but a source is unavailable: ${unavailable}. What it records is not arriving; the history shown may be incomplete until it returns.`,
          unavailable,
        };
      return { state: "live", label: "Live", sentence: "Connected: receiving live." };
    case "stale":
      return { state: "stale", label: since ? `Stale since ${since}` : "Stale", sentence: `Nothing heard from the observer${since ? ` since ${since} UTC` : ""}. What is shown is as last seen.` };
    case "reconnecting":
      return { state: "reconnecting", label: "Reconnecting", sentence: "The stream dropped. Reconnecting from the last cursor." };
    case "disconnected":
      // The source says disconnected after several failed attempts and keeps retrying (attempts > 0).
      if (c.attempts > 0) return { state: "disconnected", label: "Disconnected, retrying", sentence: `The observer cannot be reached${since ? ` since ${since} UTC` : ""}. Retrying; what is shown is as last seen.` };
      return { state: "disconnected", label: "Disconnected", sentence: `Disconnected${c.reason ? `: ${c.reason}` : "."}` };
    case "no-session":
      return { state: "disconnected", label: "No session", sentence: "The observer does not know this browser: the session expired or was dropped. Open the observer's new link." };
  }
}

export interface Notice {
  key: string;
  tone: "info" | "warning" | "danger";
  title: string;
  body: string;
  /** A steady state of the Factory that leaves what is shown complete: said in the top bar, not over the stage. */
  chip?: string;
}

/** Pure: which notice goes over the stage, and which in the chip. */
export function noticesFor({ source, connection, empty, settled, notice, observer, factory }: {
  source: SceneSource;
  connection: ConnectionStatus | null;
  empty: boolean;
  settled: boolean;
  notice: string | null | undefined;
  observer: string | null | undefined;
  factory: { factoryPresent?: boolean | null; enabled?: boolean | null; paused?: boolean | null } | null | undefined;
}): { stage: Notice | null; chip: Notice | null } {
  if (source === "simulation") {
    if (notice) return { stage: { key: "sim", tone: "info", title: notice, body: observer === "no-session" ? "An observer answered but this browser has no session with it. The link comes from the skill that started the observer; each link works once." : "Nothing here is real execution. Real history appears when the page is opened from the observer's link." }, chip: null };
    return { stage: null, chip: null };
  }
  const chip: Notice | null =
    factory?.factoryPresent !== false && factory?.enabled === false && source === "live"
      ? { key: "disabled", chip: "Factory not enabled", tone: "info", title: "The Factory is not enabled on this machine", body: "The observer shows what is recorded, but no Factory Supervisor runs work here. Enabling it is an engineer's decision taken outside the Control Tower, which has no control to start, pause, schedule or approve anything." }
      : factory?.factoryPresent !== false && factory?.paused && source === "live"
        ? { key: "paused", chip: "Factory paused", tone: "info", title: "The Factory is paused on this machine", body: "Recorded work stays as it is until an engineer resumes it, outside the Control Tower." }
        : null;
  const stage = ((): Notice | null => {
    if (connection && connection.state === "no-session") {
      return { key: "session", tone: "danger", title: "No observer session", body: "The observer no longer knows this browser: the session expired, or the observer was restarted. The link comes from the skill that started the observer; open the new link it printed." };
    }
    if (connection && isStale(connection)) {
      const look = connectionLook(connection);
      return { key: `stale-${look.state}`, tone: look.state === "disconnected" ? "danger" : "warning", title: look.state === "disconnected" ? "Observer unreachable: as last seen" : "As last seen", body: `${look.sentence} Work shown as executing may have changed; nothing moves until the observer answers again${look.state === "disconnected" ? ", and it will reconnect by itself when it does" : ""}.` };
    }
    if (factory?.factoryPresent === false) {
      return { key: "no-factory", tone: "info", title: "No Factory state in this project", body: "The observer is running, but this project has no .factory folder yet, so there is nothing to show. It appears here when MACH is installed and work starts." };
    }
    if (empty && settled && (!connection || connection.state === "live")) {
      return { key: "empty", tone: "info", title: source === "replay" ? "No history to replay" : "No Factory activity recorded yet", body: source === "replay" ? "The observer holds no events for this project." : "Connected and waiting: events appear here as the Factory records them." };
    }
    return null;
  })();
  return { stage, chip };
}


/** What makes two looks the same announcement: the state, and (M6.6) which sources are unavailable. */
export function lookKey(look: ConnectionLook): string {
  return look.unavailable ? `${look.state}|${look.unavailable}` : look.state;
}
