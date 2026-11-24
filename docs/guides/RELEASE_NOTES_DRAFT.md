# MACH release notes: 0.22.1

What is new in each release, newest first, followed by supported platforms, what you need, upgrading and security notes.

## What changed in 0.22.1

A slow build keeps its slice, the merge plan says more before you run it, and fixes.

| Change | What it is |
| --- | --- |
| A slow build keeps its slice | A factory whose work on a slice has moved says so on the slice's issue, at most once every day and a half by default, so another factory does not take a slice that is still being built. A build that has not moved for three days (`intake.claim_stale_days`) is free again, as before. |
| The merge plan says what the merge would refuse | `/mach merge`'s plan now says, before anything runs, when the slice already shipped from another factory or its slice number belongs to another slice on main. |
| "Unattended runs: off" | The Factory Floor's top bar says "Unattended runs: off" where it said "Factory not enabled": MACH is installed and working, and only the supervisor that runs work unattended is off. |
| No byte code in a ticket's workspace | MACH runs your build, test and lint commands so that Python leaves no cached byte code in the ticket's workspace, and a test run always tests the code as it is now. |
| Arguments for a verification driver | `capture ... -- <arguments>` passes the arguments to the driver on every supported Python. |
| Product Studio's layout | The "More below" mark sits under a pane and no longer covers its last line. On Vision and outcomes, "Save changes" stays in view at the top. The "ready to build" dialog opens with one short sentence. On a slice's "From the PRD" page the hint names the button it means. |

## What changed in 0.22.0

Qualifying a release on any machine. On a team, the slices of one epic are built by different factories; any of them, or a machine that built none, can now qualify the epic.

| Change | What it is |
| --- | --- |
| Qualify an epic anywhere | `/mach release qualify --epic <epic>` gives the same outcome, check for check, on every machine that has the main branch. It no longer needs the machine that built the slices. |
| The change record carries the facts | The record MACH merges with each ticket (`docs/changes/`) now ends with a section for MACH: the approved spec's SHA-256, the contracts, the slices depended on, the verification verdict with each evidence file's SHA-256, the review decision and whether a person's approval was required. |
| A record is bound to its merge | MACH counts a record only as it was merged with its ticket, for the spec it names. A record edited or replaced afterwards blocks its slice, and the check says why. |
| Evidence stays where it was made | Evidence files stay in the archive of the machine that built the ticket. Where the qualifying machine holds a file, MACH checks it against the recorded SHA-256; the result counts the files checked here and those held on another machine. |
| Acceptance from any machine's snapshot | The readiness snapshot names the change records, nothing that one machine alone holds, and the product manager records acceptance from it as before. |

**Slices merged by 0.21.0 or earlier** have no such section in their record, so they show as `missing` when an epic is qualified; record an exception for them or qualify the slices merged since.

## What changed in 0.21.0

MACH for a team: several product managers and several engineers on one repository at the same time. Also the basic decisions drafted from documents an engineer already has, and a ticket's workspace that holds no Claude Code configuration.

