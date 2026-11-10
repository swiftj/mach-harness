# Skill: /mach-audit — Repository Readiness Scorecard Skill

## Overview
`/mach-audit` is a pre-flight repository readiness and health inspection skill for MACH (**M**ulti-**A**gent **C**onstruction **H**arness). 

Before any autonomous builder agent (`/mach-build`) begins work on a feature ticket, `/mach-audit` evaluates the target repository against enterprise readiness criteria. It prevents MACH from wasting tokens or producing broken pull requests on unhardened, un-tested, or dirty codebases.

---

## Assigned Model & Resource Configuration
- **Model**: `claude-5-5-sonnet` (or `claude-5-5-haiku` for fast automated CI checks)
- **Effort Level**: `Medium`
- **Context Window**: Clean inspection session

---

## 5 Readiness Inspection Pillars

`/mach-audit` inspects the repository across 5 core pillars and computes a **Readiness Score (0–100%)**:

### 1. Reproducible Environment & Build Pipeline (Weight: 25%)
- Checks for standard build definitions (`Makefile`, `Dockerfile`, `.devcontainer/`, `pack.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`).
- Verifies that a zero-parameter build command exists and executes cleanly.

### 2. Baseline Test Suite Health (Weight: 25%)
- Runs existing unit and integration test runners (`go test ./...`, `npm test`, `pytest`, `cargo test`).
- **Pass Threshold**: 100% green status on baseline tests before any feature code is modified.

### 3. Linting, Formatting & Static Analysis (Weight: 20%)
- Inspects configuration files for strict code style enforcement (`.golangci.yml`, `.eslintrc`, `prettier`, `ruff`, `clippy`).
- Verifies static security scanner hooks (e.g. secret detection, OWASP scanners).

### 4. Architectural Rules & Boundary Contracts (Weight: 15%)
- Validates presence of `CLAUDE.md`, `AGENTS.md`, and `REVIEW.md`.
- Checks for explicit typed boundary contracts (Protocol Buffers `.proto` files, OpenAPI/Swagger schemas, or TypeScript interfaces).

### 5. Repository Hygiene & Git Cleanliness (Weight: 15%)
- Checks `git status` for clean working tree, valid `.gitignore`, and absence of untracked junk files or merge conflict markers.

---

## Readiness Tiers & Pipeline Gating

Based on the calculated score, `/mach-audit` assigns one of three readiness tiers:

| Readiness Tier | Score Range | Action / Pipeline Behavior |
| :--- | :--- | :--- |
| **Gold** | **90 – 100%** | **Full Autonomy Approved**: Ticket passes directly to `/mach-intent` and `/mach-build`. Auto-merge enabled upon passing `/mach-review`. |
| **Silver** | **70 – 89%** | **Proceed with Caution**: Minor gaps detected (e.g. missing linters). MACH executes feature work but enforces mandatory human SME review gate. |
| **Bronze / Fail** | **< 70%** | **Pipeline Blocked**: Repository is unhardened or baseline tests are failing. MACH triggers an automated "repo hardening" workflow before accepting feature tickets. |

---

## Execution Command Syntax

```bash
# Execute repository readiness audit
/mach-audit [options]

# Options:
#   --strict         Fail pipeline if score is below Gold tier (90%)
#   --fix            Auto-generate missing CLAUDE.md, .gitignore, or linting configs
#   --json           Output raw JSON scorecard to .factory/audit-report.json
```

---

## Output Artifact Format (`.factory/audit-report.json`)

```json
{
  "timestamp": "2026-11-09T09:25:00Z",
  "repository": "project-mach",
  "readiness_score": 94,
  "readiness_tier": "Gold",
  "pipeline_status": "APPROVED",
  "pillars": {
    "environment": { "score": 25, "max": 25, "status": "pass" },
    "test_health": { "score": 25, "max": 25, "status": "pass" },
    "linting_security": { "score": 19, "max": 20, "status": "pass", "note": "Missing strictly enforced static security config" },
    "contracts": { "score": 15, "max": 15, "status": "pass" },
    "git_hygiene": { "score": 10, "max": 15, "status": "warning", "note": "2 untracked scratch files found" }
  },
  "recommendations": [
    "Clean untracked files before initiating /mach-build",
    "Add static security scanner definition to Makefile"
  ]
}
```
