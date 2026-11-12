/**
 * The drawing sheet around the Atlas, fixed to the viewport (not the camera): a drafted border with
 * zone letters and numbers (so a place can be cited, "the gatehouse in zone F4"), corner
 * registration marks, the sheet's title block, a key to the marks, and the flow arrow (the plant's
 * north arrow: plan +x, the direction work moves). It makes the far view read as a finished drawing
 * edge to edge. It names what the drawing is about; nothing in it moves with the factory.
 */
import { memo } from "react";
import { AgentHead, StateMark, fc, project, round, type Lod, type MarkState } from "@mach/ui";
import type { SceneLog } from "../sim";
import { useSceneStore } from "../scene";

const ZONES_X = "ABCDEFGHJK";

/** `titled`: the title block and key are drawn at the establishing (fit) view only, where they sit in the sheet's empty corners. */
export const Sheet = memo(function Sheet({ width, height, lod, titled }: { width: number; height: number; lod: Lod; titled: boolean }) {
  // The title block names what is known so far, and where it comes from (live, replay, simulation).
  const title = useSceneStore((s) => titleOf(s.log, s.playhead, s.connection !== null && s.connection.state !== "live" && s.connection.state !== "connecting" ? s.connection.state : null));
  const live = useSceneStore((s) => s.source !== "simulation");
  if (width < 200 || height < 200) return null;
  const o = 8;
  const i = 18;
  const nx = width > 1100 ? 10 : 6;
  const ny = height > 800 ? 6 : 4;
  const [heading = "", line1 = "", line2 = ""] = title.split("\n");
  const quiet = lod === "near";
  const ink = "var(--mach-ink-subtle)";
  const zx = (k: number) => i + ((width - 2 * i) * k) / nx;
  const zy = (k: number) => i + ((height - 2 * i) * k) / ny;
  let zoneTicks = "";
  for (let k = 1; k < nx; k++) zoneTicks += `M${round(zx(k))} ${o}V${i}M${round(zx(k))} ${height - i}V${height - o}`;
  for (let k = 1; k < ny; k++) zoneTicks += `M${o} ${round(zy(k))}H${i}M${width - i} ${round(zy(k))}H${width - o}`;
  for (const [x, y] of [
    [i + 14, i + 14],
    [width - i - 14, i + 14],
    [i + 14, height - i - 14],
    [width - i - 14, height - i - 14],
  ] as const) {
    zoneTicks += `M${x - 9} ${y}h18M${x} ${y - 9}v18M${x - 5} ${y}a5 5 0 1 0 10 0a5 5 0 1 0 -10 0`;
  }
  return (
    <svg className="atlas-sheet" aria-hidden="true" width={width} height={height} style={{ opacity: quiet ? 0.45 : 1 }}>
      <rect x={o} y={o} width={width - 2 * o} height={height - 2 * o} style={{ fill: "none", stroke: ink, strokeWidth: 0.75 }} />
      <rect x={i} y={i} width={width - 2 * i} height={height - 2 * i} style={{ fill: "none", stroke: "var(--mach-ink-muted)", strokeWidth: 1.25 }} />
      {/* Zone ticks (one path) and letters along the top and left margins; the registration crosses
          just inside the four corners (one path). Batched: the sheet is chrome, not the drawing, and
          should not spend the element budget. */}
      <path d={zoneTicks} style={{ fill: "none", stroke: ink, strokeWidth: 0.75 }} />
      {Array.from({ length: nx }, (_, k) => (
        <text key={`x${k}`} x={round((zx(k) + zx(k + 1)) / 2)} y={o + 7.5} textAnchor="middle" style={{ fill: ink, fontSize: 8, fontFamily: "var(--mach-font-mono)" }}>
          {ZONES_X[k]}
        </text>
      ))}
      {Array.from({ length: ny }, (_, k) => (
        <text key={`y${k}`} x={o + 5} y={round((zy(k) + zy(k + 1)) / 2 + 3)} textAnchor="middle" style={{ fill: ink, fontSize: 8, fontFamily: "var(--mach-font-mono)" }}>
          {k + 1}
        </text>
      ))}
      {quiet || !titled ? null : (
        <>
          <TitleBlock x={i + 34} y={height - i - 30} title={heading} lines={[line1, line2]} />
          <Key x={width - i - 34} y={i + 34} live={live} />
        </>
      )}
    </svg>
  );
});

function TitleBlock({ x, y, title, lines }: { x: number; y: number; title: string; lines: string[] }) {
  return (
    <g>
      <text x={x} y={y - 26} style={{ fill: "var(--mach-ink)", fontFamily: "var(--mach-font-sans)", fontSize: 21, fontWeight: 700 }}>
        {title}
      </text>
      <path d={`M${x} ${y - 18}h300`} style={{ stroke: "var(--mach-ink-muted)", strokeWidth: 0.75 }} />
      {lines.map((l, k) => (
        <text key={k} x={x} y={y - 4 + k * 13} style={{ fill: "var(--mach-ink-muted)", fontSize: 10.5, fontFamily: k === 0 ? "var(--mach-font-mono)" : undefined }}>
          {l}
        </text>
      ))}
    </g>
  );
}

