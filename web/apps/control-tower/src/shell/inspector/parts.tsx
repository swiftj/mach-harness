/**
 * Building blocks of the inspector: sections, facts, links to related entities, and the evidence
 * list (the fixture events behind an entity, each with its telemetry class).
 */
import { CornerDownRight } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@mach/ui";
import { describe, EVENT_CATALOG, eventsFor, SCENARIO, timingAt, type AnyRef, type AnySimEvent, type Telemetry } from "../../sim";
import { useSceneStore, useStore } from "../../scene";
import { usePlayheadEffect } from "../timeline/playhead";
import { duration as durationWords, selectable, TELEMETRY_WORDS, timecode } from "../vocab";

export function Section({ title, children, aside, id }: { title: string; children: ReactNode; aside?: ReactNode; id?: string }) {
  return (
    <section className="border-t border-line px-5 py-4" aria-labelledby={id}>
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <h3 id={id} className="text-label text-ink">
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

export type Fact = [string, ReactNode] | null | false | undefined;

export function Facts({ facts }: { facts: Fact[] }) {
  const shown = facts.filter((f): f is [string, ReactNode] => Boolean(f));
  return (
    <dl className="grid grid-cols-[minmax(96px,auto)_1fr] gap-x-4 gap-y-1.5 text-body-sm">
      {shown.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-subtle">{k}</dt>
          <dd className="min-w-0 break-words text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Mono({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return <span className={cn("font-mono text-[12px] tabular", muted ? "text-ink-muted" : "text-ink")}>{children}</span>;
}

/** A related entity: a link that selects it (and asks the view to focus it). */
export function RefLink({ to, glyph, children, detail }: { to: AnyRef; glyph?: ReactNode; children: ReactNode; detail?: ReactNode }) {
  const { select } = useStore();
  const target = selectable(to);
  if (!target) {
    // Not a selection the store can hold: plain text.
    return (
      <span className="flex w-full min-w-0 items-center gap-2 px-1.5 py-1 text-body-sm">
        {glyph ? <span className="inline-flex shrink-0">{glyph}</span> : null}
        <span className="min-w-0 flex-1 truncate text-ink">{children}</span>
        {detail ? <span className="shrink-0 text-caption text-ink-subtle">{detail}</span> : null}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => {
        select(target);
        // The link unmounts with the old entity's anatomy: keep focus in the inspector, on the new heading.
        requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-inspector-heading]")?.focus({ preventScroll: true }));
      }}
      className="group flex w-full min-w-0 items-center gap-2 rounded-sm px-1.5 py-1 text-left text-body-sm hover:bg-surface-sunken"
    >
      {glyph ? <span className="inline-flex shrink-0">{glyph}</span> : null}
      <span className="min-w-0 flex-1 truncate text-ink group-hover:underline group-hover:underline-offset-2">{children}</span>
      {detail ? <span className="shrink-0 text-caption text-ink-subtle">{detail}</span> : null}
    </button>
  );
}

export function RefList({ children }: { children: ReactNode }) {
  return <div className="-mx-1.5 flex flex-col">{children}</div>;
}

/** A playhead jump, worded for its purpose. */
export function JumpButton({ seq, t, label = "Go to this moment" }: { seq?: number; t?: number; label?: string }) {
  const store = useStore();
  return (
    <button
      type="button"
      onClick={() => (seq !== undefined ? store.seekToSeq(seq) : t !== undefined ? store.seek(t) : undefined)}
      className="inline-flex items-center gap-1 rounded-xs text-caption font-semibold text-accent-ink underline decoration-1 underline-offset-[3px] hover:decoration-2"
    >
      <CornerDownRight aria-hidden="true" className="size-3" />
      {label}
    </button>
  );
}

export function TelemetryBadge({ telemetry }: { telemetry: Telemetry }) {
  const words = TELEMETRY_WORDS[telemetry];
  return (
    <span
      title={`Telemetry: ${words.label}. ${words.description}`}
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center gap-1 rounded-xs border px-1.5 text-[11px] font-semibold",
        telemetry === "exists" && "border-success-line bg-success-soft text-success-ink",
        telemetry === "derivable" && "border-info-line bg-info-soft text-info-ink",
        telemetry === "missing" && "border-dashed border-warning-line bg-transparent text-warning-ink",
      )}
    >
      <svg aria-hidden="true" width="8" height="8" viewBox="0 0 8 8">
        {telemetry === "exists" ? <circle cx="4" cy="4" r="3.4" style={{ fill: "currentColor" }} /> : null}
        {telemetry === "derivable" ? (
          <>
            <circle cx="4" cy="4" r="3" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.2 }} />
            <path d="M4 1A3 3 0 0 1 4 7Z" style={{ fill: "currentColor" }} />
          </>
        ) : null}
        {telemetry === "missing" ? <circle cx="4" cy="4" r="3" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.2, strokeDasharray: "1.6 1.4" }} /> : null}
      </svg>
      <span className="sr-only">Telemetry: </span>
      {words.label}
    </span>
  );
}

