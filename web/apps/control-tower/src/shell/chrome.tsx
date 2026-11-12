/**
 * Frame pieces: the simulation stamp, the brand and run identity, the mode switch.
 */
import { useId } from "react";
import { cn, MachMark, fc } from "@mach/ui";
import { SCENARIO, WAVE } from "../sim";
import type { ViewMode } from "../scene";

/**
 * The permanent label: this is a simulation. Same stamp as the Blueprint's title block (warning
 * tint, warning line, bold), so it reads as one mark wherever it appears. Never hidden.
 */
export function SimulationStamp({ size = "md", className }: { size?: "md" | "lg"; className?: string }) {
  return (
    <span
      data-simulation-stamp=""
      title="Everything here plays back a recorded fixture. It reads no Factory state and changes nothing."
      className={cn(
        "inline-flex shrink-0 select-none items-center gap-1.5 rounded-xs border border-warning-line bg-warning-soft font-sans font-bold text-warning-ink",
        size === "md" ? "h-6 px-2 text-caption" : "h-7 px-2.5 text-label",
        className,
      )}
    >
      <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" className="shrink-0">
        <circle cx="5" cy="5" r="4" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeDasharray: "2 1.6" }} />
      </svg>
      Simulation
    </span>
  );
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
        MACH <span className="font-normal text-ink-muted">Control Tower</span>
      </span>
    </div>
  );
}

/** Which run this is: the wave, its title, the product and the simulated date. */
export function RunIdentity({ compact }: { compact?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2.5">
      <h1 className="truncate font-serif text-body-lg leading-none text-ink">
        {RUN.waveTitle}
        <span className="sr-only">, a simulated run of the MACH Factory</span>
      </h1>
      <span className="shrink-0 font-mono text-caption text-ink-subtle">{RUN.waveId}</span>
      {compact ? null : (
        <span className="hidden shrink-0 text-caption text-ink-subtle min-[1360px]:inline">
          {RUN.project}, {RUN.date} from {RUN.startClock} UTC
        </span>
      )}
    </div>
  );
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

/** Hairline registration cross, the drawing's own mark, used as a quiet divider in the chrome. */
export function RegistrationMark() {
  return (
    <svg aria-hidden="true" width="9" height="9" viewBox="0 0 9 9" className="shrink-0">
      <path d="M4.5 0V9M0 4.5H9" style={{ stroke: fc("plate-edge"), strokeWidth: 1 }} />
      <circle cx="4.5" cy="4.5" r="2" style={{ fill: "none", stroke: fc("plate-edge"), strokeWidth: 1 }} />
    </svg>
  );
}
