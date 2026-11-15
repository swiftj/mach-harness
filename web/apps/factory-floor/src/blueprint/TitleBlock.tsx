/**
 * The sheet's title block, as the scene says it: where the drawing comes from (its provenance: the
 * Simulation, the Live Factory, a historical replay), how complete its history is (partial since a
 * gap, reconstructed from a snapshot), and, as its own small components, the playhead's live line and,
 * while the connection is stale or lost, the "as last seen" note. The playhead re-renders its text and
 * nothing else.
 */
import { fc } from "@mach/ui";
import type { Scene, WaveState } from "../sim";
import { gapClassWord, isKnown } from "../sim";
import { useSceneStore } from "../scene";
import { useStaleSince } from "./motion";
import { clock, clockTenths } from "./time";

const MARGIN = 18;
const TB_W = 260;

export interface SheetFacts {
  readonly subtitle: string;
  /** The stamp that is never hidden: "Simulation", "Live", "Replay". */
  readonly stamp: string;
  readonly facts: ReadonlyArray<readonly [string, string]>;
}

/** What the history's completeness says, in a few words for the title block. */
export function completenessWords(scene: Scene): string {
  const c = scene.completeness;
  // Records received but not interpreted (an unknown kind) lose no history: said as such, never "partial".
  const notRead = Object.values(c.notInterpreted).reduce((n, k) => n + k, 0);
  const tail = notRead ? ` · ${notRead} received, not interpreted` : "";
  if (c.state === "complete") return `complete${tail}`;
  if (c.state === "reconstructed") return `${c.since !== null ? `reconstructed, ${clock(c.since)}` : "reconstructed"}${tail}`;
  const began = Object.keys(c.began).length;
  // Only gaps that lost history make it partial.
  const lost = c.gaps.filter((g) => g.lost);
  const gaps = lost.length;
  // Said by class (observer M6.2): "2 gaps (not received, before the loaded window)".
  const classes = [...new Set(lost.map((g) => gapClassWord(g.class)))].join(", ");
  return `partial${c.since !== null ? ` since ${clock(c.since)}` : ""}${gaps ? ` · ${gaps} gap${gaps === 1 ? "" : "s"} (${classes})` : began ? ` · ${began} begun late` : ""}${tail}`;
}

/** The title block's subtitle, stamp and facts for a scene and the waves it draws. */
export function sheetFacts(scene: Scene, waves: readonly WaveState[]): SheetFacts {
  const p = scene.provenance;
  const first = waves[0];
  const waveTitle = (w: WaveState): string => (isKnown(w.meta, "title") ? `${w.id} · ${w.title}` : w.id);
  const subtitle = !first ? "Waiting for an approved wave" : waves.length === 1 ? waveTitle(first) : `${waves.length} waves · ${first.id} to ${waves[waves.length - 1]!.id}`;
  if (p.source === "simulation") {
    return { subtitle, stamp: "Simulation", facts: [["Wave", first?.id ?? "none yet"], ["Project", scene.project.name], ["Playhead", ""], ["Run", p.origin ?? ""]] };
  }
  const ids = waves.map((w) => w.id).join(", ");
  return {
    subtitle,
    stamp: p.source === "live" ? "Live" : "Replay",
    facts: [
      [waves.length > 1 ? "Waves" : "Wave", ids.length > 26 ? `${waves.length} waves` : ids || "none yet"],
      ["History", completenessWords(scene)],
      ["Playhead", ""],
      ["Source", p.origin ? `${p.label} · ${p.origin}` : p.label],
    ],
  };
}

export function PlayheadFact({ width, height, factIndex, factCount }: { width: number; height: number; factIndex: number; factCount: number }) {
  const t = useSceneStore((s) => Math.floor(s.playhead / 100) * 100);
  const cursor = useSceneStore((s) => s.cursor);
  const total = useSceneStore((s) => s.extent.events);
  const soFar = useSceneStore((s) => s.extent.kind === "so-far");
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
        · {cursor}/{total} events{soFar ? " so far" : ""}
      </tspan>
    </text>
  );
}

/**
 * While the connection is stale or lost (live only), a note set over the title block's top edge:
 * "As last seen at 14:02:10". Nothing on the sheet is then drawn as working, and nothing moves.
 */
export function StaleNote({ width, height, factCount }: { width: number; height: number; factCount: number }) {
  const since = useStaleSince();
  const state = useSceneStore((s) => s.connection?.state ?? null);
  if (since === null) return null;
  const innerW = width - MARGIN * 2;
  const innerH = height - MARGIN * 2;
  const tbH = 54 + factCount * 16;
  const x = MARGIN + innerW - TB_W;
  const y = MARGIN + innerH - tbH - 26;
  // Each connection state as itself: no-session is the observer not knowing this browser, not staleness.
  const text = `As last seen at ${clock(since)}${state === "disconnected" ? " · disconnected" : state === "reconnecting" ? " · reconnecting" : state === "no-session" ? " · no session: open the observer's link again" : " · connection stale"}`;
  return (
    <g role="status" aria-label={text}>
      <rect x={x} y={y} width={TB_W} height={20} rx={2} style={{ fill: fc("wait-soft"), stroke: fc("wait"), strokeWidth: 1 }} />
      <text x={x + 10} y={y + 13.5} style={{ fill: "var(--mach-ink)", fontSize: 10.5, fontWeight: 700 }}>
        {text}
      </text>
    </g>
  );
}
