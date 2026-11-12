# MACH Control Tower, M6.0: the Living Factory (`@mach/control-tower`)

**This app is a simulation.** It plays one deterministic, recorded run of the MACH Factory (one delivery wave of five slices, 2,126 events over 55:50 of factory time) from a fixture compiled into the bundle. It reads no Factory state, starts nothing, makes no network request, and is labelled "Simulation" on every screen.

It is the visual-experience prototype for the Control Tower: two modes of the same run, the **Factory Atlas** (the plant in axonometric) and the **Execution Blueprint** (the run as an engineering sheet), with a synchronized timeline, a contextual inspector and Theater Mode.

## Run

From `web/`:

```sh
pnpm install
pnpm --filter @mach/control-tower dev        # http://127.0.0.1:4176
```

The development server binds `127.0.0.1:4176` only (`vite.config.ts`, `strictPort`). Two single-view development entries are also served, outside the shell: `/dev/atlas.html` and `/dev/blueprint.html`.

## Build, preview, test

```sh
pnpm --filter @mach/control-tower build      # tsc, then vite build into dist/
pnpm --filter @mach/control-tower preview    # serves dist/ on 127.0.0.1:4176
pnpm --filter @mach/control-tower typecheck
pnpm --filter @mach/control-tower test       # node --test test/*.test.mjs, no browser, no dependencies
```

The 70 tests cover the simulation and the store: the scenario against MACH's own rules, the reducer's determinism, scrubbing, the clock, the capture hook, that nothing is shown before it happens (`test/no-early-outcomes.test.mjs`), and the inspector's time and review-tally wording (`test/inspector-wording.test.mjs`). From `web/`, `pnpm lint`, `pnpm typecheck` and `pnpm build` check the whole workspace.

## Capture and record

Screenshots and recordings are made by the scripts in `scripts/`, which build the app with `vite build --mode capture` (the production build plus the development hook below), serve it locally under the M5 Content-Security-Policy, and drive it on the manual clock so every frame is a function of the playhead. How to run them, and what each output shows:

- `screenshots/README.md`
- `recordings/README.md`

The package's `capture` script (`pnpm --filter @mach/control-tower capture`) runs `scripts/capture.mjs`; see the two READMEs for the others. Outputs in `screenshots/` and `recordings/` are git-ignored except their READMEs.

**The current outputs are not of the final build.** The screenshots were taken after the change to an all-sans typeface but before the last round of Blueprint, Atlas and shell fixes and before the light layer was removed (so the help-sheet shots still show its switch). The recordings are older still: they pre-date the typeface change and show the former serif. They were not re-captured; the product owner chose to review the app by hand. Details in each folder's README.

## URL parameters

Main app (`/`):

