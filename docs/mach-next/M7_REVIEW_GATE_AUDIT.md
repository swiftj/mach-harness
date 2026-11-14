# M7 — Review gate audit: can a security blocker be outvoted or bypassed?

Version 1, baseline `106f4d3`. Phase 4 of the M7 brief ("Audit the current MACH review semantics"). Read-only:
nothing in MACH was changed. Every statement is from the code and tests at `106f4d3`; line numbers are for that
commit. No test was run for this audit (the lead runs the baseline); "tested" below means a test exists that
asserts the behaviour, and the M6.6 regression run (`M6_6_ACCEPTANCE.md` section 12) reported the Python suite
passing on the final tree.

## 1. The mechanism in four facts

1. **Severity is two-valued.** `SEVERITIES = ("blocker", "note")` (`skills/review/scripts/review.py:50`); any other
   value is refused (`review.py:305-307`). There is no High, Critical, CVSS, category or "security" flag on a
   finding. A blocker must carry a `rule` and a `file` (`review.py:312-316`); nothing else.
2. **A vote follows from findings.** Any blocker makes the seat's vote `REJECT` (`review.py:369-370`).
3. **The veto is keyed on the seat, not on the finding.** `vetoed` is true when the config does not say
   `security_veto: false` **and the seat named `security`** has a blocker (`review.py:408-411`). A security
   problem raised as a blocker by the `architecture`, `product` or `general` seat is an ordinary blocker.
4. **Approval needs the count and no veto.** `approvals >= needed and not vetoed` approves (`review.py:412-413`);
   otherwise `REJECTED`, or `ESCALATE` in the last round (`review.py:414-415`). The overruled seats are printed
   (`review.py:436`, `overruled_blockers_from`) and listed in `findings.md`, but **not stored in
   `decision.json`** (`review.py:418-424`). `decision.security_veto` is true only when the veto changed the
   outcome (`review.py:421`), so a security-seat blocker on a round that failed the count anyway is not marked.

Panels (`review.py:45-49`, `templates/config.json:17-21`): High 3 seats / 3 approvals / person; Medium 3 / 2 / no
person; Low 1 seat (`general`) / 1. Tuning (`factory-tuning` label): 3 seats on the contracts tier / 3 / no person
(`review.py:190-195`). Unknown risk is treated as High (`review.py:228`).

## 2. Per tier and per switch

| # | Path | Can a security-seat blocker be outvoted or bypassed? | Can a security finding raised by another seat be outvoted? | Evidence |
|---|---|---|---|---|
| A | **Medium, defaults** (2 of 3) | **No.** The veto rejects whatever the count. | **Yes.** Two approving seats (including an approving `security` seat) outvote a third seat's blocker; the round is APPROVED and the cell `approved`. | `review.py:408-415`; `tests/test_review.py:428-438` (veto), `:346-368` (product blocker outvoted, APPROVED) |
| B | **High, defaults** (3 of 3 + person) | No: unanimity already means any blocker rejects; the person signs off only after the panel approved. | No (unanimous). | `review.py:46`, `:449-452`; `tests/test_review.py:385-400` |
| C | **Low, defaults** (1 of 1, `general` seat) | No security seat exists, so the veto can never fire. The single seat's blocker still rejects (1 of 1), so nothing is outvoted. **A security specialist never looks at a Low ticket.** | No (1 of 1). | `review.py:208` (`["general"]` when one seat), `:43` |
| D | **`review.security_veto: false`** in tracked `.factory/config.json` | **Yes**, on any 3-seat panel whose approvals threshold is below 3 (Medium by default). | Yes (as A). | `review.py:410`; `tests/test_review.py:448-455` |
| D1 | …under the supervisor | Refused at `factory enable`, `confirm` and `resume` (preflight `security_review`). **Not re-checked per pass**: the preflight is called only at `activation.py:149`, `:187`, `:251`; a tracked change to `false` after enabling is not refused until the next resume. Interactive `/mach-run` and the belt workflow never check it. Provenance records the value per execution (`provenance.py:247-248`). | — | `skills/run/scripts/policy.py:369-372`; `tests/test_mach_factory_supervisor.py:278` |
| E | **Tier overrides in tracked config** (`review.<tier>.reviewers / approvals / human_approval`) | **Yes, by removing the seat.** `review.medium.reviewers: 1` (or `review.high.reviewers: 1`) collapses the panel to one `general` seat (`review.py:204`, `:208`): no security seat, no veto. `review.high.human_approval: false` removes the person from High (`review.py:202-203`). `review.medium.approvals: 1` lets one approval outvote two blockers from non-security seats. **No preflight checks any of these** (policy.py checks only `security_veto`). Provenance records the tiers (`provenance.py:28`). | Yes (with lowered approvals). | `review.py:196-205`; `tests/test_review.py:203-214` tests raising, not lowering; no test for `reviewers: 1` on Medium/High |
| F | **`factory-tuning` label** | No outvoting: unanimous 3 of 3 with a security seat. **But** the label clears every human-approval reason, including High risk and a Silver readiness tier (`review.py:239-240`), when the diff touches only rule files, `SKILL.md`, `skills/*/references/*`, slice specs and tests (`review.py:54-57`, `:278-282`). The label is read from the ticket's inbox JSON or local ticket file (`review.py:179-187`); who applied it is not checked. `SKILL.md` files are agent instructions, so a tuning ticket can change station behaviour with no person. By design (`CLAUDE.md` section 4.8). | No. | `tests/test_review.py:540-575` |
| G | **Human approval** (`approve-human`) | **No.** It is accepted only when the outcome is `AWAITING_HUMAN` (`review.py:451`), which needs the panel to have approved with no veto. A person cannot approve over a rejection; there is no command to do so. | No. | `tests/test_review.py:476-486` |
| H | **`merge.py --by-person`** | **No.** It lifts only `merge.mode` and `merge.auto.<tier>` (`skills/merge/scripts/merge.py:203-206`); the stage must be `approved`/`pr-open`, the decision `APPROVED`, and a required human approval present (`merge.py:192-197`). A commit after approval voids it. | No. | `tests/test_merge.py:99-110`, `:121-139` |
| I | **Delta review, rounds 2–3** | **Partly.** A blocker on a checkout file that neither changed since the last round nor carried a blocker then is refused and must be a note (`review.py:318-323`). A security defect missed in round 1 in an unchanged file therefore **cannot block in rounds 2–3**. It can still block if cited through an `evidence/` file (those paths are exempt, `review.py:318-319`), a workaround nobody is told about. | Same restriction. | `tests/test_review.py:604-618` |
| J | **Outside MACH** (a person merges with Git) | Not a review path. Intake counts a manual merge as integration only from the approved commit (`tests/test_mach_product_intake.py:441`). | — | — |

