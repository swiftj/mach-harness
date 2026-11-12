/**
 * The keyboard help (`?`): every shortcut, rendered from the same table the handler uses, plus the
 * legend of the timeline's marks.
 */
import { useId } from "react";
import { cn, Dialog, DialogContent, Kbd } from "@mach/ui";
import { useSceneStore } from "../scene";
import { KEYMAP, type KeyBinding } from "./keyboard";
import { StateGlyph } from "./glyphs";
import { TelemetryBadge } from "./inspector/parts";

const GROUPS: KeyBinding["group"][] = ["Playback", "Views", "Panels", "In a view"];

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex flex-wrap items-center justify-end gap-1">
      {keys.map((k, i) => (
        <span key={k} className="inline-flex items-center gap-1">
          {i > 0 ? <span className="text-caption text-ink-subtle">/</span> : null}
          {(k.length > 1 ? k.split("+") : [k]).map((part, j) => (
            <span key={part + j} className="inline-flex items-center gap-0.5">
              {j > 0 ? <span className="text-caption text-ink-subtle">+</span> : null}
              <Kbd>{part}</Kbd>
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}

function LightSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const reduced = useSceneStore((s) => s.reducedMotion);
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-6 rounded-sm border border-dashed border-line-strong px-4 py-3">
      <div className="min-w-0">
        <label htmlFor={id} className="text-label text-ink">
          Experimental light layer (WebGL)
        </label>
        <p id={`${id}-d`} className="mt-0.5 text-body-sm text-ink-muted">
          Draws the Atlas's work lamps, packet trails and gate flashes on a WebGL canvas instead of in the drawing, for comparison. Decoration only: the drawing is complete without it. Loaded only when switched on.
          {reduced ? " Your system asks for reduced motion, so the layer stays off." : ""}
        </p>
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={on}
        aria-describedby={`${id}-d`}
        onClick={() => onChange(!on)}
        className={cn(
          "relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-[var(--mach-duration-fast)]",
          on ? "border-accent-fill bg-accent-fill" : "border-line-strong bg-surface-sunken",
        )}
      >
        <span className={cn("inline-block size-3.5 rounded-full shadow-1 transition-transform duration-[var(--mach-duration-fast)]", on ? "translate-x-[17px] bg-ink-on-accent" : "translate-x-[2px] bg-ink-muted")} />
      </button>
    </div>
  );
}

export function HelpSheet({ open, onOpenChange, light, onLight }: { open: boolean; onOpenChange: (open: boolean) => void; light: boolean; onLight: (on: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent width="lg" title="Keyboard, legend and display" description="Every shortcut in the Control Tower prototype. Keys marked for a view work while that view or the timeline tracks have focus.">
        {/* Scrolls on short windows, so it takes focus for keyboard scrolling. */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
        <div tabIndex={0} role="region" aria-label="Shortcuts and legend" className="grid min-h-0 gap-x-8 gap-y-5 overflow-y-auto px-6 pb-6 pt-4 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus md:grid-cols-2">
          {GROUPS.map((group) => (
            <section key={group} aria-labelledby={`keys-${group}`}>
              <h3 id={`keys-${group}`} className="mb-2 text-label text-ink">
                {group}
              </h3>
              <dl className="flex flex-col gap-1.5">
                {KEYMAP.filter((k) => k.group === group).map((k) => (
                  <div key={k.action} className="grid grid-cols-[1fr_auto] items-center gap-3 border-b border-line pb-1.5 last:border-b-0">
                    <dt className="text-body-sm text-ink-muted">{k.action}</dt>
                    <dd>
                      <Keys keys={k.keys} />
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
          <section aria-labelledby="display" className="md:col-span-2">
            <h3 id="display" className="mb-2 text-label text-ink">
              Display
            </h3>
            <LightSwitch on={light} onChange={onLight} />
          </section>
          <section aria-labelledby="legend" className="md:col-span-2">
            <h3 id="legend" className="mb-2 text-label text-ink">
              Reading the timeline and the inspector
            </h3>
            <ul className="grid gap-x-6 gap-y-1.5 text-body-sm text-ink-muted sm:grid-cols-2">
              <li className="flex items-center gap-2">
                <StateGlyph state="active" size={12} /> Working: a station visit or agent in progress
              </li>
              <li className="flex items-center gap-2">
                <StateGlyph state="succeeded" size={12} /> Passed or finished
              </li>
              <li className="flex items-center gap-2">
                <StateGlyph state="failed" size={12} /> Failed: a red line runs through the track
              </li>
              <li className="flex items-center gap-2">
                <StateGlyph state="waiting" size={12} /> Waiting on a dependency (dashed)
              </li>
              <li className="flex items-center gap-2">
                <StateGlyph state="human" size={12} /> Held for a person; a filled triangle is a person's act
              </li>
              <li className="flex items-center gap-2">
                <span className="inline-block h-3 w-6 border-l border-dashed border-line-strong bg-surface-sunken" aria-hidden="true" /> Beyond the live edge: has not happened yet
              </li>
              <li className="flex items-center gap-2">
                <TelemetryBadge telemetry="exists" /> MACH emits this event today
              </li>
              <li className="flex items-center gap-2">
                <TelemetryBadge telemetry="derivable" /> On disk; an observer could derive it
              </li>
              <li className="flex items-center gap-2">
                <TelemetryBadge telemetry="missing" /> Not recorded anywhere today
              </li>
            </ul>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
