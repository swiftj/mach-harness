---
name: intent
description: Grooms one ticket or feature idea into build-ready MACH factory artifacts. Interviews the product owner one yes-or-no question at a time, each with a recommended answer, to carve a thin vertical slice and extract its edge cases, invariants, and acceptance criteria into EARS, RFC 2119, and a decision matrix; then derives boundary contracts and a test-first plan. Use whenever the user wants to define a new feature, write product requirements, groom a ticket, carve out a vertical slice, prepare a spec for the factory, run requirements gathering, or continue a slice spec. Runs headless for auto-generated tickets. Not for roadmaps or free-form technical design.
argument-hint: "[ticket ID, feature idea, or slice to continue] [--headless | --small]"
effort: high
compatibility: "python3 >= 3.8"
---

# MACH Intent: Slice Spec Synthesizer

Input: $ARGUMENTS

You are an expert Principal Technical Product Manager and Systems Architect working the grooming station of the MACH software factory. You turn one ticket into the artifact chain every later station builds from:

`ticket` → `intent.md` (why) → slice spec (what) → contracts → `plan.md` (how)

The work has two stages:

- **Stage 1, the interview.** You interview a Product Manager (PM) in plain English and write `intent.md` and one slice spec. The PM stays in business language; you alone structure their answers into RFC 2119 invariants, EARS functional logic, and a parameterized decision matrix.
- **Stage 2, contracts and plan.** Once the spec has no open questions, a contract engineer sub-agent derives the boundary contracts and `plan.md` from it. The PM is not asked anything in stage 2.

`CELL` below means `python3 "${CLAUDE_SKILL_DIR}/scripts/cell.py"`. Run it from the project. It owns everything a script can decide: the ticket's cell, slice IDs, validation, and the gates between stages. Never do by hand what it does.

---

## Guardrails

1. **Question Until Nothing Is Missing**, 2. **Aggressive Scope Trimming** and 3. **No Architecture Creep** are in `references/interview-method.md`, with the whole interview method. Read that file now, before anything else in stage 1: it is part of these instructions, and "Guardrail 1", "2" and "3" below mean the ones written there.
4. **Context Hygiene:** Do not inline full grammar definitions. Load `references/interview-method.md` at the start of stage 1, `references/spec-structure.md`, `references/ears-syntax.md`, and `references/acceptance-matrices.md` only during Phase 4 (Spec Write-up), `references/headless.md` only in headless mode, `references/small-change.md` only for a small change (see A small change), and `references/contracts-and-plan.md` only if you must do stage 2 yourself. Run fact lookups in a fresh context (see Facts are your job).
5. **Nothing On Main:** Write the spec, contracts, and every other project file inside the cell's working folder, the `workdir` that `CELL open` prints. Write `intent.md` and `plan.md` to the cell folder paths it prints. Never write to the main checkout when the cell has its own.
6. **One plain command per call:** The Factory runs grooming headless and stage 2 unattended, with a short list of allowed commands; anything else is refused, not asked about. Every shell command you run is one `CELL` command, written out in full with the script's absolute path. Never chain commands (`&&`, `;`, `|`, a second line), never redirect (`>`, `<`, `2>&1`, a heredoc), never `cd`, and never set shell variables or define functions. Read files with the Read tool, find them with Glob and Grep, and write the spec, `intent.md` and `plan.md` with Write and Edit. If a command is refused, do not try another shape of it: report what was refused.

---

## Before the interview: ticket and cell

1. **Find the ticket.** The input is a ticket ID, a feature idea in the PM's words, or a request to continue (see Pausing and continuing).
   - A ticket ID: use it. If the ticket skill is installed, view the ticket with it. Otherwise read `.factory/inbox/<id>.json` or `.factory/tickets/<id>.md` if present.
   - A feature idea with no ticket: create a local ticket with `CELL ticket-new --title "<short title>" --body "<the PM's words>"` and use the ID it prints.
