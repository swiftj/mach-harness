/**
 * The Line workspace (the Factory Floor's default): a "Needs you" strip on top, the board of
 * stations and tickets, and a side panel. Everything is read from the one store at the moment it
 * holds now; the selection is the store's, so the Floor and Analytics see the same ticket picked.
 *
 * Nothing here changes the Factory: the panel offers a `/mach` command to copy and run in Claude Code.
 */
import { useCallback, useMemo, useState } from "react";
import { cn } from "@mach/ui";
import { refId, refKind, type EntityRef } from "../sim";
import { showOnFloor, useScene, useSceneStore, useStore } from "../scene";
import { indexFor, lastAtOrBefore } from "../shell/history";
import { ticketOfRef } from "../atlas/derive";
import { duration } from "../shell/time";
import { useStageNotice } from "../shell/SourceBadge";
import { Board } from "./Board";
import { feedOf, LINE_STATIONS, lineModel, needVerb, rowOfCell, stationStats, STATE_WORDS, type LineRow } from "./model";
import { StateShape, STATE_TONE } from "./Marks";
import { Feed, StationPanel, TicketPanel } from "./Panels";
import { TicketRecord } from "./Record";
import { useSource } from "../shell/source/context";
import { laneLine, lanesPanel, withLaneMarker, type LaneLine } from "./lanesModel";
import { lanesKey, useCellLanes } from "./useLanes";
import "./line.css";

/**
 * The panel a selection shows: a ticket's row, a station's column, or nothing (the feed). A ticket the
 * board does not list (one of the older landed ones) still gets its panel, from its cell.
 */
function panelOf(selection: EntityRef | null, rows: readonly LineRow[], ticketOf: (ref: EntityRef) => string | null, unlisted: (ticket: string) => LineRow | null): { row: LineRow | null; column: number | null } {
  if (!selection) return { row: null, column: null };
  const kind = refKind(selection);
  const id = refId(selection);
  if (kind === "station" && !id.includes("/")) {
    const column = LINE_STATIONS.findIndex((s) => s.key === id || s.visits.includes(id as never));
    return { row: null, column: column < 0 ? null : column };
  }
  const ticket = kind === "cell" ? id : kind === "slice" ? (rows.find((r) => r.sliceId === id)?.ticketId ?? null) : ticketOf(selection);
  return { row: rows.find((r) => r.ticketId === ticket) ?? (ticket ? unlisted(ticket) : null), column: null };
}

/** The strip of tickets waiting for a person or stopped, longest waiting first. */
function NeedsYou({ needs, now, onPick }: { needs: readonly LineRow[]; now: number; onPick: (row: LineRow) => void }) {
  return (
    <section aria-labelledby="needs-you" className="flex flex-wrap items-stretch gap-3 border-b border-line bg-canvas px-4 py-3" data-needs-you={needs.length}>
      <h2 id="needs-you" className="self-center text-label text-ink min-[700px]:min-w-[88px]">
        Needs you
      </h2>
      {needs.length === 0 ? (
        <p className="self-center text-body-sm text-ink-muted" data-needs-none="">
          Nothing is waiting for a person.
        </p>
      ) : (
        needs.map((row) => (
          <button
            key={row.ticketId}
            type="button"
            onClick={() => onPick(row)}
            data-need={row.ticketId}
            className={cn("flex min-w-0 flex-[1_1_300px] items-center gap-3 rounded-md border px-3.5 py-2.5 text-left", STATE_TONE[row.state], row.state === "stopped" && "rounded-xs")}
          >
            <StateShape state={row.state} size={14} />
            <span className="min-w-0 flex-1">
              <span className="block text-body-sm font-semibold text-ink">
                {needVerb(row)} <span className="font-mono text-[13px]">{row.ticketId}</span>
              </span>
              <span className="block text-body-sm text-ink-muted">{row.why}</span>
            </span>
            <span className="shrink-0 whitespace-nowrap text-caption text-ink-muted">{row.since !== null ? `waiting ${duration(Math.max(0, now - row.since))}` : STATE_WORDS[row.state]}</span>
          </button>
        ))
      )}
    </section>
  );
}

