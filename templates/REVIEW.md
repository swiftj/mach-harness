# REVIEW.md: how changes are reviewed in this project

The MACH review station reads this file. Edit it to match your project: every rule here is enforced on every ticket. Thresholds live in `.factory/config.json` under `review`; this file explains them and holds the checklists.

## Risk tiers

Each ticket's tier is set during grooming (in `intent.md`) and can only be raised afterwards, never lowered.

| Tier | Applies when the change touches | Reviewers | Approvals needed | Person must approve |
|------|---------------------------------|-----------|------------------|---------------------|
| High | Sign-in or permissions, billing or money, personal data, deleting data, a database schema, or a change to an existing contract file | 3 | 3 of 3 | Yes |
| Medium | Ordinary product behavior and user interface | 3 | 2 of 3 | No |
| Low | Documentation, wording, formatting, or behavior behind a flag that is off | 1 | 1 of 1 | No |

## Before review starts

A ticket is rejected without review, and returned to the build station, unless its cell holds:

- `spec.json` and a `plan.md` that passed the grooming gates;
- `evidence/summary.json` from the verify station with status `PASS`, and the evidence files it lists;
- a passing test run for the cell's branch.

## The reviewers

Every reviewer starts with a fresh context: the diff, the cell's artifacts and this file, and nothing from the builder's session. Each submits findings marked `blocker` or `note`; a seat with any blocker is a reject. A blocker must name the rule or requirement it breaks and the file that shows it. Any seat may mark a blocker as a security defect with its impact; a blocker from the security seat, or a security blocker of high or critical impact from any seat, is never outvoted, and the high or critical kind may be raised in any round, on any file. A fix and a new round clear it, or a person's recorded exception: on their explicit word, for exactly the commit reviewed, with their reason (`/mach except`). An exception also clears the reject vote of a seat whose every blocker it excepts, at any tier; it is accepted only when the round then meets its threshold with no vetoing blocker left unexcepted, and an ordinary blocker is never excepted. An exception is not an approval, it is never recorded unattended, a `factory-tuning` ticket never gets one, and `review.security_exception_by` in `.factory/config.json` can name the only people who may grant one. Reviewers report every security defect they find as usual: whether one is accepted is a person's decision after the round, never a reason to soften a finding.

### What Important means here

A note is `important` when a reader should act on it or know it before this change merges: a weak test for a requirement, a risk the spec did not foresee, a builder deviation accepted with reservations, a likely defect the reviewer could not prove. Anything smaller is a `nit`: wording, naming, a tidier shape, a test that could be clearer. A note without a weight counts as important. A security finding is never a nit.

Each seat keeps at most 5 nits a round (`review.nit_cap` in `.factory/config.json`); the review station keeps the first ones a seat lists and counts the rest, so a seat lists its nits most useful first. Nits never block, and neither the cap nor a note's weight changes any vote, threshold, veto or round. A person may rate a finding useful or not useful (`review.py rate`); the ratings are kept beside the round so the observe station can learn which findings are worth a reader's time.

### Do not report

- Anything in generated files (lock files, build output, generated clients, snapshots) unless the change edited them by hand.
- Anything the project's CI or tooling already enforces: formatting, import order, lint rules, type checks. If it matters, CI fails.
- Style preferences no rule here or in `CLAUDE.md` asks for.
- Problems that predate this ticket and that it did not make worse, beyond one note.

### 1. Architecture

- The change follows the project's layering; no logic leaks across a boundary.
- Contract files changed only additively and match what the code implements.
- The change follows every accepted architecture decision (ADR) the ticket was planned under, in `docs/adr/`; a blocker may cite one by its ID, such as `ADR-0007`. A person's recorded exception allows a departure only as far as its reason says. The project's basic choices (language, framework, storage, testing, deployment, coding standards, or the topics `adr.required_topics` lists) are always decided before planning: a change that departs from one without a recorded exception is a blocker. A new library or other choice no ADR covers arrives as a proposed ADR in the same change.
- No dead code, unused helpers, or dependencies the plan did not justify.
- No file grows past what one person can review; large files are split.

### 2. Security and performance

- Every input from outside is validated; no secrets, tokens or personal data in code, logs or evidence.
- The security scan's items are all answered (see "Secrets and new dependencies" below).
- Permission checks sit where the spec's preconditions and refusals require them.
- No unbounded loops, queries or memory growth; time limits in the spec's invariants are enforced.
- Outside services named in the spec fail the way their `[Unwanted behavior]` requirement says.

### 3. Product

- Every decision matrix case and scenario in `spec.json` has a test, and the test asserts the exact message and side effects.
- Refusals change nothing.
- The evidence shows the scenarios actually happening, not just tests passing.
- Nothing was built that the spec does not ask for.
- The change keeps every product principle the spec says applies; a blocker may cite one by its ID, such as `PP-02`. An exception in the spec is the product manager's decision with their reason, and is not the panel's to reopen.
- The change follows every statement of each policy pack the spec lists; a blocker may cite one by its ID, such as `POL-privacy-03`. A concern the pack's owner accepted is their decision, and is not the panel's to reopen.

## Secrets and new dependencies

The build station scans every commit it makes for credentials by their well-known shapes and refuses one that looks like it holds a secret; the builder may record that something is not a secret (`--not-a-secret`, with a reason), and that goes to the reviewers. At review, a script lists in the packet every secret candidate on the change's added lines and every dependency its manifests add or change. When it finds a secret candidate or an added or changed runtime dependency, the change is reviewed with a security seat on the contracts tier's model, and a Low-risk change gets the three-seat Medium panel. The security seat answers every item: each secret `real` (with a high or critical security blocker, so the round is rejected) or `not_a_secret`, and each dependency `acceptable` or `concern` (with a finding naming it). It weighs whether a dependency is needed, whether its name could be a typosquat, whether its version is pinned, and whether it is unmaintained or known to be compromised, and says so plainly when it does not know a package.

No dependency is checked against a vulnerability database: a model's knowledge ends at its training date, so a version found vulnerable since then is not caught here. A team that wants database-backed scanning runs its own scanner through Claude Code hooks or CI; release qualification reads such reports from `.factory/release/scans/`. `security.scan.enabled: false` in `.factory/config.json` switches the scan off; the review decision then says so, and the Factory refuses unattended work while it is off.

Add a licence rule here if dependencies must have particular licences; the security seat checks licences only when this file has such a rule.

## Architecture decisions

Technology decisions (stack, libraries, languages, component structure, API contracts, security standards) are recorded as ADRs in `docs/adr/NNNN-title.md` (MADR format; `adr.dir` in `.factory/config.json` moves the folder). Only an ADR whose `status` is `accepted` binds; an `applies-to` field (`path:<glob>`, `app:<type>`, `topic:<word>` or `all`) says what it covers. People change ADRs by ordinary pull requests. The factory never accepts, changes or supersedes one, and a `factory-tuning` ticket never touches the ADR folder. A decision accepted or changed after a ticket was planned binds tickets planned afterwards; that ticket is flagged, never restarted.

## Loop limit

A ticket gets three judging rounds, counting failed verifications as well as rejected reviews. After a failure in round one or two it returns to the build station with the findings. After a third failure, work stops: the ticket is labelled `blocked-requires-sme` and a person takes over. The limit is never raised for a single ticket.

## Project-specific rules

Add your own rules below. The observe station proposes additions here when the same defect keeps recurring; each proposal arrives as a `factory-tuning` ticket and is reviewed like any other change.

- None yet.
