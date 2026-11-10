<!--
MACH intent template (mach-intent, stage 1). intent.md is the "why" for one ticket.
Keep every heading below. Replace every <placeholder> and delete every comment,
including this one; 'cell.py finalize' rejects leftovers.
Save as intent.md in the cell folder (the "intent_path" that 'cell.py open' prints).
Plain business language only. The slice spec holds the "what"; do not repeat its
requirements here, point to their IDs.
-->

# Intent: <Outcome-focused title, the same as the slice title>

- **Ticket:** <TICKET-ID> (<local | github | gitea-cli | jira | fossil | telemetry>)
- **Slice:** <SLICE-NNN> at <specs/slices/SLICE-NNN-slice-name.md>
- **Mode:** <Interactive | Headless>
- **Status:** <Ready for contracts | Open questions remain>

## Why

- **Problem:** <What is wrong or missing today, for whom>
- **Who it is for:** <The single actor of the slice>
- **Success looks like:** <The observable or measurable result that shows this worked>

## Goal ancestry

<!-- From the broadest goal down to this slice, so every agent that later touches the work can
     tell what it serves. Write "Not stated." for a level nobody gave; never invent one. -->
- **Goal:** <The business goal this serves, or "Not stated.">
- **Epic:** <The larger feature this slice is the first part of, or "Not stated.">
- **Ticket:** <TICKET-ID: ticket title>
- **Slice:** <SLICE-NNN: the slice outcome in one sentence>

## Constraints

<!-- Limits that come from outside the slice: deadlines, policies, compliance, things that must not
     change. Point at the invariants that enforce them. Use "- None." if there are none. -->
- <Constraint, and the INV-NN that enforces it if there is one>

## Risk

<!-- High: sign-in or permissions, money, personal data, deleting data, or anything other teams build
     against. Medium: ordinary product behavior. Low: wording, documentation, or a setting switched
     off by default. -->
- **Tier:** <High | Medium | Low>
- **Reason:** <Why, in one sentence>

## Deferred work

<!-- One bullet per deferred feature with its reserved slice ID and, if one was filed, its ticket.
     Use "- None." if nothing was deferred. -->
- <Deferred feature> (SLICE-NNN<, ticket TICKET-ID>)