| Change | What it is |
| --- | --- |
| Factories keep out of each other's way | No slice belongs to anyone in advance. When a factory starts a slice it says so on the slice's issue; `/mach pull` on another machine skips that slice, says who is building it, and takes the next ready slice nobody is building. |
| Nobody is locked out | A slice is free again when its builder merges or abandons it, or after three days with no activity (`intake.claim_stale_days`). An engineer can take a slice over at any time by saying so; the issue records who did. |
| The shared main takes a slice once | A factory that built the same slice later is told it already shipped. Its copy is not merged, and its work is kept. |
| A slice built on another machine | Once it merges, every other factory reads it from the main branch, so slices that depend on it are no longer held. |
| Merging checks the shared main | Each ticket is tested against what is on the shared main at that moment, and checked again if main moves before the merge. A local merge is refused only when the shared main has changes this checkout lacks, with the instruction to pull first. |
| The doctor on team settings | `/mach doctor` says when the main branch does not require up-to-date branches and passing checks, and when a repository several people push to is still merging locally. |
| A number two people took at the same moment | The later product manager is told at once who holds the number and that their own issue was closed before it was marked ready, and is offered a new number. A refresh on either computer says the same if the moment was missed. |
| Shared text is never silently replaced | The project's vision and outcomes and each epic's criteria are rewritten only when nobody else changed them. If someone did, MACH takes theirs in, or shows both versions whole for you to keep yours or take theirs. |
| One project per repository | Starting a project where one exists takes its name, vision and outcomes from GitHub. With several project issues, MACH saves nothing, names them, and the factory stops grooming until one is closed. |
| Numbers across a team | Slice and ADR numbers now also count what is on GitHub and on the shared main. Two ADRs with one number name each other and the fix: `/mach adr renumber <file>`. |
| The app, working beside others | Product Studio's app shows each of these with one clear act: "Give it a new number", "Keep mine" or "Take theirs". |
| Decisions from your own documents | `/mach adr baseline` asks once for technical documents you already have: an ARCHITECTURE.md, a design, stack or deployment notes, coding standards, ADRs in another form. MACH reads them without changing them, drafts every decision it can, offers the other decisions they make as one list, and asks only about gaps and contradictions. Markdown and plain text. |
| A workspace with no Claude Code configuration | A ticket's workspace never holds `.claude/` or `.mcp.json`, so a session's sandbox has nothing to refuse there. A plan that would change one of those files is refused: a person makes that change outside the factory. |
| A workspace that cannot be made stops the ticket | MACH says what Git reported and what to do. It no longer carries on in the project's own folder. `/mach doctor` makes and removes a throwaway workspace to check. |
| Files from different versions | Every MACH command now says plainly when MACH's files in a project are from different versions, with the fix: run the installer again. |

**Needs Git 2.36 or later** for a ticket's workspace. `/mach doctor` checks it.

**For a team,** set `merge.method` to `"pr"` and protect the main branch on GitHub so that branches must be up to date and checks must pass.

## What changed in 0.20.0

Starting a project in the app, from a PRD or any other way; the app's link shown every time; and an update that always leaves MACH on one version.

| Change | What it is |
| --- | --- |
| How do you want to start? | In the app, a project with nothing defined asks how to start: describe the product yourself, start from a PRD, shape an idea first, or start from a request waiting on GitHub. |
| A PRD, from the first screen | Choose the file on the start screen. On the PRD's page MACH proposes the map of epics and thin slices in a conversation and records it only on your word; you settle what no slice covers and make the drafts there. |
| Name the product when it is needed | A PRD or an idea can be started before the product has a name. The app asks for the name, vision and outcomes just before the drafts are made, or before a request is picked up. MACH may suggest them from a PRD, marked as a suggestion; what is recorded is what you write. |
| Carry on where you left off | Until the product is named, the home page lists what you have started, with a way to continue each, and the other ways to start below. |
| The app's link, every time | Every `/mach-product-studio` starts the app quietly on your computer and shows its link, to click or paste into a browser. A browser opens only when you say "open the app". A link works once; ask for a new link at any time, with no restart. One app runs for each project. |
| An update leaves one version | Installing again always brings MACH's own files to the version being installed. A MACH file that was changed in the project is saved to `.factory/mach-backup-<time>/` first, and the installer says how many it replaced. |
| A mixed install is named | `mach status`, `/mach doctor` and Product Studio say plainly when a project holds MACH files from different versions, with the fix: run the installer again. |
| One slice on both sides of the hand-off | When Product Studio and the Factory run on the same computer, a slice's draft and the copy the Factory took in are one slice, not two with the same number. Two different slices with one number are still refused. |
| Picking up after a refused intake | If taking a slice in stopped part way, the next `/mach pull` offers it again and finishes it, reusing what was already made. |

