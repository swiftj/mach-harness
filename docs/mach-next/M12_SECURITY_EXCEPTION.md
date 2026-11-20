# M12: a recorded exception for a security blocker (as built)

Gap G4 in `M7_REVIEW_GATE_AUDIT.md`, built to the smallest design in its section 6 after the product owner said yes.
Before this, a high or critical security blocker, or a blocker from the security seat under `review.security_veto`,
could be cleared only by a fix and a new round, escalation or abandoning. Now a person can also record that the
finding is real and accepted for one commit, with their reason.

## The command

```
review.py except <ticket> --finding <round>/<seat>/<n> [--finding ...] --by "<name>" --reason "<their words>" [--expires YYYY-MM-DD]
```

Reached as `/mach except <ticket> <round>/<seat>/<n> "<why>"` through the run skill, which shows the finding first,
asks for the reason in the person's words, never offers it unprompted and never runs it unattended. The reference is
the round folder's number (`1`, or `1.1` for a repeat), the seat, and the finding's place in that seat's findings,
counting from 1. `run.py explain` lists each blocker with its `ref`.

## Rules (all in `skills/review/scripts/review.py`, `exception_state` and `cmd_except`)

1. **A person's act only.** Refused when `MACH_EXECUTION_ID` is set (a supervised Factory execution). No unattended
   instruction file, the belt workflow, the supervisor or intake names it; `tests/test_unattended_commands.py` holds
   that no unattended instruction prescribes it.
2. **Only a blocker that vetoed.** The tally now records `vetoing` in `decision.json`: each high or critical
   security-class blocker, and each security-seat blocker when `security_veto` applied. An exception names one of
   those. A note, or an ordinary blocker, is refused: "an ordinary blocker is outvoted or fixed, never excepted". The
   list is fixed at the tally, so changing `security_veto` afterwards changes nothing. A round decided before this
   field existed is recounted with today's setting.
3. **Only a round the veto alone rejected.** The decision's `security_veto` must be true (approvals met the
   threshold). A round that failed on the count is refused with that explanation.
4. **Only before a revision, on the reviewed commit.** The round must be the latest decision (not sent back by the
   merge station or a person), the cell must be where the tally left it (`built` for `REJECTED`, `blocked` for
   `ESCALATE`), `build.json`'s loop must not have moved past the round, and the branch must be the reviewed commit.
5. **Never a `factory-tuning` ticket.** Its panel is unanimous and no person signs it off.
6. **Who.** `--by` names the person. `review.security_exception_by`, a list of names in `.factory/config.json`
   (`[]` in the template), limits who may grant one when it is not empty; matching ignores case and spacing. A value
   that is not a list of names refuses every exception until fixed. It guards against accident, not forgery: anyone
   who can edit the file can add a name.
7. **Why.** At least ten characters, whitespace folded, redacted with the ticket station's `issue_rules.redact`,
   at most 2,000 characters.
8. **Expiry.** Optional, `YYYY-MM-DD`, today or later. It holds through that day (UTC). Without one it holds for the
   commit reviewed only.
9. **What is written.** `exceptions[]` in the round's `decision.json` and in `review/decision.json`: round, seat,
   index, title, rule, file, line, class, impact, `vetoed_as` (`security-class` or `security-seat`), `head` (the commit
   reviewed), `by`, `reason`, `expires`, `recorded_at`, `recorded_by`. No vote and no finding is edited.
10. **What the round becomes.** While another vetoing blocker has none, nothing changes and the output lists
    `remaining`. Once each has one, the outcome is what the count alone gives: `APPROVED`, or `AWAITING_HUMAN` where
    the tier or a Silver audit needs a person (`outcome_before_exception` keeps `REJECTED` or `ESCALATE`). The cell
    moves to `approved` or `awaiting-human` through the script. An exception is not a person's approval:
    `approve-human` is still needed, and it refuses while an exception has expired.
11. **No judging round is used**, and the three-round limit is unchanged.
12. **Renewal.** Once an exception has expired, a person may record a new one for the same finding on the approved
    round (same commit, or the merge station's revalidated commit). The new entry carries `renews` (the index of the
    expired one, which is kept). While it is in force, a second one is refused.

Under the default thresholds an exception is reachable only at Medium risk: at High (3 of 3) and Low (1 of 1) the
vetoing seat's own reject already fails the count, so the round failed on the count and is refused (rule 3).

## Binding at merge (`skills/merge/scripts/merge.py`)

- **The commit.** The approval's own binding applies unchanged: the merge station voids an approval when the branch
  is neither the approved commit nor the commit its own revalidation recorded (`revalidated.head`). An excepted
  approval is voided the same way, and the voided round keeps its exceptions on record. The rule found for
  revalidation: when main has moved, merge merges main into the branch, reruns the suite and records
  `revalidated.head`; the approval holds at that commit because only the station's own merge of main was added. The
  exception follows it: its `head` stays the reviewed commit, and it is honoured at the revalidated commit exactly
  where the approval is. A renewal is accepted at either commit.
