# MACH Next — M6.0 working contract: the Living Factory prototype

The shared agreement for everyone building M6.0. Read it before writing anything.

M6.0 is a **visual-experience prototype**, shown for review before the real Control Tower is built. It is a simulation. It reads no Factory state and changes nothing about how the Factory runs.

Baseline: `main` at `fb86441` (MACH 0.12.0), branch `feature/mach-next-m6-living-factory`, worktree `/Users/johnswift/Projects/mach-harness-m6`.

## 1. What is being made

One application, `web/apps/control-tower` (`@mach/control-tower`, dev and preview on `127.0.0.1:4176`), with two modes of the same simulated execution:

- **Factory Atlas**: a spatial, layered 2.5D picture of the factory: production regions, construction cells, agents at work, routes between stations, verification gates, the reviewer fan-out, integration.
- **Execution Blueprint**: a precise graph of the same run: workflow hierarchy, dependencies, stations, agents, tool activity, retries, artifacts.

Around both: a contextual inspector, a synchronized execution timeline with replay scrubbing and live-follow, and Theater Mode.

The bar, from the brief: it must look like a richly detailed autonomous digital factory, not a dashboard and not rectangles joined by lines. No gratuitous particles, random pulsing, heavy neon or game styling. Sophistication and readability count equally.

## 2. The rules that keep it honest

1. **One authority.** The simulation in `src/sim` is the only source of what is happening. The scene at playhead time `t` is a pure function of the fixture's events up to `t`. Atlas, Blueprint, timeline, inspector and any WebGL layer all render that one scene. No renderer keeps progress of its own.
2. **Every animation has an event.** Anything that moves, appears, fills or changes state does so because of a named fixture event, and can be traced to it (the inspector shows the event). Nothing is random: no `Math.random`, no idle shimmer standing in for work. Ambient depth and lighting may exist, but must not read as activity.
3. **Motion is a function of the playhead.** Factory motion (packets, path draws, gate closures, retries) is computed from `t - event.at`, so scrubbing backwards and forwards, pausing, and changing speed all show the right frame. `motion/react` is for interface transitions (inspector, camera easing, mode change), not for factory progress.
4. **Labelled as a simulation**, always on screen, in both modes and in Theater Mode, and in every screenshot and the recording.
5. **Separate from production.** Fixture data and the prototype live only in `web/apps/control-tower`. Nothing under `skills/`, `workflows/`, `agents/`, `apps/studio/`, `bin/` or `tests/` changes. No Factory execution, authorization or dispatch logic is touched, and nothing is started.
6. **Local only.** No network request of any kind at run time, no CDN, no external font or asset. The build must work under the M5 Content-Security-Policy (`script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'`): no inline `<script>`/`<style>`, no `eval`, no `data:` fonts, no blob workers. (Any future WebGL library must meet this too: PixiJS 8, used by the removed light-layer experiment, needed `import "pixi.js/unsafe-eval"` and workers switched off.)
7. **Additive design system.** Use `@mach/ui` tokens, type, themes (`product="control-tower"`), primitives and motion presets. New factory tokens and primitives are added to `@mach/ui`; nothing existing changes meaning. Product Studio must keep building and passing. No hex colours in components (lint enforces tokens). Both themes.
8. **Accessible.** DOM/SVG owns all text and interaction; a WebGL layer, if one is ever added, is decoration only (`aria-hidden`, no pointer events). None exists: the light-layer experiment was removed (`M6_0_FINDINGS.md`, section 1). Everything selectable is reachable and operable by keyboard. Under `prefers-reduced-motion`, state changes are shown without travel or looping motion, and the playhead can still be stepped.

## 3. Vocabulary (use these words and identifiers everywhere)

Real MACH stations, in belt order (see `CLAUDE.md` section 5 and `skills/run/scripts/run.py`): `intake` (product wave to tickets), `groom` and `plan` (intent), `audit`, `build`, `verify`, `review`, `human-approval` (gate), `merge`, `cleanup`, `observe`.

Real agents: `contract-engineer`, `builder`, `verifier`, `reviewer` (seats: architecture, security, product), plus the line supervisor and the scheduler. Model tiers as in `CLAUDE.md` section 2.

Entities: `wave`, `slice`, `ticket`, `cell` (one per ticket, a git worktree), `station`, `agent`, `tool call`, `artifact` (`intent.md`, `spec.json`, contracts, `plan.md`, commits, `build-report.json`, evidence files, `results.json`, votes, `findings.md`, `decision.json`, the merge commit), `gate` (audit gate, red-before-green, verification verdict, review consensus, human approval, merge revalidation), `dependency`.

Lifecycle states of a cell follow the real stages: `interview`, `spec-ready`, `planned`, `building`, `built`, `verified`, `awaiting-human`, `approved`, `pr-open`, `merged`, `blocked`; plus scheduler states for a slice: `waiting-on-dependency`, `eligible`, `dispatched`.

## 4. Events

The fixture is a list of events in the envelope of the real Factory event (`docs/mach-next/schemas/factory-event.schema.json`, version 2): `schema_version`, `seq`, `at`, `type`, `wave_id`, `slice_id`, `ticket_id`, `runner_id`, `execution_id`, `source`, `cause`, `refs`.

- Where a real event kind exists (M3 intake and scheduling, M4 supervisor and executions), the fixture uses it unchanged.
- Where the experience needs something the Factory does not emit today (station progress inside an execution, agent start and stop, tool calls, artifacts written, test results, votes), the simulation owner defines a kind and records it in an **event catalog** with `telemetry: "exists" | "derivable" | "missing"` and where it could come from. That catalog is the input to the telemetry-gap findings.

The scenario must show, each tied to events: one approved delivery wave arriving; three construction cells in parallel; scheduler dependency decisions; a Dynamic Workflow starting; several agents running at once; tool activity and artifacts; a build progressing to success; verification running with test results; one verification failure and return to build; reviewer fan-out with findings; a required human approval; integration of finished work; and a slice blocked by a dependency becoming eligible.

## 5. Who owns what

Nobody edits another owner's files. Need something from one? Ask in your report. **Nobody commits**: the lead verifies and commits. `package.json` files and the lockfile are the lead's; ask if you need a dependency.

| Owner | Files |
|-------|-------|
| Simulation | `web/apps/control-tower/src/sim/**` (event types, catalog, scenario fixture, reducer, selectors), `src/scene/**` (the one store: playback clock, selection, focus target, mode), `test/**` |
| Visual design | `web/packages/ui/src/factory/**`, additive entries in `web/packages/ui/src/tokens/**` and `styles/**`, the showcase section for it, `docs/mach-next/M6_0_VISUAL_SPEC.md` |
| Telemetry | `docs/mach-next/M6_0_TELEMETRY_GAPS.md` (reads code, changes none) |
| Atlas (wave 2) | `src/atlas/**` (`src/effects/**` until the light layer was removed) |
| Blueprint (wave 2) | `src/blueprint/**` |
| Shell (wave 2) | `src/shell/**` (frame, mode switch, timeline, inspector, Theater Mode, keyboard map), `src/App.tsx` |
| Capture (wave 3) | `scripts/**`, `screenshots/`, `recordings/` |

## 6. Done means

`pnpm lint`, `pnpm typecheck` and `pnpm build` pass for the whole `web/` workspace; `pnpm --filter @mach/control-tower test` passes; Product Studio is untouched and still builds; the prototype runs with `pnpm --filter @mach/control-tower dev`. Reports say exactly what was not done or not checked.