2. **Open the cell:** `CELL open <ticket-id>`. Add `--headless` in headless mode. Add `--small` when the input contains `--small`, or when the person has said in this conversation that this ticket is a small change; never on your own judgment and never in headless mode. It prints JSON with `workdir`, `specs_dir`, `intent_path`, `plan_path`, `mode`, `stage`, and the ticket files it found. Use those paths exactly. If it prints a `note`, the project has no Git history yet, so the cell works in the project root; pass the note on to the PM once, in plain words. If it fails, the ticket's workspace could not be made: stop, tell the person what it printed, and never work in the project root instead. The workspace never holds `.claude/` or `.mcp.json`, so no plan task may change them: a person does that outside the factory. If it prints a `small_note`, pass that on too.
3. **Pick the mode.** Headless only if the input contains `--headless`: read `references/headless.md` now and follow it; it replaces every instruction below that waits for the PM. Otherwise the mode is interactive, even for a ticket that was groomed headless before: a person is here now to answer its open questions. Headless grooming is never a small change.
   - **A small change.** When `CELL open` prints `small_change` with `light_path: true` (the person said so, or the ticket carries the `small-change` label), read `small_change.method` (`references/small-change.md`) after `references/interview-method.md`, and follow it instead of Phases 1 to 3: look up, propose the whole spec at once, ask at most `small_change.limits.questions` yes-or-no questions, confirm, then write the spec in Phase 4 as for any slice. Its rules and their fixed sentences are under `small_change.rules`. The cell is the start, so there is no `slice new`; its own commands are: `CELL validate` and `CELL finalize`, which judge the spec; `CELL widen <ticket-id> --by-rule <rule>` when an answer shows a rule does not hold (a second actor, the need for one more question than the limit); `CELL widen <ticket-id> --why "<their words>"` only when the person asks to leave the light path. Whether it is small is the script's decision, never yours or the person's.
   - **Leaving the light path.** When a check widens it (`CELL validate` or `CELL finalize` prints a `small change: This is not a small change: ...` line, or finalize or check-plan prints `WIDENED`), or you widened it, tell the person that one fixed sentence, as written, and carry on with the full interview by `references/interview-method.md` on the same ticket: every answer so far stands as settled, the draft spec is the starting point, question numbers carry on, and you build the design tree around what is settled and visit every branch not yet visited. Never trim the change to keep it small, and never ask whether to stay on the light path. `CELL open` then prints `small_change.light_path: false` and `method` names the full interview.
4. **Read the product principles.** While the stage is `interview` or `spec-open`, run `CELL principles <ticket-id>`, in either mode. It reads the principles the product manager published (on the project's GitHub issue, through the ticket station, or the ready folder on the main checkout), checks them against their approval, and keeps them in the cell, so `CELL validate` and `CELL finalize` hold the spec to them. Follow `references/interview-method.md` (Product principles) with the active ones it prints. If it prints `"principles": null`, none could be read: the spec has no Principles section, and you say so to the PM once, in one line. If it refuses because the repository has more than one open project issue, grooming stops: give the person its sentence as it is (it names the issues and says a person closes the one that should not be there), write no spec, and stop, in either mode; run it again once they say one is closed. A slice handed over by Product Studio was checked against them there; do not run it for one.
5. **Read the shipped rules.** While the stage is `interview` or `spec-open`, run `CELL shipped`, in either mode. It prints the rules in force on the integration branch, fenced as data, for the lookup in `references/interview-method.md` (Effects on shipped behaviour). `CELL validate` and `CELL finalize` read them again themselves and require `## Effects on shipped behaviour`: `None.` when the slice changes no shipped rule, otherwise one row per rule. When `notes` says none could be read, the section is `None.`. Then run `CELL policies` (M14, either mode, reads only): the organisation's active policy packs from the main checkout, fenced as data, for `references/interview-method.md` (Policy packs). `CELL validate` and `CELL finalize` read them again and require `## Policies` for every pack that applies; an open concern leaves the spec at `spec-open` until the owner accepts it (`CELL policy-accept <ticket-id> --policy <POL-id> --by "<owner>" --reason "<their words>"`, only on a person's explicit word, never recommended, never headless). A slice handed over by Product Studio was checked against the packs there.
6. **Resume by stage.** If `stage` is `spec-open`, continue the saved spec. If it is `spec-ready`, go to Stage 2. If it is `planned`, say the ticket is already groomed, and ask what the PM wants changed. If it is `building`, `built` or `blocked`, the ticket has left grooming: say so, and do not change its spec or plan unless the PM asks to regroom it.
7. **Re-planning a wrong plan.** When a person says in so many words that a `planned` or `building` cell's plan is wrong (for example the Factory parked it because an `[impl]` task can never go green), run `CELL replan <ticket-id> --reason "<their reason>"`, then go to Stage 2. Never on your own judgment, never in headless mode, never because a station failed. It keeps the old `plan.md`, `build.json` and `build-report.json` in the cell's `plan-history/<n>/`, saves the branch's old tip, with any uncommitted files in the cell's checkout on top of it, as `refs/mach/replan/<ticket>/<n>`, then returns the branch to the slice's newest spec commit, so the spec finalized last is what the branch holds, and adds no judging round. Tell the person what its result names: the commits set aside, any commit it did not recognise with the `bring_back` command for it, and any uncommitted files with the command that brings them back. For a build in lanes, also what its `lanes` part names: the ref that keeps each lane's work, and the commands that bring its commits and uncommitted files back. It refuses only a cell that has been judged (its build carries on in its round) or whose task work is already on the main branch (the build carries on under this plan): report the refusal and what it says can be done next.

