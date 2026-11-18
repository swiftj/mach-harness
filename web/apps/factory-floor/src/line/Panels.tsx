/**
 * The Line's side panel: what just happened (nothing selected), one ticket (why it is here, what it
 * needs from a person, where the time went, facts, the command to copy), or one station (who works
 * there, how long it takes, how often it sends work back, where its model is set).
 */
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { CommandLine } from "@mach/ui";
import { MAX_ROUNDS, type EntityRef, type Moment } from "../sim";
import { useSceneStore } from "../scene";
import { FreeText, FreeTextLabel, KindWords } from "../shell/inspector/FreeText";
import { quotingKindOf } from "../shell/history";
import { duration, timecode } from "../shell/time";
import { LINE_STATIONS, sentBackWords, type LineRow, type StationStat, type StationTime } from "./model";
import { StatePill } from "./Marks";
import { costWords, modelWords } from "./words";
import { EpicName, issueWords } from "./Epic";

function Back({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-body-sm font-semibold text-accent-ink underline decoration-1 underline-offset-[3px] hover:decoration-2">
      <ArrowLeft aria-hidden="true" className="size-3.5" />
      Back to what just happened
    </button>
  );
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-5">
      <h4 className="mb-1.5 text-label text-ink-muted">{title}</h4>
      {children}
    </section>
  );
}

