# MACH: working on this repository

MACH is an agentic software factory that runs in Claude Code. This repository is its source:
Python stations in `skills/*/scripts`, agent definitions in `agents/`, a belt workflow in
`workflows/`, two Go programs in `apps/` (Product Studio's host and the Factory Floor's
observer), and a pnpm workspace in `web/`.

## Where things are written down

- What MACH does, station by station: `docs/BLUEPRINT.md`. Read the section for the area you
  are changing, not the whole file.
- How each station behaves: its `skills/<station>/SKILL.md`. Where it and the blueprint
  differ, the skill is right.
- Where the work stands and what is next: `docs/mach-next/NEXT.md`. Read it first in a new session, and keep it current.
- What was built in each milestone, and how far it was tested: `docs/mach-next/`.
- How the two apps should look and read: `docs/mach-next/STYLE_GUIDE.md`.

When a change alters what MACH does, update the matching section of `docs/BLUEPRINT.md`.

## Commands

- All Python tests: `make test`. One area: `python3 tests/in_parallel.py <name>`.
  Slowest classes: `python3 tests/in_parallel.py --slowest 20`.
- While working: `make test-changed` runs only the classes this branch's changes can affect
  (`python3 tests/affected.py --list --why` says which and why). The whole suite runs before a merge.
- Manifests: `make validate`. Both: `make check`.
- Go: `go test ./...` in `apps/studio` and in `apps/observer`.
- Web, from `web/`: `pnpm typecheck`, `pnpm lint`, `pnpm build`;
  one app's unit tests: `pnpm --filter @mach/product-studio test`.

## Two kinds of rules, kept apart

The blueprint's invariants bind the Factory's own agents inside a project where MACH is
installed. They describe the product. They are not instructions for changing this repository.
