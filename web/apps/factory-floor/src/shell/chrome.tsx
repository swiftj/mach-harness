/**
 * Frame pieces: the source stamp, the brand and run identity, the workspace switch, and how many
 * places the Factory has at work.
 */
import { useId } from "react";
import { cn, MachMark, fc } from "@mach/ui";
import { EPIC, SCENARIO, epicsInArrivalOrder } from "../sim";
import { useScene, useSceneStore, type Workspace } from "../scene";
import { SourceStamp } from "./SourceBadge";
import { useSource } from "./source/context";
import { utcClock, utcDate } from "./vocab";

/**
 * The simulation's permanent label (the M6.0 stamp), kept for places that only ever show the
 * simulation. Anything that can show real history uses SourceStamp with the store's source.
 */
export function SimulationStamp({ size = "md", className }: { size?: "md" | "lg"; className?: string }) {
  return <SourceStamp source="simulation" size={size} className={className} />;
}

const startDate = new Date(SCENARIO.startAt);
const dateWords = `${startDate.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][startDate.getUTCMonth()]} ${startDate.getUTCFullYear()}`;

export const RUN = {
  epicId: EPIC.id,
  epicTitle: SCENARIO.definitions.epics[EPIC.id]?.title ?? EPIC.id,
  project: SCENARIO.definitions.project.name,
  date: dateWords,
  startClock: SCENARIO.startAt.slice(11, 16),
};

export function Brand() {
  return (
    <div className="flex shrink-0 items-center gap-2.5">
      <MachMark size={18} />
      <span className="text-label text-ink">
        MACH <span className="font-normal text-ink-muted max-[899px]:sr-only">Factory Floor</span>
      </span>
    </div>
  );
}

/** The simulation's run: the epic, its name, the product and the simulated date. */
function SimulatedRun({ compact }: { compact?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2.5">
      {/* The run's name gives way last: the history's start, then the epic, are cut first. */}
      <h1 className="max-w-[45%] shrink-0 truncate font-sans text-body-lg font-bold leading-none text-ink">
        {RUN.epicTitle}
        <span className="sr-only">, a simulated run of the MACH Factory</span>
      </h1>
      <span className="shrink-0 font-mono text-caption text-ink-subtle max-[799px]:hidden">{RUN.epicId}</span>
      {compact ? null : (
        <span className="hidden min-w-0 truncate text-caption text-ink-subtle min-[1360px]:inline">
          {RUN.project}, {RUN.date} from {RUN.startClock} UTC
        </span>
      )}
    </div>
  );
}

/** Real history: the observer's project, the epics whose slices were received so far, and where the history held begins. */
function RealRun({ compact }: { compact?: boolean }) {
  const { project } = useSource();
  const start = useSceneStore((s) => s.extent.start);
  const held = useSceneStore((s) => s.log.size() > 0);
  // Epic ids (codes, never names), in the order their first slice arrived: a string so the title
  // re-renders only when a new epic appears.
  const epics = useScene((s) => epicsInArrivalOrder(s).join(" "));
  const list = epics ? epics.split(" ") : [];
  const title = project ?? "This project";
  return (
    <div className="flex min-w-0 items-baseline gap-2.5">
      {/* The run's name gives way last: the history's start, then the epics, are cut first. */}
      <h1 className="max-w-[45%] shrink-0 truncate font-sans text-body-lg font-bold leading-none text-ink">
        {title}
        <span className="sr-only">, real execution of the MACH Factory, live</span>
      </h1>
      {list.length ? (
        <span className="shrink-0 font-mono text-caption text-ink-subtle max-[799px]:hidden" title={list.join(", ")}>
          {list.length > 2 ? `${list.at(-1)} and ${list.length - 1} more` : list.join(", ")}
        </span>
      ) : null}
      {compact || !held ? null : (
        <span className="hidden min-w-0 truncate text-caption text-ink-subtle min-[1360px]:inline">
          History held from {utcDate(start)}, {utcClock(start)} UTC
        </span>
      )}
    </div>
  );
}

/** Which run this is. */
export function RunIdentity({ compact }: { compact?: boolean }) {
  const source = useSceneStore((s) => s.source);
  return source === "simulation" ? <SimulatedRun compact={compact} /> : <RealRun compact={compact} />;
}

const WORKSPACE_CHOICES: Array<{ value: Workspace; label: string; keys: string; hint: string }> = [
  { value: "line", label: "Line", keys: "1", hint: "Line: the stations left to right, a row for each ticket" },
  { value: "floor", label: "Floor", keys: "2", hint: "Floor: the Factory Atlas, the factory drawn in space" },
  { value: "analytics", label: "Analytics", keys: "3", hint: "Factory Analytics: what the recorded history measures, with its sample, coverage and source" },
  { value: "decisions", label: "Decisions", keys: "4", hint: "Decisions: the architecture decisions in force, the required baseline, and what waits on a person" },
];