**If Product Studio stopped starting after an earlier update,** or `/mach pull` refused a slice because its number was used twice, run the installer again to get 0.20.0, then run the command again.

## What changed in 0.19.1

A quick start for product managers.

| Change | What it is |
| --- | --- |
| Quick start for product managers | A step-by-step guide for a product manager new to MACH and Claude Code: setting up, describing the project, and getting a first slice marked ready, starting either from a PRD or from an idea. It also covers what to do while the builders work, the optional parts of Product Studio, and getting a newer version of MACH. See [the quick start](PRODUCT_MANAGER_QUICK_START.md). |

## What changed in 0.19.0

Small changes: a short way to ask for a fix or an adjustment to something that has shipped, built and checked exactly as any slice is.

| Change | What it is |
| --- | --- |
| A small change | Optional. A fix to a shipped rule that is not holding, or an adjustment to wording, presentation, a default or a limit. The product manager says what is so today and what should be so instead; MACH looks up the rest, proposes the whole spec at once and asks at most five yes-or-no questions. |
| Nothing is checked less | A small change's spec has the same sections and passes the same checks. The plan, the failing test first, verification, the review panel at the ticket's risk tier and the merge station are unchanged. |
| What counts as small | MACH decides by fixed rules: one actor and one epic; at most three rules and four scenarios; at most one shipped rule changed and none retired; no exception to a principle, no policy concern, no new permission; risk Low or Medium. `intent.small_change` sets the limits. |
| Becoming a full slice | A change the rules say is not small carries on as a full slice, with one sentence naming the rule and every answer kept. MACH never trims a change to fit. The product manager can make one a full slice on their own word. |
| After the plan | The plan can show what a spec cannot: an existing contract changed, a file in a high-risk area, a proposed ADR. An engineer's ticket then returns to the full interview with its plan kept; a Product Studio slice stops with a question for the product manager. |
| For engineers | Say a ticket is a small change when its interview starts, or label it `small-change`. Unattended grooming never takes the short interview. |
| Shape | A fourth route beside one slice, an epic and several epics: one outcome in one capability, at most one shipped rule and no high-risk area is sized as a small change. |
| Product Studio app | A small change can be started wherever a slice is, as a fix (choosing the shipped rule) or an adjustment. It carries a "Small change" label where slices are listed, and a slice that became a full slice says why and when on its page. |
| Factory Floor and the record | The Line names a small change on its ticket. Analytics sets time at Groom for small changes beside full slices. The pull request and the change record say "small change" beside the ticket. |
| Product Studio dialogs | When a start is refused or a field is missing, what stopped it is brought into view. |

## What changed in 0.18.0

Technical needs, and a way in for a design you already have, so a new project's first technology decisions start from what the product requires.

| Change | What it is |
| --- | --- |
| Technical needs | Optional. Six questions in the product manager's words: who uses it, what it keeps, what it must work with, what must never happen, which quality wins, and what is already decided. MACH never suggests a technology and refuses one in a need; something already decided is recorded as a given, with who said it and when. |
| Publishing needs | Published on the project's issue with the product manager's approval, and to a folder they commit. Each need has a revision; a decision written for an older one is flagged, and nothing is reopened. |
| A design you already have | Bring in an architecture or design document. MACH records what it decides on each basic topic, citing lines, and each place it contradicts a need, a principle or a policy. The product manager settles each conflict in their own words; the document is published to a folder, never to an issue. |
| The baseline starts from the product | `/mach adr baseline` reads published needs and designs as evidence beside the code. A drafted decision names the needs it serves and offers at least two options; a given comes to the engineer as a point to confirm. Only an ADR an engineer accepts decides anything. |
| `serves` on an ADR | An ADR may name the needs it serves, with their revisions. `/mach adr list` flags one written for an older revision or a retired need. |
| The architecture overview | `/mach adr overview` writes a map of the decisions: the parts, how data moves, and the decisions by topic. The ADRs remain the authority and no station checks a plan against the map. |
| Product Studio app | Two screens: Technical needs, with the conversation beside the six kinds, and A design you already have, with the topics, the conflicts and publishing. |
| Product Studio layout | The act a part asks of you is in view when you arrive, above the "More below" mark. |