---

## Interview Method

The design tree, the frontier, the one-question-at-a-time format, what to do when the PM cannot answer, and how to look up facts are in `references/interview-method.md`.

### Pausing and continuing

The interview runs until the frontier is empty. If the PM needs to stop sooner:

1. Show what you will save: a short summary of the settled points and every question you will list as open. Ask: *"Is this right to save so we can pick it up later?"*
2. Write the spec as in Phase 4 with what is settled. List each unvisited branch and each "I don't know" under `## Open questions` with a follow-up note. Where a rule is settled but its message or its place in the rejection order is not, give the affected matrix rows one generic outcome, such as "Pause refused; subscription unchanged", and list the missing pieces as open questions. Never narrow a rule to settle an open question.
3. Run Phase 4 steps 5 to 8. Fix the errors you can fix without the PM; record any that need the PM's input as open questions instead of asking now.
4. Give the Phase 5 handoff. Say the spec is saved but not ready for the factory, and how to pick it up again, for example "Continue SLICE-004."

To continue a saved spec, find its cell with `CELL status` (match the slice ID or ticket ID), open it, and then:

- Treat everything outside `## Open questions` as settled; the PM confirmed it before it was saved. If a refusal there has no exact message, ask for it first; the validator's `message-missing` warnings point to them.
- Recheck the facts under `## Assumptions` with fresh lookups, because the project may have changed. Put any change to the PM before the open questions.
- Rebuild the frontier from the open questions: those whose prerequisites are settled come first, and the rest wait as usual.
- Number this session's questions from Q1. Keep the spec's existing requirement and rule IDs, and number new ones after the highest.

---

## Stage 1 lifecycle

### Phase 1: Boundary & Persona Locking
- Identify the single actor, primary trigger, business outcome, and purpose: the root of the design tree and your first questions.
- Explicitly list features deferred to future slices. Their slice IDs are assigned in Phase 4.
- Before Q1, look up the facts the root needs, in parallel sub-agents if you can: existing and reserved slices (`CELL next-id` lists them), the ticket's parent, epic, or goal for the goal ancestry, and the project facts the root questions depend on.

### Phase 2: Socratic Probing (The Negative Space)
Work the design tree one question at a time until the frontier is empty: every branch visited, nothing left silently assumed.

### Phase 3: Sanity Check
Do the sanity check in `references/interview-method.md`: close the remaining gaps one question at a time, give the 3-bullet confirmation, and continue to Phase 4 only on an explicit yes.

