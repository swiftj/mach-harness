> **Superseded.** The built skill is `skills/intent/`, which follows the prd-slice design (`docs/prd-slice-skill/`) instead of the grilling loop described here. This file is kept for history; `CLAUDE.md` section 4.3 describes the current behavior.

# `/mach-intent` — MACH Requirements Grooming & Intent Synthesis Skill

Use this skill to transform raw tickets, user requests, or sliced PRDs into structured `intent.md` and boundary contract specifications (`.proto`) before any code generation begins.

---

## 1. Skill Overview

- **Skill Trigger**: `/mach-intent [ticket_id_or_prd_path]`
- **Assigned Model Tier**: `claude-3-opus` (High Effort for architectural reasoning)
- **Primary Objective**: Interview the product owner / SME (or apply rigorous defaults headlessly), eliminate requirement ambiguity, map interface contracts, and generate `.factory/worktrees/<ticket_id>/intent.md`.

---

## 2. Ingestion & Pre-Check Phase

1. Execute `/mach-ticket view <ticket_id>` to pull the normalized ticket JSON from `.factory/inbox/<ticket_id>.json`.
2. Inspect `intent.md` template rules from `.claude/templates/intent.template.md` (if present).
3. Read relevant system architecture rules from `CLAUDE.md`, `AGENTS.md`, and existing Protocol Buffer contracts in `proto/`.

---

## 3. Interactive Requirements "Grilling" Loop

The `mach-intent` skill operates in one of two modes depending on execution context:

### Mode A: Interactive SME Session (Human Present)
Ask focused, branch-by-branch clarification questions targeting missing requirements:

1. **User Goal & Value**: *"What exact problem does this solve for the end user, and what is the success metric?"*
2. **Boundary & Contracts**: *"Which existing services or ProtoBuf contracts (`.proto`) will this feature interact with?"*
3. **Failure Modes & Edge Cases**: *"How should the system behave under network timeouts, invalid payloads, or rate limits?"*
4. **Security & Compliance**: *"Does this feature touch authentication, authorization, PII, or billing data?"*

### Mode B: Headless Autonomous Mode (`claude -p` / Scheduled Job)
If running headlessly without a human in the loop:
1. Apply strict, secure defaults for all unspecified edge cases.
2. Flag all assumed behaviors under an `## Assumptions & Inferred Constraints` section in `intent.md`.
3. If an unresolvable security or architectural contradiction is detected, mark the ticket state as `blocked-requires-sme` via `/mach-ticket update <id> --label "blocked-requires-sme"`.

---

## 4. Required Output Artifacts

Upon completing the grooming loop, create the cell worktree directory (`.factory/worktrees/<ticket_id>/`) and write the following files:

### Artifact 1: `.factory/worktrees/<ticket_id>/intent.md`

```markdown
# Intent: <Feature / Ticket Title>

**Ticket Reference**: <TICKET_ID> (<PROVIDER>)
**Target Worktree**: `.factory/worktrees/<TICKET_ID>`
**Status**: Groomed & Approved for Building

## 1. Business Outcome & User Value
- **Problem Statement**: <Concise statement of the problem>
- **Target User**: <User persona or system client>
- **Value Metric**: <Measurable outcome>

## 2. Functional Acceptance Criteria
- [ ] Criterion 1: <Specific behavioral requirement>
- [ ] Criterion 2: <Specific behavioral requirement>
- [ ] Criterion 3: <Specific behavioral requirement>

## 3. Interface & Contract Boundaries
- **Inbound Contracts**: `proto/<service>_v1.proto`
- **Outbound Dependencies**: `proto/<dependent_service>_v1.proto`
- **Data Model Changes**: <Description of schema changes>

## 4. Non-Functional & Security Constraints
- **Performance Budget**: <Latency / throughput budget>
- **Security Boundaries**: <AuthN/AuthZ checks required>
- **Error Handling**: <Graceful degradation behavior>

## 5. Assumptions & Open Inquiries
- <List of assumptions made during grooming>
```

### Artifact 2: `.factory/worktrees/<ticket_id>/spec.template.md`
Generate an initial behavioral specification outline pre-populated with unit test targets, service layer boundaries, and Playwright verification scenarios for the `Builder` and `Validator` agents.

---

## 5. Next Stage Handoff

Once `intent.md` is generated, `/mach-intent` triggers the Orchestrator to hand off execution to the `Builder` agent:

```bash
echo "[MACH Pipeline] Intent groomed successfully for <TICKET_ID>. Provisioning Builder Agent..."
```
