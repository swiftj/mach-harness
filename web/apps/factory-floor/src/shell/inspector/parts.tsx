/**
 * Building blocks of the inspector: sections, facts, links to related entities, provenance (who
 * stands behind a value, how its time is known, the record it came from) and the evidence list (the
 * events behind an entity). The simulation's events carry their M6.0 telemetry class; real events
 * carry their authority and time precision.
 */
import { useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@mach/ui";
import { entriesBehind, EVENT_CATALOG, eventsFor, isSceneLog, timingAt, type AnyRef, type AnySimEvent, type EntityRef, type Authority, type LogEntry, type Telemetry } from "../../sim";
import { analyticsStationOf, showInAnalytics, useNowEffect, useSceneStore, useStore, type AnalyticsTarget } from "../../scene";
import { visitAnalyticsWindow } from "../../scene/analytics";
import { duration as durationWords, selectable, TELEMETRY_WORDS } from "../vocab";
import { When } from "../When";
import { formatHash } from "../source/hash";
import { elapsedWords } from "./words";
import { EventWords } from "./FreeText";
import { freeTextDataKeys } from "../../text/fields";
import { useDisplayPolicy } from "../displayPolicy";
import type { DisplayPolicy } from "../../text/unchecked";

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

/** A value that applies but no record says: never 0, never blank. */
export function NotRecorded({ what }: { what?: string }) {
  return (
    <span className="text-ink-subtle italic" data-not-recorded="">
      Not recorded{what ? `: ${what}` : ""}
    </span>
  );
}

export function Mono({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return <span className={cn("font-mono text-[12px] tabular", muted ? "text-ink-muted" : "text-ink")}>{children}</span>;
}

/** Select an entity from inside the inspector and keep focus there: the link unmounts with the old entity's panel, so focus goes to the new heading. */
function follow(select: (ref: EntityRef) => void, target: EntityRef): void {
  select(target);
  requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-inspector-heading]")?.focus({ preventScroll: true }));
}

/**
 * A link to another entity inside a sentence or a fact: a real link (its address selects the entity,
 * so it can be opened in a new tab or copied) that, followed here, selects it and puts focus on the
 * new panel's heading. `label` is its accessible name when the words alone do not say where it goes.
 */
export function EntityLink({ to, children, label, className }: { to: EntityRef; children: ReactNode; label?: string; className?: string }) {
  const store = useStore();
  const href = useSceneStore((s) => formatHash({ route: s.workspace, sel: to, analytics: s.analytics, decision: s.decision }));
  return (
    <a
      href={href}
      aria-label={label}
      onClick={(e) => {
        // A modified click opens the address elsewhere, as any link does.
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        follow(store.select, to);
      }}
      className={cn("rounded-xs text-accent-ink underline decoration-1 underline-offset-[3px] hover:decoration-2", className)}
    >
      {children}
    </a>
  );
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
      onClick={() => follow(select, target)}
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

export const AUTHORITY_WORDS: Record<Authority, { label: string; description: string }> = {
  authoritative: { label: "Authoritative", description: "A MACH script recorded it as it decided it, in a write-once or append-only record." },
  observed: { label: "Observed", description: "Seen in a runtime record MACH did not decide (Claude's stream, or the supervisor sampling a cell)." },
  reconstructed: { label: "Reconstructed", description: "Derived afterwards by the observer from state files, archives or other events." },
  simulated: { label: "Simulated", description: "Invented by the simulation. Never real execution." },
};

/** Who stands behind a value: text, a glyph and a tone, never colour alone. */
export function AuthorityBadge({ authority }: { authority: Authority }) {
  const words = AUTHORITY_WORDS[authority];
  return (
    <span
      title={`${words.label}. ${words.description}`}
      data-authority={authority}
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center gap-1 rounded-xs border px-1.5 text-[11px] font-semibold",
        authority === "authoritative" && "border-success-line bg-success-soft text-success-ink",
        authority === "observed" && "border-info-line bg-info-soft text-info-ink",
        authority === "reconstructed" && "border-dashed border-line-strong bg-transparent text-ink-muted",
        authority === "simulated" && "border-dashed border-warning-line bg-warning-soft text-warning-ink",
      )}
    >
      <svg aria-hidden="true" width="8" height="8" viewBox="0 0 8 8">
        {authority === "authoritative" ? <circle cx="4" cy="4" r="3.4" style={{ fill: "currentColor" }} /> : null}
        {authority === "observed" ? (
          <>
            <circle cx="4" cy="4" r="3" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.2 }} />
            <circle cx="4" cy="4" r="1.3" style={{ fill: "currentColor" }} />
          </>
        ) : null}
        {authority === "reconstructed" ? <path d="M1 7L4 1L7 7Z" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.1, strokeLinejoin: "round" }} /> : null}
        {authority === "simulated" ? <circle cx="4" cy="4" r="3" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.2, strokeDasharray: "1.6 1.4" }} /> : null}
      </svg>
      <span className="sr-only">Authority: </span>
      {words.label}
    </span>
  );
}

