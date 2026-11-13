/**
 * Screen-reader announcements. Two polite live regions:
 * - the transport's state when it changes (playing, paused, speed, live or replay, back at the live
 *   edge), never per tick; the view when the mode switches ("Factory Atlas", "Execution Blueprint";
 *   spec c.6); and, live, the connection when it changes state (once per change: live, stale,
 *   reconnecting, disconnected), never its counters;
 * - significant moments while time moves (playing, or following the live edge): chapters or real
 *   landmarks always, other major moments at most one per few seconds of wall time, folding any in
 *   between into "and n more".
 * The words come from the history (its own sentences per event), never invented here.
 */
import { useEffect, useRef, useState } from "react";
import { useStore } from "../scene";
import { countAtOrBefore, indexFor, lastAtOrBefore } from "./history";
import { connectionLook } from "./SourceBadge";
import { spokenTime } from "./vocab";

const MIN_GAP_MS = 4000;

export function Announcer() {
  const store = useStore();
  const [status, setStatus] = useState("");
  const [moment, setMoment] = useState("");
  const last = useRef({ index: 0, wall: -Infinity, pending: 0, chapter: "", connection: "" });

  useEffect(() => {
    let prev = store.getState();
    const first = indexFor(prev);
    last.current.index = countAtOrBefore(first.moments, prev.playhead);
    last.current.chapter = lastAtOrBefore(first.landmarks, prev.playhead)?.id ?? "";
    last.current.connection = prev.connection ? connectionLook(prev.connection).state : "";
    return store.subscribe(() => {
      const s = store.getState();
      const index = indexFor(s);
      if (s.view !== prev.view) setStatus(s.view === "atlas" ? "Factory Atlas" : "Execution Blueprint");
      if (s.source === "simulation" && (s.playing !== prev.playing || s.speed !== prev.speed || s.following !== prev.following)) {
        const words = s.playing ? `Playing at ${s.speed} times` : `Paused at ${spokenTime(s.playhead)}`;
        setStatus(`${words}${s.following ? ", live" : ", replay"}.`);
      } else if (s.source !== "simulation" && (s.following !== prev.following || (!s.following && s.playing !== prev.playing))) {
        if (s.following) setStatus("Back at the live edge.");
        else if (s.playing) setStatus(`Replaying at ${s.speed} times from ${spokenTime(s.playhead)}.`);
        else setStatus(`Holding ${spokenTime(s.playhead)}${s.source === "live" ? "; events keep arriving" : ""}.`);
      }
      // One announcement per connection change, never for its counters.
      if (s.connection) {
        const look = connectionLook(s.connection);
        if (look.state !== last.current.connection) {
          const quiet = last.current.connection === "" || (look.state === "connecting" && last.current.connection === "connecting");
          last.current.connection = look.state;
          if (!quiet) setStatus(look.sentence);
        }
      }
      // While history loads (connecting) the backlog is not news: it is caught up silently.
      const moving = s.playing || (s.source === "live" && s.following && s.connection?.state === "live");
      const count = countAtOrBefore(index.moments, s.playhead);
      const chapter = lastAtOrBefore(index.landmarks, s.playhead);
      const newChapter = chapter && chapter.id !== last.current.chapter ? chapter : null;
      if (chapter) last.current.chapter = chapter.id;
      if (!moving) {
        // Seeking and stepping are announced by the controls themselves; keep the cursor in step.
        last.current.index = count;
        last.current.pending = 0;
      } else if (count > last.current.index || newChapter) {
        const fresh = index.moments.slice(last.current.index, count);
        last.current.index = count;
        const now = performance.now();
        const newest = fresh[fresh.length - 1];
        if (newChapter || (newest && now - last.current.wall >= MIN_GAP_MS)) {
          const more = Math.max(0, last.current.pending + fresh.length - 1);
          const heading = newChapter ? (index.storyboard ? `Chapter ${index.landmarks.indexOf(newChapter) + 1}: ${newChapter.title}. ` : newest?.id === newChapter.id ? "" : `${newChapter.title}. `) : "";
          setMoment(`${heading}${newest?.text ?? ""}${more > 0 ? ` And ${more} more.` : ""}`);
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
      <div role="status" aria-live="polite" className="sr-only" data-announcer="transport">
        {status}
      </div>
      <div aria-live="polite" aria-atomic="true" className="sr-only" data-announcer="moments">
        {moment}
      </div>
    </>
  );
}
