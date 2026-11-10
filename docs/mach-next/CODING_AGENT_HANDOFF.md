# MACH Next — Next Coding Agent Work Order

Context: apply the additive M0 patch to the real `swiftj/mach-harness` checkout on branch `feature/mach-next-product-studio-supervisor`. Do not merge to main and do not start any autonomous factory processes.

## Source-of-truth priority

1. Existing MACH station scripts and gates in the **current checkout**.
2. The locked design in `docs/mach-next/ARCHITECTURE.md` and `ADRS.md`.
3. The tests and structural schemas in this patch.
4. Old architectural notes only when they do not conflict.

## First task: reconcile M0 with the live repository

- Inspect current `README.md`, `CLAUDE.md`, `skills/run/SKILL.md`, `skills/run/scripts/run.py`, `skills/intent/SKILL.md`, `skills/intent/scripts/validate_slice.py`, `skills/intent/scripts/cell.py`, `bin/mach`, `templates/`, `.factory` scaffold, and `tests/`.
- Run existing MACH tests before and after changes, document their outputs. Identify any upstream schema naming or installation conflicts. Avoid unrelated refactors.
- Verify that the M0 validator's schema accepts and rejects the same shapes as the JSON Schema files. Improve tests to cover additional path/symlink, approval timestamp, unknown enum and malformed JSON cases.
- Align `product/slices/<id>.json` with MACH's existing canonical `specs/slices/<id>-*.md` without weakening its detailed `validate_slice.py` semantics.
- Add explicit integration test that M0 structural validation can never authorize dispatch even if approved flags exist.

## Second task: design M1 without inventing a competing control plane

- Define reusable, **repository-independent** business-interview authoring operations from `/mach:intent`, preserving decision matrix, scenario, traceability and open-question rules.
- Ensure PMs can use `/mach:product-studio` in a clone without a build toolchain and without creating a worktree/cell before product approval.
- Decide how the visual Studio's native-Go backend invokes the same deterministic operations. The Python validation engine remains authoritative unless a conformance-tested replacement is deliberate.
- Specify stable domain commands/APIs for `refresh`, `continue interview`, `approve slice`, `send to engineering`, and `review feedback`.

## Third task: extension of existing `/mach:run` (do not enable yet)

- Add documented plans for `factory status|enable|disable|pause|resume` under `/mach:run`, preserving existing `next`, `board`, `where`, `review-start`, `review-tally` contracts.
- Define mandatory preflight checks, explicit human consent, status of `observe` vs `supervised` policy, file permissions, local `.git/info/exclude` or tracked `.gitignore` safeguard for `.factory/local/`, and failure recovery.
- Treat Git hooks only as advisory notifications and never make them start Claude or a build.
- Do **not** ship an enable operation that flips `enabled=true` without full preflight and dispatcher-side checking.

## Recommended commits

- Commit 1: `docs: record MACH Next three-layer architecture and acceptance plan`.
- Commit 2: `feat(product): add non-dispatching product contract validation and tests`.
- Then work M1+ in subsequent reviewable commits, each with runnable tests and backward compatibility checks.

## Explicit non-goals

No portfolio management, new public MACH CLI, remote TCP listener, Go/WASM/single-file HTML, hosted backend, implicit PM toolchain dependency, skill hiding, automatic bypass of GitHub enterprise policies, or execution triggered directly by Git hooks.
