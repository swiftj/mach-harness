/**
 * Where what is shown comes from, said so it cannot be mistaken (spec: a simulation must never be
 * indistinguishable from real execution):
 *
 * - the **source badge**: Live Factory, Historical replay or Simulation, each with its own word,
 *   glyph and tone (never colour alone). It opens the source menu (switch to replay or to the
 *   simulation, and back);
 * - the **connection badge** (live only): connecting, live, reconnecting, stale since hh:mm:ss,
 *   disconnected; its popover gives the observer's lag, the Factory Supervisor's heartbeat age and
 *   what has been received;
 * - the **completeness badge**: shown only when history is not complete (partial since, reconstructed);
 * - the **stage notice**: the honest empty and failure states (no observer, no Factory state, the
 *   Factory not enabled on this machine, the observer gone quiet).
 *
 * Nothing here starts, pauses, schedules or approves anything; the menu only chooses what to read.
 */
import { Check, ChevronDown } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { cn, Popover, PopoverContent, PopoverTrigger } from "@mach/ui";
import { isStale, useSceneStore, type ConnectionStatus } from "../scene";
import { refId, refKind, sourceRuntimeOf, streamObservationOf, type Completeness, type SceneSource } from "../sim";
import { completenessWords, deliveryLagWords, receivedWords, runtimeStateWords, runtimeSummaryWords } from "./inspector/words";
import { useSource } from "./source/context";
import type { SourceChoice } from "./source/boot";
import { duration as durationWords, timecode, utcClock } from "./vocab";

// ---------------------------------------------------------------- the three sources

export const SOURCE_WORDS: Record<SceneSource, { label: string; short: string; description: string }> = {
  live: { label: "Live Factory", short: "Live", description: "Real execution, as the observer reads it from this project's Factory files, arriving as it happens." },
  replay: { label: "Historical replay", short: "Replay", description: "Real execution recorded earlier, loaded once from the observer and played back. Nothing new arrives." },
  simulation: { label: "Simulation", short: "Simulation", description: "A recorded scenario that plays back invented work. It reads no Factory state and is never real execution." },
};

/** The source's own glyph: a broadcast dot (live), a turning-back arrow (replay), a dashed ring (simulation). */
export function SourceGlyph({ source, size = 10 }: { source: SceneSource; size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 10 10" className="shrink-0">
      {source === "live" ? (
        <>
          <circle cx="5" cy="5" r="2.4" style={{ fill: "currentColor" }} />
          <circle cx="5" cy="5" r="4.3" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.1 }} />
        </>
      ) : source === "replay" ? (
        <>
          <path d="M2.2 3.2A3.6 3.6 0 1 1 1.4 5.6" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" }} />
          <path d="M0.8 1.4L2.4 3.6L4.6 2.4" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.2, strokeLinejoin: "round", strokeLinecap: "round" }} />
          <path d="M5 3.2V5.2L6.4 6" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.1, strokeLinecap: "round" }} />
        </>
      ) : (
        <circle cx="5" cy="5" r="4" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeDasharray: "2 1.6" }} />
      )}
    </svg>
  );
}

const TONE: Record<SceneSource, string> = {
  // Live: the factory's live ink on its soft ground, solid line.
  live: "border-factory-live bg-factory-live-soft text-factory-live",
  // Replay: the information tone, solid line; its word is set in capitals so it differs in shape too.
  replay: "border-info-line bg-info-soft text-info-ink",
  // Simulation: the warning tone, dashed: the M6.0 stamp.
  simulation: "border-dashed border-warning-line bg-warning-soft text-warning-ink",
};

/** The badge itself, without the menu (Theater Mode, anywhere that only labels). */
export function SourceStamp({ source, size = "md", className }: { source: SceneSource; size?: "md" | "lg"; className?: string }) {
  const words = SOURCE_WORDS[source];
  return (
    <span
      data-source-badge={source}
      // The M6.0 hook stays on the simulation's stamp.
      data-simulation-stamp={source === "simulation" ? "" : undefined}
      title={words.description}
      className={cn(
        "inline-flex shrink-0 select-none items-center gap-1.5 rounded-xs border font-sans font-bold",
        size === "md" ? "h-6 px-2 text-caption" : "h-7 px-2.5 text-label",
        TONE[source],
        className,
      )}
    >
      <SourceGlyph source={source} size={size === "md" ? 10 : 12} />
      {source === "replay" ? <span className="uppercase tracking-[0.04em]">{words.label}</span> : words.label}
    </span>
  );
}

