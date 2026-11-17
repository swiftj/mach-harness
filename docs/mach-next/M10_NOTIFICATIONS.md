# M10: Notifications

Status: design, 2026-11-16. Step 5 of `docs/mach-github-issues-integration-spec.md`.

## 1. Purpose

Tell a channel when a ticket is waiting for a person, so unattended work does not sit unnoticed. One
outbound message per waiting ticket. Nothing else: no progress feed, no successes, no reminders.

It is off on every machine until a person turns it on there. It can never approve, start or change
anything, and it never carries a link that does.

## 2. Where the address lives

The webhook's address is a secret. It lives only in `.factory/local/notify.json`, private to the user
(mode 0600) and git-ignored like the rest of `.factory/local/`:
`{"version": 1, "url", "label", "created_at", "machine"}`.

- Missing, unreadable, malformed, or written on another machine: off.
- No tracked file can turn notifications on or supply an address. The project's tracked settings can
  only forbid them: `"factory": {"notifications": false}`.
- The address is never printed, logged, put in an event, or passed on a command line. Status shows the
  host only.

## 3. Commands (through the run skill, on a person's word)

| Input | What it does |
|---|---|
| `/mach notify` or `notify status` | Whether it is on here, the host it sends to, the label, the last message sent and any failures. Changes nothing. |
| `notify set --from-file <path>` or `--from-env <NAME>` [`--label <words>`] | Reads the address from a file the person wrote or an environment variable they set, checks it, and stores it. The address never passes through the conversation: the skill tells the person how to put it in a file themselves, and never asks them to paste it. |
| `notify test` | Sends one test message. |
| `notify off` | Removes the stored address. |

The address must be `https`, name a host, and carry no user name or password. `set` sends nothing.

## 4. When a message is sent

Only when work that nobody is watching stops for a person:

1. **A run of several tickets, or any headless run driven by hand:** `run.py next <ticket> --headless`
   answers `stop` with something a person must do (`needs` other than `nothing`, and not
   `worker-in-cell`).
2. **A supervised execution ends** with the ticket waiting for a person, or **the supervisor parks** a
   ticket for a person. The supervisor sends these; a `run.py` call inside a supervised execution never
   sends and never reads the address.

3. **An approved ticket waits to be merged** because this machine does not merge unattended, though the
   project's settings would let the line merge. The supervisor sends this too.

A person driving one ticket in conversation (`/mach <ticket>`, not headless) is already there: nothing
is sent.

**Once per wait.** A message is keyed by ticket and stage, recorded in
`.factory/local/notify-state.json` before it is sent. The same ticket at the same stage is not announced
again, whichever path saw it first. When the ticket moves on and later waits at another stage, that is a
new wait.

## 5. What a message says

Fixed words and identifiers only:

```
MACH · <label>: LOCAL-014 is waiting for a person.
Approve the change, or not, after reading the review findings.
In Claude Code: /mach decide
```

- `<label>` is the person's own words from `notify set --label`, or the project folder's name.
- The middle line is the script's fixed sentence for that kind of wait (`NEEDS_TEXT`), or a fixed
  sentence for a parked ticket by its reason code. Never a ticket title, a reviewer's or verifier's
  text, a file path, a commit, a person's name, or a link.
- The last line is the command, in the form this install uses (`/mach decide` or `/mach:run decide`).

Body: `{"text": …}`, and for a Discord address `{"content": …}`, chosen by the address's host.

## 6. Sending

Standard library only (`urllib`). One POST, five-second timeout, redirects refused (an address that
redirects is treated as a failure, so the message cannot be carried to another host). A failure never
changes a station's result, a step's answer or an exit code. It is recorded in the state file with the
HTTP status or the kind of error (never the address or the response body), tried again on the next
occasion for that wait up to five times, then given up and shown in `notify status`.

## 7. Boundaries

- Outbound only. Nothing listens.
- The observer, Product Studio, intake, release qualification, `doctor`, `explain` and `decide` never
  read `.factory/local/notify.json` and never send.
- Enabling notifications enables nothing else, and `factory enable` is unchanged.
- Tracked settings that forbid notifications are honoured by every path, including `notify test`.

## 8. Not in this step

Messages for anything but a wait for a person; several channels; rich formatting; reminders; an
acknowledgement from the channel; reading replies.
