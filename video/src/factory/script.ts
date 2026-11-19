import assets from "../assets.json";
import { FPS } from "../theme";

export const LEAD = 2.4;
export const TAIL = 4.5;
export const SCENES = ["title", "premise", "studio", "engineer", "floor", "proof", "line", "people", "close"] as const;
export type SceneId = (typeof SCENES)[number];

type Line = { start: number; end: number };
const film = (assets.audio as unknown as { factory: { narration: number | null; music: number | null; lines: Line[] } }).factory;
const FALLBACK = [5, 17, 17, 10, 16, 23, 10, 8, 9];
const lines: Line[] = film.lines.length === SCENES.length ? film.lines
  : FALLBACK.reduce<Line[]>((all, d) => { const s = all.length ? all[all.length - 1].end + 1 : 0.3; return [...all, { start: s, end: s + d }]; }, []);

export const cuts = SCENES.map((id, i) => {
  const from = i === 0 ? 0 : LEAD + (lines[i - 1].end + lines[i].start) / 2;
  const to = i === SCENES.length - 1 ? LEAD + lines[i].end + TAIL : LEAD + (lines[i].end + lines[i + 1].start) / 2;
  return { id, from: Math.round(from * FPS), frames: Math.round(to * FPS) - Math.round(from * FPS), voiceAt: Math.round((LEAD + lines[i].start) * FPS) - Math.round(from * FPS) };
});
export const TOTAL = cuts[cuts.length - 1].from + cuts[cuts.length - 1].frames;
export const hasNarration = film.narration !== null;
export const hasMusic = film.music !== null;