/**
 * What a reader must know about a time beyond the time itself, or null when there is nothing: a
 * time a record carried is shown as it is, with no note on how finely it was measured. Only a time
 * that is not what it looks like says so (an arrival time, a bound, one the observer placed, one no
 * record gives).
 */
export function timeCaveatWords(precision: LogEntry["precision"] | "measured" | "inferred" | "unknown"): string | null {
  switch (precision) {
    case "ms":
    case "s":
    case "measured":
    case "simulated":
      return null;
    case "arrival":
      return "Arrival time (when the observer read it)";
    case "bounded":
      return "Bounded between other records";
    case "inferred":
      return "Placed by the observer, not measured";
    default:
      return "Time not recorded";
  }
}

/**
 * A few key fields of an event's data, as short text. A field the free-text policy names is never
 * printed here raw: the event's sentence above carries it, contained (`EventWords`).
 */
export function keyFields(event: { type?: string; data?: unknown }, policy: DisplayPolicy | null = null): Array<[string, string]> {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const prose = freeTextDataKeys(policy, event.type ?? "");
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(data)) {
    if (out.length >= 4) break;
    if (v === null || v === undefined || prose.has(k)) continue;
    if (typeof v === "string") out.push([k, v.length > 48 ? `${v.slice(0, 46)}…` : v]);
    else if (typeof v === "number" || typeof v === "boolean") out.push([k, String(v)]);
    else if (Array.isArray(v)) out.push([k, `${v.length} item${v.length === 1 ? "" : "s"}`]);
  }
  return out;
}

const isSim = (entry: LogEntry) => entry.event.schema_version !== 3;

export function EventRow({ entry, current }: { entry: LogEntry; current?: boolean }) {
  const event = entry.event;
  const policy = useDisplayPolicy();
  const fields = keyFields(event as { type?: string; data?: unknown }, policy);
  const sim = isSim(entry);
  const caveat = sim ? null : [timeCaveatWords(entry.precision), entry.late ? "arrived late" : null].filter(Boolean).join(", ");
  return (
    <li className={cn("relative border-l-2 py-2 pl-3", current ? "border-factory-select" : "border-line")} data-event-id={entry.id}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-[12px] font-semibold text-ink">{event.type}</span>
        {sim ? <TelemetryBadge telemetry={EVENT_CATALOG[(event as AnySimEvent).type]?.telemetry ?? "missing"} /> : <AuthorityBadge authority={entry.authority} />}
        <span className="ml-auto font-mono text-[11px] text-ink-subtle tabular">
          <When t={entry.t} precision="second" />
          {sim ? ` · seq ${(event as AnySimEvent).seq}` : ""}
        </span>
      </div>
      <p className="mt-1 text-body-sm text-ink-muted">
        <EventWords entry={entry} />
      </p>
      {sim ? null : (
        <p className="mt-0.5 text-caption text-ink-subtle">
          {caveat ? `${caveat[0]!.toUpperCase()}${caveat.slice(1)}. ` : null}
          <span className="font-mono text-[11px] break-all">{entry.id}</span>
        </p>
      )}
      {fields.length ? (
        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-ink-subtle">
          {fields.map(([k, v]) => (
            <span key={k} className="min-w-0 break-all">
              {k}: <span className="text-ink-muted">{v}</span>
            </span>
          ))}
        </p>
      ) : null}
      {current ? <p className="mt-1.5 text-caption text-ink-subtle">Latest event behind what you see</p> : null}
    </li>
  );
}