- **The expiry.** `survey` refuses while the latest exception for any finding has expired (`exception-expired` in the
  lifecycle gate record) and changes nothing: the cell stays `approved`. `run.py next` stops with
  `needs: security-exception-expired` (also at `awaiting-human`), which notifications carry like any other wait.
- **The pull request body** gains "Security exceptions": each finding, who accepted it, until when, and the reason,
  redacted, bounded and linking nothing.

## Where it is recorded

- **Lifecycle log.** `review.exception_recorded` (station `review`), between a `station.entered` and a
  `station.exited` whose stage is the new one: round, the findings by seat, index and impact, `expires_given`,
  `renewal`, `outcome`. Never the name or the reason. `docs/mach-next/schemas/cell-lifecycle.schema.json` knows it.
- **Run record** (`cleanup.py`). `security_exceptions`, present only for a ticket that had one (so every other record
  keeps its exact shape, which the analytics fixtures and `tests/test_cleanup.py` hold): round, seat, index, title, rule, file, class, impact, head,
  expires, renewal, recorded_at; never `by` or `reason`, which stay in the archived `decision.json`. Each blocker in
  `blockers` also carries `class` and `impact` when the finding had them, and `excepted: true` when one was recorded.
  `record_version` stays 2: optional fields, as M8 decided for `product.origin`; readers ignore keys they do not know.
- **`run.py explain`.** `security_exceptions` (who, why, expiry, expired, in force) and `ref` and `excepted` on each
  blocker.
- **`run.py decide`.** An option "Record a security exception", never recommended, only where `exception_state`
  accepts it: for a ticket a person names after a vetoed rejection (state `security-veto`, beside letting the builder
  fix it and abandoning), for an escalated round the veto alone rejected, and for an expired one
  (state `exception-expired`). The walkthrough of every waiting ticket does not list a vetoed rejection: the line
  revises it, and nothing offers an exception unprompted. decide loads `review.py` for its read-only check, which asks
  Git for the branch's commit.
- **Release qualification** (`qualify.py`). An excepted blocker still found in the approving round is listed under
  `security.open_review_blockers` with `excepted` (who, why, finding, commit, expiry), and its check stays `fail` with
  that `exception` attached. By the existing outcome rules a gap that carries a person's exception makes the release
  `qualified_with_exceptions`, never `qualified`; that is what was chosen, because the person accepted exactly this
  finding with a reason on record, and the release still says it is open. An exception whose expiry has passed when the
  release is evaluated is not applied (`exception_expired`), so the release is `blocked` until a person records a
  release exception for that commit or the finding is fixed. A blocker is matched to its exception by seat, title,
  rule and file, since the run record keeps no finding index for blockers. A security-class blocker from any seat now
  counts as a security blocker there, not only one from the security seat.
- **Observer** (`apps/observer`). An unknown lifecycle kind was not dropped silently: it became a `history.gap`
  (`unknown-type`), marking the history incomplete. So the kind is registered: event schema 3 revision 5 (additive),
  `event.Kinds` and the server's list (54 kinds), the lifecycle normaliser (codes only, a name or reason withheld),
  the allowlist and its required IDs, and `factory-event.v3.schema.json`. The Factory Floor web app was not changed;
  it keeps a kind it does not know in its log and never reduces it.

## Invariants and their tests (`tests/test_security_exception.py`)

- No silent weakening: only vetoing blockers, only a veto-alone rejection, nothing edited, every exception visible in
  the decision, the pull request, `explain`, the run record and the release snapshot.
- Nothing unattended records or uses it: refused under `MACH_EXECUTION_ID`; no unattended instruction, workflow or
  supervisor file names it; the consented tool list is unchanged.
- The supervisor still refuses unattended work when tracked settings weaken the veto; naming exception owners is not
  a weakening.
- A `factory-tuning` ticket is never excepted. The observe station never proposes one: it can target only rule files.
- The three-round limit is unchanged; an exception uses no round.

## Decisions made where the design was silent

- Several findings may be excepted in one call (`--finding` repeated), all or nothing, so one person's decision on
  two related findings is recorded at once and never half applied.
- An escalated round (`ESCALATE`, the last round) can be excepted when the veto alone rejected it: escalation there
  came only from the veto. The output says to take the `blocked-requires-sme` label off.
- An expired exception stops for a person instead of voiding the approval; the person renews it or abandons the
  ticket. Voiding would send the ticket back through verification and a fresh review with no person asked.
- The run record leaves out `by` and `reason`, as it already leaves out a person's approval's name.

## Not verified

- No live run: every rule here is held by unit and integration tests on fixture projects.
- The pull request body with exceptions was checked as text, not posted to GitHub.
