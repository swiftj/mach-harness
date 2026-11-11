# MACH Next — Incremental Delivery Plan

Suggested branch: `feature/mach-next-product-studio-supervisor`. Keep `main` untouched and use small independently revertible commits. First milestone is intentionally **non-executing**.

## M0 — Contracts and guardrails (included in this starter)

- Define product / epic / slice / wave schema v1 with stable IDs and monotonic revisions.
- Add structural validator with SHA-256 binding, dependency graph checking, safe path resolution, product-wave consistency and deterministic error reporting.
- Add disabled-by-default local policy reader; do **not** grant dispatch permissions in this milestone.
- Prove normal `mach:run`, `mach:belt`, `mach:intent` behavior is unchanged.
- **Pass:** example validates, malformed paths are rejected, cycles are rejected, open-question slices cannot be approved, absent local state is disabled.

## M1 — Product Studio domain & `/mach:product-studio`

- Extend existing business-intent interviewing by extracting reusable **business** authoring logic; preserve `validate_slice.py` and prevent technical contract/plan work on PM machines.
- Product/epic/decision editing, incremental authoring, approval records with immutable revisions, local draft/resume and deterministic reconciliation.
- Implement a single skill `/mach:product-studio`, document all capabilities and natural-language interaction. Keep other skills visible.
- **Pass:** PM with Git and Claude but no build toolchain can define an epic, interview a slice, resume drafts, pass the existing slice semantic validator, and mark it approved; same artifacts can be produced from terminal and web app.

## M2 — Local Git collaboration & enterprise PR workflow

- Isolated baseline and draft worktrees; safe refresh while local edits exist; semantic diffs and conflicts; stable revision identity.
- Product publication engine stages allowlisted product files only. Branch + commit + push + PR behind `Send to Engineering`. Respect CODEOWNERS, required checks, signed commits, enterprise auth and protected branches.
- Review status and revisions from engineering feedback, offline retry without duplicate PRs.
- **Pass:** three PM clones publish overlapping work; independent changes merge and conflicting decisions require explicit resolution; no user runs Git manually.

## M3 — Factory product intake and scheduler

- Delivery wave importer runs after merge; build idempotent intake ledger; map approved slices into existing local tickets/cells; preserve existing station gates.
- DAG scheduler releases only eligible work; supports version mismatch, superseded work, missing upstream integration and evolving requirements.
- **Pass:** a merged wave becomes visible, intake can be rerun safely, duplicate waves do not duplicate tickets, blocked work remains blocked.

## M4 — Factory Supervisor and `/mach:run factory ...`

- Implement `status|enable|disable|pause|resume` through existing skill; deterministic internal script, never a new user-facing CLI.
- Explicit preflight, local authorization, disabled default, observe/supervised modes, leases and failure recovery.
- Git hooks as advisory notifications, startup reconciliation, optional polling / macOS LaunchAgent, no remote listeners.
- **Pass:** fresh clone on PM laptop cannot dispatch; engineer enables locally; approved wave launches only with policy + gate passing; restarts and missed hooks are recovered.

## M5 — Rich Product Studio web app

- React/TypeScript/Vite, Tailwind/shadcn/ui, native Go launcher. Product workspace, guided interviews, epic/story graph, decision inbox, accepted scope, review history, `Send to Engineering`.
- UI and terminal invoke same domain API, not separate business rules.
- **Pass:** PM completes entire workflow without understanding git, gh, tickets, branches or build toolchains.

## M6 — Control Tower

- Local Go observer and event store; immutable correlated events and authoritative stage snapshots; SSE with replay cursor and reconnection.
- React Flow/ELK graph for factory floor; rich timeline, evidence inspector, animations and project-level progress semantics.
- Optional native Claude Desktop Mod consumes same read-only API.
- **Pass:** three parallel cells, a retry, a blocked decision and a human gate are accurately shown; dashboard loss never affects execution.

## M7 — Release qualification, hardening and distribution

- Cross-slice integration and release acceptance; readiness snapshots; packaged macOS/Windows launchers as appropriate; graceful degraded/offline operation.
- Test native/terminal parity; security, crashes, schema migration, symlink/path attacks, Git conflicts, multiple clones, and restart recovery.

## Mandatory integration tests

1. Fresh PM clone: supervisor disabled; refresh, interview and publication never starts a build.
2. Engineer clone: enable requires preflight and explicit confirmation; background execution never bypasses MACH's existing audit/intent/review/merge gates.
3. PM-A and PM-B publish independent waves; their drafts are not lost on sync.
4. PM-A and PM-B edit same product decision; system asks for semantic resolution rather than silently merging.
5. Enterprise requires PR, reviewers, checks, signed commits and SSO; failure is explainable, no bypass.
6. Merge includes a wave and an unrelated code commit; intake processes the wave exactly once.
7. Hooks absent/missed, machine reboot, disconnected network; startup reconciliation eventually catches up without duplicates.
8. Two engineer machines: only designated runner may dispatch; no claim of distributed scheduling support.
9. UI/CLI product artifacts are byte-equivalent after canonicalization; all core validators agree.
10. No process binds an external interface; no runtime CDN calls, MCP/proxy dependencies or telemetry leaks.
