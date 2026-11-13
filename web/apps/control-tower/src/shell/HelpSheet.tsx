/**
 * The keyboard help (`?`): every shortcut, rendered from the same table the handler uses, plus the
 * legend of the timeline's marks.
 */
import { type RefObject } from "react";
import { Dialog, DialogContent, Kbd } from "@mach/ui";
import { activeCanvas, KEYMAP, type KeyBinding } from "./keyboard";
import { StateGlyph } from "./glyphs";
import { AuthorityBadge, TelemetryBadge } from "./inspector/parts";
import { SourceGlyph } from "./SourceBadge";

const GROUPS: KeyBinding["group"][] = ["Playback", "Views", "Panels", "In a view", "Atlas", "Blueprint", "Timeline", "Timeline workspace"];
/** What each group is, where it is not obvious. */
const GROUP_NOTES: Partial<Record<KeyBinding["group"], string>> = {
  Timeline: "The timeline docked under the Factory floor.",
  "Timeline workspace": "While the Timeline (3) is up. Space, the arrows and the playback keys work there as everywhere; T does nothing.",
};

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

export function HelpSheet({ open, onOpenChange, opener }: { open: boolean; onOpenChange: (open: boolean) => void; opener?: RefObject<Element | null> }) {
  // DialogContent returns focus to whatever had it when the sheet opened, by key or by button, but only
  // to an HTML element (@mach/ui focus-return.ts checks `instanceof HTMLElement`). The views' entities
  // and the Blueprint's tree items are SVG elements, so the shell's record of the opener is used for
  // those: without it, `?` pressed on a Blueprint tree item sent focus to the whole stage on close
  // (checked with Playwright on a capture build). An opener a view re-rendered away goes back to that
  // view's canvas rather than to the design system's fallback (<main>, here the whole stage).
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        width="lg"
        onCloseAutoFocus={(event) => {
          const back = opener?.current;
          if (back instanceof SVGElement && back.isConnected && !back.closest("[inert]")) {
            event.preventDefault();
            back.focus();
            return;
          }
          const canvas = activeCanvas();
          if (back instanceof Element && !back.isConnected && canvas) {
            event.preventDefault();
            canvas.focus();
          }
        }}
        title="Keyboard, legend and display" description="Every shortcut in the Control Tower prototype. The keys under In a view, Atlas, Blueprint and Timeline work while that part has focus; those under Timeline workspace while the Timeline is up.">
        {/* Scrolls on short windows, so it takes focus for keyboard scrolling. */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
        <div tabIndex={0} role="region" aria-label="Shortcuts and legend" className="grid min-h-0 gap-x-8 gap-y-5 overflow-y-auto px-6 pb-6 pt-4 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus md:grid-cols-2">
          {GROUPS.map((group) => (
            <section key={group} aria-labelledby={`keys-${group.replace(/\s+/g, "-")}`}>
              <h3 id={`keys-${group.replace(/\s+/g, "-")}`} className="mb-2 text-label text-ink">
                {group}
              </h3>
              {GROUP_NOTES[group] ? <p className="-mt-1 mb-2 text-caption text-ink-subtle">{GROUP_NOTES[group]}</p> : null}
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
          <section aria-labelledby="sources" className="md:col-span-2">
            <h3 id="sources" className="mb-2 text-label text-ink">
              Where what you see comes from
            </h3>
            <ul className="grid gap-x-6 gap-y-1.5 text-body-sm text-ink-muted">
              <li className="flex items-start gap-2">
                <span className="mt-1 text-factory-live">
                  <SourceGlyph source="live" />
                </span>
                <span>
                  <strong className="text-ink">Live Factory</strong>: real execution, read by the observer from this project's Factory files as it happens. The connection badge beside it says whether it is live, reconnecting or stale; when stale, everything is shown as last seen and time stops at the last confirmed moment.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-1 text-info-ink">
                  <SourceGlyph source="replay" />
                </span>
                <span>
                  <strong className="text-ink">Historical replay</strong>: the same real history, loaded once and played back. Nothing new arrives.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-1 text-warning-ink">
                  <SourceGlyph source="simulation" />
                </span>
                <span>
                  <strong className="text-ink">Simulation</strong>: a recorded scenario of invented work, for demonstration. Never real execution. Shown when no observer answers, and said so.
                </span>
              </li>
              <li>
                Live: dragging the playhead back reviews what was received while events keep arriving; the transport counts the new events, and <strong className="text-ink">Return to live</strong> (L or End) goes back to the edge. Nothing can be shown past the live edge, and the Control Tower has no control that starts, pauses, schedules or approves anything.
              </li>
              <li>Times of real history are UTC wall-clock. A history that is partial (some of it could not be received) or reconstructed (seeded from a snapshot) says so beside the source badge.</li>
            </ul>
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
                <span className="inline-block h-3 w-6 border-l border-dashed border-line-strong bg-surface-sunken" aria-hidden="true" /> Simulation only: beyond the live edge, has not happened yet
              </li>
              <li className="flex items-center gap-2">
                <AuthorityBadge authority="authoritative" /> A MACH script recorded it as it decided it
              </li>
              <li className="flex items-center gap-2">
                <AuthorityBadge authority="observed" /> Seen in a runtime record MACH did not decide
              </li>
              <li className="flex items-center gap-2">
                <AuthorityBadge authority="reconstructed" /> Derived afterwards by the observer
              </li>
              <li className="flex items-center gap-2">
                <AuthorityBadge authority="simulated" /> Invented by the simulation
              </li>
              <li>Times: measured to the millisecond or the second, an arrival time, bounded between other records, or unknown. A value no record says reads "Not recorded".</li>
              <li>A workflow agent's tool calls are a count and its last tool's name: each call is not observable, so none is drawn.</li>
              <li className="flex items-center gap-2">
                <TelemetryBadge telemetry="exists" /> Simulation: MACH emits this event today
              </li>
              <li className="flex items-center gap-2">
                <TelemetryBadge telemetry="derivable" /> Simulation: on disk; an observer could derive it
              </li>
              <li className="flex items-center gap-2">
                <TelemetryBadge telemetry="missing" /> Simulation: not recorded anywhere today
              </li>
            </ul>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
