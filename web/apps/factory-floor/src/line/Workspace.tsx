/**
 * The Line workspace (the Factory Floor's default): a "Needs you" strip on top, the board of
 * stations and tickets, and a side panel. Everything is read from the one store at the moment it
 * holds now; the selection is the store's, so the Floor and Analytics see the same ticket picked.
 *
 * M23: where the observer can reach MACH's run.py, "Needs you" is MACH's own list (src/needs) and the side
 * panel of a ticket in it is where the person decides; MACH records the decision. Elsewhere (the
 * Simulation, or no run.py) the panel offers a `/mach` command to copy and run in Claude Code.
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
import { commandsPanel, laneLine, lanesPanel, withLaneMarker, type LaneLine } from "./lanesModel";
import { lanesKey, useCellLanes } from "./useLanes";
import "./line.css";
import { TriangleAlert } from "lucide-react";
import { useNeeds, type Outcome, type Waiting } from "../needs/context";
import { DecidePanel, OutcomeLine } from "../needs/Decide";
import { NOT_RUNNING, NOT_RUNNING_STOPPED, WAITING_WORDS, type NeedTicket } from "../needs/model";
import { Back } from "./Panels";
import { StoppedPanel } from "../stopped/StoppedPanel";

/** After a stopped ticket is opened: focus "What stopped it" once its panel is drawn. */
export function focusStopped(ticket: string): void {
  if (typeof window === "undefined") return;
  window.requestAnimationFrame(() =>
    window.requestAnimationFrame(() => {
      const panel = document.querySelector<HTMLElement>(`[data-stopped-panel="${CSS.escape(ticket)}"] [data-stopped-heading]`);
      panel?.focus();
      panel?.scrollIntoView({ block: "start" });
    }),
  );
}

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

/** One item in the strip: a Line row, MACH's list entry for it, or both. */
interface NeedItem {
  readonly ticketId: string;
  readonly row: LineRow | null;
  readonly need: NeedTicket | null;
}

/**
 * The strip of tickets waiting for a person or stopped, longest waiting first. Where MACH's own list is read
 * (M23) it is that list, in MACH's order; an item shows what a decision made here answered until the event
 * stream catches up. With nothing running here and something waiting, it says how the work carries on.
 */
