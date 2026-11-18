# MACH Factory Floor (`@mach/factory-floor`)

The Factory Floor is MACH's read-only view of the Factory in the browser. `mach-observer` embeds it (`apps/observer/build.sh`). When an observer answers, it shows the **Live Factory**. With no observer, or with `?simulation`, it shows one recorded run (five slices of one epic, each its own GitHub issue and ticket, 2,129 events over 55:50 of factory time) from a fixture compiled into the bundle, labelled **Simulation** on every screen. The Simulation runs forward on its own and stops at its last moment. The Factory Floor shows only the present: there is no playback, no replay and no playhead. It starts nothing and has no control that changes the Factory. Where a person must act, it shows the `/mach` command to run in Claude Code.

Three workspaces:

- **Line** (the default, `src/line/`): the stations left to right as columns, and a row for each ticket at the station it stands at. A row shows the slice's title, its issue number (as text) and its epic's name where recorded; epic names, like titles, are free text under the session's display policy. A "Needs you" strip on top, a side panel for a ticket or a station, a ticket's full record, and "What just happened" when nothing is selected.
- **Floor** (`src/atlas/`): the Factory Atlas, the plant drawn in axonometric, with the inspector, camera follow and Theater Mode.
- **Analytics** (`src/analytics/`): Factory Analytics, with the inspector on request.

The evidence player (`src/evidence/`) opens over any workspace.

## Run

From `web/`:

```sh
pnpm install
pnpm --filter @mach/factory-floor dev        # http://127.0.0.1:4176
```

The development server binds `127.0.0.1:4176` only (`vite.config.ts`, `strictPort`). Set `MACH_OBSERVER_PORT` to a running observer's port to proxy `/api` to it. Two development pages are also served, outside the shell:

- `/dev/atlas.html`: the Atlas alone on the Simulation.
- `/src/atlas/dev/live.html`: the Atlas on a live store fed by a test fixture (see the comment at the top of `src/atlas/dev/live.tsx`).

## Build, preview, test

```sh
pnpm --filter @mach/factory-floor build      # tsc, then vite build into dist/
pnpm --filter @mach/factory-floor preview    # serves dist/ on 127.0.0.1:4176
pnpm --filter @mach/factory-floor typecheck
pnpm --filter @mach/factory-floor test       # node --test test/*.test.mjs: no browser
```

From `web/`, `pnpm lint`, `pnpm typecheck` and `pnpm build` check the whole workspace.

The browser suites run Playwright's Chromium against the Vite dev server. They build `mach-observer` and `mach-synth` from this working tree with `go build` into a scratch folder, so they need Go. They never run `build.sh`.

```sh
pnpm --filter @mach/factory-floor test:e2e:floor       # the Line over the Simulation; an empty live project
pnpm --filter @mach/factory-floor test:e2e:evidence    # the evidence player, live and simulated
pnpm --filter @mach/factory-floor test:e2e:analytics   # Analytics: proof page, shell, live observer
```

`e2e/journeys-m66.e2e.mjs` is run on its own; its header gives the command.

## Screenshots

`pnpm --filter @mach/factory-floor capture` runs `scripts/capture.mjs`. It builds the app with `vite build --mode capture` (the production build plus the development hook below), serves it with `vite preview` on `127.0.0.1:4186`, opens the Floor and takes screenshots of the Atlas on the Simulation's manual clock. See `screenshots/README.md`. It has not been run since the redesign.

## Addresses

Main app (`/`):

| Address | Effect |
|---|---|
| `?simulation` | Show the Simulation, even when an observer answers |
| `?theme=light` or `?theme=dark` | Pin the theme (default: follow the system) |
| `#line`, `#floor`, `#analytics` | The workspace. Kept in step with the app; a workspace change is a new history entry |
| `?sel=<ref>` after any route, e.g. `#line?sel=cell:131` | Select an entity (any `EntityRef`). The Floor also frames it |
| `#floor?theater=1` | Open the Floor in Theater Mode |
| `#analytics?area=&win=&risk=&app=&model=&station=&cmp=&focus=&pick=` | Analytics' area, period, filters, comparison, open rows and cross-filter (grammar in `src/shell/source/hash.ts`) |
| `evidence=<ticket>&check=<id>` after any route | Open the evidence player for one ticket at one check |