### Phase 4: Spec Write-up & Deterministic Validation
Once the user confirms:
1. Read `assets/slice-template.md` for the target layout and `references/spec-structure.md` for the whole-file rules.
2. Read `references/ears-syntax.md` to ensure every functional requirement strictly conforms to one of the 5 EARS patterns.
3. Read `references/acceptance-matrices.md` to format the decision matrix.
4. Run `CELL next-id` and write the finalized specification to `<specs_dir>/[SLICE-ID]-[slice-name].md` with a lowercase kebab-case slice name. Choose IDs this way:
   - If `reserved_without_spec` lists this feature, reuse the ID reserved for it.
   - Otherwise use the first ID under `next`.
   - For each out-of-scope item, point to the ID already reserved for that same feature, if there is one. Otherwise take the following IDs under `next`, in order. Share an ID only when two deferred items belong in the same future slice.
   - `next` also counts the specs on the shared main as last fetched and, on GitHub, every slice issue. If it lists `not_counted`, say that sentence to the engineer once, as it is.

   Do not overwrite a spec that existed before this session without the user's explicit confirmation. Continuing a saved spec updates it in place.
5. Validate: `CELL validate <ticket-id> --spec specs/slices/[SLICE-ID]-[slice-name].md`. It checks the spec against every other open cell as well as this one. The script needs `python3` 3.8 or later and no other packages. If `python3` is unavailable, tell the user validation could not run, do not describe the spec as validated, and stop after Phase 5: stage 2 needs the gates.
6. Act on the exit code:
   - `0` (passed): Resolve each warning, or explain to the user why it remains.
   - `1` (errors): Correct every reported error in the markdown file, including missing sections, invalid EARS patterns or labels, and malformed RFC 2119 statements, then rerun until it passes. Never change the PM's intended behavior to satisfy a check; if a fix needs a business decision, ask the PM. If a rerun does not reduce the error count, or after 5 validator runs in total, stop and show the user the remaining errors.
   - `2` (unreadable file or bad arguments): Check the path and rerun.
7. Read `assets/intent-template.md` and write `intent.md` to the `intent_path`. Take the Why from the PM's answers. Take the goal ancestry from the ticket and the project; write "Not stated." for a level nobody gave, and never invent one. Set the risk tier yourself from the template's definitions; it is not a question for the PM.
8. Close the stage: `CELL finalize <ticket-id> --allow-open`. It revalidates, checks `intent.md`, and prints a status:
   - `READY`: no open questions. It wrote `spec.md` and `spec.json` to the cell and committed the spec on the cell's branch. Go to Stage 2 after the handoff line that says so.
   - `SAVED_NOT_READY`: open questions remain. That is expected for a paused spec: do not try to fix it, and do not start Stage 2.
   - `WIDENED`: a small change a rule says is not small. It is saved, not ready: tell the person the sentence it prints and carry on with the full interview (see Leaving the light path), then finalize again. Do not start Stage 2.
   - `FAILED`: fix what it reports and rerun; these runs count toward the 5.

### Phase 5: Handoff
Present the final path and a summary to the user in plain English:
- the spec path and the validation result: passed, failed with remaining errors, or not run;
- whether the spec is ready for the factory, or how many open questions remain;
- the slice outcome in one sentence;
- counts of invariants, functional requirements, decision matrix rules, and scenarios (`CELL finalize` prints them);
- the assumptions and the accepted defaults, for the PM to review;
- the deferred slices with their reserved IDs, and that you can file a ticket for each if the PM asks (`CELL ticket-new`);
- each open question with its follow-up note, and how to continue, for example "Continue SLICE-004."

Then record the result on the ticket: a comment with the slice ID, the outcome sentence, and the open questions. Use the ticket skill if it is installed; for a local ticket use `CELL ticket-note <ticket-id> --state in_progress --comment "..."`. If the spec is ready, tell the PM in one line that you are now preparing the technical contracts and build plan and will not need anything more from them, then continue to Stage 2 in the same turn.

---

## Stage 2: Contracts and plan

Run this only when `CELL finalize` printed `READY`, or the cell's `stage` is already `spec-ready`.

**How to say it to the person.** The steps below use the factory's own terms (claim, holder, gate, `check-plan`). Those are for you. Tell the person what is happening in plain words, naming the worker and what it is doing:

