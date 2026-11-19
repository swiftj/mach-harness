import assets from "./assets.json";
import { FPS } from "./theme";

/** Seconds of music before the first word, and after the last. */
export const LEAD = 2.2;
export const TAIL = 4.5;

export const SCENES = ["title", "problem", "interview", "ready", "engineer", "line", "visibility", "analytics", "close"] as const;
export type SceneId = (typeof SCENES)[number];

// Used until the narration exists, so the film can be previewed without it.
const FALLBACK = [6, 11, 24, 10, 12, 19, 13, 10, 4];

type Line = { start: number; end: number };
const lines: Line[] = (assets.audio.lines as Line[]).length === SCENES.length
  ? (assets.audio.lines as Line[])
  : FALLBACK.reduce<Line[]>((all, d) => { const s = all.length ? all[all.length - 1].end + 1 : 0.3; return [...all, { start: s, end: s + d }]; }, []);

/** Each scene runs from the middle of the pause before its line to the middle of the pause after it. */
export const cuts = SCENES.map((id, i) => {
  const from = i === 0 ? 0 : LEAD + (lines[i - 1].end + lines[i].start) / 2;
  const to = i === SCENES.length - 1 ? LEAD + lines[i].end + TAIL : LEAD + (lines[i].end + lines[i + 1].start) / 2;
  return { id, from: Math.round(from * FPS), frames: Math.round(to * FPS) - Math.round(from * FPS), voiceAt: Math.round((LEAD + lines[i].start) * FPS) - Math.round(from * FPS) };
});
export const TOTAL = cuts[cuts.length - 1].from + cuts[cuts.length - 1].frames;
export const footage = assets.footage as Record<string, number>;
export const has = (name: string) => name in footage;
export const hasNarration = assets.audio.narration !== null;
export const hasMusic = assets.audio.music !== null;
