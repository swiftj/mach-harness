import { useEffect, useRef } from "react";
import { isBusy } from "../../interview/model";
import { useNeedsConversation } from "../shell/useNeedsConversation";

/**
 * Whether the needs conversation is writing right now (a turn is running), read from the shared conversation hook:
 * while it writes, the host answers `conflict` to every act on a design, so the page says so and its acts wait. This
 * page only watches the conversation; it never starts one or replies to it (that is on Technical needs). When a turn
 * ends, `onFinished` runs, as the turn may have recorded a design's map.
 */
export function useNeedsWriting(onFinished: () => void): boolean {
  const conv = useNeedsConversation();
  const writing = conv.phase === "live" && !conv.model.ended && (conv.model.turnRunning || isBusy(conv.model.hostState));
  const was = useRef(writing);
  const finished = useRef(onFinished);
  useEffect(() => {
    finished.current = onFinished;
  });
  useEffect(() => {
    if (was.current && !writing) finished.current();
    was.current = writing;
  }, [writing]);
  return writing;
}
