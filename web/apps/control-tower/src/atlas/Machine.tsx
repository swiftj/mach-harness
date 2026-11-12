/**
 * A station machine with its name plate. The grammar's machine labels sit beside the block at near
 * zoom, where the next machine on the rail covers them; here the name is lettered on the machine's
 * own lit front face instead (an engineer's name plate), so it can never collide with a neighbour.
 */
import { StationMachine, factoryStates, factoryTokens, fc, stations, uprightTransform, type FactoryState, type Lod, type StationKind, type Vec3 } from "@mach/ui";

const PAD = factoryTokens.size.stationPad;

export function Machine({ kind, state, progress, round, at, lod, dimmed, plate }: { kind: StationKind; state: FactoryState; progress?: number; round?: number; at: Vec3; lod: Lod; dimmed?: boolean; plate?: string }) {
  const h = stations[kind].height;
  const text = (plate ?? stations[kind].label).toUpperCase() + (round && round > 1 ? ` · R${round}` : "");
  const size = Math.min(6.4, h * 0.46);
  const ink = state === "idle" ? "var(--mach-ink-subtle)" : state === "failed" ? fc("fail") : "var(--mach-ink-muted)";
  return (
    <g>
      <StationMachine kind={kind} state={state} progress={progress} round={round} at={at} lod={lod} dimmed={dimmed} showLabel={false} />
      {lod !== "far" ? (
        <g transform={uprightTransform({ x: at.x - PAD / 2, y: at.y + PAD / 2, z: at.z ?? 0 }, h)} aria-hidden="true" style={{ opacity: dimmed ? 0.28 : 1 }}>
          <text x={PAD / 2} y={h / 2 + size * 0.36} textAnchor="middle" className="notranslate" style={{ fill: ink, fontSize: size, fontFamily: "var(--mach-font-mono)", fontWeight: 600, letterSpacing: "0.04em" }}>
            {text.length > 12 ? text.slice(0, 12) : text}
          </text>
          {lod === "near" ? (
            <text x={PAD / 2} y={h - 1.2} textAnchor="middle" style={{ fill: ink, fontSize: Math.min(4.2, size * 0.7), opacity: 0.9 }}>
              {factoryStates[state].label}
            </text>
          ) : null}
        </g>
      ) : null}
    </g>
  );
}