function upperBoundByT(entries: readonly LogEntry[], t: number): number {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((entries[mid] as LogEntry).t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The events behind an entity (as log entries, any source), and how many of them have happened by
 * now. Re-read when the log changes (live ingest); the count is what is subscribed to, so
 * this changes when the entity's own next event happens, not on every tick.
 */
export function useEntityEvents(entity: AnyRef): { all: readonly LogEntry[]; happened: number } {
  const log = useSceneStore((s) => s.log);
  const version = useSceneStore((s) => s.logVersion);
  // With the event the entity's own record names, so the evidence never reads "0 events" beside a record that names one (D14).
  const all = useMemo(() => (isSceneLog(log) && log.provenance.source !== "simulation" ? entriesBehind(log, entity) : eventsFor(log, entity)), [log, entity, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const happened = useSceneStore((s) => upperBoundByT(all, s.now));
  return { all, happened };
}

/** "Why it looks like this" and the evidence: every event behind the entity so far. */
export function Evidence({ entity }: { entity: AnyRef }) {
  const { all, happened } = useEntityEvents(entity);
  const [showAll, setShowAll] = useState(false);
  const past = all.slice(0, happened);
  const later = all.length - happened;
  const latest = past[past.length - 1];
  const limit = showAll ? past.length : 6;
  const listed = past.slice(-limit).reverse();
  const sim = latest ? isSim(latest) : false;
  const counts = useMemo(() => {
    const telemetry: Record<Telemetry, number> = { exists: 0, derivable: 0, missing: 0 };
    const authority: Record<Authority, number> = { authoritative: 0, observed: 0, reconstructed: 0, simulated: 0 };
    for (const e of all.slice(0, happened)) {
      if (isSim(e)) telemetry[EVENT_CATALOG[(e.event as AnySimEvent).type]?.telemetry ?? "missing"] += 1;
      else authority[e.authority] += 1;
    }
    return { telemetry, authority };
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
        <p className="text-body-sm text-ink-muted">No event received touches this yet.</p>
      ) : (
        <>
          {sim ? (
            <p className="mb-2 flex flex-wrap items-center gap-1.5 text-caption text-ink-subtle">
              Today MACH would know:
              {(["exists", "derivable", "missing"] as const).map((k) =>
                counts.telemetry[k] ? (
                  <span key={k} className="inline-flex items-center gap-1">
                    <TelemetryBadge telemetry={k} />
                    <span className="tabular">{counts.telemetry[k]}</span>
                  </span>
                ) : null,
              )}
            </p>
          ) : (
            <p className="mb-2 flex flex-wrap items-center gap-1.5 text-caption text-ink-subtle">
              Recorded as:
              {(["authoritative", "observed", "reconstructed"] as const).map((k) =>
                counts.authority[k] ? (
                  <span key={k} className="inline-flex items-center gap-1">
                    <AuthorityBadge authority={k} />
                    <span className="tabular">{counts.authority[k]}</span>
                  </span>
                ) : null,
              )}
            </p>
          )}
          <ol className="flex flex-col gap-0.5" aria-label="Events, newest first">
            {listed.map((e) => (
              <EventRow key={e.id} entry={e} current={e === latest} />
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
 * Elapsed time of work, as known now: "for 2 min 10 s" while it runs, the whole span once
 * it has finished. Never a fraction or a time left (nobody knows how long work in flight will take).
 * Written straight to the DOM as time moves, so it never re-renders the inspector.
 */
export function Elapsed({ startedAt, finishedAt, mode = "work" }: { startedAt: number; finishedAt: number | null; mode?: "work" | "wait" | "ended-unrecorded" | "interrupted" | "open" }) {
  const ref = useRef<HTMLSpanElement>(null);
  useNowEffect(
    (s) => {
      const timing = timingAt(startedAt, finishedAt, s.now);
      // A wait on a person is never "at work" (D14); a visit that never exited is bounded, not "took" (D4).
      const text = elapsedWords(mode === "ended-unrecorded" && timing.finished ? "ended-unrecorded" : mode, timing.started, timing.finished, durationWords(timing.elapsed));
      if (ref.current && ref.current.textContent !== text) ref.current.textContent = text;
    },
    [startedAt, finishedAt, mode],
  );
  return <span ref={ref} data-frame="" className="tabular" />;
}

/**
 * A link from the inspector into Factory Analytics (M6.5 design section 4): the selection stays;
 * Analytics opens on `target`.
 */
export function AnalyticsLink({ target, children }: { target: AnalyticsTarget; children: ReactNode }) {
  const store = useStore();
  return (
    <button
      type="button"
      onClick={() => showInAnalytics(store, target)}
      data-analytics-link={target.area}
      className="text-caption font-semibold text-accent-ink underline decoration-1 underline-offset-[3px] hover:decoration-2"
    >
      {children}
    </button>
  );
}

/** "Open its measured history": Analytics' Flow area for one station kind; nothing for a station Analytics does not measure. */
export function StationHistoryLink({ kind }: { kind: string }) {
  const station = analyticsStationOf(kind);
  return station ? <AnalyticsLink target={{ area: "flow", filters: { station } }}>Open its measured history</AnalyticsLink> : null;
}

/**
 * "Open its measured history" for one station visit (I-12, journey 3): Flow for
 * its station over the week the visit ended in, with the visit still selected, so Flow can say where it
 * sits among that week's measured visits. The simulation's Analytics reads its own fixture, not the
 * simulated run, so there the period is left as it is.
 */
export function VisitHistoryLink({ visit }: { visit: { readonly station: string; readonly enteredAt: number; readonly leftAt: number | null } }) {
  const station = analyticsStationOf(visit.station);
  const simulated = useSceneStore((s) => s.source === "simulation");
  if (!station) return null;
  return <AnalyticsLink target={{ area: "flow", filters: { station }, ...(simulated ? {} : { window: visitAnalyticsWindow(visit) }) }}>Open its measured history</AnalyticsLink>;
}

/**
 * "See how often this recurs": Analytics' Quality area, filtered to the station, with the rows of the
 * metric that counts this kind of outcome open (R1 review rejection rate; Q4 verification failures).
 */
export function RecurrenceLink({ kind }: { kind: "review" | "verify" }) {
  return (
    <AnalyticsLink target={{ area: "quality", filters: { station: kind }, focus: { metric: kind === "review" ? "R1" : "Q4", group: null } }}>
      See how often this recurs
    </AnalyticsLink>
  );
}
