# Skill: /mach-observe — Autonomous Meta-Learning & Self-Improvement Skill

## Overview
`/mach-observe` is the meta-learning, self-improving observer engine for MACH (**M**ulti-**A**gent **C**onstruction **H**arness). 

It continuously monitors factory telemetry—analyzing closed ticket reviews, multi-agent voting feedback, human SME overrides, and production crash reports (from Sentry, PostHog, or Datadog). It transforms execution history into actionable self-improvements by updating project governance files (`CLAUDE.md`, `REVIEW.md`) and tuning MACH skill instructions over time.

---

## Assigned Model & Resource Configuration
- **Model**: `claude-5-1-fable` or `claude-5-5-opus` (High-effort deep reasoning and pattern synthesis)
- **Effort Level**: `High`
- **Trigger Schedule**: Nightly cron execution, post-sprint review, or on-demand after 10 closed tickets

---

## Core Operational Responsibilities

### 1. Review Loop & SME Correction Analysis
- Scans `.factory/archive/` and review logs for tickets that required more than 1 revision round or escalated to human SMEs.
- Extracts recurring code defects, architectural anti-patterns, or linting failures (e.g. repeated failure to handle database connection timeouts, un-sanitized API parameters, or missing error context).

### 2. Telemetry & Production Crash Ingestion
- Ingests production crash reports and stack traces from observability tools (Sentry, PostHog, Datadog).
- Maps production regressions back to the specific MACH task, PR, or skill responsible for the failure.
- Auto-generates pre-filled `intent.md` tickets for zero-touch bug remediation.

### 3. Automated Skill & Rule Optimization
- Proposes precise git diff updates to:
  - **`CLAUDE.md`**: Updates coding style conventions, forbidden library patterns, and service layer architecture rules.
  - **`REVIEW.md`**: Refines reviewer voting criteria and security checklist items based on discovered edge cases.
  - **`.claude/skills/`**: Tunes instructions for `/mach-build`, `/mach-verify`, and `/mach-intent` to explicitly prevent past failure modes.

### 4. Agent Execution Performance Scorecard
- Tracks metrics across execution runs:
  - Average review rounds per ticket (Target: < 1.3 rounds).
  - First-pass CI success rate (Target: > 85%).
  - Human SME override rate (Target: < 5%).
  - Average token cost per completed ticket.

---

## Execution Command Syntax

```bash
# Run meta-learning observer analysis over recent execution history
/mach-observe [options]

# Options:
#   --history-depth <N>   Number of past closed tickets to analyze (default: 20)
#   --telemetry-source    Ingest live crash logs ('sentry', 'posthog', 'datadog')
#   --auto-pr             Automatically create a PR with proposed rule updates
```

---

## Workflow Diagram

```
 [ Factory Telemetry & Logs ]     [ Sentry / Production Crashes ]
              │                                 │
              └────────────────┬────────────────┘
                               │
                               ▼
                    [ /mach-observe Skill ]
                  (Claude 5.1 Fable Engine)
                               │
            ┌──────────────────┼──────────────────┐
            ▼                  ▼                  ▼
  [ Refine CLAUDE.md ]  [ Tune Skill Instructions ] [ Auto-Generate Fix Ticket ]
  (Update Repo Rules)   (Update /mach-build)      (Self-Healing Feedback)
```

---

## Output Artifact Format (`.factory/observations/observation-report.md`)

```markdown
# MACH Observer Meta-Learning Report — Session #42

## 1. Analyzed Pipeline Data
- **Tickets Analyzed**: 25 completed tickets (GIT-1020 to GIT-1045)
- **First-Pass Pass Rate**: 84% (21/25 passed review on Round 1)
- **Escalation Count**: 1 ticket escalated to Human SME (GIT-1032 — missing database migration index)

## 2. Identified Anti-Patterns
- **Pattern A**: 3 out of 25 tickets omitted gRPC context deadline propagation in backend handlers.
- **Pattern B**: 2 frontend UI tickets generated inline CSS instead of utilizing Tailwind design tokens.

## 3. Autonomous Skill & Rule Optimizations (Proposed PR)
- **`CLAUDE.md` Update**: Added mandatory rule enforcing `context.WithTimeout` on all gRPC handlers.
- **`mach-build-skill.md` Update**: Added explicit prompt constraint requiring Tailwind utility classes for all component styling.
```
