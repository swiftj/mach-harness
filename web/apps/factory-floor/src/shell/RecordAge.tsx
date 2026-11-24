/**
 * The top bar's freshness, beside the connection badge (live only): the age of the newest record the
 * page has received, in words that follow the clock ("last record 12 s ago"), in the warning tone
 * once it is older than STALE_RECORD_MS while a ticket is at work, and "no ticket at work" when none
 * is (freshness.ts has the rule and its reason). The exact moment is in its tooltip, its accessible
 * name and on keyboard focus (style guide 7.16). It is never a live region itself: the words change
 * every second, so only a change of tone is announced, once, in its own polite region.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { cn, Tooltip } from "@mach/ui";
import { useSceneStore } from "../scene";
import { freshnessAnnouncement, freshnessOf, ticketsAtWork, type Freshness as FreshnessWords } from "./freshness";

/** The tickets at work, as one key so the component re-renders only when the set changes. */
const atWorkKey = (s: { log: { sceneAt(t: number): Parameters<typeof ticketsAtWork>[0] }; now: number }) => ticketsAtWork(s.log.sceneAt(s.now)).join(",");

const wallClock = () => Date.now();

export function RecordAge({ clock = wallClock }: { readonly clock?: () => number } = {}) {
  const live = useSceneStore((s) => s.source !== "simulation" && s.connection !== null);
  const newest = useSceneStore((s) => s.log.headTime());
  const working = useSceneStore(atWorkKey);
  const [now, setNow] = useState(clock);
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => setNow(clock()), 1000);
    return () => window.clearInterval(id);
  }, [live, clock]);
  const count = working ? working.split(",").length : 0;
  const f: FreshnessWords = useMemo(() => freshnessOf(newest, now, count), [newest, now, count]);
  // Announced once per change of tone, never per tick.
  const tone = useRef<FreshnessWords["tone"] | null>(null);
  const [said, setSaid] = useState("");
  useEffect(() => {
    const words = freshnessAnnouncement(tone.current, f);
    tone.current = f.tone;
    if (words) setSaid(words);
  }, [f]);
  if (!live) return null;
  const warn = f.tone === "warning";
  return (
    <>
      <Tooltip content={f.full}>
        <time
          dateTime={f.at !== null ? new Date(f.at).toISOString() : undefined}
          // Focusable, so the exact moment also shows on keyboard focus, as it does on hover (7.16).
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          aria-label={f.full}
          data-freshness={f.tone}
          className={cn(
            "inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-1.5 text-caption tabular outline-offset-2",
            warn ? "border border-warning-line bg-warning-soft px-2 font-semibold text-warning-ink" : "text-ink-muted",
          )}
        >
          {warn ? (
            // The stale clock: the warning is a shape too, never colour alone.
            <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" className="shrink-0">
              <circle cx="5" cy="5" r="3.6" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.3 }} />
              <path d="M5 2.8V5.2L6.6 6.2" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round" }} />
            </svg>
          ) : null}
          <span>{f.text}</span>
        </time>
      </Tooltip>
      <span role="status" aria-live="polite" className="sr-only" data-announcer="freshness">
        {said}
      </span>
    </>
  );
}
