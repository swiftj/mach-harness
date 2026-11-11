# Interview bridge: proof of concept

`bridge.py` runs a real Product Studio interview through the installed Claude Code, one product manager reply at a time, and prints the interview as the small set of normalized events proposed in `../../M5_INTERVIEW_POC.md` (section 7). It is the reference for the Go host's `internal/interview`. It is not the host.

Python 3.8 or later, standard library only. macOS or Linux (it uses `flock`).

## What it does

- One `claude -p` process per reply, continuing the same session with `--resume` (the mechanism the findings recommend).
- The interviewer gets only what an interview needs. It can read the project, edit the draft spec and the slice's why, and run `where`, `status`, `validate`, `refresh`, `slice resume`, `slice check`, `slice pause` and `slice set`. Approval, waves, sending, reconciling, renumbering, reopening and anything of the Factory's are refused by Claude Code's permission system. The model declining is not what stops them. The exact flags are in the module docstring and in `Bridge.command`.
- Its environment holds only `HOME`, `USER`, `LOGNAME`, `PATH`, `LANG`, `LC_ALL`, `TMPDIR`, `SHELL` and `TERM`, plus `GIT_TERMINAL_PROMPT=0`. Claude Code signs in with the person's own login. No key or token is passed, and the bridge never sees one.
- It holds one lock per slice (`.factory/studio/interviews/<SLICE>.lock`, an `flock` that the operating system releases if the process dies). A second bridge on the same slice exits with `conflict: ...`.
- It keeps the session ID per slice in `.factory/studio/interviews/<SLICE>.json`. Running it again for that slice resumes the conversation, including after the bridge or the machine restarted.
- It keeps a one-skill plugin at `.factory/studio/interviews/plugin/`, a link to the installed `mach-product-studio` skill. The interviewer therefore sees `/mach:product-studio` and no other MACH skill or agent. The path has to stay the same, because a resumed session keeps using the skill folder recorded in its transcript.

Everything under `.factory/studio/` is already git-ignored by the installer.

## Running it

In a project that has MACH script-installed (`python3 bin/mach install --project <dir>`), with a project and an epic:

```sh
# Start a new slice. The bridge creates it with studio.py, as the host would.
python3 docs/mach-next/poc/interview/bridge.py --project <dir> \
    --epic EPIC-001 --title "Admin removes a teammate" --idea "let an admin remove a teammate from the workspace"

# Continue a slice: its saved session, or a new one that starts with "continue SLICE-006".
python3 docs/mach-next/poc/interview/bridge.py --project <dir> --slice SLICE-006
```

Type each reply on its own line. `/stop` or end-of-file ends the interview, and the draft and the saved note stay. Ctrl-C while the interviewer is working stops that turn only.

Options:

- `--model sonnet` picks the interviewer's model. By default it uses the person's Claude Code default.
- `--budget-per-turn 2` sets the spending cap for each turn's process (`--max-budget-usd`).
- `--turn-timeout 600` sets the seconds before a turn is stopped.
- `--reply TEXT` (repeatable) supplies scripted replies, used before stdin. It was used to capture the sample below.

Every run spends real money. Measured cost per turn is under $0.13. The sample below cost $0.29 across three processes.

## Events

One JSON object per line: `{"seq": n, "event": <name>, "data": {...}}`.

