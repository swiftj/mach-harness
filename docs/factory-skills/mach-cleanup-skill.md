# Skill: /mach-cleanup — Workspace Pruning & Worktree Teardown Engine

## Overview
`/mach-cleanup` is the resource management and workspace hygiene skill of the **MACH** (Managed Agentic Construction Harness) platform. Running on high-speed, ultra-affordable models (`claude-5-5-haiku`), it handles post-merge teardowns, ephemeral `git worktree` pruning, code linting, and evidence archiving with zero token waste.

---

## Model Tier & Execution Parameters
- **Skill Name**: `/mach-cleanup`
- **Assigned Model**: `claude-5-5-haiku` (Fast, high-volume, low-cost utility model)
- **Effort Level**: Low
- **Execution Cost**: ~$0.00 / sub-cent execution

---

## Primary Responsibilities

1. **Ephemeral Worktree Pruning**: Safely unmounts and removes `.factory/worktrees/<ticket_id>` once a feature branch is merged or abandoned.
2. **Branch Hygiene**: Deletes local feature branches (`feature/<ticket_id>`) post-merge to maintain clean Git repository state.
3. **Evidence Archiving & Compression**: Compresses heavy visual/execution evidence (PNG/WebM/GIF/Flamegraphs) into `.factory/archive/<ticket_id>-evidence.tar.gz` and clears temporary build caches.
4. **Mechanical Linting & Formatting**: Runs language-specific formatters (`gofmt`, `prettier`, `ruff`, `cargo fmt`) across target paths.
5. **Ticket Closure & Synchronization**: Updates ticket state on Gitea (`gt`), Fossil, GitHub (`gh`), Jira, or Local Markdown files to `Closed` / `Archived`.

---

## Execution Workflow

```text
               [ Trigger: PR Merged / Ticket Complete / Command ]
                                       │
                                       ▼
                   [ 1. Verify Git Status & Safety Checks ]
                   (Ensure zero uncommitted changes in main)
                                       │
                                       ▼
                   [ 2. Archive Evidence & Build Logs ]
                   (Tar/gz evidence to .factory/archive/)
                                       │
                                       ▼
                   [ 3. Prune Ephemeral Git Worktree ]
                   (git worktree remove --force .factory/worktrees/<id>)
                                       │
                                       ▼
                   [ 4. Delete Local Feature Branch ]
                   (git branch -d feature/<id>)
                                       │
                                       ▼
                   [ 5. Sync Ticket Status via /mach-ticket ]
                   (Mark ticket as Closed / Resolved)
```

---

## Safety & Verification Guardrails

Before destroying any worktree or directory, `/mach-cleanup` enforces the following hard rules:
- **Merge Check**: Verifies that commit hashes are present in `main` or explicitly flagged for abandonment (`--force-abandon`).
- **Path Locking**: Restricts file deletion exclusively to `.factory/worktrees/<ticket_id>` and `.factory/tmp/`. Never executes destructive commands outside designated sandbox paths.
- **Uncommitted Diff Safeguard**: Stashes or logs any untracked debug files before worktree removal to prevent accidental data loss.

---

## Execution Commands

```bash
# Standard post-merge cleanup for a completed ticket
claude -p "Execute /mach-cleanup for ticket GIT-1042"

# Perform global workspace maintenance & prune orphaned worktrees
claude -p "Execute /mach-cleanup --all-orphans"

# Force abandon an unmerged worktree cell
claude -p "Execute /mach-cleanup GIT-1042 --abandon"
```
