# MACH Next — Architecture & Operating Model (ADR-001)

Status: **Accepted for implementation; experimental until conformance tests pass**

## Product shape

MACH has three *product experiences*, not three separately deployed control planes:

1. **MACH Product Studio** — the PM/technical founder's environment for product vision, epics, progressively elaborated slices, durable interviews/decisions, approval, iterative delivery waves, and safe source-control collaboration. Rich React/TypeScript/Vite SPA, local native Go service; corresponding `/mach:product-studio` skill in Claude Code. No independent orchestration implementation in the skill.
2. **MACH Factory** — existing Claude Code + Dynamic Workflow + deterministic MACH station machinery, extended with a project scheduler, intake ledger, and optional local Factory Supervisor. Extend existing `/mach:run` with management (`factory status|enable|disable|pause|resume`); **no new user-facing CLI**. Execution remains disabled on every new machine until explicitly activated.
3. **MACH Control Tower** — immersive React/TypeScript graph and evidence experience backed by a native Go localhost observer, plus optional Claude Desktop Mod. Observability must not affect execution. A terminal status experience uses the same local state.

**No Go/WASM or single-HTML target**. All production UI assets are locally bundled. Go services expose local loopback only and require origin/session protections. No MACH-hosted backend, remote listener, shared database, or mandatory cloud dependency. Claude model connectivity and opt-in GitHub/GHEC outbound synchronization are allowed.

## Personas are capabilities, not permanent identities

- PM: same project repository cloned to MacBook, uses browser Studio or `/mach:product-studio`, need not learn Git/GitHub CLI or have build toolchains. PM may also be an engineer.
- Engineer/steward: runs Factory/Control Tower, sets limits and accepts escalations. Factory enablement is **local per machine**, stored in ignored runtime state and never transferred by Git.
- Multiple PMs collaborate on a shared Git branch-protected repository, with artifact-level semantic reconciliation and human review on conflicting business decisions.
- Disconnected teams can still exchange versioned `.machpkg` snapshots/updates; not the preferred Git-backed workflow.

## Version-controlled product artifacts vs operational state

Tracked in the project repository:

```text
product/
  project.json
  epics/EPIC-NNN.json
  slices/SLICE-NNN.json
  decisions/DEC-NNN.json                  # phase 2
  delivery-waves/WAVE-NNN.json
specs/slices/SLICE-NNN-short-name.md     # preserve MACH convention
```

Untracked, machine-local:

```text
.factory/local/runner.json               # default off, not SCM-tracked
.factory/observations/                   # live events, replay history
.factory/worktrees/                      # current MACH cells
.factory/tickets/                        # operational ticket queue
```

`product/slices/SLICE-NNN.json` is an **approved work order**; `.factory/tickets/` is the derived, idempotent *operational execution ticket*. Never use the latter as canonical product truth.

## Product Studio collaboration

- PM receives a semantic summary of updates (`Refresh Project`); MACH fetches remote state and safely updates an isolated approved-baseline worktree without resetting personal drafts.
- The PM's product work is continuously saved to workspace-controlled local drafts. New remote approvals never overwrite local edits.
- `Send to Engineering` structurally and semantically validates the selected wave, stages only allowlisted product files in an isolated contribution branch, commits, pushes, and opens a PR. Enterprise GHEC rules, CODEOWNERS, signing and required review are respected, never bypassed.
- PM sees `Waiting for review`, `Changes requested`, `Accepted`, etc., not raw Git commands. `/mach:product-studio` uses exactly the same deterministic collaboration operations.
- Concurrent edits to distinct artifacts may merge. Changes to the same decision or incompatible cross-slice assumptions require explicit PM reconciliation; text merging alone does not confer product approval.

## Studio-to-Factory handoff

1. A delivery wave is approved in Studio and submitted in a PR.
2. The product PR is reviewed and merged into the configured integration branch.
3. On the *enabled* engineer machine, local reconciliation observes the approved integration branch (hooks are **advisory wake-ups**, not authorization or dispatch).
4. The Supervisor verifies trusted baseline, schema, content hashes, dependency DAG, approved slice state, **existing MACH intent validator**, audit readiness, and local policy.
5. Intake writes an idempotent ledger entry keyed by project, wave, source commit and normalized content digest; derives local tickets without duplicating existing work.
6. A deterministic scheduler finds runnable slices, requiring upstream integration rather than merely upstream code generation where declared.
7. Claude Code/Dynamic Workflow carries out the existing MACH stations; the engineer handles escalations, risk approvals, and merge policy as configured.
8. Control Tower projects recorded station events, agent/tool observations, and artifact provenance into an interactive view. Recorded gate results outrank inferred agent activity.

## Factory local activation / autonomy

- Default on **every clone**: `enabled=false`, `paused=false`, `auto_sync=false`.
- User enters `/mach:run factory enable` to opt in after preflight and conscious selection of Observe, Supervised Autopilot, or Extended Autopilot. The initial default is **Observe** for new activations; an engineer may opt into Supervised Autopilot.
- Enablement belongs only to a local machine, not a Git-tracked `product` or shared `.factory/config.json` file. Absence, invalid data, or inaccessible state always means disabled.
- `pause`: drain, no new scheduling. `disable`: revoke authorization, stop background reconciliation/dispatch safely. Separate emergency stop interrupts active work with recoverable records.
- Hooks `post-merge`, `post-checkout`, `post-rewrite` notify if present. Supervisor always reconciles on startup and on explicit refresh; optional polling is opt-in. Hook failure must never fail Git operations.
- Active Factory must never run on a PM machine merely because the PM cloned/pulled project data.
- For initial release, one designated active runner per project. Multi-host execution coordination deferred; local locks cannot coordinate separate laptops.

## Native runtime boundary

- Existing station scripts and validators remain authoritative and Python-based (Python 3.8+ per current MACH).
- New Go local services (Studio, Observer/Supervisor) embed SPA assets and expose HTTP/SSE only on `127.0.0.1` or `::1`, with session token, CSRF/origin enforcement, and DNS-rebinding protection. No wildcard/LAN binding.
- Shared schemas and conformance tests ensure the Go native components and existing Python validators agree on accepted artifacts. Do **not** create a weaker second implementation of intent semantics.
- Claude invocations execute through an explicitly bounded local process bridge using the user's existing approved Claude Code environment, with least privilege and explicit audit events.

## Non-goals for this revision

- Portfolio management, hosted multi-tenant MACH service, automatic bypass of branch protections, hidden skills, Go WebAssembly/single-file HTML, direct PM laptop to engineer laptop network access, and automatic production deployment.