## What changed in 0.17.0

Shape, the part of Product Studio that comes before epics, and a new layout for every Product Studio screen.

| Change | What it is |
| --- | --- |
| Shape: ideas | Optional, and one of the ways to start. One board for every idea, from your own words, a request, an idea filed with `/mach-idea`, or a fault MACH recorded. A decision of no keeps its reason and stays findable. |
| Shape: explore and the brief | A conversation with open questions, one at a time; MACH looks up shipped rules, similar ideas, principles and policies instead of asking. The brief is one page with outcomes, each with how you would know, and assumptions marked as assumed. MACH checks it is complete. |
| Shape: the case and the verdict | MACH asks the hardest questions it can find; the product manager records go, not now or no in their own words, saved with the brief's hash and their GitHub login. MACH never scores an idea or recommends a verdict. A changed brief makes the verdict stale. |
| Shape: size and route | After a go, MACH sizes the work from what the brief touches, by fixed rules: one slice, an epic, or several epics. A map is settled as the PRD on-ramp's is, with every outcome carried or accounted for, and applied on the product manager's word. |
| Shape: the chain and look back | A slice made from an idea names the outcome it serves. When it ships, each outcome and assumption comes back for the product manager to record. "Change what exists" starts an idea from a shipped rule. |
| Ideas on GitHub | An idea is saved as one issue: the brief as its body, the verdict as a comment. Without GitHub it is written to a folder. |
| Product Studio layout | Every screen now fits the window instead of scrolling the page: side-by-side panes, parts that open one at a time, and a "More below" mark where a pane has more. |

## What changed in 0.16.0

Product memory, policy and design inputs, and the screens to go with them.

| Change | What it is |
| --- | --- |
| Enterprise Managed User logins | A GitHub login ending in `_shortcode` is accepted everywhere: sign-in, marking a slice ready, the approval and acceptance comments, intake. The rule now lives in one place. `/mach doctor` asks only about github.com's sign-in. |
| Product principles | Rules that hold across every slice, published on the project's issue with the product manager's approval. Every spec answers every principle; reviewers may cite them. |
| Effects on shipped behaviour | Every spec says what it does to rules that have shipped: kept, changed, replaced or retired. The build station works on today's main branch; the merge station checks what landed in between and has the change verified and reviewed again when it touches the same ground. |
| How an epic works today | `/mach current` and Product Studio compile the rules in force from shipped slices, by fixed rules and not by a model's summary. The Factory keeps one comment on the epic's issue up to date. |
| Starting from a PRD | Optional. Import a document, settle a proposed map of epics and slices with every section accounted for, then confirm drafted answers instead of answering each from nothing. |
| Jira | A Jira key on a slice or epic is carried to the pull request title and merge commit. `jira export` writes a CSV to upload; `jira keys` brings the new keys back. MACH never calls Jira. |
| The change record | Each change lands with `docs/changes/<ticket>.md`: the why, the plan, every check with the hash of its evidence, every reviewer's findings, who approved, every exception. |
| Policy packs | Organisation policies as files in the repository, each with an owner. A spec answers each pack that applies; a flagged concern holds the slice until its owner accepts it or the spec changes. |
| Design mocks | Up to four pictures per slice, bound to the approval by hash, delivered as committed files. The verifier records a side-by-side result for each. |
| `/mach-idea` | A short interview for someone who is not an engineer; files the idea in a fixed template with no label. |
| Factory evals | Finished tickets kept as cases and, on a person's command with a budget, replayed in throwaway copies to compare the Factory before and after a change to its rules or models. |
| Self-reporting | MACH records its own internal errors on the machine; `/mach report` shows the exact issue text and files it on MACH's repository only on the person's yes. |
| Verification and review | The verifier re-proves up to two neighbouring shipped scenarios. A reviewer's note is important or a nit, with nits capped per seat; a person may rate a finding. |
| Control bands and scan intake | `/mach bands` watches the Factory's own measures for drift. `ingest-scan` turns a security scanner's findings (SARIF or CSV) into tickets, held at Medium risk or above. |
| Product Studio app | Screens for principles, policy packs, effects, how an epic works today, the PRD on-ramp, Jira and design mocks; requests in the idea template shown in five parts. |
| Factory Floor | The new waiting states, the approved mock beside the captured screen, the Jira key and the change record on a ticket. Two Analytics figures that miscounted the new records are fixed. |

