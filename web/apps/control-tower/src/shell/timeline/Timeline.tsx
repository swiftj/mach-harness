/**
 * The synchronized execution timeline, docked at the bottom (spec f.8): transport, the run-wide
 * scrubber with chapters and moments, and the tracks. Its size, collapse, time window and which
 * tracks are expanded are the shell's own interface state; time, selection and focus are the store's.
 */
import { useCallback, useMemo, useState } from "react";
import { Ruler } from "./Ruler";
import { Tracks, type TimeWindow } from "./Tracks";
import { Transport } from "./Transport";
import { timelineModel } from "./model";

export function Timeline({ collapsed, onCollapse }: { collapsed: boolean; onCollapse: () => void }) {
  const model = useMemo(() => timelineModel(), []);
  const [win, setWin] = useState<TimeWindow>({ v0: 0, v1: model.duration });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const onToggle = useCallback((id: string, open?: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      const want = open ?? !prev.has(id);
      if (want === prev.has(id)) return prev;
      if (want) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Transport collapsed={collapsed} onCollapse={onCollapse} />
      {collapsed ? null : (
        <>
          <Ruler moments={model.moments} duration={model.duration} window={win} onWindow={setWin} />
          <Tracks model={model} window={win} onWindow={setWin} expanded={expanded} onToggle={onToggle} />
        </>
      )}
    </div>
  );
}
