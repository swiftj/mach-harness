/**
 * Screen-reader announcements. Two polite live regions:
 * - the workspace when it switches ("Line", "Floor: Factory Atlas", "Factory Analytics: ..."; under
 *   reduced motion the switch is a cut, so this is how it is noticed); and, live, the connection when it changes state (once per change: live,
 *   stale, reconnecting, disconnected), never its counters;
 * - significant moments as they happen: chapters (the simulation) or real landmarks always, other
 *   major moments at most one per few seconds of wall time, folding any in between into "and n more".
 * The words come from the history (its own sentences per event), never invented here.
 */
import { useEffect, useRef, useState } from "react";
import { ANALYTICS_AREA_WORDS, useStore } from "../scene";
import { countAtOrBefore, indexFor, lastAtOrBefore, quotingKindOf } from "./history";
import { connectionLook } from "./SourceBadge";
import { lookKey, unavailableSourceWords } from "./notices";
import { codesOnlyWords } from "../text/fields";

const MIN_GAP_MS = 4000;

export function Announcer() {
  const store = useStore();
  const [status, setStatus] = useState("");
  const [moment, setMoment] = useState("");
  const last = useRef({ index: 0, wall: -Infinity, pending: 0, chapter: "", connection: "" });

  useEffect(() => {
    let prev = store.getState();
    const first = indexFor(prev);
    last.current.index = countAtOrBefore(first.moments, prev.now);
    last.current.chapter = lastAtOrBefore(first.landmarks, prev.now)?.id ?? "";
    last.current.connection = prev.connection ? lookKey(connectionLook(prev.connection, unavailableSourceWords(prev.factoryStatus?.sources))) : "";
    return store.subscribe(() => {
      const s = store.getState();
      const index = indexFor(s);
      // A workspace switch is said once, with where it lands (the Floor's drawing when returning to it).
      if (s.workspace !== prev.workspace)
        setStatus(
          s.workspace === "line"
            ? "Line: stations left to right, a row for each ticket"
            : s.workspace === "analytics"
              ? `Factory Analytics: ${ANALYTICS_AREA_WORDS[s.analytics.area]}`
              : "Floor: Factory Atlas",
        );
      else if (s.workspace === "analytics" && s.analytics.area !== prev.analytics.area) setStatus(`Factory Analytics: ${ANALYTICS_AREA_WORDS[s.analytics.area]}`);
      // One announcement per connection change, never for its counters.
      if (s.connection) {
        // M6.6: a source going unavailable, or returning, is a change of the connection's words too.
        const look = connectionLook(s.connection, unavailableSourceWords(s.factoryStatus?.sources));
        const key = lookKey(look);
        if (key !== last.current.connection) {
          const quiet = last.current.connection === "" || (look.state === "connecting" && last.current.connection === "connecting");
          last.current.connection = key;
          if (!quiet) setStatus(look.sentence);
        }
      }
      // While history loads (connecting) the backlog is not news: it is caught up silently.
      const moving = s.source === "simulation" || s.connection?.state === "live";
      const count = countAtOrBefore(index.moments, s.now);
      const chapter = lastAtOrBefore(index.landmarks, s.now);
      const newChapter = chapter && chapter.id !== last.current.chapter ? chapter : null;
      if (chapter) last.current.chapter = chapter.id;
      if (!moving) {
        last.current.index = count;
        last.current.pending = 0;
      } else if (count > last.current.index || newChapter) {
        const fresh = index.moments.slice(last.current.index, count);
        last.current.index = count;
        const now = performance.now();
        const newest = fresh[fresh.length - 1];
        if (newChapter || (newest && now - last.current.wall >= MIN_GAP_MS)) {
          const more = Math.max(0, last.current.pending + fresh.length - 1);
          const heading = newChapter ? (index.storyboard ? `Chapter ${index.landmarks.indexOf(newChapter) + 1}: ${newChapter.title}. ` : newest?.id === newChapter.id ? "" : `${(newChapter.eventType && codesOnlyWords(newChapter.eventType)) || newChapter.title} `) : "";
          setMoment(`${heading}${newest ? ((index.storyboard ? null : codesOnlyWords(quotingKindOf(store.getState().log, newest) ?? "", newest.ticketId)) ?? newest.text) : ""}${more > 0 ? ` And ${more} more.` : ""}`);
          last.current.wall = now;
          last.current.pending = 0;
        } else {
          last.current.pending += fresh.length;
        }
      } else if (count < last.current.index) {
        last.current.index = count;
      }
      prev = s;
    });
  }, [store]);

  return (
    <>
      <div role="status" aria-live="polite" className="sr-only" data-announcer="status">
        {status}
      </div>
      <div aria-live="polite" aria-atomic="true" className="sr-only" data-announcer="moments">
        {moment}
      </div>
    </>
  );
}
