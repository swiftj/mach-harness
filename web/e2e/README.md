# Product Studio end-to-end suites

The real app in a real Chromium, the real Go host (`apps/studio`) and the real engine
(`skills/product-studio/scripts/studio.py`), driven together. Fixtures are not used, except by the two request suites (below).

Every run builds the host with the app embedded in a scratch folder (the app's own `dist/` and the
committed placeholder in `apps/studio/internal/webui/dist` are never touched), then for each suite
creates a throwaway world and removes it afterwards:

- a local bare repository as the shared remote, an engineer's clone with MACH scaffolded
  (`bin/mach scaffold`, committed and pushed), and the product manager's clone, which reaches the
  remote through a `github.com` address (`url.<remote>.insteadOf`), as the engine's own tests do;
- a stand-in `gh` first on `PATH`: the Python suite's stand-in for GitHub issues (`FAKE_GH` in
  `tests/test_mach_product_issues.py`, copied out at run time as `gh-issues`, never edited here),
  which keeps issues, labels, comments and sub-issues in a file, wrapped by `fakes/gh.py`, which
  adds a lock and a log of every call's full argument vector;
- a scripted stand-in `claude` first on `PATH` (`fakes/claude.py`) that answers the host's
  capability probes and plays interview turns in the stream-json shapes the host parses: a parsed
  question, then a turn that writes a complete, valid spec and why into the draft and runs the
  engine's own `slice resume` / `slice check --ready`, as the real interviewer does;
