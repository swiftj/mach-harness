# M15: the Factory Floor brought up to date with M13 and M14 (as built)

Built 2026-11-20 on `feature/m15`. The Factory Floor stays a read-only view: the observer (`apps/observer`) is still GET only, loopback only, standard library only, writes only under `.factory/local/observer/`, starts no process and runs no MACH script. Nothing here is estimated: every new state comes from a code MACH recorded, and a code the Floor does not know falls back to what it showed before.

## What changed in the Factory, and what the Floor now shows

| Factory change | Where it is recorded | What the Floor shows |
|---|---|---|
| M13 build on today's main: a conflict with main stops the build (`needs: main-conflict`) | `gate.evaluated` `build.start`/`build.revise` refused `main-conflict` (the build station's refusal record); the supervisor's `human.required` "waiting for main-conflict" | **Waiting for you** at Build, "conflict with main"; Needs you: "Resolve the conflict with main on T"; `/mach decide T`, then `/mach explain T`. The wait ends when a build visit is entered again |
| M13 check at the merge: an approval voided because what landed on main touches the same ground | `gate.evaluated` `merge.landed_overlap` and `merge.land` refused `landed-overlap`; the merge exit `landed-overlap` with stage `built`; the voided `decision.json` | **Held** at Verify, "verify again", with the dashed "sent back" arc from Merge to Verify; it uses no judging round and needs nobody; `/mach explain T`. The merge column counts it as sent back. The catalogue marks the voided decision `reason_code: landed-overlap` |
| M13 repeat review round (`round-N.k`) | a second `review.round_started` for a decided round (revision 7 `repeat`) | its own visit and its own review entry in the full record: "round 1, repeat 1 (no judging round used)"; rounds used do not rise |
| M13 change record | `cell.json` `change_record` (read at `merge.completed`), the run record's `change_record` | side panel and full record: "Change record" with the repository path as text, never a link; "not recorded" otherwise |
| M13 Jira key | the intake ledger (`slices.<id>.jira`), the run record's `jira` | side panel and full record: "Jira" with the key as text, never a link; checked against Jira's form again in the observer |
| M13 epic view (outbox moment `epic-view`) | the intake ledger's outbox only | nothing: the outbox is not part of the event stream, and the Floor showed no other outbox moment either |
| M13 principles and effects | spec sections | nothing (spec content) |
| M14 policy packs: a spec held only by a policy concern (`needs: policy-owner`) | `gate.evaluated` `groom.finalize` refused `open-questions` with `open_questions: 0` (cell.py writes `policy_concerns_open` exactly then); the supervisor's "waiting for policy-owner" | **Waiting for you** at Groom, "policy owner"; Needs you: "Ask the policy's owner about T"; `/mach policy accept T <POL-id> "<the owner's words>"`, then `/mach explain T`, with a line saying only the owner accepts |
| M14 design mocks: a slice issue held at intake (`waiting: mocks`) | `intake.refused` with intake's sentence "Waiting for its design mocks: ..." (revision 7 `waiting: mocks`) | a row named by the slice, before Plan, **Waiting for you**, "waits for mocks", intake's words quoted contained; Needs you: "Commit the design mocks for SLICE-NNN"; `/mach product status`, then `/mach pull --dry-run`. The row leaves when the slice is taken in |
| M14 design mocks: `MOCK-N` checks | `results.json` `mocks`, `mock_records`, `records` (verify.py `compare` writes no lifecycle line) | the evidence player shows the approved mock and the captured screen side by side (stacked when narrow), each labelled in words, with the recorded result, the binding flag, the scenario and the verifier's differences and note as plain text, labelled free text |
| M14 factory evals, self-report | `.factory/evals/`, `.factory/local/faults/` | nothing; a test holds that the observer reads neither and names neither in its source |

No new colour role was needed: the new waits use the Line's existing five states (person, held) with their shapes and tones (STYLE_GUIDE 6.5, 8.8, 8.9).

## Observer

- **Event contract revision 7** (additive; `event.Revision` and `feed.SchemaRevision` are 7; `M6_1_EVENT_CONTRACT.md` section 10.7; `schemas/factory-event.v3.schema.json`): `human.required.needs` and `execution.completed.needs` (the routing sheet's stop codes, enumerated in `redact.StopCodes` and enforced by `redact.Enums`; an unknown code is `null`), `intake.refused.waiting` (`mocks`), `review.round_started.repeat`, `verify.check_recorded.target_kind` `design mock`, `slice.materialized.jira`, `run.recorded.jira` and `change_record`, `merge.completed.change_record`; the gate name pattern allows `_` after the dot (`merge.landed_overlap` was replaced by the station's name before); the inferred rules `fixed-phrase`, `decided-before`, `cell-file`.
- **Reading MACH's fixed words.** `needs` is read from intake's own phrase "waiting for <code>" and `waiting` from intake's own sentence, as `capacity.wait_changed` already reads the supervisor's fixed sentence. Each is marked inferred. The words themselves are still served as before.
- **Evidence catalogue** (`artifact/catalog.go`): a run's `results.json` mocks become `MockCheck` records on its entry; each evidence target of a design mock carries `role` (`approved-mock` or `capture`), `compared` and `binding`. The verifier's note and differences are scrubbed (credentials, paths, known people) and bounded to 280 characters.
- **Evidence route** (`server/artifacts.go`): a design mock's check is listed from `results.json` with `basis: "results.json"`, its two files with their roles and catalogue ids, and `mock` with the result and the words labelled `free_text_note`. `display_policy.free_text.catalog_fields` names the two places.
- **Synthetic generator** (`testkit/synth/m15.go`, `mach-synth --m15`): the new states in test data. Off by default, so every recorded history stays byte for byte as it was (`compat_test.go`).