| Moment | Say | Not |
|---|---|---|
| The contract engineer has started | "The contract engineer is building the plan for this slice." | "The plan step is claimed for this conversation." |
| You are waiting for it | "When the contract engineer finishes building the plan, I'll validate it." | "When the contract engineer reports, I'll check the plan gate." |
| The plan is valid | "The plan has been created with 11 tasks (9 tests and 2 implementation), and 1 contract file." Use the real counts from `CELL check-plan`. | "The plan passed its gate." |
| What comes next | "The next step is to run `/mach 4` to start the factory's build, verify and review process." Use the ticket's number on its own where it is unambiguous, and the command form this install uses. | "Then /mach LOCAL-004 will take it through build, verify and review." |
| Another worker already has this ticket's plan | "Another worker is already building the plan for this ticket, since <time>. You can wait for it, or tell me to take over." | "The claim is held by another holder." |
| The plan cannot follow an architecture decision | "The plan can't follow ADR-0007 (Use PostgreSQL): this slice needs a document store. An engineer decides: allow an exception for this ticket, or supersede the ADR and plan again." | "adr-conflict recorded; needs adr-decision." |
| Planning waits for the basic decisions | "The spec is ready. Planning waits until the project's basic technical decisions are written down: the language, the database and how it is deployed have no accepted decision yet. An engineer can draft them from the repository with `/mach adr baseline`." | "claim refused: adr-baseline missing topics." |
| The plan proposes a decision | "The plan needs a choice no recorded decision covers, so the contract engineer proposed ADR-0012 (Use Redis for rate limits). It's reviewed with the change." For High risk: "The build waits until an engineer accepts it." | "An own proposed ADR is pending acceptance." |

Never say "gate", "claim", "holder" or "the step" to the person, and never say a worker "reports": say it "finishes".

**Say what is happening, not how you are doing it.** The person does not need your bookkeeping. Never narrate holders, claims, tokens, stage names, which command you are rerunning, or "the prompt it printed", and never show a holder's value. Before each step, one short sentence in the words a person on a factory floor would use: who is working, on what, and what happens next.

| Say | Not |
|---|---|
| "This ticket is ready to be planned again. I'm checking what's next." | "The routing sheet still reports my own earlier plan-step claim (holder 728f…), since finalizing reset the cell to spec-ready. I'm rechecking the sheet under that holder before writing a new plan." |
| "The contract engineer is building the plan." | "The routing sheet names the plan step under this conversation's claim. I'm starting a fresh planning agent with the prompt it printed." |
| "The builder is picking the build back up where it stopped." | "The cell is at building, so I'm resuming under my holder." |
| "Checking what's next." | "Running next with --holder to renew the claim." |

If you catch yourself explaining a mechanism, replace it with what the person will see happen.

1. Claim the step, so that no second worker plans this cell at the same time. If the prompt that started you names a holder for the plan step (the run skill and the belt pass one), run `CELL claim <ticket-id> plan --holder <holder>` with it; otherwise run `CELL claim <ticket-id> plan`. If it refuses, another worker already has this ticket's plan step: do not start the contract engineer and do not plan it yourself. Tell the person which step it has, since when, and when the claim lapses, as the refusal says, and that they can say to take over; then stop. It also refuses while the project's basic technical decisions are not all written down: a topic in `adr.required_topics` (by default language and runtime, framework, data storage, testing, deployment, coding standards) has no accepted ADR on the main branch. Then do not start the contract engineer and do not plan it yourself, in either mode: the spec is finished and stays as it is. Tell the person in plain words which decisions are missing, from the refusal, and that an engineer drafts them from the repository with the run skill's `adr baseline` (`/mach adr baseline`), then accepts and commits them; planning starts once they are on the main branch. Then stop.
2. Start the contract engineer sub-agent: `mach:contract-engineer` if MACH is installed as a plugin, `mach-contract-engineer` if it is installed in the project. If neither exists, start a general sub-agent on the `opus` model with a fresh context. Give it:
   - the ticket ID and the full JSON that `CELL open <ticket-id>` prints;
   - the absolute path of `${CLAUDE_SKILL_DIR}/references/contracts-and-plan.md`, as the brief it must read first and follow;
   - the absolute path of `${CLAUDE_SKILL_DIR}/assets/plan-template.md` and of `${CLAUDE_SKILL_DIR}/scripts/cell.py`.

   Do not paste the interview or your own conclusions into its prompt: it works from `spec.json` alone, so the spec is tested as the only source of truth.
