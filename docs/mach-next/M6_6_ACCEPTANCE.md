# MACH Next M6.6: Control Tower integration and production hardening — acceptance report

M6.6 made the three Control Tower workspaces (Factory Floor, Execution Timeline, Factory Analytics) behave as
one product, checked them against real MACH Factory execution, and hardened the observer boundary. It added no
workspace and no execution authority. The full Evidence Theater stays deferred.

Companion documents: `M6_6_PERFORMANCE.md`, `M6_6_ACCESSIBILITY.md`, `M6_6_RELIABILITY.md`, `M6_6_PACKAGING.md`,
`M6_6_RULES_REVIEW.md`, `M6_6_JOURNEY.md`, and section 8 of `M6_5_SECURITY.md`.

## 1. Baseline and commits

- Baseline: `20326ab` on `main`, the merge of M6.5. The M6.5 branch had been merged and deleted.
- Branch: `feature/mach-next-m6-6-control-tower-hardening`, in its own worktree. `main` was not touched.
- Baseline regression on `20326ab` before any change: Go vet and tests pass (16 packages), web lint, typecheck
  and build pass, Control Tower unit tests 602 of 602, Python 630 pass (1 skipped).

| Commit | What |
|---|---|
| `071e186` | Three stale facts in `CLAUDE.md` |
| `d9edd9a` | Observer: real-run defects and security fixes |
| `aa5d9be` | Control Tower: replay, states, time wording, free-text containment, journeys |
| `4180c16` | Design notes brought in line |
| `cc37615` | Rules review and packaging validation; two small fixes |
| `359995b` | Two cost rules counted failed executions as missing a cost |
| `65f4f78`, `d99edb4` | Capped lists, basis and coverage labels, acceptance wording |
| `fa29636` | Timeline scrub regression fixed; timing tests made load-independent |
| `b3878f0`, `d14c7b8` | Recovery and accessibility results |
| `e82fe24` | Accessibility and recovery fixes |
| the commit after | An archived cell's log is not a lost source; the held overview's summary stops at the playhead; a key event with no key is ignored; this report and the journey |

## 2. Changes made

**One product across three workspaces**
- Held at an earlier moment, nothing after the playhead is shown: Timeline tracks, hover words, table, lenses
  and overview stop at the playhead; a span open there reads as open. An off-by-default control, "Show what
  happened after this moment", brings the later history back, tinted. This reverses M6.3's T6 decision.
- Analytics shows the observer's state (live, replay, simulation, stale, disconnected, no session), missing
  history, and a "Back to live" action. It no longer always reads "Live Factory".
- Day-counted figures say which UTC day they stop at and which parts of an area are cut at the playhead
  exactly. A window is never inverted. An observer without replay-moment support gets "not available".
- Journey links: a station visit opens its measured history in Flow; a failed verification or rejected review
  offers "Show the floor at this moment"; Back restores an Analytics view's sort, toggles and scroll.
- One duration and basis vocabulary across Analytics, the Timeline and the observer's insight text.

**What the real runs exposed** (section 5)
- A supervisor hold now shows as held, with its recorded reason; a wait on a person ends at the approval;
  slice titles come from the intake ledger; a ticket with no cell is not a cell; a visit that outlived its
  execution is bounded, not measured; a capacity wait starts at its first record.
- Cost: the metric's definition is unchanged (section 13); the reason shown for excluded executions is now
  true, and failed executions' own recorded cost shows as a separate line, never added in.

**Security** (section 8), **performance** (section 9), **accessibility** (section 10).

## 3. M6.5 limitations resolved

| M6.5 limitation | State |
|---|---|
| No real Factory run through Analytics | Done: two live runs and one recorded run replayed (section 5) |
| Later outcomes shown when scrubbed back | Fixed in the Timeline; a leak in Analytics found by the real run and fixed |
| Analytics hid observer state and gaps | Fixed |
| Replay captions read as the exact moment | Fixed |
| Free text unlabelled outside Analytics | Fixed: floor, Blueprint, inspectors, Timeline; tooltips and accessible names carry codes only |
| Three duration vocabularies | Fixed |
| Trend charts without the Timeline ruler | Fixed |
| Brush 264 ms against 200 ms | Not a defect: 37 ms median, 107 ms worst over 40 drags |
| Intermittent unit test under load | `live-scale` made deterministic; see section 4 for what remains |
| "17 rules" | There are 18; the documents miscounted |