const KEY: Array<[MarkState, string]> = [
  ["active", "Working"],
  ["succeeded", "Passed"],
  ["failed", "Failed"],
  ["waiting", "Waiting"],
  ["human", "A person"],
];
/** Live and replay: the conditions the simulation never has, in a second column. */
const LIVE_KEY: Array<[MarkState, string]> = [
  ["interrupted", "Interrupted"],
  ["stale", "As last seen"],
  ["unknown", "Not known"],
];

function hhmm(t: number): string {
  const d = new Date(t);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/**
 * Three lines, joined by newlines (so the store selector returns a string and the sheet re-renders
 * only when they change): the heading, the project and wave, and what the drawing is (its source and
 * how complete its history is).
 */
function titleOf(log: SceneLog, t: number, connection: string | null): string {
  const defs = log.definitions;
  const sim = log.provenance.source === "simulation";
  if (sim) {
    const wave = Object.values(defs.waves)[0];
    return [wave ? wave.title : defs.project.name, `${defs.project.name} · ${wave?.id ?? ""} · ${wave?.epicId ?? ""} ${wave?.epicTitle ?? ""}`, "Factory Atlas · plant in 2:1 axonometric · simulation"].join("\n");
  }
  const head = log.head();
  const waves = Object.values(head.waves).sort((a, b) => a.discoveredAt - b.discoveredAt);
  const wave = waves[waves.length - 1];
  const project = head.project.name || head.project.id || log.provenance.origin || "Project not recorded";
  const heading = wave ? (wave.meta.unknown.includes("title") ? wave.id : wave.title) : project;
  const waveLine = waves.length === 0 ? "no wave received yet" : waves.length === 1 ? wave!.id : `${waves.length} waves, latest ${wave!.id}`;
  const c = log.sceneAt(t).completeness;
  const complete = c.state === "complete" ? "" : c.state === "reconstructed" ? ` · reconstructed from a snapshot${c.since !== null ? ` at ${hhmm(c.since)}` : ""}` : ` · partial history${c.since !== null ? ` since ${hhmm(c.since)}` : ""}`;
  return [heading, `${project} · ${waveLine}`, `Factory Atlas · ${log.provenance.label.toLowerCase()}${connection ? `, ${connection}: as last seen` : ""}${complete}`].join("\n");
}

/** Key to the marks and the flow arrow, upper right, right-aligned to x. */
function Key({ x, y, live }: { x: number; y: number; live: boolean }) {
  const w = 230;
  const x0 = x - w;
  // The flow arrow: plan +x projected, i.e. down and to the right on the sheet.
  const a = project({ x: 0, y: 0 });
  const b = project({ x: 34, y: 0 });
  const c = project({ x: 0, y: 34 });
  const ox = x0 + 40;
  const oy = y + 4;
  return (
    <g>
      <g transform={`translate(${ox} ${oy})`}>
        <path d={`M${a.x} ${a.y}L${round(b.x)} ${round(b.y)}`} style={{ stroke: "var(--mach-ink)", strokeWidth: 1.5 }} />
        <path d={`M${round(b.x)} ${round(b.y)}l-7 -0.8l3 4.6z`} style={{ fill: "var(--mach-ink)" }} />
        <path d={`M${a.x} ${a.y}L${round(c.x)} ${round(c.y)}`} style={{ stroke: "var(--mach-ink-subtle)", strokeWidth: 1, strokeDasharray: "2 2" }} />
        <text x={round(b.x) + 4} y={round(b.y) + 10} style={{ fill: "var(--mach-ink)", fontSize: 9, fontWeight: 700, letterSpacing: "0.08em" }}>
          FLOW
        </text>
        <text x={round(c.x) - 4} y={round(c.y) + 10} textAnchor="end" style={{ fill: "var(--mach-ink-subtle)", fontSize: 8.5, letterSpacing: "0.06em" }}>
          CELLS
        </text>
      </g>
      {KEY.map(([state, label], k) => (
        <g key={state} transform={`translate(${x0 + 150} ${y + 2 + k * 15})`}>
          <StateMark state={state} r={4.5} />
          <text x={10} y={3.5} style={{ fill: "var(--mach-ink-muted)", fontSize: 10 }}>
            {label}
          </text>
        </g>
      ))}
      {live
        ? LIVE_KEY.map(([state, label], k) => (
            <g key={state} transform={`translate(${x0 + 150} ${y + 2 + (KEY.length + k) * 15})`}>
              <StateMark state={state} r={4.5} />
              <text x={10} y={3.5} style={{ fill: "var(--mach-ink-muted)", fontSize: 10 }}>
                {label}
              </text>
            </g>
          ))
        : null}
      {(["fable", "opus", "sonnet", "haiku"] as const).map((tier, k) => (
        <g key={tier} transform={`translate(${x0 + 14 + k * 20} ${y + 58})`}>
          <AgentHead tier={tier} fill={fc("plate-top")} stroke={fc("ink")} />
        </g>
      ))}
      <text x={x0 + 4} y={y + 76} style={{ fill: "var(--mach-ink-subtle)", fontSize: 8.5 }}>
        Fable · Opus · Sonnet · Haiku
      </text>
    </g>
  );
}
