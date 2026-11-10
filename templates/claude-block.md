## MACH software factory

This project is built with MACH (Multi-Agent Construction Harness). Work moves through stations, one ticket at a time: ticket → intent → build → verify → review → merge → cleanup. The stations are skills named `mach-<station>` (`/mach:<station>` when MACH is installed as a plugin).

Rules for every agent working here:

1. **Never work on the main checkout.** Each ticket has a cell at `.factory/worktrees/<ticket_id>/`. Its `repo/` folder is a git worktree on the branch `feature/<ticket_id>`; all code, contracts and the slice spec are written there.
2. **Follow the artifact chain.** `intent.md` (why) → `spec.md` and `spec.json` (what) → contracts → `plan.md` (how), all in the cell folder. `spec.json` is the source of truth for behavior; if code and spec disagree, the code is wrong or the spec needs a new grooming pass. Never edit the spec to match the code.
3. **Tests first.** No implementation is written until a failing test for it exists. Every test traces to a requirement ID (`FR-NN`, `INV-NN`), a decision matrix rule (`RN`) or a scenario (`AC-NN`) in the spec.
4. **No self-certified completion.** Work is done when the verify station has produced evidence in the cell's `evidence/` folder, not when its author says so.
5. **Fresh-context review, three rounds at most.** Reviewers never share context with the builder. After a third failed round of verification or review the ticket is labelled `blocked-requires-sme` and a person decides.
6. **Contracts are boundaries.** Contract files (`proto/`, OpenAPI, schemas) change only additively, and any change to them makes the ticket High risk. See `REVIEW.md`.

Where things are: tickets in `.factory/tickets/`, slice specs in `specs/slices/`, factory settings in `.factory/config.json`, review rules in `REVIEW.md`, agent roles in `AGENTS.md`. Run `make mach-status` to see the open cells.
