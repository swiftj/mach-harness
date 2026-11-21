# MACH release notes: 0.17.0

What is new in each release, newest first, followed by supported platforms, what you need, upgrading and security notes.

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

Claude Code, `git`, and `python3` 3.8 or later. The GitHub CLI (`gh`) is needed to save slices as GitHub issues and to verify build provenance. A missing Git or Python stops the installer with a plain message and, on a Mac, the `xcode-select --install` step.

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
