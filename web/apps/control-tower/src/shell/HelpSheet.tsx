/**
 * The keyboard help (`?`): every shortcut, rendered from the same table the handler uses, plus the
 * legend of the timeline's marks.
 */
import { type RefObject } from "react";
import { Dialog, DialogContent, Kbd } from "@mach/ui";
import { KEYMAP, type KeyBinding } from "./keyboard";
import { StateGlyph } from "./glyphs";
import { TelemetryBadge } from "./inspector/parts";

const GROUPS: KeyBinding["group"][] = ["Playback", "Views", "Panels", "In a view", "Atlas", "Blueprint", "Timeline"];

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
          const canvas = document.querySelector<HTMLElement>("[data-stage-active] [tabindex='0']");
          if (back instanceof Element && !back.isConnected && canvas) {
            event.preventDefault();
            canvas.focus();
          }
        }}
        title="Keyboard, legend and display" description="Every shortcut in the Control Tower prototype. The keys under In a view, Atlas, Blueprint and Timeline work while that part has focus.">
        {/* Scrolls on short windows, so it takes focus for keyboard scrolling. */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
        <div tabIndex={0} role="region" aria-label="Shortcuts and legend" className="grid min-h-0 gap-x-8 gap-y-5 overflow-y-auto px-6 pb-6 pt-4 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus md:grid-cols-2">
          {GROUPS.map((group) => (
            <section key={group} aria-labelledby={`keys-${group.replace(/\s+/g, "-")}`}>
              <h3 id={`keys-${group.replace(/\s+/g, "-")}`} className="mb-2 text-label text-ink">
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
