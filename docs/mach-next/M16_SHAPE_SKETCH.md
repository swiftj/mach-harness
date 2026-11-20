# M16 sketch: Shape, the part of Product Studio that comes before epics

Exploratory, 2026-11-20. Nothing here is built or decided. It is a sketch to react to.

## Why

Product Studio starts at "define a project, its epics, and one slice at a time". Product managers asked for what comes before that: where an idea is explored, argued for, sized and turned into epics. Other spec-driven methods call this "clarify" or "analysis". In MACH it is one more workspace of Product Studio, called **Shape**, built the MACH way: a person decides, a script checks, and everything traces forward to the code and back to the reason.

The chain today starts at the slice:

    slice (why, spec) → contracts → plan → build → evidence → review → merge → acceptance

Shape adds the front of it, and a way to close it:

    idea → brief → the case → size and route → epics and slices → … → acceptance → look back

## The six steps

### 1. Ideas

One board for everything that might become work, wherever it came from: an idea filed with `/mach-idea`, a request issue, something the product manager typed, or a fault from production. Each idea is at one of five places: New, Exploring, Brief written, Decided, Shaped into work. Nothing is lost by saying no: a decision is recorded with its reason and the idea stays findable.

### 2. Explore

A guided conversation, one question at a time, in the product manager's own words. Unlike the slice interview these are open questions an analyst would ask. Facts are looked up, never asked:

- **What exists today**: the shipped rules in force that the idea would touch (from "how this epic works today").
- **What is already wanted**: other ideas and requests that look like this one.
- **What stands in the way**: product principles and policy packs the idea would run into, flagged now and not at the spec.

### 3. The brief

One page, written by the conversation and owned by the product manager:

- **Problem** and **who has it**
- **Outcomes**, each with **how we would know** (`O-1`, `O-2`: a measure or an observable change)
- **Not doing**
- **Assumptions**, each marked "assumed, not confirmed" until someone confirms it (`A-1`, `A-2`)
- **Open questions** and **risks**
- **What it touches**: capabilities and shipped rules, by ID

A script checks the brief: every outcome has a way to know, assumptions are listed and none is hidden in the prose as a fact, nothing reads as a technology choice (that is an ADR's job).

### 4. The case

Before any epic exists, the product manager makes the case in a few sentences as the customer would hear it, and MACH asks the hardest questions it can find: who would not want this, what it costs if an assumption is wrong, what is the smallest version worth shipping, what would make us stop. The answers are the product manager's.

Then the product manager records a verdict in their own words: **Go**, **Not now**, or **No**. MACH never recommends one. The verdict is saved with the brief's hash and their GitHub login, like every other approval.

### 5. Size and route

A script, not a model, sizes the work from what the brief touches: how many capabilities, how many shipped rules, whether it reaches anything classed as high risk (sign-in, billing, stored data, an existing contract), whether a principle or policy concern is already flagged. It answers one of four routes:

| Route | When | What happens next |
|---|---|---|
| **A small change** | One capability, no shipped rule changed, nothing high risk | A light spec: far fewer questions, every Factory gate kept |
| **One slice** | One outcome, a few rules | The slice interview, seeded from the brief |
| **An epic** | Outcomes inside one capability, needing several slices | Shape proposes thin slices in build order |
| **Several epics** | Outcomes in different capabilities | Shape proposes epics, then slices in each |

For the last two, Shape proposes the map the way the PRD on-ramp does, and uses the same coverage rule: every outcome in the brief is carried by a slice, or the product manager says it is out of scope or for later. Nothing is created until they say so.

A second way in skips the brief: **change what exists**. On "how this epic works today", pick a rule and choose "change this". That opens a short proposal (why, what changes) with the affected shipped rules already filled in, and sizes it the same way.

### 6. Look back

When an epic is accepted, each outcome from the brief comes back with its "how we would know": **met**, **not met**, or **too early to say**, recorded by the product manager. Assumptions come back too: confirmed, wrong, or still unknown. This is the first place MACH connects what shipped to why it was wanted.

## What this adds to the record

Every requirement in a slice can name the outcome it serves (`O-2`), so the chain reads end to end: outcome → requirement → scenario → test → evidence → accepted → met. A brief that changes mid-flight shows which slices rested on the part that changed.

## What does not change

- The slice spec stays the authority for what is built. The brief never reaches the builders as instructions.
- A person decides at every point that matters: the verdict, the route's map, marking ready.
- Scripts check structure and completeness; MACH never scores an idea.
- Nothing upstream starts a station or touches the Factory.

## Decisions (product owner, 2026-11-20)

1. **The verdict is one person's**, typically the product manager.
2. **A brief is optional**, like the PRD on-ramp, and is one of the ways to start using MACH.
3. **Briefs live in GitHub issues** (recommended and accepted in principle): one issue per idea, which becomes the brief; the verdict is a signed comment carrying the brief's hash; the epic's issue links back to it. Without GitHub, a folder form as slices have. The Factory never needs the brief, so it never has to be in the repository. Caution for a public repository: an issue is as visible as the repository, so a brief holding commercially sensitive detail needs a private repository or the folder form.

4. **The light path for small changes is left out, for now.** A small change takes the "one slice" route, so the first build has three routes, not four.

## Deferred: to come back to

**A light path for small changes** (deferred by the product owner, 2026-11-20; may be revisited).

- *What it is:* for a change a script judges small and safe, Product Studio asks a handful of questions and writes a shorter spec (what changes, one or two scenarios). Every Factory gate stays: a failing test first, independent verification, review.
- *Small and safe means all of:* one capability; no shipped rule changed; nothing high risk (sign-in, billing, stored data); no existing contract changed; no principle or policy concern.
- *Guards:* a script decides eligibility, never the model; any answer that reveals more sends the slice to the full interview.
- *What would reopen it:* evidence from real use that small slices take too long to spec. Factory Analytics already measures time at the Groom station per ticket, which is where that would show.
- *Why it waited:* it is the one part of Shape that reaches into the slice interview itself; leaving it out keeps the first build purely upstream.