## What changed in 0.15.0

| Change | What it is |
| --- | --- |
| A recorded exception for a security blocker | `/mach except <ticket> <round>/<seat>/<n> "<why>"`: a person accepts a vetoing security blocker for exactly the commit reviewed, with an optional expiry. A reviewer whose only blockers are all excepted then counts as approving, so it works at every risk tier; a High-risk change still needs a person's approval as well. Refused in any unattended run and for `factory-tuning` tickets. Recorded in the decision, the pull request, the run record and the lifecycle log; a release that includes one is at best "qualified with exceptions". `review.security_exception_by` may list who can grant one. |
| Secrets never enter a branch | The build station scans what it is about to commit and refuses anything shaped like a credential. The builder's override needs a reason, which the reviewers see. |
| Review answers for secrets and dependencies | The review packet lists every secret candidate and every dependency the change adds or bumps. The security reviewer must answer each, on the contracts tier when anything is flagged; a flagged Low-risk change gets three reviewers. A candidate called real must be a high or critical security blocker. `security.scan.enabled: false` switches it off, and unattended work is then refused. |
| Diagrams in ADRs and plans | A Mermaid diagram may be drawn where the structure or the sequence is the decision; MACH checks its kind, size and that it carries nothing but the picture. Slice specs carry none. |
| Factory Floor fixes | Small text on the Line now passes contrast; the analytics colours are tokens; the sample factory's feed no longer lists events later than its clock. |
| Product Studio | A note where an issue link is first offered, saying a private repository's issue opens only in a signed-in browser; `Y` confirms the interview's summary; a slice is introduced as a slice of intent. |
| Installer | The newest release is found from the release page when GitHub's API does not answer (shipped on `main` before 0.14.0's tag). |

## What changed in 0.14.0

| Change | What it is |
| --- | --- |
| Slices as GitHub issues | Product Studio saves a finished slice as an issue under its epic's issue and marks it ready; that issue is the Factory's ticket. The project is one pinned issue. Without `gh`, the same slice is written to a folder. |
| Removed from Product Studio | Delivery waves, `slice approve`, `send`, `feedback`, the product pull request, epic approval. An epic is a container: `open` or `deferred`. |
| Factory intake from issues | `/mach product` takes in issues marked ready (and committed ready folders), checks who marked them and that the text matches its approval, and reports back on the issue: being built, a question, shipped and closed. |
| `/mach pull` | One command for the engineer: take in what is ready, schedule it, dispatch it, then run it. |
| Architecture decisions | MADR files in `docs/adr`. Accepted ones bind planning, building and review. No ticket is planned until the required topics (language, framework, storage, testing, deployment, coding standards) each have an accepted decision on the main branch. `/mach adr baseline` drafts them from the repository and settles open points by interview. `adr.landing` says how they reach main: a pull request (default) or a direct commit. |
| Release qualification per epic | `release qualify --epic`, or a named list of slices; product acceptance is a comment on the epic's issue. |
| Factory Floor: the Line | A 2D view, stations as columns and tickets as rows, is the default. The isometric Floor and Analytics remain. The Timeline, the Execution Blueprint and all playback were removed. Epics replace waves. |
| Product Studio's screens | A project home in place of the navigation rail, a roomier interview with a Yes button on its summary, "Mark ready to build", each slice's place with the builders, the builders' question with "Answer it", slice order, "On GitHub". |
| Requests, scheduling, decisions | GitHub issues as requests in Product Studio (M8); several tickets scheduled by MACH's rules, one worker per ticket and the walkthrough of decisions (M9); notifications when a ticket waits (M10); the evidence player; `/mach` as the one command; `doctor` and `explain`. |
| Installer | An updated program is moved into place as a new file, so macOS no longer stops it. The newest release is found from the release page when GitHub's API does not answer. |

