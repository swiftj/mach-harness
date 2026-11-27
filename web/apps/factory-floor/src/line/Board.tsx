/**
 * The Line's board: the stations as columns, left to right, each with its heading (who works there
 * and the typical time, from what the history holds), and each ticket a row moving across, its marker
 * at the station it stands at. Drawn in HTML so a ticket's recorded title is shown through the
 * free-text policy (plain, bounded, never in a label).
 *
 * Mouse: a click on a row or a heading shows it in the side panel; a double-click on a row opens the
 * ticket's full record. Keyboard: each row has one button (its name is the ticket ID and its state,
 * never its title): Space shows it in the side panel, Enter opens its full record, the up and down
 * arrows move between rows.
 */
import { useCallback, type KeyboardEvent } from "react";
import { cn } from "@mach/ui";
import { FreeText, FreeTextLabel } from "../shell/inspector/FreeText";
import { duration } from "../shell/time";
import { LINE_STATIONS, STATE_WORDS, drawsSentBack, sentBackTimesWords, timesWords, type LineRow, type StationStat } from "./model";
import { Marker, PassedNode } from "./Marks";
import { modelWords } from "./words";
import { EpicLine } from "./Epic";
import { LanesStrip } from "./Lanes";
import type { LaneLine } from "./lanesModel";

const COLS = LINE_STATIONS.length;
/** Where the Build column starts, as a share of the lane's width (in %): a ticket's lanes are shown from there. */
const BUILD_START = (LINE_STATIONS.findIndex((s) => s.key === "build") / COLS) * 100;
/** The centre of a column, as a share of the lane's width (in %). */
const centre = (column: number) => ((column + 0.5) / COLS) * 100;
/** The boundary after a column (a person's approval sits between Review and Merge). */
const boundary = (column: number) => ((column + 1) / COLS) * 100;

/** The words on a marker: what the station recorded, else the state. */
export function markerLabel(row: LineRow): string {
  if (row.state === "working") return row.detail ?? STATE_WORDS.working;
  if (row.state === "person") return row.beforeMerge ? "Your approval" : STATE_WORDS.person;
  return STATE_WORDS[row.state];
}

/** The line under a marker: how long, in plain words, and what it is waiting on. */
export function underWords(row: LineRow, now: number): string | null {
  const since = row.since !== null ? duration(Math.max(0, now - row.since)) : null;
  switch (row.state) {
    case "working":
      return since ? `working ${since}` : null;
    case "held":
      return row.detail ?? (since ? `held ${since}` : null);
    case "person":
      // M15: a wait M13 or M14 added says which (the marker keeps its state word).
      if (row.stop && row.detail) return since ? `${row.detail}, ${since}` : row.detail;
      return since ? `waiting ${since}` : "waiting";
    case "stopped":
      // How often it was sent back, counted across every round a person gave it; the rounds when it never was.
      if (row.sentBack && row.sentBack.times > 0) return sentBackTimesWords(row.sentBack.times);
      return row.roundsUsed > 0 ? `${row.roundsUsed} round${row.roundsUsed === 1 ? "" : "s"} used` : null;
    case "landed":
      if (!row.finished) return "merged, waiting for cleanup";
      return since ? `finished ${since} ago` : "finished";
    case "closed":
      return since ? `finished ${since} ago` : "finished";
  }
}

function StationHeading({ column, stat, selected, onPick }: { column: number; stat: StationStat | undefined; selected: boolean; onPick: (column: number) => void }) {
  const station = LINE_STATIONS[column]!;
  const models = stat ? modelWords(stat.models) : null;
  return (
    <button
      type="button"
      onClick={() => onPick(column)}
      aria-pressed={selected}
      data-station-heading={station.key}
      className={cn(
        "relative flex min-w-0 flex-col items-start rounded-t-md px-3 pb-2 pt-2.5 text-left hover:bg-surface-sunken/70",
        selected && "shadow-[inset_0_3px_0_var(--mach-accent)]",
      )}
    >
      <span className="text-label text-factory-ink">{station.name}</span>
      <span className="w-full truncate text-caption text-ink-muted">{models ?? station.worker}</span>
      <span className="w-full truncate text-caption text-ink-muted">{stat?.typicalMs != null ? `typical ${duration(stat.typicalMs)}` : "time not recorded yet"}</span>
    </button>
  );
}

