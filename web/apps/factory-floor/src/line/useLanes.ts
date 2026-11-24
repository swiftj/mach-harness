/**
 * M22: the lanes of the tickets the Line asks about, read from the observer (`/cells/{ticket}`'s
 * `lanes`) and read again whenever the ticket's events change (a task done, a gate evaluated, a
 * visit begun), as the evidence player does. Only with an observer: the Simulation has no lanes, and
 * none are invented for it.
 */
import { useEffect, useRef, useState } from "react";
import type { ObserverClient } from "../live/observer";
import type { CellState } from "../sim";
import { readLanesReply, type LanesReply } from "./lanesModel";

/** What a ticket's events have recorded so far: when it changes, the lanes are read again. */
export function lanesKey(cell: Pick<CellState, "tasks" | "gateLog" | "visits"> | undefined): string {
  if (!cell) return "";
  return `${cell.visits.length}:${cell.tasks.length}:${cell.tasks.filter((t) => t.doneAt !== null).length}:${cell.gateLog.length}`;
}

/**
 * The lanes of each wanted ticket (ticket -> what its events have recorded so far). A ticket is in
 * the map once the observer answered for it: its reply, or null for a build not in lanes.
 */
export function useCellLanes(client: ObserverClient | null | undefined, wanted: ReadonlyMap<string, string>): ReadonlyMap<string, LanesReply | null> {
  const [replies, setReplies] = useState<ReadonlyMap<string, LanesReply | null>>(() => new Map());
  const asked = useRef(new Map<string, string>());
  const signature = [...wanted].map(([t, k]) => `${t}=${k}`).join("|");
  useEffect(() => {
    if (!client?.cellLanes) return;
    const read = client.cellLanes.bind(client);
    const ctl = new AbortController();
    const due = [...wanted].filter(([ticket, key]) => asked.current.get(ticket) !== key);
    if (!due.length) return;
    (async () => {
      for (const [ticket, key] of due) {
        if (ctl.signal.aborted) return;
        try {
          const reply = readLanesReply(await read(ticket, ctl.signal));
          if (ctl.signal.aborted) return;
          asked.current.set(ticket, key);
          setReplies((m) => new Map(m).set(ticket, reply));
        } catch {
          // Not read this time (the observer busy, the cell not seen yet): asked again when its events change.
        }
      }
    })();
    return () => ctl.abort();
    // `signature` stands for `wanted`'s content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, signature]);
  return replies;
}