function Facts({ rows }: { rows: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-1 text-body-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-muted">{k}</dt>
          <dd className="text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const BASIS_WORDS: Readonly<Record<StationTime["basis"], string>> = { measured: "", "so-far": " so far", "at-most": " at most" };

/** Where the time went: one bar per station visit, rework marked in words as well as colour. */
function TimeBars({ times }: { times: readonly StationTime[] }) {
  if (!times.length) return <p className="text-body-sm text-ink-muted">No station visit is recorded yet.</p>;
  const max = Math.max(1, ...times.map((t) => t.ms ?? 0));
  return (
    <ul className="grid grid-cols-[76px_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 text-body-sm" data-time-bars="">
      {times.map((t, i) => (
        <li key={i} className="contents">
          <span className="truncate text-ink">{LINE_STATIONS[t.column]!.name}</span>
          <span className="h-2 min-w-0">
            <span
              className={t.basis === "so-far" ? "block h-full rounded-xs bg-factory-live" : t.rework ? "block h-full rounded-xs bg-factory-fail" : "block h-full rounded-xs bg-factory-route"}
              style={{ width: `${t.ms === null ? 0 : Math.max(4, (t.ms / max) * 100)}%` }}
            />
          </span>
          <span className="whitespace-nowrap text-right text-caption text-ink-muted tabular">
            {t.ms === null ? "not recorded" : `${duration(t.ms)}${BASIS_WORDS[t.basis]}`}
            {t.rework ? ", again" : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function TicketPanel({ row, now, onBack, onRecord, onFloor }: { row: LineRow; now: number; onBack: () => void; onRecord: () => void; onFloor: () => void }) {
  const station = LINE_STATIONS[row.column]!.name;
  return (
    <div data-line-panel="ticket" data-ticket={row.ticketId}>
      <Back onBack={onBack} />
      <p className="mt-4 font-mono text-[13px] text-ink-muted">{row.ticketId}</p>
      <h3 tabIndex={-1} data-inspector-heading="" className="font-sans text-title-3 font-bold leading-snug text-ink outline-none">
        {row.title ? <FreeText field="sliceTitle" text={row.title} labelled /> : "Title not recorded"}
      </h3>
      <p className="mt-2 flex flex-wrap items-center gap-2">
        <StatePill state={row.state} />
        <span className="text-body-sm text-ink-muted">{row.beforeMerge ? `at ${station}, before Merge` : `at ${station}`}</span>
      </p>
      <Part title="Why it is here">
        <p className="text-body-sm text-ink">{row.why}</p>
        {row.held?.kind === "supervisor" ? (
          <p className="mt-1 text-body-sm text-ink">
            <FreeText field="heldWhy" text={row.held.freeText} />
          </p>
        ) : null}
        {row.personWords ? (
          <p className="mt-1 text-body-sm text-ink">
            <FreeText field="personNeeded" text={row.personWords} />
          </p>
        ) : null}
        {row.since !== null && row.state !== "working" ? <p className="mt-1 text-caption text-ink-muted">Since {timecode(row.since, false)}, {duration(Math.max(0, now - row.since))} ago.</p> : null}
      </Part>
      <Part title="What it needs from you">
        <p className="text-body-sm text-ink">{row.needs}</p>
        <CommandLine className="mt-2" command={row.command} purpose={`for ${row.ticketId}`} />
        {row.state === "stopped" ? <CommandLine className="mt-1.5" command={`/mach explain ${row.ticketId}`} purpose={`to explain ${row.ticketId}`} /> : null}
      </Part>
      <Part title="Where the time went">
        <TimeBars times={row.times} />
      </Part>
      <Part title="Facts">
        <Facts
          rows={[
            ["Issue", issueWords(row.issue) ?? "not recorded"],
            ["Epic", row.epicTitle || row.epicId ? (
              <span key="e">
                <EpicName row={row} />
                {row.epicTitle && row.epicId ? <span className="ml-1 font-mono text-caption text-ink-muted">{row.epicId}</span> : null}
              </span>
            ) : "not recorded"],
            ["Risk", row.risk ?? "not recorded"],
            ["Rounds used", `${row.roundsUsed} of ${MAX_ROUNDS}`],
            ["Cost", costWords(row.cost)],
          ]}
        />
      </Part>
      <p className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2">
        <button type="button" onClick={onRecord} data-open-record="" className="rounded-sm border border-line-control bg-surface px-3 py-1.5 text-body-sm font-semibold text-ink hover:bg-surface-sunken">
          Open the full record
        </button>
        <span className="text-caption text-ink-muted">or double-click the ticket (Enter on it)</span>
      </p>
      <p className="mt-3">
        <button type="button" onClick={onFloor} className="text-body-sm font-semibold text-accent-ink underline decoration-1 underline-offset-[3px] hover:decoration-2">
          Show it on the Floor
        </button>
      </p>
    </div>
  );
}

export function StationPanel({ column, stat, onBack }: { column: number; stat: StationStat | undefined; onBack: () => void }) {
  const station = LINE_STATIONS[column]!;
  const models = stat ? modelWords(stat.models) : null;
  const back = stat ? sentBackWords(stat.sentBack) : null;
  return (
    <div data-line-panel="station" data-station={station.key}>
      <Back onBack={onBack} />
      <h3 tabIndex={-1} data-inspector-heading="" className="mt-4 font-sans text-title-3 font-bold leading-snug text-ink outline-none">
        {station.name}
      </h3>
      <p className="mt-1 text-body-sm text-ink-muted">{station.does}</p>
      <Part title="Who works here">
        <Facts
          rows={[
            ["Worker", station.worker],
            ["Models seen", models ?? "not recorded yet"],
            ["At work now", `${stat?.atWork ?? 0} ticket${stat?.atWork === 1 ? "" : "s"}`],
          ]}
        />
      </Part>
      <Part title="In the history held">
        <Facts
          rows={[
            ["Typical time", stat?.typicalMs != null ? `${duration(stat.typicalMs)}, the middle of ${stat.sample} finished visit${stat.sample === 1 ? "" : "s"}` : "not recorded yet"],
            ...(stat?.sentBack ? ([["Sent back", back ?? "nothing decided here yet"]] as const) : []),
          ]}
        />
      </Part>
      <Part title="To change the model for this station">
        <p className="text-body-sm text-ink-muted">
          The model tiers are set in the project's <code className="font-mono text-[13px] text-ink">.factory/config.json</code>, under <code className="font-mono text-[13px] text-ink">{station.tiers}</code>.
        </p>
      </Part>
    </div>
  );
}

/** What just happened: the newest significant moments, newest first, in the history's own sentences. */
export function Feed({ moments, onTicket }: { moments: readonly Moment[]; onTicket: (ref: EntityRef) => void }) {
  const log = useSceneStore((s) => s.log);
  const source = useSceneStore((s) => s.source);
  return (
    <div data-line-panel="feed">
      <h3 tabIndex={-1} data-inspector-heading="" className="font-sans text-title-3 font-bold leading-snug text-ink outline-none">
        What just happened
      </h3>
      <p className="mt-0.5 text-body-sm text-ink-muted">Newest first. Pick a ticket or a station to look closer.</p>
      {moments.length === 0 ? (
        <p className="mt-4 text-body-sm text-ink-muted" data-feed-empty="">
          Nothing has happened yet. Each step the Factory records appears here as it happens.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-line border-y border-line" data-feed="">
          {moments.map((m) => (
            <li key={m.id} className="grid grid-cols-[64px_minmax(0,1fr)] gap-2 py-2 text-body-sm">
              <time className="pt-px font-mono text-[12px] text-ink-subtle tabular">{timecode(m.t, false)}</time>
              <span className="min-w-0 text-ink">
                {m.ticketId ? (
                  <button type="button" onClick={() => onTicket(`cell:${m.ticketId}`)} className="mr-1 font-mono text-[12.5px] font-semibold text-accent-ink underline decoration-1 underline-offset-[3px]">
                    {m.ticketId}
                  </button>
                ) : null}
                <KindWords kind={source === "simulation" ? null : quotingKindOf(log, m)} text={m.text} />
              </span>
            </li>
          ))}
        </ul>
      )}
      <FreeTextLabel what="Reasons and titles quoted from the record" className="mt-3 block text-caption text-ink-subtle" />
    </div>
  );
}