/** A few key fields of an event's data, as short text. */
function keyFields(event: AnySimEvent): Array<[string, string]> {
  const data = event.data as unknown as Record<string, unknown>;
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(data)) {
    if (out.length >= 4) break;
    if (v === null || v === undefined) continue;
    if (typeof v === "string") out.push([k, v.length > 48 ? `${v.slice(0, 46)}…` : v]);
    else if (typeof v === "number" || typeof v === "boolean") out.push([k, String(v)]);
    else if (Array.isArray(v)) out.push([k, `${v.length} item${v.length === 1 ? "" : "s"}`]);
  }
  return out;
}

export function EventRow({ event, current }: { event: AnySimEvent; current?: boolean }) {
  const entry = EVENT_CATALOG[event.type];
  const fields = keyFields(event);
  return (
    <li className={cn("relative border-l-2 py-2 pl-3", current ? "border-factory-select" : "border-line")}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-[12px] font-semibold text-ink">{event.type}</span>
        <TelemetryBadge telemetry={entry.telemetry} />
        <span className="ml-auto font-mono text-[11px] text-ink-subtle tabular">
          {timecode(event.t)} · seq {event.seq}
        </span>
      </div>
      <p className="mt-1 text-body-sm text-ink-muted">{describe(event)}</p>
      {fields.length ? (
        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-ink-subtle">
          {fields.map(([k, v]) => (
            <span key={k} className="min-w-0 break-all">
              {k}: <span className="text-ink-muted">{v}</span>
            </span>
          ))}
        </p>
      ) : null}
      <div className="mt-1.5 flex items-center gap-3">
        <JumpButton seq={event.seq} />
        {current ? <span className="text-caption text-ink-subtle">Latest event behind what you see</span> : null}
      </div>
    </li>
  );
}

function upperBoundByT(events: readonly AnySimEvent[], t: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((events[mid] as AnySimEvent).t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The events behind an entity, and how many of them have happened at the playhead. The count is
 * the only thing subscribed to, so this changes when the entity's own next event happens, not on
 * every tick.
 */
export function useEntityEvents(entity: AnyRef): { all: readonly AnySimEvent[]; happened: number } {
  const all = useMemo(() => eventsFor(SCENARIO, entity), [entity]);
  const happened = useSceneStore((s) => upperBoundByT(all, s.playhead));
  return { all, happened };
}

/** "Why it looks like this" and the evidence: every event behind the entity up to the playhead. */
export function Evidence({ entity }: { entity: AnyRef }) {
  const { all, happened } = useEntityEvents(entity);
  const [showAll, setShowAll] = useState(false);
  const past = all.slice(0, happened);
  const later = all.length - happened;
  const latest = past[past.length - 1];
  const limit = showAll ? past.length : 6;
  const listed = past.slice(-limit).reverse();
  const counts = useMemo(() => {
    const c: Record<Telemetry, number> = { exists: 0, derivable: 0, missing: 0 };
    for (const e of all.slice(0, happened)) c[EVENT_CATALOG[e.type].telemetry] += 1;
    return c;
  }, [all, happened]);
  return (
    <Section
      title="Evidence"
      id={`ev-${entity}`}
      aside={
        <span className="text-caption text-ink-subtle tabular">
          {past.length} event{past.length === 1 ? "" : "s"}
          {later ? `, ${later} later` : ""}
        </span>
      }
    >
      {past.length === 0 ? (
        <p className="text-body-sm text-ink-muted">No event has touched this yet at the playhead.</p>
      ) : (
        <>
          <p className="mb-2 flex flex-wrap items-center gap-1.5 text-caption text-ink-subtle">
            Today MACH would know:
            {(["exists", "derivable", "missing"] as const).map((k) =>
              counts[k] ? (
                <span key={k} className="inline-flex items-center gap-1">
                  <TelemetryBadge telemetry={k} />
                  <span className="tabular">{counts[k]}</span>
                </span>
              ) : null,
            )}
          </p>
          <ol className="flex flex-col gap-0.5" aria-label="Events, newest first">
            {listed.map((e) => (
              <EventRow key={e.seq} event={e} current={e === latest} />
            ))}
          </ol>
          {past.length > 6 ? (
            <button type="button" onClick={() => setShowAll((v) => !v)} className="mt-2 text-caption font-semibold text-accent-ink underline underline-offset-[3px]">
              {showAll ? "Show the latest 6" : `Show all ${past.length}`}
            </button>
          ) : null}
        </>
      )}
    </Section>
  );
}

/**
 * Elapsed time of work, as known at the playhead: "for 2 min 10 s" while it runs, the whole span once
 * it has finished. Never a fraction or a time left (nobody knows how long work in flight will take).
 * Written straight to the DOM on each frame, so it never re-renders the inspector.
 */
export function Elapsed({ startedAt, finishedAt }: { startedAt: number; finishedAt: number | null }) {
  const ref = useRef<HTMLSpanElement>(null);
  usePlayheadEffect(
    (s) => {
      const timing = timingAt(startedAt, finishedAt, s.playhead);
      const text = !timing.started ? "not started" : timing.finished ? `took ${durationWords(timing.elapsed)}` : `at work for ${durationWords(timing.elapsed)}`;
      if (ref.current && ref.current.textContent !== text) ref.current.textContent = text;
    },
    [startedAt, finishedAt],
  );
  return <span ref={ref} data-frame="" className="tabular" />;
}