function Lane({ row, now, onStopped }: { row: LineRow; now: number; onStopped?: (row: LineRow) => void }) {
  const at = row.beforeMerge ? boundary(row.column) : centre(row.column);
  const first = row.passed[0];
  const under = underWords(row, now);
  const opens = row.state === "stopped" && onStopped;
  return (
    <div className="relative h-[76px] min-w-0">
      {/* The belt: dotted, across every station. */}
      <span aria-hidden="true" className="absolute top-[34px] h-0 border-t-2 border-dotted border-factory-hatch" style={{ left: `${centre(0) - 3}%`, right: `${100 - centre(COLS - 1) - 3}%` }} />
      {/* Done: solid from the first station passed to the marker. */}
      {first !== undefined ? <span aria-hidden="true" className="absolute top-[33px] h-[3px] rounded-full bg-factory-pass" style={{ left: `${centre(first)}%`, width: `${Math.max(0, at - centre(first))}%` }} /> : null}
      {row.passed.map((c) => (
        <span key={c} aria-hidden="true" className="absolute top-[27px] -translate-x-1/2" style={{ left: `${centre(c)}%` }}>
          <PassedNode />
        </span>
      ))}
      {row.sentBack && drawsSentBack(row) ? <SentBack from={row.sentBack.from} to={row.sentBack.to} times={row.sentBack.times} /> : null}
      <span className="absolute top-[21px] flex -translate-x-1/2 flex-col items-center" style={{ left: `${at}%` }} data-marker={row.state}>
        {opens ? (
          // A stopped box opens what stopped it: the ticket's panel, at "What stopped it".
          <button
            type="button"
            className="rounded-xs outline-offset-2"
            aria-label={`${row.ticketId}: stopped. Show what stopped it and how to carry it on`}
            data-stopped-open={row.ticketId}
            onClick={(e) => {
              e.stopPropagation();
              onStopped(row);
            }}
          >
            <Marker state={row.state} label={markerLabel(row)} />
          </button>
        ) : (
          <span aria-hidden="true">
            <Marker state={row.state} label={markerLabel(row)} />
          </span>
        )}
        {under ? (
          <span aria-hidden="true" className="mt-0.5 whitespace-nowrap text-[12px] text-ink-muted" data-under={row.state}>
            {under}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * The dashed arc from the station that sent work back to the one it went back to, with how many times:
 * a node at the sending station, an arrowhead at the marker it went back to.
 */
function SentBack({ from, to, times }: { from: number; to: number; times: number }) {
  const left = centre(Math.min(from, to));
  const width = Math.abs(centre(from) - centre(to));
  const back = from > to; // right to left, the usual case
  return (
    <span aria-hidden="true" className="absolute top-[4px] h-[26px]" style={{ left: `${left}%`, width: `${width}%` }} data-sent-back={times}>
      <svg className="absolute inset-0 h-full w-full overflow-visible text-factory-fail" viewBox="0 0 100 26" preserveAspectRatio="none">
        <path d={back ? "M100 24 C100 6, 0 6, 0 17" : "M0 24 C0 6, 100 6, 100 17"} style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeDasharray: "5 4", vectorEffect: "non-scaling-stroke" }} />
      </svg>
      {/* The sending station's node: a small ring where the arc starts. */}
      <span className="absolute top-[18px] size-[9px] -translate-x-1/2 rounded-full border-[1.6px] border-factory-fail bg-factory-plate-top" style={{ left: back ? "100%" : "0%" }} data-sent-back-from="" />
      {/* The arrowhead, onto the marker it went back to. */}
      <svg className="absolute top-[14px] -translate-x-1/2 text-factory-fail" style={{ left: back ? "0%" : "100%" }} width="10" height="7" viewBox="0 0 10 7">
        <path d="M1 1 L5 6 L9 1" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" }} />
      </svg>
      <span className="absolute -top-[6px] left-1/2 -translate-x-1/2 whitespace-nowrap rounded-xs bg-factory-plate-top px-1 text-[11.5px] font-semibold text-factory-fail">sent back {timesWords(times)}</span>
    </span>
  );
}

export interface BoardProps {
  readonly rows: readonly LineRow[];
  readonly stats: readonly StationStat[];
  readonly now: number;
  readonly landedHidden: number;
  /** The ticket shown in the side panel, if any. */
  readonly selectedTicket: string | null;
  readonly selectedColumn: number | null;
  readonly onTicket: (row: LineRow) => void;
  readonly onStation: (column: number) => void;
  readonly onRecord: (row: LineRow) => void;
  /** What the board says when there is no ticket at all. */
  readonly empty: { readonly title: string; readonly body: string };
  /** M22: each ticket built in lanes, what its row shows of them (src/line/lanesModel.ts); absent for every other ticket. */
  readonly lanes?: ReadonlyMap<string, LaneLine>;
  /** A stopped box was pressed: show what stopped the ticket. Absent: the box is drawn only. */
  readonly onStopped?: (row: LineRow) => void;
}

export function Board({ rows, stats, now, landedHidden, selectedTicket, selectedColumn, onTicket, onStation, onRecord, empty, lanes, onStopped }: BoardProps) {
  const onRowKey = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>, row: LineRow) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onRecord(row);
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const all = [...(e.currentTarget.closest("[data-line-board]")?.querySelectorAll<HTMLButtonElement>("[data-row-button]") ?? [])];
      const i = all.indexOf(e.currentTarget);
      all[Math.max(0, Math.min(all.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
    },
    [onRecord],
  );
  return (
    <div className="min-h-0 overflow-auto bg-factory-ground" data-line-board="">
      <div className="relative grid min-w-[1010px] grid-cols-[220px_repeat(7,minmax(108px,1fr))] gap-x-1.5 px-3 pb-3 pt-2">
        {/* The stations' plates, behind the headings and the rows: the same grid, laid underneath. */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 grid grid-cols-[220px_repeat(7,minmax(108px,1fr))] gap-x-1.5 px-3 pb-3 pt-2">
          <span />
          {LINE_STATIONS.map((s) => (
            <span key={s.key} className="rounded-md border border-factory-plate-shade bg-factory-plate-top" />
          ))}
        </div>
        <div className="relative flex flex-col justify-end pb-2 pr-2">
          <span className="text-label text-factory-ink">Tickets</span>
          <FreeTextLabel what="Titles and epic names" className="text-[12px] leading-tight text-ink-muted" />
        </div>
        {LINE_STATIONS.map((s, i) => (
          <StationHeading key={s.key} column={i} stat={stats[i]} selected={selectedColumn === i} onPick={onStation} />
        ))}
        <ol className="relative col-span-full grid grid-cols-subgrid" aria-label="Tickets on the line">
          {rows.length === 0 ? (
            <li className="col-span-full grid grid-cols-subgrid" data-line-empty="">
              <span />
              <div className="col-span-7 px-4 py-6">
                <p className="text-label text-factory-ink">{empty.title}</p>
                <p className="mt-1 max-w-[70ch] text-body-sm text-ink-muted">{empty.body}</p>
              </div>
            </li>
          ) : null}
          {rows.map((row) => {
            const selected = selectedTicket === row.ticketId;
            const station = LINE_STATIONS[row.column]!.name;
            return (
              // A row is shown in the side panel by a click anywhere on it; its button is the keyboard's way in.
              // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
              <li
                key={row.ticketId}
                className="group col-span-full grid cursor-pointer grid-cols-subgrid"
                onClick={() => onTicket(row)}
                onDoubleClick={() => onRecord(row)}
                data-line-row={row.ticketId}
                data-line-state={row.state}
              >
                <div className={cn("relative flex min-w-0 flex-col justify-center border-l-4 py-1.5 pl-2 pr-2", selected ? "border-accent bg-surface" : "border-transparent group-hover:bg-surface/60")}>
                  <button
                    type="button"
                    data-row-button=""
                    aria-pressed={selected}
                    aria-label={`${row.ticketId}: ${STATE_WORDS[row.state]}${row.beforeMerge ? ", before Merge" : `, at ${station}`}`}
                    aria-keyshortcuts="Enter Space ArrowUp ArrowDown"
                    onKeyDown={(e) => onRowKey(e, row)}
                    onClick={(e) => {
                      e.stopPropagation();
                      onTicket(row);
                    }}
                    className="self-start rounded-xs font-mono text-[13px] font-semibold text-factory-ink outline-offset-2"
                  >
                    {row.ticketId}
                  </button>
                  {row.title ? (
                    <span className="mt-0.5 line-clamp-2 text-body-sm leading-snug text-factory-ink">
                      <FreeText field="sliceTitle" text={row.title} labelled expandable={false} />
                    </span>
                  ) : (
                    <span className="mt-0.5 text-caption text-ink-muted">title not recorded</span>
                  )}
                  <EpicLine row={row} labelled className="mt-0.5 line-clamp-1 text-caption text-ink-muted" />
                </div>
                <div className={cn("col-span-7 min-w-0", selected ? "bg-surface/60" : "group-hover:bg-surface/40")}>
                  <Lane row={row} now={now} onStopped={onStopped} />
                  {lanes?.get(row.ticketId) ? <LanesStrip ticketId={row.ticketId} line={lanes.get(row.ticketId)!} offset={BUILD_START} /> : null}
                </div>
              </li>
            );
          })}
        </ol>
        {landedHidden > 0 ? (
          <p className="relative col-span-full pl-2 pt-2 text-caption text-ink-muted" data-landed-hidden={landedHidden}>
            And {landedHidden} more finished earlier; Analytics lists every finished ticket.
          </p>
        ) : null}
      </div>
    </div>
  );
}
