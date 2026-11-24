/**
 * Tickets on this computer the page does not show (onDisk.ts has the rule and the words): one plain
 * line per ticket under the top bar, live only, in the warning tone of a banner (style guide 7.7). It
 * stays while the situation lasts and goes by itself when the records arrive or the folder goes. A
 * polite status: said once when it appears or changes, never per tick.
 */
import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { useSceneStore } from "../scene";
import { onDiskLines, type CellFolder, type OnDiskLine } from "./onDisk";

/** The sentence with its ticket ID set as an identifier (mono, never translated). */
function Identified({ text, id }: { text: string; id: string }) {
  const at = text.indexOf(id);
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <span translate="no" className="font-mono">
        {id}
      </span>
      {text.slice(at + id.length)}
    </>
  );
}

/** How many lines are written out; the rest are counted. */
const SHOWN = 3;

const wallClock = () => Date.now();

export function OnDiskNotice({ clock = wallClock }: { readonly clock?: () => number } = {}) {
  const live = useSceneStore((s) => s.source !== "simulation");
  const sources = useSceneStore((s) => s.factoryStatus?.sources);
  const scene = useSceneStore((s) => s.log.sceneAt(s.now));
  // The grace for a folder just made is measured on the wall clock: look again every few seconds.
  const [now, setNow] = useState(clock);
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => setNow(clock()), 5000);
    return () => window.clearInterval(id);
  }, [live, clock]);
  if (!live || !sources) return null;
  const folders: CellFolder[] = sources.flatMap((s) => (s.cell ? [s.cell] : []));
  const lines: OnDiskLine[] = onDiskLines(folders, scene, now);
  if (!lines.length) return null;
  return (
    <div role="status" data-on-disk={lines.map((l) => `${l.ticketId}:${l.kind}`).join(",")} className="flex flex-col gap-1 border-t border-warning-line bg-warning-soft px-4 py-2">
      {lines.slice(0, SHOWN).map((l) => (
        <p key={l.ticketId} className="flex min-w-0 items-start gap-2 text-body-sm text-ink">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning-ink" />
          <span className="min-w-0">
            <span className="font-semibold">
              <Identified text={l.text} id={l.ticketId} />
            </span>{" "}
            <span className="text-ink-muted">{l.action}</span>
          </span>
        </p>
      ))}
      {lines.length > SHOWN ? <p className="pl-6 text-caption text-ink-muted">And {lines.length - SHOWN} more tickets like these.</p> : null}
    </div>
  );
}
