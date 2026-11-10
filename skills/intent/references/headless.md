# Headless mode

Read this file only in headless mode, which is when the input contains `--headless`. Whatever starts the skill for an auto-generated ticket passes that flag. No person is answering, so nothing in this session may wait for one. This file replaces every instruction in `SKILL.md` that asks the PM something or waits for a reply. Everything else in `SKILL.md` still applies, including the guardrails, the lookups, Phase 4, and Stage 2.

## The rule

Build the design tree and work the frontier exactly as in an interview, but answer each question yourself, in order, as if the PM had said "you decide":

1. **A fact settles it.** The ticket, a document in the project, or current behavior in the code answers the question. Use it, and record it under `## Assumptions` with its source file.
2. **A safe default settles it.** You have a grounded recommendation or a common default, and a wrong guess is cheap to correct later. Use it, and record it under `## Assumptions`, starting the entry with "Decided without a PM:" and giving the reason. Do not list it under `## Accepted defaults`: nobody accepted it.
3. **Nothing safe settles it.** Record it under `## Open questions` with a follow-up note naming who can answer it, usually the ticket's reporter or owner. Do not ask the questions that depend on it; list them as open too, noting what they wait for.

A decision is never safe to default, whatever you would recommend, when a wrong guess would:

- charge, refund, or move money, or change a price or a limit on money;
- let someone see, change, or delete data they could not before, or lock someone out;
- delete or overwrite data in a way that cannot be undone;
- break a promise the project has written down, such as a policy, a legal notice, or a published limit;
- pick the winner between two rules that conflict.

Choose the strictest reading when a default is safe but there are several: refuse rather than allow, shorter lifetimes rather than longer, fewer people rather than more.

Wording is safe to default. Write each refusal message yourself in the product's existing voice, copying an existing message when one fits, and record it as decided without a PM.

## What changes in each phase

- **Before the interview.** Never create a ticket in headless mode; if the input has no ticket ID, stop and report that. If `.factory/inbox/<id>-intent.md` exists (`seeded_intent` in the `CELL open` output), it was generated from telemetry: treat its stack trace, culprit file, and error details as facts for the lookups, not as the finished intent.
- **Scope.** Trim as usual. Deferred features still reserve slice IDs.
- **Phase 3.** Do not ask for confirmation. Write the three-bullet summary into the ticket comment instead (see below).
- **Phase 4.** Unchanged. In `intent.md`, set `Mode` to `Headless`.
- **Pausing.** There is no pause. A spec with open questions is saved by `CELL finalize <ticket-id> --allow-open` exactly as a paused one would be.
- **Stage 2.** Runs only on `READY`, as usual.

## Repair tickets

A ticket generated from a crash, an alert, or a failing build describes a fault, not a feature. Groom it as the thinnest slice that makes the fault impossible:

- **Actor** is the one persona who hit the fault; **Trigger** is the action that was running when it happened; **Outcome** is that action completing, or being refused with a clear message, instead of failing.
- Find out from the code what the system was meant to do at the failing point. If that is clear, write it as the requirement the fault broke. If the code and the ticket do not show the intended behavior, that is an open question: a repair must not invent product behavior.
- Add one scenario that reproduces the fault from the ticket's details, with synthetic data in place of any real user data. It is the regression test.
- Keep everything else out of scope. A repair slice changes no behavior beyond the fault.
- Never copy personal data, credentials, or tokens from a stack trace or event into the spec, `intent.md`, or a ticket comment.

## Finishing

Record the result on the ticket, with the ticket skill if it is installed, or `CELL ticket-note` for a local ticket:

- **Ready and planned:** comment with the slice ID, the outcome sentence, the three-bullet summary, and every "Decided without a PM" assumption, so a person can review them before or during code review. Add the labels `groomed` and `headless-groomed`.
- **Open questions remain:** comment with the open questions and their follow-up notes. Add the label `blocked-requires-sme` and set the state to `blocked`. Say how to resume: a person runs the intent skill on the same ticket without `--headless`, and the interview continues from the open questions.

End with a short plain-text report of the same facts as your final output. Do not ask anything in it.