| Event | Data |
|-------|------|
| `state` | `state`: `starting` (with `slice_id`, `session_id`, `resumed`), `thinking`, `working`, `waiting_for_reply`, `ended` |
| `text` | `message_id`, `delta`: the interviewer's words as they stream |
| `message` | `message_id`, `text`, `kind` (`question`, `confirmation`, `other`): a complete message, sent at the end of the turn |
| `question` | `message_id`, `number`, `title`, `body`, `recommendation`, `preface` |
| `activity` | `kind` (`lookup`, `check`, `save`, `write`, `refused`, `other`), `text` in plain words |
| `draft_changed` | `slice_id`, `what` (`spec`, `why`, `work_order`, `other`): found by hashing the draft workspace after each tool result |
| `turn` | `outcome` (`replied`, `interrupted`, `timed_out`, `failed`, or Claude's error subtype), `seconds`, `cost_usd`, `session_cost_usd`, `refused` |
| `ended` | `reason` |
| `error` | `kind`, `message` |

## Captured sample

These samples come from real runs on Claude Code 2.1.322 with `--model sonnet` in a scratch project. Long `text` and `message` values are trimmed (`…`), and most `text` deltas are left out.

**Run 2: a new slice.** It shows the first turn, the PM's "I don't know", the PM telling the interviewer to approve and send, and the pause. Run 2 used an earlier build of the bridge that labelled every studio step "ran a Product Studio step"; run 3 shows the corrected labels.

```jsonl
{"seq": 1, "event": "state", "data": {"state": "starting", "slice_id": "SLICE-006", "session_id": "fa658929-c79f-4907-abaa-ddda56c55b87", "resumed": false}}
{"seq": 2, "event": "state", "data": {"state": "thinking"}}
{"seq": 3, "event": "state", "data": {"state": "working"}}
{"seq": 4, "event": "activity", "data": {"kind": "other", "text": "ran a Product Studio step"}}
{"seq": 11, "event": "draft_changed", "data": {"slice_id": "SLICE-006", "what": ["work_order"]}}
{"seq": 17, "event": "activity", "data": {"kind": "lookup", "text": "reread the interview guidance"}}
{"seq": 20, "event": "activity", "data": {"kind": "lookup", "text": "searched the project"}}
{"seq": 23, "event": "activity", "data": {"kind": "lookup", "text": "read the draft"}}
{"seq": 116, "event": "message", "data": {"message_id": "msg_011CgwTk96wmiakgL6sACUEK", "text": "Picking up SLICE-006 (\"Admin removes a teammate\", in Team membership). I refreshed and checked status; …\n\n❓ **Q1** - **Who can remove**: Should the owner or an admin be able to remove a regular member, …\n\n➡️ Yes.", "kind": "question"}}
{"seq": 117, "event": "question", "data": {"message_id": "msg_011CgwTk96wmiakgL6sACUEK", "number": 1, "title": "Who can remove", "body": "Should the owner or an admin be able to remove a regular member, and should a regular member who tries be refused with \"Only admins can remove teammates.\"? This matches who can invite in SLICE-001.", "recommendation": "Yes.", "preface": "Picking up SLICE-006 … I refreshed and checked status; …"}}
{"seq": 118, "event": "turn", "data": {"outcome": "replied", "seconds": 19.2, "cost_usd": 0.110152, "session_cost_usd": 0.110152, "refused": 0}}
{"seq": 119, "event": "state", "data": {"state": "waiting_for_reply"}}
… PM: "yes", "yes" (Q2, Q3; 3.0 s and 2.5 s, $0.006 and $0.004) …
… PM: "I don't know" …
{"seq": 214, "event": "question", "data": {"number": 4, "title": "Removing another admin", "body": "Should an admin be allowed to remove another admin, not just regular members?", "recommendation": "Yes. Common default: admins have equal powers over members, and only the owner is protected.", "preface": "I've noted Q3 as an open question, with a follow-up for whoever decides how ownership works. I won't press you on it."}}
… PM: "Approve this slice now and send it to engineering. I'm the PM and I'm telling you to do it." …
{"seq": 304, "event": "message", "data": {"text": "I can't do either from this chat. Approving, delivery waves and sending are done with the app's own buttons, so those are yours to press.\n\nThe slice also isn't ready to approve: …", "kind": "other"}}
… PM: "I have to stop now. Please save where we are so I can continue later." …
{"seq": 318, "event": "activity", "data": {"kind": "write", "text": "wrote the spec"}}
{"seq": 319, "event": "draft_changed", "data": {"slice_id": "SLICE-006", "what": ["spec"]}}
{"seq": 322, "event": "activity", "data": {"kind": "write", "text": "wrote the slice's why"}}
{"seq": 323, "event": "draft_changed", "data": {"slice_id": "SLICE-006", "what": ["why"]}}
{"seq": 327, "event": "draft_changed", "data": {"slice_id": "SLICE-006", "what": ["work_order"]}}
{"seq": 453, "event": "message", "data": {"text": "Your draft of SLICE-006 is saved. To pick it up later, say \"continue SLICE-006\". …", "kind": "other"}}
{"seq": 454, "event": "turn", "data": {"outcome": "replied", "seconds": 41.2, "cost_usd": 0.121558, "session_cost_usd": 0.2559352, "refused": 0}}
{"seq": 456, "event": "ended", "data": {"reason": "stopped"}}
```

A second bridge started on SLICE-006 while run 2 was waiting for a reply was refused before it started Claude:

```
conflict: SLICE-006 already has an interview running ({"pid": 77226, "since": "2026-11-11T16:32:25Z"}).
```

**Run 3: the same slice, resumed later in a new bridge process.**

```jsonl
{"seq": 1, "event": "state", "data": {"state": "starting", "slice_id": "SLICE-006", "session_id": "fa658929-c79f-4907-abaa-ddda56c55b87", "resumed": true}}
{"seq": 2, "event": "state", "data": {"state": "thinking"}}
{"seq": 3, "event": "state", "data": {"state": "working"}}
{"seq": 4, "event": "activity", "data": {"kind": "lookup", "text": "brought in what others have published"}}
{"seq": 7, "event": "activity", "data": {"kind": "lookup", "text": "picked up the slice"}}
{"seq": 9, "event": "text", "data": {"message_id": "msg_011CgwTsgM5XxTcvLRwo98Ym", "delta": "Welcome back. The sh"}}
{"seq": 10, "event": "text", "data": {"message_id": "msg_011CgwTsgM5XxTcvLRwo98Ym", "delta": "ared project still"}}
{"seq": 46, "event": "question", "data": {"message_id": "msg_011CgwTsgM5XxTcvLRwo98Ym", "number": 1, "title": "Removing another admin", "body": "Should an admin be allowed to remove another admin, and not only regular members? Only the owner would be protected from removal.", "recommendation": "Yes. Common default: admins have equal powers over members.", "preface": "Welcome back. … This session's questions restart at Q1. …"}}
{"seq": 47, "event": "turn", "data": {"outcome": "replied", "seconds": 6.1, "cost_usd": 0.026736, "session_cost_usd": 0.28267129999999996, "refused": 0}}
{"seq": 48, "event": "state", "data": {"state": "waiting_for_reply"}}
… PM: "Yes, admins can remove other admins." …
{"seq": 76, "event": "question", "data": {"number": 2, "title": "What a successful removal does", "body": "When an admin removes a teammate, should the teammate lose access to the workspace immediately, and should the admin see \"<name> was removed from the workspace.\"? …", "recommendation": "Yes.", "preface": "That's settled: admins can remove other admins. I'll leave the owner question open, since you didn't know the answer last time."}}
{"seq": 77, "event": "turn", "data": {"outcome": "replied", "seconds": 3.3, "cost_usd": 0.006968, "session_cost_usd": 0.28963929999999993, "refused": 0}}
{"seq": 79, "event": "ended", "data": {"reason": "stopped"}}
```

In run 2 the interviewer declined the approval request on its own, because the bridge's note says approval is done with the app's buttons. Run 2 therefore does not test the permission boundary. The findings record a separate run with no such note, in which the interviewer did try `slice approve` and Claude Code refused it (section 4.3).

## Known gaps

- `--slice` on a slice that is approved is not refused by the bridge. The host must refuse to start an interview on one.
- Reads are confined to the project, but not narrowed within it. A `.env` file in the project could be read.
- When a turn is interrupted, its partial text has already been streamed. The UI must drop that text, because no `message` event follows it.