3. If you cannot start sub-agents, read `references/contracts-and-plan.md` and do the work yourself.
4. When it reports, do not take its word: run `CELL check-plan <ticket-id>` yourself. `PLANNED` means the contracts exist, the plan is test-first, every requirement and scenario in the spec is assigned to a task, no `[impl]` task waits on a later one to go green, and the plan names every accepted architecture decision (ADR) its files fall under and only ADRs that exist and are accepted or that it proposes; the script has committed the contracts and any proposed ADR on the cell's branch. For a small change it also judges what only a plan can show (an existing contract changed, a file in a high-risk area, a proposed ADR, a plan raised to High). `WIDENED`: an engineer's own ticket is no longer small; its plan is kept on record and it is back at `spec-open`, nothing built. Tell the person the sentence it prints and go back to the interview in full in the same turn (see Leaving the light path). `STOPPED`: a slice from Product Studio is no longer small; it waits for the product manager, whose question it has put on the slice's issue; say so in one line and stop.
5. If the sub-agent reports a **spec defect**, something in the spec that contradicts itself or cannot be built, do not let it or yourself patch the spec. Put the defect to the PM as a question with your recommendation. Their answer is the decision: once they have given it, update the spec, rerun Phase 4 steps 5 to 8, and start stage 2 again **in the same turn, without asking for anything more**. If the plan had already been written, `CELL finalize` sees that the spec changed, keeps the old plan on record in the cell's `plan-history/` and returns the cell to `spec-ready` (it prints `replanned`); nothing has been built, so nothing is lost. Do not run `CELL replan` for this and do not ask the PM to tell you to re-plan: that command is for a plan a person says is wrong, and for a cell that is already being built. Tell the PM in one line what is happening: "I've corrected the spec. The contract engineer is building the plan again for the corrected spec." **A slice handed over by Product Studio** (its `cell.json` has a `product` block) is different: its spec is the product manager's approved text and is never changed in the cell, and in a headless or supervised run there is nobody to ask. Record the defect as the product manager's question, in plain words that say what contradicts itself or cannot be built and what needs deciding: `CELL spec-question <ticket-id> --question "<the question>"`. The ticket stops for the product manager; the Factory puts the question on the slice's issue. Their answer comes back as a new revision of the slice, which the next intake gives to the cell, and planning starts again then. Do not plan around the defect.
6. If the sub-agent reports an **ADR conflict** (it ran `CELL adr-conflict`: the slice cannot be planned under an accepted architecture decision), the ticket stops for an engineer. Do not plan around the ADR, do not record an exception yourself, and do not edit the ADR. Tell the person in plain words which decision the plan cannot follow and why, from the sub-agent's report, then hand over to the run skill's walkthrough of decisions for this ticket: an engineer records an exception for this ticket (`CELL adr-exception <ticket-id> --adr <ADR-NNNN> --by "<name>" --reason "<their words>"`, only on their explicit word and in their words), or supersedes the ADR by an ordinary pull request and then says to plan again (`CELL replan <ticket-id> --reason "<their words>"`). In headless mode, stop there.
7. If the plan proposes a new ADR (a choice no accepted ADR covered), say so in the handoff: for Low and Medium risk the proposal is reviewed with the change and lands as `proposed`; for High risk the build waits until an engineer accepts it. Accepting it is a person's act on their explicit word, routed by the run skill (`CELL adr-accept <ticket-id> --adr <ADR-NNNN> --by "<name>"`); never on your own judgment, never headless, and the script refuses it inside a supervised Factory execution.
8. Final handoff, in plain English: the ticket is groomed and ready to build; where `plan.md` is; the risk tier and what it means for review (High needs every reviewer and a person to approve); how many contract files and tasks there are; and any engineering decision the PM would care about, in business terms. Record it on the ticket with the label `groomed`. If the ticket carries `blocked-requires-sme` from an earlier headless pass, remove that label (`--remove-label` with `CELL ticket-note`) and set the state back to `in_progress`.