| Parameter | Effect |
|---|---|
| `?theme=light` or `?theme=dark` | Pin the theme (default: follow the system; the Control Tower's own default is dark) |
| `#atlas`, `#blueprint` | The mode. Kept in step with the app |
| `#blueprint?sel=cell:LOCAL-031` | Select an entity (any `EntityRef`, such as `gate:LOCAL-032/human-approval`) and frame it. Kept in step with the app |
| `#atlas?theater=1` | Open in Theater Mode |

Development entries (`/dev/atlas.html`, `/dev/blueprint.html`): `?theme=`, `?t=<factory ms>` (seek), `?play=<speed>` (play at that speed), `?meter` (frame-time meter). In the main app's development build, `?meter` shows the Atlas's frame meter.

## Development hook

In development and capture builds only (never in a production build), `window.__machSim` drives the app:

```js
const sim = window.__machSim;
sim.duration; sim.eventCount; sim.chapters;    // chapters: [{ id, title, t, seq }]
sim.seek(t); sim.seekToSeq(seq); sim.seekToChapter("human-gate"); sim.step(n);
sim.play(); sim.pause(); sim.setSpeed(4);      // 0.5, 1, 2, 4, 8, 16
sim.select("cell:LOCAL-031"); sim.focus("overview");
sim.setMode("blueprint"); sim.setTheater(true); sim.setFollow(true); sim.followLive();
sim.state();                                   // playhead, liveAt, following, playing, speed, view, selection, follow, clock, ...
sim.useManualClock(); sim.advance(1000 / 30); sim.useLiveClock();   // frame-exact rendering
```

The full reference is `src/sim/README.md`, section 6. The Atlas also exposes `window.__atlasCamera` (`get`, `set`, `zoomTo`, `fit`, `follow`, `lod`) in the same builds.

## Keyboard

Generated from `src/shell/keyboard.ts` (`KEYMAP`); `?` shows it in the app.

| Keys | Action |
|---|---|
| `Space` | Play or pause |
| `,` / `.` | Previous / next event |
| `Shift+,` / `Shift+.` | Back / forward 10 s of factory time |
| `[` / `]` | Previous / next chapter |
| `{` / `}` | Slower / faster (0.5× to 16×) |
| `Home` / `End` | Start of the run / live edge |
| `L` | Return to live (and follow) |
| `1` / `2` | Factory Atlas / Execution Blueprint |
| `T` | Theater Mode |
| `F` | Focus the selection |
| `Shift+F` | Camera follow back on |
| `Escape` | Clear highlight, then selection, then leave Theater Mode |
| `I` | Show or hide the inspector |
| `Shift+T` | Expand or collapse the timeline |
| `?` | This list |

In either view (Atlas or Blueprint focused):

| Keys | Action |
|---|---|
| `+` / `-` / `0` | Zoom in / out / fit |
| `Shift+Arrows` | Pan |
| `Enter` / `Space` | Select the focused entity |

Atlas:

| Keys | Action |
|---|---|
| `Arrows` | Move to the nearest entity in that direction on screen |

Blueprint (an ARIA tree):

| Keys | Action |
|---|---|
| `↑` / `↓` | Previous / next visible item |
| `→` | Open the item, or move into it |
| `←` | Close the item, or move out to its parent |
| `Alt+→` / `Alt+←` | Open / close without moving |
| `Home` / `End` | First / last item |
| `*` | Open every sibling of the focused item (on a lane: every lane of the wave) |

Timeline:

| Keys | Action |
|---|---|
| `←` / `→` | Previous / next event (playhead or tracks focused) |
| `PageUp` / `PageDown` | Previous / next chapter (playhead focused) |
| `↑` / `↓` | Previous / next track (tracks focused) |
| `Enter` | Select the focused track's entity |
| `Alt+→` / `Alt+←` | Expand / collapse the focused track (`*` also expands) |
| `+` / `-` / `0` | Narrow / widen the time window, or show the whole run (tracks focused) |
| `↑` / `↓` | Taller / shorter timeline (its top edge focused; `Enter` collapses or restores it) |

Each view is one tab stop; arrow keys move inside it. The Tab order is skip link, top bar, the view, the inspector, the timeline.

## Rendering choices

- **SVG only.** The brief asked for a WebGL light-layer experiment. It was built on PixiJS 8 and measured, then rejected: its glow sat above the whole drawing (covering machines, agents and text), it cost about 0.8 ms per frame, and as decoration it could carry no information the drawing did not already have. It was removed with the PixiJS dependency on the product owner's decision on 2026-11-12 (commit "chore(control-tower): remove the WebGL light layer experiment and the PixiJS dependency"). The code is in Git history if a WebGL renderer is ever wanted, most plausibly for scale (many more cells than SVG can hold), which was never measured.
- **React Flow is installed but not used.** `@xyflow/react` stays a dependency on the product owner's decision; the Blueprint is one hand-drawn SVG. It is to be considered for future features where it adds real value (editing a graph, free-form layouts, very large graphs), not adopted by default.

Both are explained in `docs/mach-next/M6_0_ARCHITECTURE.md` section 6.

## Documents

| Document | What it holds |
|---|---|
| `docs/mach-next/M6_0_CONTRACT.md` | The rules the prototype was built to |
| `docs/mach-next/M6_0_ARCHITECTURE.md` | How the scenes are built and drawn, the tradeoffs, and the path to production |
| `docs/mach-next/M6_0_VISUAL_SPEC.md` | The visual grammar, camera and interaction, rendering recommendation |
| `docs/mach-next/M6_0_TELEMETRY_GAPS.md` | What the real Factory records today and what it would need to emit |
| `docs/mach-next/M6_0_FINDINGS.md` | Review findings and captured evidence |
| `src/sim/README.md` | The simulation's API, event model, store, scenario and storyboard |