## Line, Floor and evidence player (web)

- One reading for every view: `src/sim/stops.ts` (`cellStopOf`, `mockWaitsOf`, `recheckCount`), used by the Line's model and the Floor's activity (`selectors.ts`).
- The Line (`src/line/model.ts`): the four new rows above; `needVerb` for the Needs you strip; `alsoCommand`; `jira`, `changeRecord`, `rechecks`; `reviewOfVisit` and `visitRoundWords` for the full record. Panels show Jira, the change record and the rechecks in Facts; the full record says the same under the title.
- The Floor (isometric): only the activity a cell is drawn with: "Waits for the policy's owner", "Waits for a person: conflict with main" (waiting for a person), "Held: back to verify". No scenery was added.
- The evidence player: `MockCompare` in `EvidencePlayer.tsx`; the model (`evidence/model.ts`) gains `role`, `mock`, `mockSides`, `mockResultWords`, `ROLE_WORDS`. The page compares nothing. Selecting a mock's check requests both pictures (by catalogue id, only that check's, only while `floor.evidence_media` is on); withheld pictures say why in the existing words.
- The Simulation: ticket 131 gains `MOCK-1`, a non-binding mock that differs from its capture, drawn by the app and labelled as the simulation's sample.

## Analytics: what was checked

Each catalogue metric was read against the new records:

| Metric | Finding | Change |
|---|---|---|
| Q1 first-pass verification | a re-verification after a voided approval is a second round-1 `verify.verdict` and was counted again | **fixed**: only a ticket's first round-1 verdict counts |
| R1 review rejection rate | a repeat round's decision already replaced the voided one (M7) | none |
| R3 security veto rate | the voided decision stayed counted beside the repeat's | **fixed**: the repeat's decision takes its place, as in R1 |
| X2 gate refusals | `merge.landed_overlap` and `merge.land` refusals are refusals; the gate name is now kept | none (the name now groups correctly) |
| Q2, Q3, R5, R6, G1, G2 (observe parity) | read from run records; a void raises no `review_loop`, so `rounds` is unchanged | none; `tests/test_mach_analytics_parity.py` passes |
| C1, C2, remediation share (insight) | the re-verify and repeat review are real visits; their lifecycle round stays N, so they are not counted as later rounds | none |
| S4 parked for a person | `human.required` counts as before; `needs` changes no count | none |
| W3 human approval wait | a repeat round awaiting a person opens its own wait | none |
| Q4 failures by kind | `design mock` is a new `target_kind` group, from lifecycle checks only (none today) | none |
| T1, T2, C3, C4, W1, W2, W2b, W4, W5, X1, X3, S1 to S6, K1 to K10, G3 | not touched by these records | none |

Tested in `server/m15_metrics_test.go` (Q1, R1, R3, X2 on a rechecked ticket).

## Not built

- The observer's own projection views (`/api/v1/cells/{t}`, `/slices`, `/snapshot`) do not carry `needs`, the Jira key or the change record as fields; the page reads them from the events.
- `merge-recheck.md` (the merge station's reasons) is not catalogued; the full record says the recheck sent the ticket back, not which files.
- `decide` has no policy-owner state; the Line offers the accept command the run skill routes, with the POL id and the owner's words for the person to fill in.
- The outbox moment `epic-view` is not shown (no outbox moment is).
- A `MOCK-N` lifecycle record: verify.py `compare` writes none, so a mock's check has no recorded time (`at` is null) and is grouped with its run by the catalogue's link.

## How far tested

- Go: `normalize/m15_test.go` (each new field, an unknown code, a smuggled value, the schema), `artifact/m15_mocks_test.go`, `server/m15_mocks_test.go`, `server/m15_metrics_test.go`, `ingest/m15_ignored_test.go`, `testkit/synth/m15_test.go` (the generated project indexed with nothing unrecognised and every new field present).
- Web: `test/m15-states.test.mjs` (the Line rows, Needs you, commands, the Floor's activity, the repeat round, the mock wait, Jira and change record, the evidence model live and simulated).
- Results on this branch: `go vet` and `go test ./...` in `apps/observer` pass (16 packages); the Factory Floor's unit tests 391 of 391; its end-to-end suites `test:e2e:evidence` (2) and `test:e2e:floor` (6) pass; the web workspace's typecheck, lint and build pass; the contrast report shows no failing pair (no token was added); `apps/observer/build.sh` and `smoke.sh` pass; `make test` 1,633 tests, OK (1 skipped).
- One existing assertion changed: `test/evidence-model.test.mjs` expects a simulated picture's `role` when it has one (the new mock sample). `compat_test.go`'s recorded histories are unchanged (M15 data is opt-in).
- The screens were not looked at: no screenshot or video was captured. The new view of a design mock, the Line's new rows and the Floor's new activity words were checked by unit tests and the existing end-to-end suites (which read the accessibility tree), not by eye.