## Supported platforms

Each release builds Product Studio's app (`mach-studio`) and the Factory Floor (`mach-observer`) for:

- macOS on Apple silicon
- Linux arm64
- Linux amd64

Every program is smoke-tested on a native machine of its kind before a release is published, and ships with a software bill of materials, a checksum and a build attestation. Install with the one-line installer: it verifies what it downloads before anything runs.

## What you need

Claude Code, `git` 2.36 or later, and `python3` 3.8 or later. The GitHub CLI (`gh`) is needed to save slices as GitHub issues and to verify build provenance. A missing Git or Python stops the installer with a plain message and, on a Mac, the `xcode-select --install` step.

## What MACH includes

| Component | What it does |
|---|---|
| The stations: ticket, audit, intent, build, verify, review, merge, cleanup, observe | The factory's conveyor belt. MACH's fixed rules, not the agents, decide gates, order, commits and verdicts. |
| `/mach` | The one command for engineers: take work in, schedule it, run several tickets side by side, and stop wherever a person is needed. |
| Product Studio | The product manager's workspace, in the conversation or in a browser on your own machine: Shape, the project, principles, epics, slices by interview, and marking a slice ready as a GitHub issue. |
| Factory Floor | A read-only live view of the factory: the Line, the Floor and Analytics. |
| Factory supervisor | Unattended running, off until a person enables it on that machine. It stops at every point a person is needed. |
| Release qualification | One commit, a clear outcome, and a readiness record that names every check. |
| Installer | Installs a release and verifies its source archive and programs against published checksums and, with `gh`, their build attestation. |

## Upgrading

- Run the installer again. It installs the newest full release; choose a specific one with `MACH_VERSION=<x.y.z>`.
- Your work is kept: Product Studio drafts, tickets in progress, the archive and run records, `.factory/config.json` and a customised `REVIEW.md` are not touched.
- After upgrading to 0.22.0, release qualification reads the change records merged from then on. Keep `records.enabled` on (the default) for a slice to qualify.
- A draft made by 0.13.0 with an epic marked `proposed` needs `epic set <EPIC-ID> --status open` once.
- If you enabled supervised running before 0.13.0, enable it again after upgrading.
- Back up `.factory/` before moving to an older version.

## Security notes

- MACH runs locally. Its services listen on `127.0.0.1` only and need a one-time link. It sends no telemetry.
- Unattended running is off by default and limited to an explicit tool list when on. That list includes running Python and there is no operating-system sandbox, so enable it only on a machine and account you are prepared to expose. Enabling it asks you to accept this in writing.
- The installer checks a release's archive and programs against the release's checksums, and verifies build provenance when the GitHub CLI is installed and signed in. `MACH_REQUIRE_PROVENANCE=1` refuses to install without that verification.
- MACH relies on your repository host's rules (branch protection, reviews, signed commits, single sign-on). It does not replace them.
- The build station refuses a commit that looks like it holds a credential, and the security reviewer answers for every secret candidate and new dependency. This is not a vulnerability database or static analysis; run your own scanner in CI if your team wants one.
- Personal names in free text are shown in the Factory Floor.

The [Operator and Security Guide](OPERATOR_SECURITY_GUIDE.md) has the detail.
