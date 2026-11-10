# `/mach-ticket` — MACH Universal Ticket Adapter Skill

Use this skill to fetch, list, and update tickets across any issue tracking backend (`gitea-cli`, `fossil`, `github`, `jira`, `local`) without external script dependencies.

---

## 1. Skill Overview

- **Skill Trigger**: `/mach-ticket [action] [ticket_id] [flags]`
- **Supported Actions**: `view`, `list`, `update`, `comment`
- **Default Backend**: `gitea-cli` (`gt`)
- **Supported Backends**: `gitea-cli` (`gt`), `fossil`, `github` (`gh`), `jira` (`jira`), `local` (`.factory/tickets/*.md`)

---

## 2. Environment & Configuration Check

Before running any CLI command, inspect the `ISSUE_PROVIDER` environment variable (defaults to `gitea-cli` if unset):

```bash
PROVIDER="${ISSUE_PROVIDER:-gitea-cli}"
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
  "provider": "<gitea-cli|fossil|github|jira|local>",
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

Write the normalized JSON to `.factory/inbox/<ticket_id>.json` and present the clean summary to the conversation context.

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
- **Save Raw Inbound**: Always back up the unedited raw CLI output to `.factory/inbox/<ticket_id>.raw` for auditability.