## 4. Unresolved limitations

| Limitation | Severity |
|---|---|
| Floor-to-Timeline switch on a 240,000-event history: 598–874 ms against a 300 ms budget (was 2.0–4.9 s) | Should-fix |
| Blueprint navigation and zoom, and observer CPU per appended event (1.65 ms against 1 ms), over budget on M6.5 and M6.6 alike | Should-fix |
| A supervisor hold cannot be shown as "waiting on a person": the Factory records the reason as prose with no code | Needs a Factory-side change |
| Repeated cell lifecycle lines are counted again (lifecycle lines carry no identity) | Should-fix, known since M6.2 |
| At 320 px some buttons inside Analytics charts and tables extend past the edge (their regions scroll sideways); a text-spacing stylesheet injected after load clips the Timeline toolbar | Should-fix |
| Four rules never run in the default whole-history view; one cannot fire while reviews record no rule list; one fires on normal test-first refusals | Product owner (section 13) |
| R1: a person's name in free text is still served, labelled and contained | Open by decision (section 8) |
| No published release carries the observer | Release work |
| The unit suite failed once in a back-to-back run, no test named, and then passed three times at load 20; three tests still assert on elapsed time with generous limits | Note |
| Not measured: a 30-minute browser memory session, three clients under load, the long-history Timeline browser test on the final build | Note |

## 5. Real Factory acceptance evidence

All Factory runs were in throwaway projects under the session's scratch folder, enabled through
`factory enable` and its confirmation code, in supervised mode, never merging automatically. No `.factory`
exists in the main checkout or the M6.6 worktree before or after; no hook, timer or service was installed.

**Live run 1** (baseline build `20326ab`, 14 Nov, USD 3.45, three executions): an approved wave through
intake; a dependency hold; two cells at once; the belt workflow; 51 agents; build, verification and review; a
human gate; approval, by-person merge and cleanup; the dependent slice then running. No retry occurred and
none was manufactured. Station times matched the lifecycle logs to the millisecond; concurrency, waits, cost,
tokens, station shares, provenance and insight reasons matched the records. The project's 632 files were
identical after closing the browser and after stopping the observer; executions wrote records while the
observer was down; all page requests were GET to `127.0.0.1`.

Defects it found, all fixed: Analytics showing whole-history figures at a past playhead (the reply cache
ignored the cut); a supervisor hold invisible on the floor; redaction eating "authorized: the …"; an inverted
replay window; a wait on a person running 36 s past the approval; slice titles shown as not recorded.

**Recorded real run replayed** (13 Nov, High risk, two rejected review rounds with a security veto, three
executions of which two failed, two waits on a person): this is a replay of genuine records, not a live run.
The Timeline's retry path, the floor at four moments and hand-checked Analytics figures matched the records.
Defects it found, fixed: a wait counted as build time; a phantom cell; a capacity wait drawn from before its
first record; the wrong reason beside recorded cost.

**Live run 2 and the engineer journey** (final build): see section 6 and `M6_6_JOURNEY.md`.

**Not verified against a live run:** a retry or remediation cycle (seen only in the replayed record); a
supervisor restart; a failure induced on purpose.

## 6. Cross-view navigation and the engineer journey

Scripted browser tests on the final commit `e82fe24`, run by the lead:

| Suite | Result |
|---|---|
| Analytics (proof, shell over the Simulation, live observer) and the four M6.6 journey tests | 37 tests: 36 pass, 0 fail, 1 deliberate skip |
| Timeline (synthetic, real-run, live) | 32 tests: 32 pass |

The journey tests cover journeys 2, 3, 5 and 6 of the brief on a real observer over a synthetic history.
The recorded end-to-end journey on a live Factory is in `M6_6_JOURNEY.md`; its result is summarised here:

