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
import { LINE_STATIONS, STATE_WORDS, timesWords, type LineRow, type StationStat } from "./model";
import { Marker, PassedNode } from "./Marks";
import { modelWords } from "./words";
import { EpicLine } from "./Epic";

const COLS = LINE_STATIONS.length;
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
      return since ? `waiting ${since}` : "waiting";
    case "stopped":
      return `${row.roundsUsed} round${row.roundsUsed === 1 ? "" : "s"} used`;
    case "landed":
      return since ? `${since} ago` : null;
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
      <span className="w-full truncate text-caption text-factory-ink-soft">{models ?? station.worker}</span>
      <span className="w-full truncate text-caption text-factory-ink-soft">{stat?.typicalMs != null ? `typical ${duration(stat.typicalMs)}` : "time not recorded yet"}</span>
    </button>
  );
}

function Lane({ row, now }: { row: LineRow; now: number }) {
  const at = row.beforeMerge ? boundary(row.column) : centre(row.column);
  const first = row.passed[0];
  const under = underWords(row, now);
  return (
    <div className="relative h-[76px] min-w-0" aria-hidden="true">
      {/* The belt: dotted, across every station. */}
      <span className="absolute top-[34px] h-0 border-t-2 border-dotted border-factory-hatch" style={{ left: `${centre(0) - 3}%`, right: `${100 - centre(COLS - 1) - 3}%` }} />
      {/* Done: solid from the first station passed to the marker. */}
      {first !== undefined ? <span className="absolute top-[33px] h-[3px] rounded-full bg-factory-pass" style={{ left: `${centre(first)}%`, width: `${Math.max(0, at - centre(first))}%` }} /> : null}
      {row.passed.map((c) => (
        <span key={c} className="absolute top-[27px] -translate-x-1/2" style={{ left: `${centre(c)}%` }}>
          <PassedNode />
        </span>
      ))}
      {row.sentBack ? <SentBack from={row.sentBack.from} to={row.sentBack.to} times={row.sentBack.times} /> : null}
      <span className="absolute top-[21px] flex -translate-x-1/2 flex-col items-center" style={{ left: `${at}%` }} data-marker={row.state}>
        <Marker state={row.state} label={markerLabel(row)} />
        {under ? <span className="mt-0.5 whitespace-nowrap text-[12px] text-factory-ink-soft">{under}</span> : null}
      </span>
    </div>
  );
}

/** The dashed arc from the station that sent work back to the one it went back to, with how many times. */
function SentBack({ from, to, times }: { from: number; to: number; times: number }) {
  const left = centre(Math.min(from, to));
  const width = Math.abs(centre(from) - centre(to));
  return (
    <span className="absolute top-[4px] h-[26px]" style={{ left: `${left}%`, width: `${width}%` }} data-sent-back={times}>
      <svg className="absolute inset-0 h-full w-full overflow-visible text-factory-fail" viewBox="0 0 100 26" preserveAspectRatio="none">
        <path d="M100 24 C100 6, 0 6, 0 20" style={{ fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeDasharray: "5 4", vectorEffect: "non-scaling-stroke" }} />
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
}

export function Board({ rows, stats, now, landedHidden, selectedTicket, selectedColumn, onTicket, onStation, onRecord, empty }: BoardProps) {
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
          <FreeTextLabel what="Titles and epic names" className="text-[12px] leading-tight text-factory-ink-soft" />
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
                <p className="mt-1 max-w-[70ch] text-body-sm text-factory-ink-soft">{empty.body}</p>
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
                    <span className="mt-0.5 text-caption text-factory-ink-soft">title not recorded</span>
                  )}
                  <EpicLine row={row} labelled className="mt-0.5 line-clamp-1 text-caption text-factory-ink-soft" />
                </div>
                <div className={cn("col-span-7 min-w-0", selected ? "bg-surface/60" : "group-hover:bg-surface/40")}>
                  <Lane row={row} now={now} />
                </div>
              </li>
            );
          })}
        </ol>
        {landedHidden > 0 ? (
          <p className="relative col-span-full pl-2 pt-2 text-caption text-factory-ink-soft" data-landed-hidden={landedHidden}>
            And {landedHidden} more landed earlier; Analytics lists every finished ticket.
          </p>
        ) : null}
      </div>
    </div>
  );
}