- Git configuration isolated from yours (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`).

The host is started with `--no-open` on an ephemeral `127.0.0.1` port. Nothing reaches GitHub, the
network, or the Factory.

## Requirements

Node 22+, Go, Python 3, Git, pnpm, and the web workspace installed (`pnpm install` in `web/`).
Playwright and axe are the versions `apps/product-studio` already pins as dev dependencies; this
folder resolves them from there, so it is not a pnpm workspace package and adds no dependency.
Chromium must be installed for that Playwright (`pnpm --filter @mach/product-studio exec playwright install chromium`).

## Running

From the repository root (or `cd web/e2e && npm run <name>`):

| Suite | Command | What it proves |
|-------|---------|----------------|
| Lifecycle | `node --test --test-reporter=spec web/e2e/suites/lifecycle.test.mjs` | The acceptance path through the UI only: one-time URL, vision and outcomes, epic (approve), slice, interview, engine check, "Mark ready to build" (exactly one slice issue under one epic issue, labelled ready, and the issue link the engine returned), the builders take it and a refresh shows "Being built", reopen (ready comes off the issue; the engine's note is shown), someone else saves a newer version and the PM takes theirs in Decisions, then marks it ready again (the same issue, version 2). Then the builders ask a question: it is quoted in Decisions, and "Answer it" reopens the slice and the interview's opening turn says, in the host's fixed words and never the question's, that `slice resume` carries it. After every step the engine's state on disk (`studio.py status`, `slice check`) and the stand-in's issues are compared with the screen. Ends by checking no outside request, no CSP violation, no `.factory/local/`, and a byte-identical PM checkout. |
| Conformance | `node --test --test-reporter=spec web/e2e/suites/conformance.test.mjs` | The same 26 steps through `studio.py` directly and through the host API (including marking ready, the builders' label, reopening, a newer version taken, marking ready again) leave identical `.factory/studio/draft/` trees and `status`; the host's reports equal the engine's own `--app` reports; the issues each saved on GitHub match. Every allowlisted op answers with the envelope; nothing outside the allowlist is reachable, including the engine's leftover commands (`slice.approve`, waves, `send`, `feedback`, acceptance). |
| Security | `node --test --test-reporter=spec web/e2e/suites/security.test.mjs` | Cookie, Host, Origin, CSRF and Content-Type checks; the one-time token; loopback-only binding (lsof, LAN addresses, `::1`); draft-route traversal, bad names and symlinks; CSP on every response, no outside request; no credential readable by the page or present in any response or log; nothing can enable the Factory or write `.factory/local/`; the interviewer's allow/deny rules; `factory_authorized: false`; a byte-identical checkout. |
| Accessibility and visuals | `node --test --test-reporter=spec web/e2e/suites/a11y.test.mjs` | axe (WCAG 2.2 AA tags) on every route with real data in light and dark; no horizontal overflow at 1440x900 and 1100x800; a keyboard-only pass of the main path (skip link, tab order, visible focus, dialogs trap focus, one Escape closes, focus returns); reduced motion. |
| Requests (fixture mode) | `node --test --test-reporter=spec web/e2e/suites/requests.test.mjs web/e2e/suites/requests-text.test.mjs` | The exception to "no fixtures": GitHub issue requests (M8 D8) depend on who marked an issue and with what permission, which the stand-in cannot vouch for, so these two build the app with `vite build --mode fixtures` into a scratch folder and serve it from 127.0.0.1 (`lib/fixtures.mjs`), with no host or engine. Every request state and its buttons, pick-up read back from the list, a refusal in the engine's words, axe in light and dark; and a hostile request body (script, event handler, `javascript:` link, a fence line, 20,000 characters) served without the CSP is one text node, ran nothing, and appears in no attribute, title, address or storage. DOM checks only, no screenshots. |
| Project home and interview (fixture mode) | `node --test --test-reporter=spec --test-concurrency=1 web/e2e/suites/home.test.mjs` (`npm run home`) | The app built in fixture mode, like the request suites: the project home's epics and slices with the builders' states (ready to build, being built, question, shipped, changed on GitHub) and issue numbers, the row of links above the carry-on action ("Add an epic" opens its dialog in place), per-epic "ready or further" counts, each slice's time as words with the exact time on hover and keyboard focus, "Everything is saved" or what is not in the top bar, the builders' question quoted in Decisions and on the slice with "Answer it" reopening it into its interview, each epic's slices in the engine's order with Move up and Move down (and "Finish the move"), "Open it here" for a slice someone else saved (and a refusal with its hint), the notice leading to Decisions, a newer version and a taken number settled in Decisions, every secondary screen reached from "More" and from the row and back, the "More" menu by keyboard, axe in light and dark; the interview's layout, the "Mark ready to build" offer with its dialog and the issue link, the folder result with the engine's two ways on, and the "New" marks. |
| Real interview (opt-in, spends money) | `E2E_REAL_CLAUDE=1 node --test --test-reporter=spec web/e2e/suites/interview-real.test.mjs` | Your real, signed-in `claude`: start, one real parsed question, answer, the next message, stop. Uses only the host's documented `--budget-per-turn` (default 0.30) and `--model` (default `sonnet`) to bound spend; override with `E2E_REAL_BUDGET` / `E2E_REAL_MODEL`. Skipped without the variable. |

All four default suites in one go: `cd web/e2e && npm run all`.

| Variable | Meaning |
|----------|---------|
| `E2E_BINARY` | Reuse a host binary instead of building one per suite: `export E2E_BINARY=$(node web/e2e/build.mjs)`. |
| `E2E_SCRATCH` | Where the scratch worlds and builds go (default: the system temporary folder). |
| `E2E_KEEP=1` | Keep each world after the run, for inspection. |
| `E2E_PYTHON` | The Python for the engine and the stand-ins (default `python3`). |

Screenshots of every lifecycle step at both sizes, every route in both themes and sizes, and the
axe report go to `web/e2e/screenshots/` (git-ignored). Steps of the lifecycle and keyboard suites
run in order; after a failed step the rest are skipped and a `FAILED-*.png` is saved. Checks named
with a letter (`05b`, `12e`) are findings that do not stop the path.

## Layout

```
build.mjs           builds the host with the app embedded; prints the binary's path
fakes/gh.py         the stand-in gh: a lock and a call log around the Python suite's issues stand-in
fakes/claude.py     the scripted stand-in claude
lib/env.mjs         paths; Playwright and axe resolved from apps/product-studio
lib/build.mjs       vite build + go build in a scratch folder, with build.sh's CSP refusals
lib/world.mjs       the throwaway world: remote, clones, stand-ins, engine calls, GitHub changes by others, checkout snapshot
lib/host.mjs        starts the host; raw HTTP with full header control; an API client like the app's
lib/app.mjs         a watched page (console, CSP, outside requests, API failures), screenshots, steps
lib/content.mjs     a valid spec and why (the repository's fixture)
lib/seed.mjs        a project with something on every screen, built through the engine
lib/fixtures.mjs    the app built in fixture mode and served from 127.0.0.1 (request suites only)
suites/*.test.mjs   the suites (node:test)
```