**Live run 2** (final build `e82fe24`, 14 Nov, USD 2.16, two executions, a new throwaway project, Silver
audit): both executions ran at once and stopped at the human gate; one was approved, merged by person and
cleaned up; the daily run limit held the third slice, as set; the Factory was disabled afterwards. All 13
journey steps passed, each checked from page text or the project's records: open on the live Factory, watch
work scheduled and built, inspect an active cell, its Timeline, a recorded refusal, a reviewer result shown
as contained free text, Analytics, the station's measured history, the executions behind a figure and back
to the Timeline, the floor, a 30-second browser close and reopen through a second-browser link, the
executions continuing meanwhile, and the completed work inspected as history. Held mid-run, the floor and
Analytics showed no cost, merge or outcome from later.

The defects of live run 1 did not reproduce: the held slice read "held by the supervisor" with its reason,
and the wait on a person ended at the recorded approval. Three steps needed a second attempt because the
script's selectors were wrong, not the product. Limits: the browser gap fell near the end of the runs, so
only three lifecycle lines were written during it; no retry happened live; the recording is in three files
and no capture shows the two cells mid-build.

It found three lesser defects: a cleaned-up cell's log reported as an unavailable source, the Timeline
overview's summary naming the history's end and total while held, and a page error from a synthetic key
event. The first two are fixed in the commit after `e82fe24`; none was must-fix.

## 7. Screenshots and recordings

Git-ignored, in the worktree under `web/apps/control-tower/`: `screenshots/m66/real/` and
`recordings/m66/real/` (live run 1 and the replay, on the baseline build), `screenshots/m66/final/` and
`recordings/m66/final/` (final build). Agents did not review the final set as images; it is for the product
owner to look through. Intermediate sets (`states/`, `floor/`, `words/`) predate later fixes.

## 8. Security and privacy

A review attacked a running observer and read the code. Held: loopback-only binding (no flag or environment
value changes it); the one-time link and session cookie on every route, the event stream and artifacts; Host
and Origin checks against rebinding and cross-site requests; GET only; every path, symlink, hard-link, FIFO
and archive-member trick refused; prompts, thinking, tool inputs and results, environment values, secrets and
absolute paths absent from 318 replies, the event stream, the index and stderr; 34,191 fuzzed requests with no
5xx; analytics opens no artifact file; the page makes only same-origin GET requests.

Fixed: one implausible timestamp flooding the Timeline (tens of thousands of requests, a crashed tab); the
observer writing outside its folder through a linked `index` folder; forged access-log lines; a learned name
rewriting a JSON key; undeclared copies of free text (42 places now declared, with a test that fails on any
new one); free text shown unlabelled and in tooltips and accessible names.

**R1 remains open.** A person's name that appears only in prose is still served: the declared event fields
and their copies, artifact content, file names and the project folder name. The policy is label-and-contain,
unchanged. On a single engineer's laptop the observer adds no reader of files that engineer cannot already
open. In a shared or screen-shared setting the prose is visible to whoever sees the screen. Redaction is not
comprehensive and is not claimed to be. **If the release environment requires stronger confidentiality, this
gate fails**; the remediation is to withhold prose at the observer by default and show codes and counts,
which needs allowlist and projection changes and the product owner reversing "label, do not withhold".

## 9. Performance

On a regenerated 240,000-event history, five runs each on `20326ab` and M6.6, on a machine that was never
quiet (absolute times are upper bounds). Full tables: `M6_6_PERFORMANCE.md`.

| Measure | M6.5 | M6.6 | Budget |
|---|---|---|---|
| Timeline playhead step | 6.5 ms | 32 ms (579 ms before the fix) | 100 ms |
| Floor-to-Timeline switch, first / later | 2.0–4.9 s | 874 / 598 ms | 300 ms |
| Analytics brush | — | 37 ms median, 107 ms worst | 200 ms |
| Observer rebuild, restart, warm queries | within budget | within budget | — |

M6.6 introduced a scrub regression (the cut at the playhead re-assigned every mark to a track on every step)
and removed it in `fa29636`.

## 10. Accessibility

