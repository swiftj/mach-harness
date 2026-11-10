# AGENTS.md: who does what in the MACH factory

Each station runs as its own agent with its own context, model tier and permissions. Model names are Claude Code aliases, set in `.factory/config.json` under `models`; change them there, not here.

| Station | Skill | Role | Model tier | May write |
|---------|-------|------|------------|-----------|
| Ticket | `mach-ticket` | Fetches and normalizes tickets and telemetry; updates ticket state | `utility` | `.factory/inbox/`, `.factory/tickets/` |
| Audit | `mach-audit` | Scores whether the repository is ready for autonomous work | `build` | `.factory/audit-report.json` |
| Intent | `mach-intent` | Interviews the product owner; writes `intent.md` and the slice spec | `planning` | the cell folder; `specs/slices/` in the cell's checkout |
| Intent, stage 2 | `mach-contract-engineer` agent | Derives contracts and `plan.md` from the spec | `contracts` | contract files in the cell's checkout; `plan.md` |
| Build | `mach-build`, `mach-builder` agent | Test-first implementation, following `plan.md` | `build` | the cell's checkout only |
| Verify | `mach-verify`, `mach-verifier` agent | Runs the built slice and captures evidence, in a fresh context | `build` | the cell's `evidence/` only |
| Review | `mach-review`, `mach-reviewer` agent per seat | Independent reviewers submit findings against `REVIEW.md`; a script tallies | `contracts` for High risk, `build` otherwise | the cell's `review/` only |
| Cleanup | `mach-cleanup` | Archives a finished cell, removes its worktree and branch, writes the run record | `utility` | `.factory/archive/`; removes cells |
| Observe | `mach-observe` | Measures finished tickets, finds recurring defects, and proposes rule changes for a person to approve | `planning` | `.factory/observations/` only; proposals become `factory-tuning` tickets |

## Rules that apply to every agent

- An agent writes only where its row says. Nothing writes to the main checkout.
- An agent never grades its own work: builders do not verify, verifiers do not review.
- An agent that finds the spec wrong or contradictory stops and reports a spec defect; it does not patch the spec or guess.
- Every agent is given the ticket's goal ancestry from `intent.md`, so a small task is always done in view of what it serves.
- Agents load tool descriptions and reference files only when they need them, to keep their context small.

`python3 .factory/bin/mach status` shows which skills are installed in this project.