function NeedsYou({
  items,
  now,
  onPick,
  outcomes,
  waiting,
  notRunning,
}: {
  items: readonly NeedItem[];
  now: number;
  onPick: (item: NeedItem) => void;
  outcomes: Readonly<Record<string, Outcome>>;
  waiting: Readonly<Record<string, Waiting>>;
  notRunning: boolean;
}) {
  return (
    <section aria-labelledby="needs-you" className="flex flex-wrap items-stretch gap-3 border-b border-line bg-canvas px-4 py-3" data-needs-you={items.length}>
      <h2 id="needs-you" tabIndex={-1} className="self-center text-label text-ink outline-none min-[700px]:min-w-[88px]">
        Needs you
      </h2>
      {items.length === 0 ? (
        <p className="self-center text-body-sm text-ink-muted" data-needs-none="">
          Nothing is waiting for a person.
        </p>
      ) : (
        items.map((item) => {
          const row = item.row;
          const state = row?.state ?? "person";
          const outcome = outcomes[item.ticketId];
          const said = waiting[item.ticketId]
            ? `${WAITING_WORDS}.`
            : (outcome?.refusal ?? outcome?.decided?.now ?? (outcome?.decided?.inConversation ? outcome.decided.why : null));
          // MACH's warning (another worker may be on it) in the warning tone, under the line: never in place of the choice.
          const warning = item.need?.warnings[0] ?? null;
          return (
            <button
              key={item.ticketId}
              type="button"
              onClick={() => onPick(item)}
              data-need={item.ticketId}
              className={cn("flex min-w-0 flex-[1_1_300px] items-center gap-3 rounded-md border px-3.5 py-2.5 text-left", STATE_TONE[state], state === "stopped" && "rounded-xs")}
            >
              <StateShape state={state} size={14} />
              <span className="min-w-0 flex-1">
                <span className="block text-body-sm font-semibold text-ink">
                  {row ? needVerb(row) : "Decide on"} <span className="font-mono text-[13px]">{item.ticketId}</span>
                </span>
                <span className="block text-body-sm text-ink-muted" data-need-said={said ? "" : undefined}>
                  {said ?? item.need?.summary ?? row?.why}
                </span>
                {warning ? (
                  <span className="mt-0.5 flex items-start gap-1.5 text-body-sm text-warning-ink" data-need-warning="">
                    <TriangleAlert aria-hidden="true" className="mt-[3px] size-3.5 shrink-0" />
                    <span>{warning}</span>
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 whitespace-nowrap text-caption text-ink-muted">{row && row.since !== null ? `waiting ${duration(Math.max(0, now - row.since))}` : STATE_WORDS[state]}</span>
            </button>
          );
        })
      )}
      {notRunning && items.length > 0 ? (
        <p className="basis-full text-body-sm text-ink-muted" data-needs-not-running="">
          {items.some((i) => i.row?.state === "stopped" || i.need?.state === "escalated") ? NOT_RUNNING_STOPPED : NOT_RUNNING}
        </p>
      ) : null}
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
      const line = r.column === buildColumn ? laneLine(replies.get(r.ticketId)?.lanes ?? null, scene.cells[r.ticketId] ?? null) : null;
      if (line) m.set(r.ticketId, line);
    }
    return m;
  }, [model.rows, replies, scene, buildColumn]);
  const boardRows = useMemo(() => model.rows.map((r) => withLaneMarker(r, lineLanes.get(r.ticketId) ?? null)), [model.rows, lineLanes]);
  const panelLanes = useMemo(() => (row ? lanesPanel(replies.get(row.ticketId)?.lanes ?? null, scene.cells[row.ticketId] ?? null) : null), [row, replies, scene]);
  const panelCommands = useMemo(() => (row ? commandsPanel(replies.get(row.ticketId)?.commands) : null), [row, replies]);

  const pickRow = useCallback((r: LineRow) => store.select(r.sliceId && !scene.cells[r.ticketId] ? (`slice:${r.sliceId}` as EntityRef) : (`cell:${r.ticketId}` as EntityRef), { focus: false }), [store, scene]);
  // M23: MACH's own "Needs you" list, where it can be read; else the Line's own reading of the records.
  const needs = useNeeds();
  const running = useSceneStore((s) => s.factoryStatus?.running ?? null);
  const items = useMemo<NeedItem[]>(() => {
    if (!needs.list) return model.needs.map((r) => ({ ticketId: r.ticketId, row: r, need: null }));
    const listed = needs.list.tickets.map((t) => ({ ticketId: t.ticketId, row: model.rows.find((r) => r.ticketId === t.ticketId) ?? null, need: t }));
    // A ticket decided here that has left MACH's list keeps its item, with MACH's sentence, until the stream catches up.
    const decided = Object.keys(needs.outcomes)
      .filter((t) => !listed.some((i) => i.ticketId === t))
      .map((t) => ({ ticketId: t, row: model.rows.find((r) => r.ticketId === t) ?? null, need: null }));
    return [...listed, ...decided];
  }, [needs.list, needs.outcomes, model.needs, model.rows]);
  // A ticket MACH lists that no record on this page shows yet is opened here, not through the store's selection.
  const [picked, setPicked] = useState<{ readonly ticket: string; readonly selection: EntityRef | null } | null>(null);
  const pickItem = useCallback(
    (item: NeedItem) => {
      if (item.row) {
        setPicked(null);
        pickRow(item.row);
      } else {
        setPicked({ ticket: item.ticketId, selection });
      }
      // "Unblock 6" opens what stopped it.
      if (item.row?.state === "stopped" || item.need?.state === "escalated") focusStopped(item.ticketId);
    },
    [pickRow, selection],
  );
  const pickedTicket = picked && picked.selection === selection ? picked.ticket : null;
  const selectedTicket = selection && refKind(selection) === "cell" ? refId(selection) : null;
  const panelTicket = pickedTicket ?? row?.ticketId ?? selectedTicket;
  const need = needs.find(panelTicket);
  const outcome = !need && panelTicket ? (needs.outcomes[panelTicket] ?? null) : null;
  const decidePart = need ? (
    <DecidePanel key={need.ticketId} ticket={need} />
  ) : outcome && panelTicket ? (
    <section aria-label={`What was decided on ${panelTicket}`}>
      <h4 className="mb-1.5 text-label text-ink-muted">What it needs from you</h4>
      <OutcomeLine outcome={outcome} ticket={panelTicket} />
    </section>
  ) : undefined;
  const shownRow = pickedTicket && pickedTicket !== row?.ticketId ? null : row;
  // A ticket stopped for a person: the one panel that says what stopped it, with its decision (src/stopped).
  const stoppedPart =
    panelTicket && (row?.state === "stopped" || need?.state === "escalated") ? (
      <StoppedPanel
        key={`stopped-${panelTicket}`}
        ticketId={panelTicket}
        cell={scene.cells[panelTicket] ?? null}
        sentence={row?.why ?? need?.summary ?? "The line stopped work on it."}
        at={row?.since ?? null}
        need={need}
        live={live}
      />
    ) : undefined;
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
      <NeedsYou items={items} now={now} onPick={pickItem} outcomes={needs.outcomes} waiting={needs.waiting} notRunning={needs.enabled && running?.running === false} />
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
            onStopped={(r) => {
              setPicked(null);
              pickRow(r);
              focusStopped(r.ticketId);
            }}
            empty={empty}
          />
        </div>
        <aside aria-label="Details" className="min-h-0 overflow-y-auto border-l border-line bg-surface px-5 py-4 max-[899px]:border-l-0 max-[899px]:border-t">
          {shownRow && row ? (
            <TicketPanel
              key={row.ticketId}
              row={row}
              now={now}
              lanes={panelLanes}
              commands={panelCommands}
              onBack={back}
              onRecord={() => setRecord(row.ticketId)}
              onFloor={() => showOnFloor(store, { ref: `cell:${row.ticketId}` as EntityRef })}
              decide={decidePart}
              stopped={stoppedPart}
            />
          ) : stoppedPart ? (
            <div data-line-panel="ticket" data-ticket={panelTicket ?? ""}>
              <Back onBack={() => (setPicked(null), back())} />
              <p className="mt-4 font-mono text-[13px] text-ink-muted">{panelTicket}</p>
              <h3 tabIndex={-1} data-inspector-heading="" className="mb-4 font-sans text-title-3 font-bold leading-snug text-ink outline-none">
                {panelTicket} is stopped
              </h3>
              {stoppedPart}
            </div>
          ) : need || (outcome && panelTicket) ? (
            <div data-line-panel="ticket" data-ticket={panelTicket ?? ""}>
              <Back onBack={() => (setPicked(null), back())} />
              <p className="mt-4 font-mono text-[13px] text-ink-muted">{panelTicket}</p>
              <h3 tabIndex={-1} data-inspector-heading="" className="mb-4 font-sans text-title-3 font-bold leading-snug text-ink outline-none">
                {need ? `${panelTicket} waits for you` : `${panelTicket}: decided here`}
              </h3>
              {decidePart}
            </div>
          ) : column !== null ? (
            <StationPanel key={column} column={column} stat={stats[column]} onBack={back} />
          ) : (
            <Feed moments={feed} onTicket={(ref) => store.select(ref, { focus: false })} />
          )}
        </aside>
      </div>
      <p className="border-t border-line bg-canvas px-4 py-2 text-caption text-ink-subtle" data-line-footer="">
        {needs.enabled
          ? "A decision made here is recorded by MACH, as in Claude Code. Anything else: copy the command a ticket shows and run it in Claude Code."
          : "To change anything, copy the command a ticket shows and run it in Claude Code."}
      </p>
      <TicketRecord row={recordRow} now={now} onClose={() => setRecord(null)} />
    </div>
  );
}