Scripted results and the manual checklist are kept apart in `M6_6_ACCESSIBILITY.md`. After the fixes: axe
reports 0 violations across 22 states (24 nodes before); no control is off screen at 320 px; focus rings draw
again (a Tailwind 4 outline-style defect); failed bars carry a non-colour cue; keyboard walk with no trap;
reduced motion honoured. **No screen-reader session was run, Safari was checked only through Playwright's
WebKit for three checks, and no WCAG conformance is claimed.** The manual checks (VoiceOver with Chrome and
Safari, real 400% zoom, increased contrast) are a 20-minute checklist for a person.

## 11. Packaging and installation

Validated in a throwaway project from a locally built release layout (`M6_6_PACKAGING.md`): checksum refusal,
unavailable URL, upgrade, uninstall, the run skill's start step, loopback-only binding, no Node.js needed,
clean shutdown on SIGINT and SIGTERM, start-up diagnostics, the Factory staying disabled. Product Studio's
install paths are unchanged since M6.3. **Not verified:** per-platform release builds, attestation, and the
installer downloading from GitHub; only a tagged release can show those. The installer checks the checksum
file and not the release's signed attestation.

## 12. Regression results

Run by the lead on the final tree. The browser suites ran on `e82fe24`, one commit before the last three small fixes.

| Suite | Data | Result |
|---|---|---|
| Go vet and tests, 16 packages | synthetic and recorded-shape | pass |
| Python `make test` | fixtures | 631 run, pass (1 skipped) |
| Web lint, typecheck, build | — | pass |
| Control Tower unit tests | fixtures | 692 of 692 |
| Tower guards, observe parity | — | pass |
| Analytics and journey browser tests | synthetic, real observer | 36 pass, 1 skip |
| Timeline browser tests | synthetic and a recorded real run | 32 pass |
| Recovery scenarios | replayed real records | 10 pass, 2 partial, 1 fail (`M6_6_RELIABILITY.md`) |
| Accessibility scripts | recorded real run | see section 10 |
| Live Factory | genuine execution | two runs (sections 5 and 6) |

Not run on the final build: the long-history Timeline browser test; WebKit after the accessibility fixes;
recovery scenarios 4 and 8 after their fixes.

## 13. Remaining product risks and decisions for the product owner

1. **Recorded cost excludes failed executions** by the metric's definition, because the Factory records no
   cost on a failed execution. On the recorded run that meant USD 1.29 shown against USD 4.73 spent. Changing
   it means redefining the metric or recording cost on failure in the Factory.
2. **Supervisor holds carry no reason code**, so a hold only a person can clear is not shown as a human wait.
3. **Rule thresholds and populations** are M6.5's choices (`M6_6_RULES_REVIEW.md`): whether build is exempt
   from the station-time-share rule; whether test-first refusals count as recurring gate refusals; whether
   the default view should pick a window so four rules can run.
4. **R1** (section 8).
5. **`templates/AGENTS.md` says observe's proposals are "for a person to approve"** while `CLAUDE.md` and the
   observe skill say tuning needs no person. Not changed: it is a human-approval rule.
6. **Product acceptance is not recorded by MACH.** Analytics says integrated, never accepted.

## 14. Recommendation

The Control Tower is ready for release-candidate testing by engineers on their own machines, with three
conditions: a person runs the manual accessibility checklist and looks through the final captures; the
product owner accepts R1 for that environment; a release is tagged so the per-platform builds, attestation
and installer download can be checked. It is not ready for an environment that requires confidentiality of
free text.

## 15. Requirements for M7

1. Record a reason code on supervisor holds and a cost on failed executions (Factory-side, recorded only).
2. Give lifecycle lines an identity so a repeated line is not counted twice.
3. Bring the floor-to-Timeline switch, Blueprint navigation and per-event observer CPU within budget on
   large histories.
4. Decide R1 for shared environments; if prose is to be withheld, do it at the observer.
5. Verify release provenance in the installer (attestation, not only the checksum file).
6. A screen-reader pass and a real Safari pass, and the remaining 320 px items.
7. A live run that includes a rejection and remediation, and a supervisor restart, observed through the
   Control Tower.
8. The Evidence Theater, on the guarded artifact access that exists.
