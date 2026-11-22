# The MACH films

Three short films, built with [Remotion](https://www.remotion.dev): `MachDemo` (the introduction, dark), `MachFactory` (the software factory, light) and `MachShape` (from idea to proof, light). Published at https://youtu.be/M1HSnETFg5Q, https://youtu.be/ejPnwHeqsI8 and https://youtu.be/ehJI7cH6bJs.

Audio, screen footage and renders are git-ignored; this folder holds what makes them.

| Part | Where | How it is made |
|------|-------|----------------|
| Scenes | `src/` | React components in MACH's own colours and typefaces. `src/script.ts`, `src/factory/script.ts` and `src/shape/script.ts` cut each scene to its narration line. |
| Product Studio footage | `capture/studio/capture.mjs` | Testreel, against the end-to-end suite's world: the real host and engine with a stand-in GitHub and a scripted interviewer. |
| Factory Floor footage | `capture/floor/shots.mjs` (dark), `shots-light.mjs` (light) | Chromium's own screen capture of the page's built-in sample factory, which labels itself "Simulation". |
| Voice and music | `public/audio/` | ElevenLabs: `narration.mp3` and `music.mp3` for the introduction, `narration-factory.mp3` and `music-factory.mp3` for the second film, `narration-shape.mp3` and `music-shape.mp3` for the third (its narration text is `src/shape/narration.ts`), each narration with the `.cues.json` its generator wrote (one line per scene). |

## Making a film again

```bash
npm install
npx playwright install chromium
node capture/studio/capture.mjs
node capture/floor/shots.mjs
node capture/floor/shots-light.mjs
node scripts/sync.mjs
npm run render
npm run render:factory
npm run render:shape
```

`scripts/sync.mjs` records which clips and narration exist and how long each is (`src/assets.json`); run it after any capture or new narration. The narration and music must be generated again before a render, since they are not in the repository. Nothing here starts a Factory or a real `claude`.

Remotion is free for individuals and for companies of up to three people; a larger company needs its licence.
