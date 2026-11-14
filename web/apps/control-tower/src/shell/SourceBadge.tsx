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
 *   observer gone quiet), over the stage only while it is empty or its contents may be out of date;
 * - the **Factory state chip**: the steady states that leave the stage full and correct (the Factory
 *   not enabled on this machine, or paused), as a compact chip in the top bar whose popover holds the
 *   whole notice, so it never covers the Atlas or the Blueprint.
 *
 * Nothing here starts, pauses, schedules or approves anything; the menu only chooses what to read.
 */
import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { cn, Popover, PopoverContent, PopoverTrigger } from "@mach/ui";
import { useSceneStore, type ConnectionStatus } from "../scene";
import { refId, refKind, sourceRuntimeOf, streamObservationOf, type Completeness, type SceneSource } from "../sim";
import { completenessWords, deliveryLagWords, receivedWords, runtimeStateWords, runtimeSummaryWords } from "./inspector/words";
import { useSource } from "./source/context";
import { connectionLook, noticesFor, unavailableSourceWords, type ConnectionLook, type Notice } from "./notices";

export { connectionLook, noticesFor, type ConnectionLook, type Notice } from "./notices";
import type { SourceChoice } from "./source/boot";
import { duration as durationWords, isMoment, timecode, utcClock } from "./vocab";

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
  const unavailable = unavailableSourceWords(factory?.sources);
  const look = connectionLook(connection, unavailable);
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
    ...(unavailable ? ([["Sources", `Unavailable: ${unavailable}`]] as Array<[string, ReactNode]>) : []),
    ["Last confirmed", isMoment(connection.confirmedAt) ? `${utcClock(connection.confirmedAt)} UTC` : "Nothing yet"],
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
  // M6.6 (reliability defect 4): a source gone or unreadable is said here, on every workspace.
  const unavailable = useSceneStore((s) => unavailableSourceWords(s.factoryStatus?.sources));
  if (!connection) return null;
  const look = connectionLook(connection, unavailable);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-connection={look.state}
          data-source-unavailable={look.unavailable ?? undefined}
          aria-label={`Connection: ${look.label}. Details`}
          className={cn("inline-flex h-6 min-w-0 shrink items-center gap-1.5 rounded-full border px-2 text-caption font-semibold tabular", look.unavailable ? CONNECTION_TONE.stale : CONNECTION_TONE[look.state])}
        >
          <ConnectionGlyph state={look.state} />
          {/* A longer label ("Stale since 18:50:00", "Disconnected, retrying") folds to its glyph below 1280 px, so the top bar never clips (M6.6); the name keeps it. */}
          <span className={cn("truncate", look.unavailable ? "max-[1279px]:sr-only" : look.state === "live" || look.state === "connecting" ? "max-[1099px]:sr-only" : "max-[1279px]:sr-only")}>{look.label}</span>
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

/**
 * The completeness of the scene at the playhead in words, as one string so the badge re-renders only
 * when it changes. M6.6 (I-38): at the playhead, as the Atlas's title reads it, so a replay held before
 * a later gap does not already say "Partial since …" (following live, the playhead is the head).
 */
export function completenessKey(s: { log: { sceneAt(t: number): { completeness: Completeness } }; source: SceneSource; playhead: number }): string {
  if (s.source === "simulation") return "";
  const c = s.log.sceneAt(s.playhead).completeness;
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

/**
 * The honest empty and failure states: at most one over the stage (the most important), and the
 * Factory's steady state on this machine (not enabled, paused) for the top bar's chip, each chosen
 * on its own so a chip never hides an empty or failing stage's notice.
 */
export function useNotices(): { stage: Notice | null; chip: Notice | null } {
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
  return noticesFor({ source, connection, empty, settled, notice, observer, factory });
}

/** The notice over the stage, if any (the chip's steady states are not among them). */
export function useStageNotice(): Notice | null {
  return useNotices().stage;
}

/**
 * The notice over a workspace: over the top of the floor's stage, or (`at="bottom"`) floating over the
 * foot of Analytics' sheet, clear of its header and filters (M6.6, I-02). Either way it floats, so
 * nothing moves when it appears, and it is a polite status (role="status").
 */
export function StageNotice({ at = "top" }: { readonly at?: "top" | "bottom" } = {}) {
  const n = useStageNotice();
  if (!n) return null;
  const tone = n.tone === "danger" ? "border-danger-line bg-danger-soft" : n.tone === "warning" ? "border-warning-line bg-warning-soft" : "border-info-line bg-info-soft";
  const ink = n.tone === "danger" ? "text-danger-ink" : n.tone === "warning" ? "text-warning-ink" : "text-info-ink";
  return (
    <div className={cn("pointer-events-none absolute inset-x-0 z-20 flex justify-center px-4", at === "top" ? "top-3" : "bottom-4")}>
      <div key={n.key} role="status" data-stage-notice={n.key} className={cn("pointer-events-auto max-w-[560px] rounded-md border px-3.5 py-2.5 shadow-1", tone)}>
        <p className={cn("text-label", ink)}>{n.title}</p>
        <p className="mt-0.5 text-body-sm text-ink">{n.body}</p>
      </div>
    </div>
  );
}

/**
 * The Factory's steady state on this machine (not enabled, paused) as a chip in the top bar: one tab
 * stop, never over the stage. Its popover holds the whole notice, including that nothing in the
 * Control Tower can change it; screen readers hear the notice from the chip itself.
 */
export function FactoryStateChip() {
  const n = useNotices().chip;
  const bodyId = useId();
  if (!n || !n.chip) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-factory-state={n.key}
          aria-label={n.title.startsWith(n.chip) ? `${n.title}. Details` : `${n.chip}: ${n.title}. Details`}
          aria-describedby={bodyId}
          title={n.title}
          className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-xs border border-info-line bg-info-soft px-2 text-caption font-semibold text-info-ink"
        >
          <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" className="shrink-0">
            <circle cx="5" cy="5" r="4" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.2 }} />
            <path d="M5 4.4V7.4M5 2.6V2.8" style={{ stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" }} />
          </svg>
          <span className="max-[1439px]:sr-only">{n.chip}</span>
          <span id={bodyId} className="sr-only">
            {n.body}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-96" aria-label={n.title}>
        <div data-stage-notice={n.key}>
          <p className="text-label text-info-ink">{n.title}</p>
          <p className="mt-1 text-body-sm text-ink">{n.body}</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