## 3. Questions asked, answered

- **Is severity recorded at all?** Only `blocker` / `note`. No High/Critical notion exists in review, findings,
  decision, lifecycle or analytics. The lifecycle `review.verdict_submitted.rules` keeps only spec/matrix IDs
  (`skills/intent/scripts/lifecycle.py:88-90`), so a blocker whose rule is prose ("REVIEW.md: no secrets…") is
  recorded with `rules: []` (seen in a real run: `M6_6` live run notes, N7).
- **Can a verified security blocker be recorded as an authorised exception with traceability?** **No.** There is
  no exception record, command or field. The only ways past a security-seat blocker are project-wide config
  (`security_veto: false`, or a panel without a security seat), which is not per finding, not tied to a revision,
  names no approver and leaves no record in the cell beyond the provenance snapshot of a supervised execution.
  A rejected ticket can only be revised, escalated (`blocked-requires-sme`) or abandoned.
- **Is "verified" a concept?** No. A finding is the reviewer's claim; nothing independently reproduces it
  (Phase 4 "separate discovery from verification" is not implemented in review).

## 4. Gaps and the smallest fix for each (nothing changed)

| # | Gap | Severity (RC) | Smallest fix |
|---|---|---|---|
| G1 | A security defect raised as a blocker by a non-security seat is outvoted at Medium (row A). The brief's Phase 4 names exactly this. | **Blocker** (bypasses a required gate as the brief defines it) | Add an optional `category: "security"` on a blocker (`check_findings`); veto when any seat's blocker has it, not only the `security` seat's. One field, one condition at `review.py:410`, two tests. |
| G2 | Tracked tier overrides can remove the security seat (`reviewers: 1`), drop the person from High, or lower approvals, and nothing refuses it (row E). | **Major** | Clamp in `panel_for`: Medium/High keep 3 seats; High keeps `human_approval`. Or add the same preflight check as `security_veto` for these keys (`policy.py:369`). |
| G3 | `security_veto: false` is not re-checked after enabling (row D1). | **Minor** | Call the `security_review` check in each supervisor pass before dispatch, or record the config digest at enable and hold on change. |
| G4 | No exception record (section 3). | **Major** (the brief requires a traceable authorised exception) | A `review.py except <ticket> --finding N --by NAME --reason …` that writes `exception` into `decision.json` bound to `head`, valid only for that commit, only on a person's explicit instruction, refused for unattended callers; merge treats it like a human approval. Small, but a new authority: needs the product owner's yes. |
| G5 | Delta rounds cannot raise a new security blocker on an unchanged file (row I). | **Major** | Exempt the `security` seat (or G1's `category: "security"`) from the restriction at `review.py:321`. |
| G6 | `decision.json` does not keep `overruled_blockers_from`; `security_veto` is true only when it changed the outcome. | **Minor** | Store `overruled_blockers_from` and a separate `security_blockers` count in the decision. |
| G7 | Only blocker/note; no High/Critical. | **Minor** alone (G1 is the part that matters) | G1's category field; a severity scale is not needed for the gate. |
| G8 | Lifecycle drops prose rules (`rules: []`). | **Minor** | Record a short hash or the first rule token when no ID matches. |
| G9 | `templates/REVIEW.md` never mentions the security veto or that `max_loops` can be raised project-wide (it says the limit "is never raised for a single ticket", `templates/REVIEW.md:50`, while `review.py:166-168` accepts any positive `max_loops`). | **Minor** | Two sentences in the template. |
| G10 | Tuning label clears High-risk and Silver human approval and is trusted from the ticket file (row F). | **Minor** (by documented design; unanimous panel remains) | Record who labelled it, or keep High-risk human approval for tuning tickets. Product owner decision. |
| G11 | Low-risk tickets never get a security reviewer (row C). | **Deferred** (by design; risk is set in grooming and can only be raised) | None for RC; note in REVIEW.md. |

Real-run evidence: the 13 Nov recorded run (High risk) had a round rejected with a security-seat blocker
(`M6_2_ACCEPTANCE.md` section 2.2, `M6_6_ACCEPTANCE.md` section 5). At High risk unanimity rejects anyway, so
that run does not show the veto overriding a passing count; the veto's deciding case (Medium, 2 approvals) is
shown only by `tests/test_review.py:428-438` (fixture). No run exercises G1–G5.