The address never names a moment. Anything it does not recognise is ignored.

In development builds, `?meter` shows the Atlas's frame meter. `/dev/atlas.html` takes `?theme=`, `?meter` and `?t=<factory ms>` (start the Simulation at that moment).

## Development hook

In development and capture builds only (never in a production build), `window.__machSim` holds the Simulation at a moment for tests and screenshots. Nothing in the interface can move the Simulation's moment.

```js
const sim = window.__machSim;            // version 2
sim.duration; sim.eventCount; sim.fixtureId;
sim.seek(t);                             // move the Simulation to scenario time t, either way; it runs on from there
sim.select("cell:131"); sim.focus("overview");
sim.setWorkspace("floor"); sim.setTheater(true); sim.setFollow(true);
sim.state();                             // now, cursor, workspace, theater, selection, follow, focus, reducedMotion, clock
sim.useManualClock(); sim.advance(1000 / 30); sim.useLiveClock();
```

On the manual clock the Simulation moves only through `advance(ms)`. The full reference is `src/sim/README.md`, section 6. The Atlas also exposes `window.__atlasCamera` (`get`, `set`, `zoomTo`, `fit`, `follow`, `lod`) in the same builds.

## Keyboard

From `src/shell/keyboard.ts` (`KEYMAP`); `?` shows the same list in the app.

| Keys | Action |
|---|---|
| `1` | Line |
| `2` | Floor, keeping the selection |
| `3` | Analytics, keeping the selection |
| `Escape` | Clear the highlight, then the selection, then leave Theater Mode |
| `I` | Show or hide the inspector (Floor and Analytics) |
| `?` | The list of keys |
| `S` | Choose the source: Live Factory or Simulation |

On the Line, with a ticket's row focused:

| Keys | Action |
|---|---|
| `↑` / `↓` | Previous / next ticket |
| `Space` | Show the ticket in the side panel |
| `Enter` | Open the ticket's full record (double-click does the same) |

On the Floor:

| Keys | Action |
|---|---|
| `T` | Theater Mode |
| `F` | Frame the selection |
| `Shift+F` | Camera follow back on |
| `+` / `-` / `0` | Zoom in / out / fit (the Atlas focused) |
| `Shift+Arrows` | Pan (the Atlas focused) |
| `Arrows` | Move to the nearest entity in that direction (the Atlas focused) |
| `Enter` / `Space` | Select the focused entity |

In the evidence player: `,` / `.` for the previous / next file, `[` / `]` for the previous / next check.

## Rendering choices

- **SVG and HTML only.** A WebGL light layer on PixiJS 8 was built for the M6.0 brief, measured and rejected: its glow covered machines, agents and text, it cost about 0.8 ms per frame, and it carried no information. It was removed with the PixiJS dependency on the product owner's decision on 2026-11-12. The code is in Git history.
- **React Flow is installed but not used.** `@xyflow/react` stays a dependency on the product owner's decision. Nothing in the app imports it.

`docs/mach-next/M6_0_ARCHITECTURE.md` section 6 has the original reasoning.

## Documents

| Document | What it holds |
|---|---|
| `docs/mach-next/M6_0_CONTRACT.md` | The rules the M6.0 prototype was built to |
| `docs/mach-next/M6_0_ARCHITECTURE.md` | How the scenes are built and drawn (written for M6.0: it still describes playback and the Blueprint) |
| `docs/mach-next/M6_0_VISUAL_SPEC.md` | The Atlas's visual grammar, camera and interaction |
| `docs/mach-next/M6_0_TELEMETRY_GAPS.md` | What the real Factory records today and what it would need to emit |
| `docs/mach-next/M6_0_FINDINGS.md` | Review findings from M6.0 |
| `src/sim/README.md` | The simulation's API, event model, store, scenario and storyboard |
| `src/live/README.md` | The live source: the observer's stream into the scene log |
