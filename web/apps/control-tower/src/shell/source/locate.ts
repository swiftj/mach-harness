/**
 * Finding the time of an event the history held does not reach, for an address's `at=<event id>`
 * (./hashSync.ts). The observer has no lookup by event id; what does carry event ids is the Timeline's
 * marks (`eventId`) and the ends of its spans (`start.eventId`, `end.eventId`), over the whole history.
 * Null when neither names it: the caller tells the person the moment could not be located.
 */
import type { TimelineData, TimeWindow } from "../../timeline/contract";

export async function locateEvent(data: Pick<TimelineData, "marks" | "spans">, whole: TimeWindow, id: string, signal?: AbortSignal): Promise<number | null> {
  const marks = await data.marks(whole, undefined, signal);
  const mark = marks.find((m) => m.eventId === id);
  if (mark) return mark.at;
  const page = await data.spans({ window: whole }, signal);
  for (const span of page.spans) {
    if (span.start?.eventId === id && span.start.at !== null) return span.start.at;
    if (span.end?.eventId === id && span.end.at !== null) return span.end.at;
  }
  return null;
}
