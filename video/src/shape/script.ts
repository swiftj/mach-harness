import assets from "../assets.json";
import { FPS } from "../theme";
import { NARRATION } from "./narration";

/** Seconds of music before the first word, and after the last. */
export const LEAD = 2.4;
export const TAIL = 4.5;
export const SCENES = NARRATION.map(([id]) => id);
export type SceneId = (typeof NARRATION)[number][0];

type Line = { start: number; end: number };
const film = (assets.audio as unknown as { shape?: { narration: number | null; music: number | null; lines: Line[] } }).shape ?? { narration: null, music: null, lines: [] };
// Used until the narration exists, so the film can be previewed without it.
const FALLBACK = [7, 15, 15, 14, 14, 15, 14, 16, 10, 6];
const lines: Line[] = film.lines.length === SCENES.length ? film.lines
  : FALLBACK.reduce<Line[]>((all, d) => { const s = all.length ? all[all.length - 1].end + 1.2 : 0.3; return [...all, { start: s, end: s + d }]; }, []);

/** Each scene runs from the middle of the pause before its line to the middle of the pause after it. */
export const cuts = SCENES.map((id, i) => {
  const from = i === 0 ? 0 : LEAD + (lines[i - 1].end + lines[i].start) / 2;
  const to = i === SCENES.length - 1 ? LEAD + lines[i].end + TAIL : LEAD + (lines[i].end + lines[i + 1].start) / 2;
  const fromF = Math.round(from * FPS);
  return { id, from: fromF, frames: Math.round(to * FPS) - fromF, voiceAt: Math.round((LEAD + lines[i].start) * FPS) - fromF, voiceLen: Math.round((lines[i].end - lines[i].start) * FPS) };
});
export const TOTAL = cuts[cuts.length - 1].from + cuts[cuts.length - 1].frames;
export const hasNarration = film.narration !== null;
export const hasMusic = film.music !== null;

/**
 * The frame, within a scene, at which the voice reaches a phrase of that scene's line.
 * Estimated from where the phrase sits in the line's text, so on-screen words follow the voice
 * whatever length the generated line turns out to be.
 */
export const cueFor = (id: SceneId, voiceAt: number, voiceLen: number) => (phrase: string) => {
  const text: string = NARRATION.find(([n]) => n === id)![1];
  const i = text.indexOf(phrase);
  if (i < 0) throw new Error(`"${phrase}" is not in the ${id} line`);
  return voiceAt + Math.round((voiceLen * i) / text.length);
};
