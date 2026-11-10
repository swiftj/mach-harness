<!--
MACH slice specification template (mach-intent, stage 1).
Keep every heading below, in this order. Replace every <placeholder> and delete
every comment, including this one. The validator rejects leftover placeholders
and comments.
Save as specs/slices/SLICE-NNN-slice-name.md inside the cell's checkout. Get SLICE-NNN
from 'cell.py next-id', which counts file names and "Deferred to" pointers in every
open cell and the main checkout, unless an earlier spec reserved an ID for this slice. slice-name is
lowercase kebab-case. The H1 must use the same SLICE-NNN as the file name.
Describe business behavior only: no HTTP status codes, error codes, payloads,
or data schemas.
-->

# SLICE-NNN: <Outcome-focused title>

## Summary

- **Actor:** <The single persona who performs the action>
- **Trigger:** <The event or action that starts the slice>
- **Outcome:** <The verifiable business result when the slice succeeds>

## Scope

### In scope

- <Behavior this slice delivers>

### Out of scope

<!-- One bullet per deferred feature, each reserving a new slice ID. Use "- None." only if nothing was deferred. -->
- <Deferred feature> (Deferred to SLICE-NNN)

## Preconditions

- <State that must already be true before the trigger>

## Invariants

<!-- One line each. Absolute RFC 2119 keywords only: MUST, MUST NOT, SHALL, SHALL NOT, REQUIRED. -->
- **INV-01:** <Subject> MUST <boundary that can never be breached>.

## Functional requirements

<!-- One labeled EARS statement per line, using one of the five patterns in references/ears-syntax.md. -->
- **FR-01:** [Event-driven] When <trigger>, the <system> SHALL <response>.
- **FR-02:** [Unwanted behavior] If <unwanted condition>, then the <system> SHALL <response>.

## Acceptance criteria

### Decision matrix

<!-- Rule, one column per condition, Expected outcome, Side effects, Covers. Declare the values of any
     condition that is not Yes/No in its header, such as "Amount (Under $75 / $75 to $5,000 / Over $5,000)".
     A cell may list values with "or" or exclude one with "not", such as "not Over $5,000".
     See references/acceptance-matrices.md. -->
| Rule | <Condition A> | <Condition B> | Expected outcome | Side effects | Covers |
|------|---------------|---------------|------------------|--------------|--------|
| R1   | Yes           | Yes           | <Outcome>        | <What changes or is sent, or None> | FR-01 |

### Scenarios

#### AC-01: <Scenario title>

- **Covers:** FR-01, INV-01
- **Given** <starting state>
- **When** <the single action>
- **Then** <observable result>

## Dependencies and permissions

<!-- Name things as the business knows them. Each dependency ends with the requirement that covers it failing;
     separate several with ";". Write "None." when nothing applies. -->
- **External dependencies:** <Service the slice calls that can fail, and what it is used for> (failure: FR-02)
- **Required permissions:** <The role or permission the actor needs, or "None." with a reason>

## Assumptions

<!-- Only two kinds of entry: decisions the PM handed to you ("you decide"), with the reason, and facts
     found in the project that the spec relies on, with their source file. Use "- None." if there are neither. -->
- <Decision the PM delegated, and why; or a fact and its source file>

## Accepted defaults

<!-- Each common default the PM accepted, ending with the requirement IDs it produced. Use "- None." if there are none. -->
- <Default the PM accepted> (INV-01)

## Open questions

<!-- One bullet per unanswered question, each with a follow-up note:
     "- <question> Follow up: <who or what can answer it>." Use "- None." when everything is answered. -->
- None.
