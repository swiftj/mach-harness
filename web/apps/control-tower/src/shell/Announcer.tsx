/**
 * Screen-reader announcements. Two polite live regions:
 * - the transport's state when it changes (playing, paused, speed, live or replay), never per tick;
 * - significant moments while playing, at a sensible rate: chapters always, other major moments at
 *   most one per few seconds of wall time, folding any in between into "and n more".
 * The words come from the simulation (describe), never invented here.
 */
import { useEffect, useRef, useState } from "react";
import { chapterAt, moments, SCENARIO } from "../sim";
import { useStore } from "../scene";
import { spokenTime } from "./vocab";

const MAJOR = moments(SCENARIO, "major");
const MIN_GAP_MS = 4000;

function indexAt(t: number): number {
  let lo = 0;
  let hi = MAJOR.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((MAJOR[mid]?.t ?? 0) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo; // moments [0, lo) have happened
}

export function Announcer() {
  const store = useStore();
  const [status, setStatus] = useState("");
  const [moment, setMoment] = useState("");
  const last = useRef({ index: 0, wall: -Infinity, pending: 0, chapter: "" });

  useEffect(() => {
    let prev = store.getState();
    last.current.index = indexAt(prev.playhead);
    last.current.chapter = chapterAt(SCENARIO, prev.playhead)?.id ?? "";
    return store.subscribe(() => {
      const s = store.getState();
      if (s.playing !== prev.playing || s.speed !== prev.speed || s.following !== prev.following) {
        const words = s.playing ? `Playing at ${s.speed} times` : `Paused at ${spokenTime(s.playhead)}`;
        setStatus(`${words}${s.following ? ", live" : ", replay"}.`);
      }
      const index = indexAt(s.playhead);
      const chapter = chapterAt(SCENARIO, s.playhead);
      const newChapter = chapter && chapter.id !== last.current.chapter ? chapter : null;
      if (chapter) last.current.chapter = chapter.id;
      if (!s.playing) {
        // Seeking and stepping are announced by the controls themselves; keep the cursor in step.
        last.current.index = index;
        last.current.pending = 0;
      } else if (index > last.current.index || newChapter) {
        const fresh = MAJOR.slice(last.current.index, index);
        last.current.index = index;
        const now = performance.now();
        const newest = fresh[fresh.length - 1];
        if (newChapter || (newest && now - last.current.wall >= MIN_GAP_MS)) {
          const more = Math.max(0, last.current.pending + fresh.length - 1);
          const heading = newChapter ? `Chapter ${SCENARIO.chapters.indexOf(newChapter) + 1}: ${newChapter.title}. ` : "";
          setMoment(`${heading}${newest?.text ?? ""}${more > 0 ? ` And ${more} more.` : ""}`);
          last.current.wall = now;
          last.current.pending = 0;
        } else {
          last.current.pending += fresh.length;
        }
      } else if (index < last.current.index) {
        last.current.index = index;
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
