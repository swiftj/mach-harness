# Product Studio end-to-end suites

The real app in a real Chromium, the real Go host (`apps/studio`) and the real engine
(`skills/product-studio/scripts/studio.py`), driven together. Fixtures are not used anywhere here.

Every run builds the host with the app embedded in a scratch folder (the app's own `dist/` and the
committed placeholder in `apps/studio/internal/webui/dist` are never touched), then for each suite
creates a throwaway world and removes it afterwards:

- a local bare repository as the shared remote, an engineer's clone with MACH scaffolded
  (`bin/mach scaffold`, committed and pushed), and the product manager's clone;
- a stand-in `gh` first on `PATH` (`fakes/gh.py`, the stand-in from
  `tests/test_mach_product_collab.py` plus a log of every call's full argument vector);
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
| Lifecycle | `node --test --test-reporter=spec web/e2e/suites/lifecycle.test.mjs` | The acceptance path through the UI only: one-time URL, vision and outcomes, epic (approve), slice, interview, engine check, approve slice, wave (approve), send (exactly one PR request to the stand-in `gh`, on `product/WAVE-001`, only `product/` and `specs/slices/` files), review states, land upstream and refresh, the Shared project view, a conflicting upstream change reconciled in Decisions. After every step the engine's state on disk (`studio.py status`, `slice check`, `feedback`) is compared with the screen. Ends by checking no outside request, no CSP violation, no `.factory/local/`, and a byte-identical PM checkout. |
| Conformance | `node --test --test-reporter=spec web/e2e/suites/conformance.test.mjs` | The same 24 operations through `studio.py` directly and through the host API leave identical `.factory/studio/draft/` trees and `status`; the host's reports equal the engine's own `--app` reports; the pull requests match. Every allowlisted op answers with the envelope; nothing outside the allowlist is reachable. |
| Security | `node --test --test-reporter=spec web/e2e/suites/security.test.mjs` | Cookie, Host, Origin, CSRF and Content-Type checks; the one-time token; loopback-only binding (lsof, LAN addresses, `::1`); draft-route traversal, bad names and symlinks; CSP on every response, no outside request; no credential readable by the page or present in any response or log; nothing can enable the Factory or write `.factory/local/`; the interviewer's allow/deny rules; `factory_authorized: false`; a byte-identical checkout. |
| Accessibility and visuals | `node --test --test-reporter=spec web/e2e/suites/a11y.test.mjs` | axe (WCAG 2.2 AA tags) on every route with real data in light and dark; no horizontal overflow at 1440x900 and 1100x800; a keyboard-only pass of the main path (skip link, tab order, visible focus, dialogs trap focus, one Escape closes, focus returns); reduced motion. |
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
fakes/gh.py         the stand-in gh
fakes/claude.py     the scripted stand-in claude
lib/env.mjs         paths; Playwright and axe resolved from apps/product-studio
lib/build.mjs       vite build + go build in a scratch folder, with build.sh's CSP refusals
lib/world.mjs       the throwaway world: remote, clones, stand-ins, engine calls, checkout snapshot
lib/host.mjs        starts the host; raw HTTP with full header control; an API client like the app's
lib/app.mjs         a watched page (console, CSP, outside requests, API failures), screenshots, steps
lib/content.mjs     a valid spec and why (the repository's fixture)
lib/seed.mjs        a project with something on every screen, built through the engine
suites/*.test.mjs   the suites (node:test)
```
