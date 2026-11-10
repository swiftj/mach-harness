# `/mach-ticket` — MACH Universal Ticket & Telemetry Adapter Skill

Use this skill to fetch, list, ingest telemetry, and update tickets across any issue tracking backend (`gitea-cli`, `fossil`, `github`, `jira`, `local`) or observability telemetry source (`sentry`, `posthog`, `datadog`, `github-actions`) without external script dependencies.

---

## 1. Skill Overview

- **Skill Trigger**: `/mach-ticket [action] [ticket_id|payload_file] [flags]`
- **Supported Actions**: `view`, `list`, `update`, `comment`, `ingest-telemetry`
- **Default Backend**: `gitea-cli` (`gt`)
- **Supported Issue Backends**: `gitea-cli` (`gt`), `fossil`, `github` (`gh`), `jira` (`jira`), `local` (`.factory/tickets/*.md`)
- **Supported Telemetry Adapters**: `sentry`, `posthog`, `datadog`, `github-actions` (`ci-log`), `local-log`

---

## 2. Environment & Configuration Check

Before running any command, inspect environment configuration variables:

```bash
PROVIDER="${ISSUE_PROVIDER:-gitea-cli}"
TELEMETRY_SOURCE="${TELEMETRY_PROVIDER:-sentry}"
```

---

## 3. Sub-Command Execution Rules

### Action: `view <ticket_id>` / `fetch <ticket_id>`

Retrieve the ticket from the active CLI/source, strip terminal formatting/noise, and normalize into the MACH Ticket Schema.

#### Command Dispatch by Provider:

1. **`gitea-cli` (Default)**:
   ```bash
   gt issue view <ticket_id>
   ```
2. **`github`**:
   ```bash
   gh issue view <ticket_id> --json number,title,body,labels,state,comments
   ```
3. **`fossil`**:
   ```bash
   fossil ticket show <ticket_id>
   ```
4. **`jira`**:
   ```bash
   jira issue view <ticket_id> --raw
   ```
5. **`local`**:
   Read `.factory/tickets/<ticket_id>.md` directly from the filesystem.

#### Output Normalization Prompt Rule:
After executing the underlying CLI command, parse the output and emit strictly valid JSON matching this schema:

```json
{
  "ticket_id": "<ID>",
  "provider": "<gitea-cli|fossil|github|jira|local|telemetry>",
  "title": "<Extracted Title>",
  "summary": "<Extracted Problem Summary>",
  "labels": ["<label1>", "<label2>"],
  "state": "<open|in_progress|needs_review|closed|blocked>",
  "acceptance_criteria": [
    "<Criterion 1>",
    "<Criterion 2>"
  ],
  "raw_payload_path": ".factory/inbox/<ticket_id>.json"
}
```

Write the normalized JSON to `.factory/inbox/<ticket_id>.json`.

---

### Action: `ingest-telemetry <source> [payload_file|event_id]`

Ingest live production crash telemetry, unhandled exceptions, or CI build failure logs, transforming raw stack traces into auto-generated MACH tickets for autonomous self-healing.

#### Telemetry Adapters:

1. **`sentry`**:
   Parse Sentry JSON webhook payload or CLI issue export (`sentry-cli issues get <event_id>`):
   - Extract: `exception_type`, `value`, `culprit_file`, `line_number`, `stacktrace`, `release`, `user_impact_count`.
   - Title: `[BUG/Telemetry] <exception_type>: <value> in <culprit_file>`
   - Auto-Labels: `["bug", "telemetry-auto-generated", "sentry", "severity-high"]`

2. **`posthog`**:
   Parse PostHog exception event export or webhook:
   - Extract: `$exception_message`, `$exception_type`, `$current_url`, `$browser`, `person_id`.
   - Title: `[BUG/Telemetry] PostHog Error: <$exception_type> on <$current_url>`
   - Auto-Labels: `["bug", "telemetry-auto-generated", "posthog"]`

3. **`datadog`**:
   Parse Datadog alert / log trace JSON:
   - Extract: `alert_title`, `metric_name`, `service`, `host`, `log_trace`.
   - Title: `[ALERT/Telemetry] Datadog: <alert_title> (<service>)`
   - Auto-Labels: `["alert", "telemetry-auto-generated", "datadog"]`

4. **`github-actions` / `ci-log`**:
   Parse failing GitHub Actions workflow log or local test panic output (`gh run view <run_id> --log-failed`):
   - Extract: `failing_step`, `test_name`, `error_output`, `commit_sha`.
   - Title: `[CI/Failure] Build Failed in <failing_step>: <test_name>`
   - Auto-Labels: `["ci-failure", "telemetry-auto-generated", "automated-repair"]`

#### Output Artifact Generation:
1. Write normalized ticket JSON to `.factory/inbox/AUTO-<timestamp>.json`.
2. Automatically create pre-filled `intent.md` in `.factory/inbox/AUTO-<timestamp>-intent.md`:
   ```markdown
   # Intent: Auto-Generated Self-Healing Repair (Ticket: AUTO-<timestamp>)

   ## 1. Problem Context & Telemetry Stack Trace
   - **Source**: <sentry|posthog|datadog|ci-log>
   - **Culprit File**: `<culprit_file>:<line_number>`
   - **Error Details**: `<exception_type>: <value>`

   ```
   <Stack Trace / Log Snippet>
   ```

   ## 2. Objective & Fix Scope
   - Reproduce failing condition via targeted unit test.
   - Resolve stack trace exception without introducing breaking API changes.
   - Verify fix passes test suite and regression checks.
   ```
3. Sync ticket to active issue tracker (e.g., `gt issue create` or `.factory/tickets/AUTO-<timestamp>.md`).

---

### Action: `list [--label <label>]`

Retrieve active open tickets from the active provider.

1. **`gitea-cli`**: `gt issue list --state open ${LABEL:+--label "$LABEL"}`
2. **`github`**: `gh issue list --state open ${LABEL:+--label "$LABEL"} --json number,title,labels`
3. **`fossil`**: `fossil ticket ls`
4. **`jira`**: `jira issue list -sOpen`
5. **`local`**: Scan `.factory/tickets/*.md` for `state: open` frontmatter.

---

### Action: `update <ticket_id> --state <state> [--comment <msg>] [--label <label>]`

Update ticket status, add labels, or post reviewer feedback.

1. **`gitea-cli`**:
   - Change State: `gt issue edit <ticket_id> --state <state>`
   - Add Comment: `gt issue comment <ticket_id> --body "<msg>"`
   - Add Label: `gt issue label add <ticket_id> "<label>"`
2. **`github`**:
   - Change State: `gh issue edit <ticket_id> --state <state>`
   - Add Comment: `gh issue comment <ticket_id> --body "<msg>"`
   - Add Label: `gh issue edit <ticket_id> --add-label "<label>"`
3. **`fossil`**:
   - Update: `fossil ticket set <ticket_id> status "<state>"`
4. **`jira`**:
   - Comment & State: `jira issue comment add <ticket_id> "<msg>"` && `jira issue move <ticket_id> "<state>"`
5. **`local`**:
   - Modify the YAML frontmatter in `.factory/tickets/<ticket_id>.md` and append comments under `## Activity Log`.

---

## 4. Context Preservation & Token Safeguards

- **Strip ANSI**: Filter out raw terminal color escape codes (`\033[...m`).
- **Trim Verbosity**: Remove vendor signature blocks, redundant metadata lines, and empty comment footers.
- **Save Raw Inbound**: Always back up the unedited raw CLI output or telemetry payload to `.factory/inbox/<ticket_id>.raw` for auditability.
