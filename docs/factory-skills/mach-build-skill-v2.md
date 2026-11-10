# SKILL.md — /mach-build (TDD Construction & Design System Anchored Implementation Skill)

## 1. Overview & Purpose
The `/mach-build` skill executes the core Test-Driven Development (TDD) construction loop for MACH (**M**anaged **A**gentic **C**onstruction **H**arness).

Running on **Claude 5.5 Sonnet** (`claude-5-5-sonnet`), `/mach-build` takes the `spec.md`, `.proto` contract files, and `plan.md` created during grooming and builds clean, production-grade code inside an isolated Git worktree cell.

---

## 2. Core Operating Principles

1. **Cellular Worktree Isolation**: All edits occur strictly within `.factory/worktrees/<ticket_id>/`. Never touch `main` directly.
2. **Strict Test-Driven Development (TDD)**: Write failing unit/integration tests FIRST. Verify they fail (RED state) before writing any implementation code.
3. **Design System & UI Component Anchoring (Anti-Slop Guardrail)**: For UI/frontend tasks, strictly enforce project design tokens, existing component registries (e.g. Tailwind / Shadcn / Storybook / custom design system), semantic HTML, and ARIA accessibility standards. Never generate raw unstyled divs, arbitrary inline hex codes, or monolithic "vibecoded" slop.
4. **Service Layer Architecture**: Organize backend code into modular ports/adapters (Services, Repositories, Handlers/CLI commands). No multi-thousand-line single files.
5. **Zero Dead Code & Zero Spurious Dependencies**: Do not introduce unused imports, uncalled helper functions, or unnecessary third-party packages.
6. **No Builder Self-Review**: Focus purely on green builds and passing local unit tests. Hand off validation to `/mach-verify` and `/mach-review` for fresh-context verification.

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
       [ 2. Inspect Architecture & Design System ]
      (CLAUDE.md / design tokens / component registry)
                        │
                        ▼
       [ 3. Write Failing Unit Tests ] ──► Validate RED State
                        │
                        ▼
       [ 4. Implement Service & UI Logic ] ──► Reach GREEN State
                        │
                        ▼
       [ 5. Refactor, A11y & Lint Check ] ──► Clean Architecture
                        │
                        ▼
       [ 6. Trigger /mach-verify ]      ──► Multi-Target Evidence
```

### Step 1: Workspace & Spec Ingestion
* Navigate into `.factory/worktrees/<ticket_id>/`.
* Load `.factory/worktrees/<ticket_id>/plan.md`, `spec.md`, and compiled contract files (`.proto` / OpenAPI / CLI schemas).

### Step 2: Architecture & Design System Discovery
* **Backend Architecture**: Identify service layer contracts and package dependencies.
* **Frontend / UI Architecture Check**:
  * Check for design system configurations (`tailwind.config.js`, `theme.json`, `components.json`, Storybook).
  * Audit existing UI component registry (e.g., `src/components/ui/` or `lib/components/`).
  * **Rule**: Re-use existing atomic components (`Button`, `Modal`, `Card`, `Input`, `Table`) before creating new UI primitives.
  * **Design Tokens Rule**: Use design tokens (`var(--primary)`, `text-theme-muted`, `p-4`) instead of arbitrary hardcoded values (`#3b82f6`, `style="padding: 17px;"`).
  * **Accessibility (a11y) Rule**: Include semantic elements (`<main>`, `<nav>`, `<article>`, `<button>`), `aria-label`, keyboard focus rings, and dark mode compliance.

### Step 3: Red Phase (Write Failing Tests)
* Create functional unit tests covering every requirement and acceptance criterion in `spec.md`.
* For UI components, write component unit tests (`Testing Library`, `Vitest`, `Playwright component tests`).
* Execute the test suite (`go test`, `pytest`, `cargo test`, `npm test`) and confirm tests fail as expected (RED state).

### Step 4: Green Phase (Implementation)
* Write the minimum implementation code required to satisfy the failing tests.
* Ensure all code complies with project conventions defined in `CLAUDE.md` and design system standards.

### Step 5: Refactor Phase (Clean Architecture & Anti-Slop Audit)
* Refactor implementation into clean, testable service layers.
* Verify UI code contains zero inline magic styles, zero accessibility warnings, and zero dead code.
* Run language linters and formatting commands (`go fmt`, `ruff`, `clippy`, `prettier`, `eslint`).

### Step 6: Handoff to Verification
* Once local test execution passes 100% clean, trigger the verification harness:
  ```bash
  /mach-verify <ticket_id>
  ```