function MenuItem({ choice, current, available, onPick, children }: { choice: SourceChoice; current: SceneSource; available: boolean; onPick: (c: SourceChoice) => void; children: ReactNode }) {
  const on = current === choice;
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={on}
      disabled={!available && !on}
      onClick={() => onPick(choice)}
      className="flex w-full items-start gap-2.5 rounded-sm px-2 py-2 text-left hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center">{on ? <Check aria-hidden="true" className="size-4 text-ink" /> : null}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </button>
  );
}

/** The source badge in the top bar: what is shown, and the menu to read something else. */
export function SourceBadge({ open: openProp, onOpenChange }: { open?: boolean; onOpenChange?: (open: boolean) => void } = {}) {
  const source = useSceneStore((s) => s.source);
  const { observer, switchTo } = useSource();
  const [openOwn, setOpenOwn] = useState(false);
  const open = openProp ?? openOwn;
  const setOpen = onOpenChange ?? setOpenOwn;
  const words = SOURCE_WORDS[source];
  const real = observer === "answered";
  const pick = (choice: SourceChoice) => {
    setOpen(false);
    if (choice !== source) switchTo(choice);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Source: ${words.label}. Choose what to show`}
          aria-keyshortcuts="S"
          aria-haspopup="menu"
          data-source-menu=""
          className={cn("inline-flex h-6 shrink-0 items-center gap-1.5 rounded-xs border px-2 font-sans text-caption font-bold outline-offset-2", TONE[source])}
        >
          <SourceGlyph source={source} />
          {source === "replay" ? <span className="uppercase tracking-[0.04em]">{words.label}</span> : words.label}
          <ChevronDown aria-hidden="true" className="size-3.5 opacity-80" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-2" aria-label="What to show">
        <p className="px-2 pb-1 pt-1 text-caption text-ink-subtle">{words.description}</p>
        <div role="menu" aria-label="Source" className="mt-1 flex flex-col">
          <MenuItem choice="live" current={source} available={real} onPick={pick}>
            <span className="flex items-center gap-1.5 text-body-sm font-semibold text-ink">
              <SourceGlyph source="live" /> Live Factory
            </span>
            <span className="block text-caption text-ink-muted">{real ? "Real execution as it happens." : "Needs the observer: open the link the skill printed."}</span>
          </MenuItem>
          <MenuItem choice="replay" current={source} available={real} onPick={pick}>
            <span className="flex items-center gap-1.5 text-body-sm font-semibold text-ink">
              <SourceGlyph source="replay" /> Historical replay
            </span>
            <span className="block text-caption text-ink-muted">{real ? "The same real history, played back from its start." : "Needs the observer."}</span>
          </MenuItem>
          <MenuItem choice="simulation" current={source} available onPick={pick}>
            <span className="flex items-center gap-1.5 text-body-sm font-semibold text-ink">
              <SourceGlyph source="simulation" /> Simulation
            </span>
            <span className="block text-caption text-ink-muted">The M6.0 scenario: invented work, for demonstration. Never real.</span>
          </MenuItem>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------- the connection

export interface ConnectionLook {
  state: "connecting" | "live" | "reconnecting" | "stale" | "disconnected";
  label: string;
  /** For screen readers and the announcer. */
  sentence: string;
}


/** The words for a connection. Times are factory time (the stream's), never the browser's clock. */
export function connectionLook(c: ConnectionStatus): ConnectionLook {
  const since = c.staleSince !== null ? utcClock(c.staleSince) : null;
  switch (c.state) {
    case "connecting":
      return { state: "connecting", label: "Connecting", sentence: "Connecting to the observer." };
    case "live":
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

function ConnectionGlyph({ state }: { state: ConnectionLook["state"] }) {
  return (
    <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" className="shrink-0">
      {state === "live" ? <circle cx="5" cy="5" r="3.6" style={{ fill: "currentColor" }} /> : null}
      {state === "connecting" || state === "reconnecting" ? (
        <>
          <circle cx="5" cy="5" r="3.6" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.3 }} />
          <path d="M5 1.4A3.6 3.6 0 0 1 8.6 5H5Z" style={{ fill: "currentColor" }} />
        </>
      ) : null}
      {state === "stale" ? (
        <>
          <circle cx="5" cy="5" r="3.6" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.3 }} />
          <path d="M5 2.8V5.2L6.6 6.2" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round" }} />
        </>
      ) : null}
      {state === "disconnected" ? <path d="M2 2L8 8M8 2L2 8" style={{ stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" }} /> : null}
    </svg>
  );
}

const CONNECTION_TONE: Record<ConnectionLook["state"], string> = {
  connecting: "border-line-strong text-ink-muted",
  live: "border-factory-live text-factory-live",
  reconnecting: "border-dashed border-warning-line text-warning-ink",
  stale: "border-warning-line bg-warning-soft text-warning-ink",
  disconnected: "border-danger-line bg-danger-soft text-danger-ink",
};

/** Seconds, in words, or "Not recorded". */
const ageWords = (seconds: number | null | undefined) => (seconds === null || seconds === undefined ? "Not recorded" : seconds < 1 ? "under a second" : durationWords(seconds * 1000));

/** The facts behind the connection badge: also shown in the inspector's "the run now". */
export function ConnectionFacts({ connection }: { connection: ConnectionStatus }) {
  const factory = useSceneStore((s) => s.factoryStatus);
  const look = connectionLook(connection);
  const heartbeat = connection.supervisor?.heartbeatAgeSeconds ?? factory?.supervisor.heartbeatAgeSeconds ?? null;
  const leasePresent = connection.supervisor?.present || factory?.supervisor.leasePresent;
  const fresh = factory?.supervisor.heartbeatFresh ?? connection.supervisor?.live ?? null;
  // The runtime version's state for the selected execution, when one is selected (observer M6.2).
  const runtime = useSceneStore((s) => {
    const sel = s.selection;
    if (!sel || refKind(sel) !== "execution") return null;
    const id = refId(sel);
    return runtimeStateWords(streamObservationOf(s.log.head(), id, sourceRuntimeOf(s.factoryStatus?.sources, id)));
  });
  // Every stream's runtime, summed by the observer (`/health` `ingest.runtime`, observer M6.2).
  const runtimes = factory?.runtime ? runtimeSummaryWords(factory.runtime) : null;
  const rows: Array<[string, ReactNode]> = [
    ["Connection", look.sentence],
    ["Last confirmed", connection.confirmedAt !== null ? `${utcClock(connection.confirmedAt)} UTC` : "Nothing yet"],
    ["Settled history", connection.sourceLagMs !== null ? `trails now by ${connection.sourceLagMs < 1000 ? "under a second" : durationWords(connection.sourceLagMs)}` : "Not reported"],
    ["Delivery lag", deliveryLagWords(connection.deliveryLagMs ?? factory?.delivery?.lastHoldMs ?? null)],
    [
      "Supervisor heartbeat",
      leasePresent === false ? "No supervisor lease: no Factory Supervisor is running here." : heartbeat === null ? "Not recorded" : `${ageWords(heartbeat)} ago${fresh === false ? ", not fresh" : fresh ? ", fresh" : ""}`,
    ],
    ["Received", receivedWords(connection)],
  ];
  if (runtimes) rows.push(["Claude Code streams", runtimes]);
  if (runtime) rows.push(["Selected execution", runtime]);
  if (connection.gaps || connection.resets) rows.push(["Recovered", `${connection.gaps} gap${connection.gaps === 1 ? "" : "s"}, ${connection.resets} index rebuild${connection.resets === 1 ? "" : "s"}`]);
  if (connection.refused) rows.push(["Not understood", `${connection.refused} line${connection.refused === 1 ? "" : "s"} were not version 3 events and were left out`]);
  if (connection.reason && connection.state !== "live") rows.push(["Why", connection.reason]);
  return (
    <dl className="grid grid-cols-[minmax(96px,auto)_1fr] gap-x-3 gap-y-1.5 text-body-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-subtle">{k}</dt>
          <dd className="min-w-0 break-words text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The connection badge (live only). */
export function ConnectionBadge() {
  const connection = useSceneStore((s) => s.connection);
  if (!connection) return null;
  const look = connectionLook(connection);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-connection={look.state}
          aria-label={`Connection: ${look.label}. Details`}
          className={cn("inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2 text-caption font-semibold tabular", CONNECTION_TONE[look.state])}
        >
          <ConnectionGlyph state={look.state} />
          <span className="max-[1099px]:sr-only">{look.label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-96" aria-label="Connection">
        <p className="mb-2 text-label text-ink">The observer connection</p>
        <ConnectionFacts connection={connection} />
        <p className="mt-3 text-caption text-ink-subtle">The Control Tower only reads. It cannot start, pause, schedule or approve anything.</p>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------- completeness

/** The head scene's completeness in words, as one string so the badge re-renders only when it changes. */
function completenessKey(s: { log: { head(): { completeness: Completeness } }; source: SceneSource }): string {
  if (s.source === "simulation") return "";
  const c = s.log.head().completeness;
  const words = completenessWords(c);
  return words ? `${words.state}|${c.since ?? ""}|${words.why}` : "";
}

/**
 * History completeness next to the badge, only when it is not complete (D8): partial only where
 * history was lost; records received and not interpreted are said as such, quietly.
 */
export function CompletenessBadge() {
  const key = useSceneStore(completenessKey);
  if (!key) return null;
  const [state, sinceText, ...rest] = key.split("|");
  const why = rest.join("|");
  const since = sinceText ? Number(sinceText) : null;
  const label = state === "reconstructed" ? `Reconstructed${since !== null ? ` since ${timecode(since, false)}` : ""}` : state === "partial" ? `Partial${since !== null ? ` since ${timecode(since, false)}` : ""}` : "Not all interpreted";
  return (
    <span
      data-completeness={state}
      title={why}
      className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-xs border border-dashed border-line-strong px-2 text-caption font-semibold text-ink-muted"
    >
      <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10">
        <path d="M1 5H3.4M6.6 5H9" style={{ stroke: "currentColor", strokeWidth: 1.4 }} />
        <path d="M4.2 2.5L5.8 7.5" style={{ stroke: "currentColor", strokeWidth: 1.2 }} />
      </svg>
      {label}
      <span className="sr-only">. {why}</span>
    </span>
  );
}

// ---------------------------------------------------------------- the stage notice

interface Notice {
  key: string;
  tone: "info" | "warning" | "danger";
  title: string;
  body: string;
}

/** The honest empty and failure states, over the top of the stage. At most one, the most important. */
export function useStageNotice(): Notice | null {
  const source = useSceneStore((s) => s.source);
  const connection = useSceneStore((s) => s.connection);
  const empty = useSceneStore((s) => s.source !== "simulation" && s.log.size() === 0);
  const { notice, observer } = useSource();
  const factory = useSceneStore((s) => s.factoryStatus);
  // A fresh live page has received nothing yet; give history a moment before calling it empty.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setSettled(true), 2500);
    return () => window.clearTimeout(id);
  }, []);

  if (source === "simulation") {
    if (notice) return { key: "sim", tone: "info", title: notice, body: observer === "no-session" ? "An observer answered but this browser has no session with it. The link comes from the skill that started the observer; each link works once." : "Nothing here is real execution. Real history appears when the page is opened from the observer's link." };
    return null;
  }
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
  if (factory?.enabled === false && source === "live") {
    return { key: "disabled", tone: "info", title: "The Factory is not enabled on this machine", body: "The observer shows what is recorded, but no Factory Supervisor runs work here. Enabling it is an engineer's decision taken outside the Control Tower, which has no control to start, pause, schedule or approve anything." };
  }
  if (empty && settled && (!connection || connection.state === "live")) {
    return { key: "empty", tone: "info", title: source === "replay" ? "No history to replay" : "No Factory activity recorded yet", body: source === "replay" ? "The observer holds no events for this project." : "Connected and waiting: events appear here as the Factory records them." };
  }
  if (factory?.paused && source === "live") {
    return { key: "paused", tone: "info", title: "The Factory is paused on this machine", body: "Recorded work stays as it is until an engineer resumes it, outside the Control Tower." };
  }
  return null;
}

export function StageNotice() {
  const n = useStageNotice();
  if (!n) return null;
  const tone = n.tone === "danger" ? "border-danger-line bg-danger-soft" : n.tone === "warning" ? "border-warning-line bg-warning-soft" : "border-info-line bg-info-soft";
  const ink = n.tone === "danger" ? "text-danger-ink" : n.tone === "warning" ? "text-warning-ink" : "text-info-ink";
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-4">
      <div key={n.key} role="status" data-stage-notice={n.key} className={cn("pointer-events-auto max-w-[560px] rounded-md border px-3.5 py-2.5 shadow-1", tone)}>
        <p className={cn("text-label", ink)}>{n.title}</p>
        <p className="mt-0.5 text-body-sm text-ink">{n.body}</p>
      </div>
    </div>
  );
}
