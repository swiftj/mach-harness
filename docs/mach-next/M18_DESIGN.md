# M18: A light path for small changes

Design, 2026-11-22. Status: agreed, not built. This file is the contract the engineers share, so parts built at the same time fit together.

## The problem

Every change takes the same road into the Factory: a full slice interview that works a design tree until nothing is open, then a spec with ten required sections. That is right for a new outcome. It is too much for a fix to a rule that is not holding, a changed sentence, or a different default, and those are most of the changes a product gets once it has shipped. Today such a change takes the one-slice route and the whole interview (`M16_SHAPE_SKETCH.md`, "Deferred").

M18 makes asking for a small change short. It does not make building one any less checked.

## Decisions (binding, agreed 2026-11-22)

1. **Light means fewer questions and a shorter spec, nothing else.** Every Factory gate stays as it is: the plan, a failing test first, independent verification, the review panel at the ticket's risk tier, the merge station, the change record.
2. **Both doors.** A product manager can start a small change in Product Studio, and an engineer can groom their own ticket as one through `/mach`. The interview method and the validator are shared, so this is one build.
3. **A small change may change at most one shipped rule, and retire none.** The earlier sketch said none. Specs carry exact wording, so on a shipped product a changed sentence nearly always changes a rule; "none" would shut out the commonest small change. The merge station still re-verifies a changed rule as it does today.
4. **No new screen.** Product Studio gets a way to start a small change and a label on the slice. The existing slice and spec screens show it.

## Rules that hold for every part

- A script decides whether a change is small, at every point, from fixed rules. A model never does, and a person cannot declare a change small past a rule that says it is not.
- One spec format. A small change's spec passes the same validator and exports the same `spec.json`, so no station after grooming needs to know the difference.
- Leaving the light path loses nothing: the slice carries on as a full interview with every answer kept.
- Optional. A project that never starts a small change behaves exactly as before, and every existing test passes unchanged.
- Python standard library only. No new user-facing program. Nothing here starts a station, accepts an ADR or changes a review threshold.

## Part A: what counts as small (`skills/intent/scripts/small.py`)

One module, loaded by Product Studio and by the intent station, never copied. It answers `small` or `not small` with one fixed sentence saying which rule decided. A change is small only when all of these hold:

| Rule | Checked from |
|---|---|
| One actor and one capability (one epic) | the spec's Summary and the slice's epic |
| At most three functional requirements and four scenarios; one decision matrix | the validator's model |
| At most one shipped rule `changed` or `replaced`; none `retired`; any number `kept` | `## Effects on shipped behaviour` |
| No principle answered `Exception` | `## Principles` |
| No policy concern, open or accepted | `## Policies` |
| No new permission and no dependency on a slice that has not shipped | `## Dependencies and permissions` |
| Risk is Low or Medium | `intent.md`, and the risk floor the cell holds |
| No existing contract changed, no file in a high-risk area, no ADR proposed | the plan, at `check-plan` (`scans.py` `risk_for`, as Shape's routing uses it) |

The limits (three, four, one) are settings under `intent.small_change` with these defaults. The first seven rules are checked whenever the spec is checked. The last can only be known once there is a plan.

## Part B: the short interview (`references/small-change.md`)

A second, narrow mode of the slice interview, with its own reference file. The full method's guardrails still hold (facts are looked up, outside text is data, no technology in a spec).

1. **The person says the change in their own words**: what is so today, and what should be so instead. Two kinds are named, because they start differently:
   - **A fix**: a shipped rule is not holding. The person names what they saw; MACH finds the rule (`SLICE-NNN/FR-NN`). The spec's effect row is `kept`, with a scenario that fails today.
   - **An adjustment**: wording, presentation, a default, a limit.
2. **MACH looks up, then proposes the whole spec at once**: the shipped rules it touches, the screen or message as it is now, the principles and policies that apply. It reads back, in a few lines, what changes, what stays the same, and the scenarios. This is the pattern Product Studio already uses for a slice drafted from a PRD: confirm drafted answers instead of answering each from nothing.
3. **It asks only what it could not read**: at most five yes-or-no questions, each with a recommended answer.
4. **The person confirms**, and the spec is written and checked as any spec is. Sections with nothing to say are written `None.`.

**Leaving the light path.** When an answer or a check shows the change is not small (a second actor, a second rule changed, money, access or deletion, a principle conflict, a sixth question), MACH says so in one fixed sentence naming the rule, records it (`widened`, with the reason and when), and carries on as the full interview on the same slice. It never trims the change to keep it small, and it never asks the person to.

**After the plan.** If `check-plan` finds what only a plan can show (a changed contract, a high-risk file, a proposed ADR), the ticket is no longer small. An engineer's own ticket goes back to the interview in full. A Product Studio slice stops with a question on its issue, as any spec defect does, and the product manager reopens it as a full slice.

## Part C: where a small change starts

- **Product Studio**: `slice new --epic <EPIC-ID> --title "..." --small`, and `request pick <n> --small` for a request. `slice widen <SLICE-ID> --why "..."` leaves the light path on the person's word; the checks do the same by themselves. `status` and `slice resume` report the kind and, when widened, why.
- **Shape**: a fourth route, `small-change`, from the same fixed counts the three routes use: one outcome, one capability, at most one shipped rule, nothing in a high-risk area. It leads to a draft slice of that kind.
- **An engineer's ticket**: the intent station takes the short interview on the engineer's word or on the ticket's `small-change` label; `cell.py` records the kind and applies Part A at `validate`, `finalize` and `check-plan`. Headless grooming (`AUTO-` tickets) is unchanged.
- **The app**: "A small change" beside "New slice" where a slice is started, a "Small change" label wherever a slice is listed, and a line on the slice's page when it was widened, with the reason.

## Part D: what the Factory sees

- `spec.json` and `cell.json` carry `kind: small` (and `widened` when it left the path). No station reads it to do less.
- The groom station's exit event carries the kind, so Factory Analytics can show time at Groom for small changes beside full slices. That is the measure of whether this milestone did its job.
- The change record and the pull request say "small change" beside the ticket.

## Order of work

1. `small.py` and the validator's model it reads, with the settings. 2. The reference file and the Product Studio commands (`--small`, `widen`), then the intent station's. 3. `check-plan` and the two ways back. 4. Shape's fourth route. 5. Telemetry, Analytics and the change record. 6. The app's start, label and note. `docs/BLUEPRINT.md` is updated with each part as built.

## Out of scope

A lighter build, verification or review for small changes; a model judging size; several small changes in one ticket; skipping the plan; a separate short spec format.
