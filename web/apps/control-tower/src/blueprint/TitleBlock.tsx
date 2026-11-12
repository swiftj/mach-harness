/**
 * The live line of the sheet's title block: the playhead to a tenth of a second and the events
 * applied. Drawn into the row BlueprintSheet leaves for it, as its own small component, so the
 * playhead re-renders this text and nothing else.
 */
import { useSceneStore } from "../scene";
import { clockTenths } from "./time";

const MARGIN = 18;
const TB_W = 260;

export function PlayheadFact({ width, height, factIndex, factCount }: { width: number; height: number; factIndex: number; factCount: number }) {
  const t = useSceneStore((s) => Math.floor(s.playhead / 100) * 100);
  const cursor = useSceneStore((s) => s.cursor);
  const total = useSceneStore((s) => s.fixture.events.length);
  const innerW = width - MARGIN * 2;
  const innerH = height - MARGIN * 2;
  const tbH = 54 + factCount * 16;
  const x = MARGIN + innerW - TB_W + 96;
  const y = MARGIN + innerH - tbH + 52 + factIndex * 16;
  return (
    <text x={x} y={y} style={{ fill: "var(--mach-ink)", fontFamily: "var(--mach-font-mono)", fontSize: 10 }} className="tabular" aria-live="off">
      {clockTenths(t)}
      <tspan style={{ fill: "var(--mach-ink-muted)" }}>
        {" "}
        · {cursor}/{total} events
      </tspan>
    </text>
  );
}
