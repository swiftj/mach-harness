# SKILL.md — /mach-verify (Multi-Target Dynamic Evidence & Verification Skill)

## 1. Overview & Purpose
The `/mach-verify` skill executes automated, objective quality assurance and evidence collection for any application component built by MACH (**M**anaged **A**gentic **C**onstruction **H**arness). 

To eliminate builder confirmation bias and ensure target flexibility across non-web applications, `/mach-verify`:
1. Runs independently on **Claude 5.5 Sonnet** (`claude-5-5-sonnet`) with a fresh context window.
2. Inspects `spec.md` to identify the `app_type` (Web, CLI, API/Microservice, Desktop/Mobile, or Library/SDK).
3. Invokes the appropriate **Multi-Target Evidence Runner** to capture objective proof of correctness.
4. Saves verification logs, screenshots, video walkthroughs, terminal gifs, or benchmark diffs into `.factory/worktrees/<ticket_id>/evidence/`.

---

## 2. Multi-Target Evidence Runner Matrix

Depending on the `app_type` specified in `.factory/worktrees/<ticket_id>/spec.md`, `/mach-verify` selects the relevant execution pipeline:

### Type A: Web Applications (`app_type: web`)
* **Tools**: Playwright, Cypress, Puppeteer.
* **Execution**: Boots the application locally or in a sandbox, executes user flows outlined in acceptance criteria, and captures visual proof.
* **Evidence Artifacts**: 
  * `.factory/worktrees/<ticket_id>/evidence/screenshot-*.png`
  * `.factory/worktrees/<ticket_id>/evidence/walkthrough-*.webm`

### Type B: CLI & Terminal Tools (`app_type: cli`)
* **Tools**: `vhs` (Charm), `asciinema`, terminal automation scripts, `diff`.
* **Execution**: Spawns terminal sessions executing CLI commands, sub-commands, `--help` flags, and error state handling.
* **Evidence Artifacts**:
  * `.factory/worktrees/<ticket_id>/evidence/terminal-demo.gif`
  * `.factory/worktrees/<ticket_id>/evidence/stdout-stderr.log`
  * `.factory/worktrees/<ticket_id>/evidence/exit-codes.json`

### Type C: Backend APIs & Microservices (`app_type: api` | `grpc` | `rest`)
* **Tools**: `protoc` compiler, `curl`, `grpcurl`, `k6`, Postman runner, DB state checkers.
* **Execution**: Verifies interface contract compilation (`.proto` or OpenAPI), executes HTTP/gRPC requests, validates response payloads against JSON schemas, and inspects database before/after state.
* **Evidence Artifacts**:
  * `.factory/worktrees/<ticket_id>/evidence/contract-compile.log`
  * `.factory/worktrees/<ticket_id>/evidence/api-response-dump.json`
  * `.factory/worktrees/<ticket_id>/evidence/db-state-diff.md`

### Type D: Desktop & Mobile Applications (`app_type: desktop` | `mobile`)
* **Tools**: Native OS automation (`cliclick`, `xdotool`, `screencapture`), Android ADB, iOS Simulator CLI (`simctl`).
* **Execution**: Launches the GUI binary, sends simulated user interactions (clicks, keystrokes, gestures), and captures OS window frame snapshots.
* **Evidence Artifacts**:
  * `.factory/worktrees/<ticket_id>/evidence/gui-window-*.png`
  * `.factory/worktrees/<ticket_id>/evidence/app-interaction.mp4`

### Type E: Libraries, SDKs & Algorithms (`app_type: library`)
* **Tools**: Native language test runners (`go test -v -bench=.`, `cargo test`, `pytest --cov`), API compatibility checkers (`abidiff`, `gorelease`).
* **Execution**: Runs unit and integration test suites, holdout scenario tests, code coverage reports, public API signature diffs, and benchmark flamegraphs.
* **Evidence Artifacts**:
  * `.factory/worktrees/<ticket_id>/evidence/test-coverage.log`
  * `.factory/worktrees/<ticket_id>/evidence/api-surface-diff.txt`
  * `.factory/worktrees/<ticket_id>/evidence/benchmark-flamegraph.png`

---

## 3. Skill Workflow Execution Steps

```
   [ Command: /mach-verify <ticket_id> ]
                     │
                     ▼
  [ 1. Read spec.md & Detect app_type ]
                     │
                     ▼
  [ 2. Load Holdout Test Scenarios ]
  (Tests hidden from Builder Agent)
                     │
                     ▼
  [ 3. Execute Target Evidence Runner ]
  (Playwright / VHS / grpcurl / OS Auto / Test Benchmark)
                     │
                     ▼
  [ 4. Store Proof in evidence/ Directory ]
                     │
                     ▼
  [ 5. Evaluate Pass/Fail & Notify Orchestrator ]
```

### Step 1: Context & Holdout Initialization
- Read `.factory/worktrees/<ticket_id>/spec.md` and `.factory/worktrees/<ticket_id>/intent.md`.
- Load holdout validation scenarios from `.factory/holdouts/<ticket_id>/` (if present) that were obscured during construction to prevent builder test-cheating.

### Step 2: Evidence Runner Execution
- Execute the target-specific verification runner command based on `app_type`.
- Collect stdout, stderr, visual frame grabs, and binary return codes.

### Step 3: Artifact Packing & Status Generation
- Copy all output artifacts to `.factory/worktrees/<ticket_id>/evidence/`.
- Create `.factory/worktrees/<ticket_id>/evidence/summary.json`:
  ```json
  {
    "ticket_id": "GIT-1042",
    "app_type": "cli",
    "status": "PASS",
    "contract_valid": true,
    "holdout_tests_passed": true,
    "evidence_files": [
      "terminal-demo.gif",
      "stdout-stderr.log",
      "exit-codes.json"
    ],
    "timestamp": "2026-11-08T07:42:00Z"
  }
  ```

---

## 4. Output Status Outcomes

- **`PASS`**: All acceptance criteria, contract checks, and holdout tests passed with complete evidence collected. Ready for `/mach-review`.
- **`FAIL_WITH_EVIDENCE`**: Functional failure or contract mismatch detected. Error dumps and evidence logs appended; returns to `/mach-build`.
- **`INCOMPLETE_EVIDENCE`**: App compiled but required visual/log evidence failed to generate. Execution halts for retry.
