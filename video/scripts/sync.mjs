// Records which clips and narration exist, with their lengths, so the film never guesses.
//   node scripts/sync.mjs
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const seconds = (file) =>
  Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }).trim());

const footage = {};
const dir = join(root, "public/footage");
if (existsSync(dir)) for (const name of readdirSync(dir).filter((n) => n.endsWith(".mp4")).sort()) footage[name.replace(/\.mp4$/, "")] = Number(seconds(join(dir, name)).toFixed(2));

// The narration's cue sheet gives each line's start and end; one line per scene, in order.
const audio = { narration: null, music: null, lines: [] };
const cues = join(root, "public/audio/narration.cues.json");
if (existsSync(join(root, "public/audio/narration.mp3"))) audio.narration = Number(seconds(join(root, "public/audio/narration.mp3")).toFixed(2));
if (existsSync(join(root, "public/audio/music.mp3"))) audio.music = Number(seconds(join(root, "public/audio/music.mp3")).toFixed(2));
if (existsSync(cues)) {
  const sheet = JSON.parse(readFileSync(cues, "utf8"));
  const lines = sheet.timeline ?? sheet.lines ?? sheet.cues ?? [];
  audio.lines = lines.map((l) => ({ start: l.start, end: l.end }));
}
// The companion films (the factory, and shape: from idea to proof) each have their own voice and music.
const film = (name) => {
  const out = { narration: null, music: null, lines: [] };
  const voice = join(root, `public/audio/narration-${name}.mp3`), bed = join(root, `public/audio/music-${name}.mp3`), sheet = join(root, `public/audio/narration-${name}.cues.json`);
  if (existsSync(voice)) out.narration = Number(seconds(voice).toFixed(2));
  if (existsSync(bed)) out.music = Number(seconds(bed).toFixed(2));
  if (existsSync(sheet)) out.lines = (JSON.parse(readFileSync(sheet, "utf8")).timeline ?? []).map((l) => ({ start: l.start, end: l.end }));
  return out;
};
audio.factory = film("factory");
audio.shape = film("shape");
writeFileSync(join(root, "src/assets.json"), JSON.stringify({ footage, audio }, null, 2) + "\n");
console.log(JSON.stringify({ footage, audio }, null, 2));
