# SKILL.md — /mach-build (TDD Construction & Implementation Skill)

## 1. Overview & Purpose
The `/mach-build` skill executes the core Test-Driven Development (TDD) construction loop for MACH (**M**anaged **A**gentic **C**onstruction **H**arness).

Running on **Claude 5.5 Sonnet** (`claude-5-5-sonnet`), `/mach-build` takes the `spec.md`, `.proto` contract files, and `plan.md` created during grooming and builds clean, production-grade code inside an isolated Git worktree cell.

---

## 2. Core Operating Principles

1. **Cellular Worktree Isolation**: All edits occur strictly within `.factory/worktrees/<ticket_id>/`. Never touch `main` directly.
2. **Strict Test-Driven Development (TDD)**: Write failing unit/integration tests FIRST. Verify they fail (RED state) before writing any implementation code.
3. **Service Layer Architecture**: Organize code into modular ports/adapters (Services, Repositories, Handlers/CLI commands). No monolithic "vibecoded slop" or multi-thousand-line single files.
4. **Zero Dead Code & Zero Spurious Dependencies**: Do not introduce unused imports, uncalled helper functions, or unnecessary third-party packages.
5. **No Builder Self-Review**: Focus purely on green builds and passing local unit tests. Hand off validation to `/mach-verify` and `/mach-review` for fresh-context verification.

---

## 3. TDD Construction Workflow

```
       [ Command: /mach-build <ticket_id> ]
                        │
                        ▼
       [ 1. Check Out Cellular Worktree ]
      (.factory/worktrees/<ticket_id>/)
                        │
                        ▼
       [ 2. Write Failing Unit Tests ] ──► Validate RED State
                        │
                        ▼
       [ 3. Implement Service Logic ]   ──► Reach GREEN State
                        │
                        ▼
       [ 4. Refactor & Lint Check ]     ──► Clean Architecture
                        │
                        ▼
       [ 5. Trigger /mach-verify ]      ──► Multi-Target Evidence
```

### Step 1: Workspace & Spec Ingestion
* Navigate into `.factory/worktrees/<ticket_id>/`.
* Load `.factory/worktrees/<ticket_id>/plan.md`, `spec.md`, and compiled contract files (`.proto` / OpenAPI / CLI schemas).

### Step 2: Red Phase (Write Failing Tests)
* Create functional unit tests covering every requirement and acceptance criterion in `spec.md`.
* Execute the test suite (`go test`, `pytest`, `cargo test`, `npm test`) and confirm tests fail as expected.

### Step 3: Green Phase (Implementation)
* Write the minimum implementation code required to satisfy the failing tests.
* Ensure all code complies with project conventions defined in `CLAUDE.md`.

### Step 4: Refactor Phase (Clean Architecture)
* Refactor implementation into clean, testable service layers.
* Run language linters and formatting commands (`go fmt`, `ruff`, `clippy`, `prettier`).

### Step 5: Handoff to Verification
* Once local test execution passes 100% clean, trigger the verification harness:
  ```bash
  /mach-verify <ticket_id>
  ```
