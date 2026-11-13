/**
 * Frame pieces: the source stamp, the brand and run identity, the workspace switch and the mode switch.
 */
import { useId } from "react";
import { cn, MachMark, fc } from "@mach/ui";
import { SCENARIO, WAVE } from "../sim";
import { useScene, useSceneStore, type ViewMode, type Workspace } from "../scene";
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
  waveId: WAVE.id,
  waveTitle: SCENARIO.definitions.waves[WAVE.id]?.title ?? WAVE.id,
  project: SCENARIO.definitions.project.name,
  date: dateWords,
  startClock: SCENARIO.startAt.slice(11, 16),
};

export function Brand() {
  return (
    <div className="flex shrink-0 items-center gap-2.5">
      <MachMark size={18} />
      <span className="text-label text-ink">
        MACH <span className="font-normal text-ink-muted max-[899px]:sr-only">Control Tower</span>
      </span>
    </div>
  );
}

/** The simulation's run: the wave, its title, the product and the simulated date. */
function SimulatedRun({ compact }: { compact?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2.5">
      {/* The run's name gives way last: the history's start, then the waves, are cut first. */}
      <h1 className="max-w-[45%] shrink-0 truncate font-sans text-body-lg font-bold leading-none text-ink">
        {RUN.waveTitle}
        <span className="sr-only">, a simulated run of the MACH Factory</span>
      </h1>
      <span className="shrink-0 font-mono text-caption text-ink-subtle max-[799px]:hidden">{RUN.waveId}</span>
      {compact ? null : (
        <span className="hidden min-w-0 truncate text-caption text-ink-subtle min-[1360px]:inline">
          {RUN.project}, {RUN.date} from {RUN.startClock} UTC
        </span>
      )}
    </div>
  );
}

/** Real history: the observer's project, the waves received so far, and where the history held begins. */
function RealRun({ compact }: { compact?: boolean }) {
  const source = useSceneStore((s) => s.source);
  const { project } = useSource();
  const start = useSceneStore((s) => s.extent.start);
  const held = useSceneStore((s) => s.log.size() > 0);
  // Wave ids, in arrival order: a string so the title re-renders only when a wave arrives.
  const waves = useScene((s) =>
    Object.values(s.waves)
      .sort((a, b) => a.discoveredAt - b.discoveredAt)
      .map((w) => w.id)
      .join(" "),
  );
  const list = waves ? waves.split(" ") : [];
  const title = project ?? "This project";
  return (
    <div className="flex min-w-0 items-baseline gap-2.5">
      {/* The run's name gives way last: the history's start, then the waves, are cut first. */}
      <h1 className="max-w-[45%] shrink-0 truncate font-sans text-body-lg font-bold leading-none text-ink">
        {title}
        <span className="sr-only">, {source === "live" ? "real execution of the MACH Factory, live" : "real execution of the MACH Factory, replayed"}</span>
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

const MODES: Array<{ value: ViewMode; label: string; key: string; hint: string }> = [
  { value: "atlas", label: "Atlas", key: "1", hint: "Factory Atlas: the plant in space" },
  { value: "blueprint", label: "Blueprint", key: "2", hint: "Execution Blueprint: the run as a drawing" },
];

function ModeIcon({ mode }: { mode: ViewMode }) {
  return (
    <svg aria-hidden="true" width="16" height="14" viewBox="0 0 16 14" className="shrink-0">
      {mode === "atlas" ? (
        <>
          <path d="M1.5 6L8 2.5L14.5 6L8 9.5Z" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.2, strokeLinejoin: "round" }} />
          <path d="M1.5 6V8.5L8 12L14.5 8.5V6" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.2, strokeLinejoin: "round" }} />
        </>
      ) : (
        <>
          <path d="M1.5 2.5H14.5V11.5H1.5Z" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.2 }} />
          <path d="M1.5 7H14.5" style={{ stroke: "currentColor", strokeWidth: 0.8 }} />
          <circle cx="5" cy="4.8" r="1.2" style={{ fill: "currentColor" }} />
          <path d="M8 9.2L9.4 7.8L10.8 9.2L9.4 10.6Z" style={{ fill: "currentColor" }} />
        </>
      )}
    </svg>
  );
}

/** "Atlas | Blueprint": a radio group, so arrow keys move between the two and the choice is announced. */
export function ModeSwitch({ value, onChange }: { value: ViewMode; onChange: (v: ViewMode) => void }) {
  const name = useId();
  return (
    <fieldset className="flex shrink-0 rounded-sm border border-line bg-surface-sunken p-0.5" data-mode-switch="">
      <legend className="sr-only">View</legend>
      {MODES.map((m) => (
        <label
          key={m.value}
          title={`${m.hint} (${m.key})`}
          className={cn(
            "relative flex h-7 cursor-pointer items-center gap-1.5 rounded-xs px-2.5 text-body-sm text-ink-muted transition-colors duration-[var(--mach-duration-fast)]",
            "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-focus",
            value === m.value ? "bg-surface font-semibold text-ink shadow-1" : "hover:text-ink",
          )}
        >
          <input type="radio" name={name} value={m.value} checked={value === m.value} onChange={() => onChange(m.value)} className="sr-only" />
          <ModeIcon mode={m.value} />
          <span>{m.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

const WORKSPACE_CHOICES: Array<{ value: Workspace; label: string; keys: string; hint: string }> = [
  { value: "floor", label: "Factory floor", keys: "1, 2", hint: "Factory floor: the plant now, as the Atlas or the Blueprint" },
  { value: "timeline", label: "Timeline", keys: "3", hint: "Execution Timeline: what the Factory did, when, and how it is known" },
];

function WorkspaceIcon({ workspace }: { workspace: Workspace }) {
  return (
    <svg aria-hidden="true" width="16" height="14" viewBox="0 0 16 14" className="shrink-0">
      {workspace === "floor" ? (
        <>
          <path d="M1.5 4.5L8 1.5L14.5 4.5L8 7.5Z" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.2, strokeLinejoin: "round" }} />
          <path d="M1.5 8.5L8 11.5L14.5 8.5" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.2, strokeLinejoin: "round" }} />
        </>
      ) : (
        <>
          <path d="M1.5 3.5H9M4 7H14.5M1.5 10.5H7.5" style={{ stroke: "currentColor", strokeWidth: 2, strokeLinecap: "butt" }} />
          <path d="M11 1V13" style={{ stroke: "currentColor", strokeWidth: 0.9 }} />
        </>
      )}
    </svg>
  );
}

/**
 * The primary navigation (M6.3 design section 3): the workspace. A radio group in the same language as
 * the Atlas/Blueprint switch, which is shown beside it on the floor only. Later experiences are not
 * drawn until they exist.
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
          <input type="radio" name={name} value={w.value} checked={value === w.value} onChange={() => onChange(w.value)} aria-keyshortcuts={w.value === "timeline" ? "3" : "1 2"} className="sr-only" />
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