function WorkspaceIcon({ workspace }: { workspace: Workspace }) {
  return (
    <svg aria-hidden="true" width="16" height="14" viewBox="0 0 16 14" className="shrink-0">
      {workspace === "floor" ? (
        <>
          <path d="M1.5 4.5L8 1.5L14.5 4.5L8 7.5Z" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.2, strokeLinejoin: "round" }} />
          <path d="M1.5 8.5L8 11.5L14.5 8.5" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.2, strokeLinejoin: "round" }} />
        </>
      ) : workspace === "line" ? (
        <>
          <path d="M1 3.5H15M1 7H15M1 10.5H15" style={{ stroke: "currentColor", strokeWidth: 0.9, strokeDasharray: "1.5 1.5" }} />
          <circle cx="4" cy="3.5" r="1.6" style={{ fill: "currentColor" }} />
          <circle cx="9" cy="7" r="1.6" style={{ fill: "currentColor" }} />
          <circle cx="12.5" cy="10.5" r="1.6" style={{ fill: "currentColor" }} />
        </>
      ) : workspace === "decisions" ? (
        <>
          {/* A ruled sheet with a mark: a decision written down. */}
          <path d="M3 1.5H10.5L13 4V12.5H3Z" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.2, strokeLinejoin: "round" }} />
          <path d="M5.5 6.5H10.5M5.5 9H9" style={{ stroke: "currentColor", strokeWidth: 1.1 }} />
          <circle cx="5.5" cy="3.8" r="0.9" style={{ fill: "currentColor" }} />
        </>
      ) : (
        <>
          <path d="M3.5 12V7.5M8 12V3M12.5 12V9" style={{ stroke: "currentColor", strokeWidth: 2, strokeLinecap: "butt" }} />
          <path d="M1 12.5H15" style={{ stroke: "currentColor", strokeWidth: 0.9 }} />
        </>
      )}
    </svg>
  );
}

/**
 * The primary navigation: the workspace (Line, Floor, Analytics, Decisions), as a radio group, so arrow keys
 * move between them and the choice is announced.
 */
export function WorkspaceSwitch({ value, onChange }: { value: Workspace; onChange: (w: Workspace) => void }) {
  const name = useId();
  return (
    <fieldset className="flex shrink-0 rounded-sm border border-line bg-surface-sunken p-0.5" data-workspace-switch="">
      <legend className="sr-only">Workspace</legend>
      {WORKSPACE_CHOICES.map((w) => (
        <label
          key={w.value}
          title={`${w.hint} (${w.keys})`}
          className={cn(
            "relative flex h-7 cursor-pointer items-center gap-1.5 rounded-xs px-2.5 text-body-sm text-ink-muted transition-colors duration-[var(--mach-duration-fast)]",
            "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-focus",
            value === w.value ? "bg-surface font-semibold text-ink shadow-1" : "hover:text-ink",
          )}
        >
          <input type="radio" name={name} value={w.value} checked={value === w.value} onChange={() => onChange(w.value)} aria-keyshortcuts={w.keys.replace(/,\s*/g, " ")} className="sr-only" />
          <WorkspaceIcon workspace={w.value} />
          <span className="max-[1099px]:sr-only">{w.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

/** Hairline registration cross, the drawing's own mark, used as a quiet divider in the chrome. */
export function RegistrationMark() {
  return (
    <svg aria-hidden="true" width="9" height="9" viewBox="0 0 9 9" className="shrink-0">
      <path d="M4.5 0V9M0 4.5H9" style={{ stroke: fc("plate-edge"), strokeWidth: 1 }} />
      <circle cx="4.5" cy="4.5" r="2" style={{ fill: "none", stroke: fc("plate-edge"), strokeWidth: 1 }} />
    </svg>
  );
}

/**
 * How many places the Factory has at work: executions running now, of the most it may run at once
 * when the Factory recorded its limit (`factory.activated`); without a recorded limit, the count alone.
 * Not shown before anything is recorded.
 */
export function PlacesChip() {
  const running = useScene((s) => s.counters.executionsRunning);
  const limit = useScene((s) => s.factory.limits?.max_parallel ?? null);
  const known = useScene((s) => s.factory.enabled || Object.keys(s.executions).length > 0);
  if (!known) return null;
  const n = Math.max(0, running);
  const words = limit !== null ? `${n} of ${limit} place${limit === 1 ? "" : "s"} working` : `${n} working`;
  return (
    <span className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-xs px-1 text-caption text-ink-muted" data-places={`${n}/${limit ?? ""}`}>
      {limit !== null && limit <= 8 ? (
        <span aria-hidden="true" className="inline-flex gap-[3px]">
          {Array.from({ length: limit }, (_, i) => (
            <span key={i} className={cn("size-[9px] rounded-[2px] border-[1.5px] border-factory-ink-soft", i < n && "bg-factory-ink-soft")} />
          ))}
        </span>
      ) : null}
      <span className="max-[1279px]:sr-only">{words}</span>
    </span>
  );
}