export function LineWorkspace() {
  const store = useStore();
  const scene = useScene();
  const source = useSceneStore((s) => s.source);
  // Durations are read to the second (the simulation's to ten scenario seconds, one of the wall clock): no render per frame.
  const now = useSceneStore((s) => (s.source === "simulation" ? Math.floor(s.now / 10_000) * 10_000 : Math.floor(s.now / 1000) * 1000));
  const selection = useSceneStore((s) => s.selection);
  const moments = useSceneStore((s) => indexFor(s).moments);
  // The feed's clock: the time of the last moment at or before now, so the feed changes only when a
  // moment is reached (not every frame) and never lists one later than the clock.
  const feedNow = useSceneStore((s) => lastAtOrBefore(indexFor(s).moments, s.now)?.t ?? Number.NEGATIVE_INFINITY);
  const model = useMemo(() => lineModel(scene, now), [scene, now]);
  const stats = useMemo(() => stationStats(scene, model.rows), [scene, model.rows]);
  const feed = useMemo(() => feedOf(moments, feedNow), [moments, feedNow]);
  const notice = useStageNotice();
  const [record, setRecord] = useState<string | null>(null);

  const { row, column } = useMemo(
    () =>
      panelOf(
        selection,
        model.rows,
        (ref) => ticketOfRef(scene, ref),
        (ticket) => (scene.cells[ticket] ? rowOfCell(scene, scene.cells[ticket], now) : null),
      ),
    [selection, model.rows, scene, now],
  );
  // M22: the lanes of each ticket at Build, and of the ticket in the side panel, read from the observer
  // and read again as their events arrive. The Simulation has no observer and shows no lanes.
  const { client } = useSource();
  const live = source !== "simulation";
  const buildColumn = LINE_STATIONS.findIndex((s) => s.key === "build");
  const wanted = useMemo(() => {
    const m = new Map<string, string>();
    if (!live) return m;
    for (const r of model.rows) if (r.column === buildColumn && scene.cells[r.ticketId]) m.set(r.ticketId, lanesKey(scene.cells[r.ticketId]));
    if (row && scene.cells[row.ticketId]) m.set(row.ticketId, lanesKey(scene.cells[row.ticketId]));
    return m;
  }, [live, model.rows, row, scene, buildColumn]);
  const replies = useCellLanes(live ? client : null, wanted);
  const lineLanes = useMemo(() => {
    const m = new Map<string, LaneLine>();
    for (const r of model.rows) {
      const line = r.column === buildColumn ? laneLine(replies.get(r.ticketId) ?? null, scene.cells[r.ticketId] ?? null) : null;
      if (line) m.set(r.ticketId, line);
    }
    return m;
  }, [model.rows, replies, scene, buildColumn]);
  const boardRows = useMemo(() => model.rows.map((r) => withLaneMarker(r, lineLanes.get(r.ticketId) ?? null)), [model.rows, lineLanes]);
  const panelLanes = useMemo(() => (row ? lanesPanel(replies.get(row.ticketId) ?? null, scene.cells[row.ticketId] ?? null) : null), [row, replies, scene]);

  const pickRow = useCallback((r: LineRow) => store.select(r.sliceId && !scene.cells[r.ticketId] ? (`slice:${r.sliceId}` as EntityRef) : (`cell:${r.ticketId}` as EntityRef), { focus: false }), [store, scene]);
  const pickStation = useCallback((c: number) => store.select(`station:${LINE_STATIONS[c]!.key}` as EntityRef, { focus: false }), [store]);
  const back = useCallback(() => store.select(null), [store]);
  const recordRow = record ? (model.rows.find((r) => r.ticketId === record) ?? null) : null;

  const empty =
    source === "simulation"
      ? { title: "No ticket has started yet", body: "The simulated run is starting: its tickets appear here in a moment." }
      : notice
        ? { title: notice.title, body: notice.body }
        : { title: "No tickets on the line yet", body: "Connected and waiting: each ticket appears here as the Factory records it." };

  return (
    <div className="flex h-full min-h-0 flex-col" data-line-workspace="" data-line-rows={model.rows.length}>
      <NeedsYou needs={model.needs} now={now} onPick={pickRow} />
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_360px] max-[899px]:grid-cols-1 max-[899px]:grid-rows-[minmax(0,1fr)_minmax(0,45%)]">
        <div className="flex min-h-0 min-w-0 flex-col" data-line-home="" tabIndex={-1}>
          <Board
            rows={boardRows}
            lanes={lineLanes}
            stats={stats}
            now={now}
            landedHidden={model.landedHidden}
            selectedTicket={row?.ticketId ?? null}
            selectedColumn={column}
            onTicket={pickRow}
            onStation={pickStation}
            onRecord={(r) => setRecord(r.ticketId)}
            empty={empty}
          />
        </div>
        <aside aria-label="Details" className="min-h-0 overflow-y-auto border-l border-line bg-surface px-5 py-4 max-[899px]:border-l-0 max-[899px]:border-t">
          {row ? (
            <TicketPanel
              key={row.ticketId}
              row={row}
              now={now}
              lanes={panelLanes}
              onBack={back}
              onRecord={() => setRecord(row.ticketId)}
              onFloor={() => showOnFloor(store, { ref: `cell:${row.ticketId}` as EntityRef })}
            />
          ) : column !== null ? (
            <StationPanel key={column} column={column} stat={stats[column]} onBack={back} />
          ) : (
            <Feed moments={feed} onTicket={(ref) => store.select(ref, { focus: false })} />
          )}
        </aside>
      </div>
      <p className="border-t border-line bg-canvas px-4 py-2 text-caption text-ink-subtle">This page only reads. To change anything, copy the command it shows and run it in Claude Code.</p>
      <TicketRecord row={recordRow} now={now} onClose={() => setRecord(null)} />
    </div>
  );
}
