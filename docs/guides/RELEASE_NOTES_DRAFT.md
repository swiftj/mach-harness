# MACH release notes: 0.26.0

What is new in each release, newest first, followed by supported platforms, what you need, upgrading and security notes.

## What changed in 0.27.0

A project someone else defined is there when you open Product Studio, and one command opens the app.

### Joining a project

| Change | What it is |
| --- | --- |
| Nothing to fill in | On a fresh clone of a repository whose product is already on GitHub, Product Studio brings it in before showing anything: the project, its principles and technical needs, every epic, and every slice in the state it is in. The app shows "Bringing in <project> from GitHub", then the project. The terminal says the same in one line. |
| It stays in step | Every refresh also takes in what others have published since, and newer versions of anything you have not changed. A draft you changed is never replaced. |
| A newer version is looked at first | When someone published a newer version of something you changed, the first step is to look at the two, then take theirs or keep yours as a new version. |
| "From GitHub" on the project home | What came, what could not come and why, what waits, and where an earlier copy of yours was kept, each with its one step. |
| Design pictures | A slice's pictures come from the main branch at the first refresh after this computer has them (after a pull or fetch). Until then the slice says so, and marking it ready never drops them without your word. |
| A project you had started | If you began a project here that was never saved to GitHub and the repository has one, MACH brings in the repository's project, keeps your words aside and keeps your epics and drafts as drafts. |
| When GitHub cannot be read | The app says why and tries again. It does not offer to describe a product that may already exist, unless you say to start one of your own. |
| The ways to start from nothing | Shown only when GitHub was read and holds no project for the repository, or the repository has no GitHub origin. |

Drafts never marked ready, PRDs, designs, ideas' working files and interview notes exist only on the computer where they were written.

### One command opens the app

| Change | What it is |
| --- | --- |
| `/mach-app` | Opens MACH Product Studio in your browser. There is nothing to add after it and nothing to phrase. With the plugin it is `/mach:app`. |
| Always the installed release | The app that opens is the one for the MACH release installed in the project. A missing or older program is fetched and checked against the release's checksum first. An older Product Studio still running for the project is stopped and replaced. |
| It says what it did | "Product Studio 0.27.0 is open in your browser.", whether it was already running, and a fresh link for another browser on this computer. When a newer MACH release exists it says so, and that running the installer updates it. |
| `/mach-app link` and `/mach-app stop` | A fresh link without opening a browser; and stopping the app. |
| `/mach-app floor` | The same for the Factory Floor, with `link` and `stop`. |
| It keeps running | The app runs until `/mach-app stop` or the computer restarts, not only while Claude Code is open. |

`/mach-studio open the app` and `/mach floor` still work and do the same thing.

## What changed in 0.26.0

Nobody is blocked because someone else has the work. MACH says who has it and since when, then does what was asked.

### Engineers

| Change | What it is |
| --- | --- |
| Naming a ticket takes it | `/mach 6`, `/mach 1 3 6` and "take over SLICE-011" start the work in the same step. There is no flag to know, no plan to read first and no second yes. |
| What held it becomes a warning | Another worker's or another Factory's claim, a slice it depends on that is not merged yet, and the limit on how many run at once are said first, then the work starts. |
| The other worker stops | A worker whose ticket was taken over is refused at its next step, and a Factory run on it is ended. Files it had not committed are kept aside and named. |
| Both copies can be on GitHub | A slice taken over from another Factory gets its own branch, so neither push is refused and both can open pull requests. Each Factory is told about the other's. |
| A second copy can be merged | When another copy of a slice landed first, a person's merge brings main in. If nothing differs MACH says so and closes this copy out. If something does, it is verified and reviewed again, then lands on top, and the change record says another copy landed first. |
| Looking never takes anything | Status, explain and the list of what needs you change nothing. They say who has the work and how to take it. |
| The Factory still keeps out of the way | Work the Factory picks by itself (`/mach pull`, the supervisor) leaves other people's work alone and says how to take it: by naming it. |
| A build started early says so | A ticket built before the slice it depends on was merged says that when a check fails. |

### Product managers

| Change | What it is |
| --- | --- |
| Any slice can be opened | A slice another product manager saved opens here, with its design mocks from the main branch. One whose text changed after approval, or that has no approval, opens as a draft and says so. What it depends on is opened first. |
| A taken number is handled in one act | Marking a slice ready, or saving an idea, whose number someone else took gives it the next free number and carries on. |
| Your version is published when you ask | When someone else saved a newer version, yours replaces it as asked. MACH says what it replaced and keeps the other version; `replaced list` shows what was kept and `replaced restore` puts one back. |
| Told when the builders have started | Marking ready over a version the builders are working on says so, and when they take the new one. |
| A request can be picked up by two | Picking up a request someone else picked up adds you as well. |
| In the app | Another window writing the same slice can be taken over with one click. A reply or an edit sent while the interviewer is writing stops it and goes ahead. An extra project issue can be closed from the app. |

### Decisions

| Change | What it is |
| --- | --- |
| Every decision stays on offer | A ticket another worker holds shows everything it is waiting for, with a warning above. |
| Take it over, from anywhere | "Take it over" works in the terminal and in the Factory Floor, and can hand the ticket back to the Factory. |
| Two people deciding at once | The second waits for the first. If the first already settled it, the second is told what was decided and what is on offer now. |

No message tells one person to ask another. A slice with nothing valid to build, such as one whose text was changed after approval, still says what fixes it.

## What changed in 0.25.0

Moving a project to another repository as it was: one export, one import, nothing interviewed again.

| Change | What it is |
| --- | --- |
| Export needs nothing prepared | Asking to export the project makes the file straight away. Whatever the workspace lacks, MACH reads from GitHub by itself: the project, its principles and technical needs, the epics, every slice and the design mock pictures on the main branch. The workspace is not changed. |
| Export from any computer | A computer that has never opened the project can export what GitHub holds. The result says what was read from GitHub, and that drafts never marked ready, PRDs, designs, ideas' working files and interview notes exist only on the computer where they were written. |
| The result says what the file holds | What came from this workspace, what came from GitHub, which version was used where both exist, and anything not in the file, each with its reason and what to do. |
| Ready means still as approved | A slice comes as ready only when its spec, why and mocks are the approved ones and it answers the project's principles. One changed after approval, or whose issue was closed without being built, comes as a draft and the result says so. |
| Mark ready in one step | "Mark ready the slices that were ready there" publishes the principles and technical needs that came, then marks those slices ready, dependencies first, on the product manager's word. If it stops, it says where, why and what is left, and carries on when asked again. |
| Principles that say the same become one | When the destination already has a project, an incoming principle with the same statement takes the ID already there. |
| "Not assessed" | Where a slice was written before a principle joined the project, MACH records that it was not assessed for it. The row does not hold up marking ready, reviewers see it, and it is answered when the slice is next changed. It travels with the project when it moves again. |
| Effects on shipped behaviour need no second answer | A slice that names a rule of a slice that came with it now depends on that slice and waits for it to ship. A small change stays a small change. |
| Numbers never collide with an engineer's slice | The engineers' numbering skips numbers an import holds, and an import gives its own slice another number and carries on when an engineer took one. Renumbering a slice afterwards keeps the import's records right. |
| Move this project, in the app | Product Studio's app downloads the project as one file, and brings one in: it always shows what would come in first, then the report. A stopped import can be finished or set aside there, and "What was it called before?" answers for any ID. Files up to 64 MB; a larger one goes through `/mach-studio`. |

A slice with design mocks is still held by the builders until its mock pictures are committed to the destination's main branch; marking ready says so for each such slice.

## What changed in 0.24.0

One command runs the Factory, a person decides in the terminal or in the Factory Floor, and a build can work on several tasks at once.

### `/mach pull` is the one command

| Change | What it is |
| --- | --- |
| Pull hands the batch to the Factory | `/mach pull` takes in what is ready, hands the batch to the Factory Supervisor and returns. There is no enabling step, no code and no second command. |
| Work pauses when Claude Code closes | The Factory that pull starts stops its work when Claude Code exits. The next `/mach pull` carries each ticket on from the stage it was at. |
| `/mach factory start` for the background | It starts the same Factory in the background, where it keeps running after Claude Code exits. |
| It says when one is already running | Pull and `factory start` look first. If a Factory is running they say how it was started and since when, hand it the batch, and give the Factory Floor's link. |
| `/mach stop`, `/mach pause`, `/mach resume` | Short forms. Stop ends the Factory's work; the next pull or `factory start` starts it again with no other step. |
| Low and Medium risk merge on their own | Once review approves. A High-risk change waits for a person's approval, then merges. |
| No spending limit unless you set one | A project (`factory.*` in its settings) or a person (`/mach factory start --budget-per-day N`) sets one. One execution is still stopped after 120 minutes, and a ticket that gets nowhere twice waits for a person. |
| `/mach pull --here` | Runs the batch in the conversation, as pull used to. `/mach <ticket>` and `/mach 1 3 6` are unchanged. |
| A project can still say no | `factory.supervisor: false` keeps every pull in the conversation. `/mach factory disable` does the same for one machine, and it sticks. |

The first pull in a project says one plain line: agents now build here on their own, running this repository's tests and scripts as you, and `/mach stop` stops them.

### "Needs you"

| Change | What it is |
| --- | --- |
| One list | Everything waiting for a person is one list, read from the Factory's own files, so it is the same after Claude Code, the Factory or the computer restarts. `/mach` and `/mach pull` lead with "Needs you: N". |
| One command records a decision | Approve, send back, merge, accept an ADR, an exception to an ADR, plan again, set a test command, answer open questions, abandon. The Factory then carries the ticket on; no `resume --retry`. |
| Decide in the Factory Floor | "Needs you" in the Factory Floor shows what happened and the same options, as buttons. A decision that cannot be undone is confirmed first. A reason is always your own words. |
| Answer open questions in writing | Questions that grooming without a person left open can be answered one by one, or left open, in the Floor or the terminal. |
| Stop from the Factory Floor | The top bar says when a Factory is running and how it was started, with a Stop control. The Floor never starts or enables a Factory. |
| A banner on a Mac | Once the Factory is on, a Notification Center banner says when a ticket needs you. `/mach notify banner off` turns it off. |

### Building in lanes

| Change | What it is |
| --- | --- |
| Several tasks at once | A plan whose parts do not depend on each other is built in lanes, up to three at once (`build.max_lanes`), each in its own workspace, then joined and tested whole. |
| Lanes on the Factory Floor | A ticket being built in lanes shows each lane and where it is. |
| A build that cannot start says how to fix it | With no test command known, the build says so before anything changes, and `set-commands` supplies one at any point. Planning again keeps the newest spec and sets nothing aside for good. |

### Moving a project

| Change | What it is |
| --- | --- |
| Export and import | `/mach-studio` exports a Product Studio project to one archive and imports it into another repository, which may already hold a project. Everything is renumbered and every slice arrives as a draft. |

### Under a sandbox, and day to day

| Change | What it is |
| --- | --- |
| The installer sets what a sandbox blocks | It turns on Git's per-worktree settings, so a ticket's workspace can be made under Claude Code's sandbox. |
| Verification without a browser | Where no browser can start, as in a sandbox that forbids Playwright, verify proves a web change from logs, request and response dumps and saved pages, and says so to the reviewers and in the change record. Nothing goes back to the builder for a missing screenshot, and no settings file needs editing. `verify.screen_evidence` (`prefer`, `require`, `never`) changes it. |
| Package caches inside the project | npm, pip and other tools keep their caches under `.factory/cache/`, where a sandbox allows writing. `commands.env` adds your own variables. |
| MACH's own tickets go to GitHub | When the project's origin is GitHub, the installer says so and how to switch to local tickets. |
| The audit is not run on every pull | A good audit stays good as the main branch moves, for 30 days (`audit.max_age_days`). |
| No archive by default | Cleanup keeps an archive of a ticket's evidence only when a person decided something on it (`cleanup.archive`). The rest is in Git. |

### The Factory Floor

| Change | What it is |
| --- | --- |
| Finished tickets leave the floor | A ticket that is merged and cleaned up moves to a Finished shelf. |
| How fresh the page is | The top bar says when the last record arrived, and warns when a ticket is at work and nothing has arrived for ten minutes. |
| "Partial" says what is missing | The badge opens a list of the records that were lost, and a ticket folder the page cannot show gets its own line saying why. |
| Fewer false "Partial" | Restarting the Floor, merging a pull request, widening a small change, planning again and a voided approval no longer leave gaps. |
| The gate panel | A link back to the slice, plain words for a refusal, and no "Related" or "Measured to the millisecond". |

**After updating:** `/mach factory enable` no longer asks for a code; `--confirm`, `--accept-execution-risk`, `--include-backlog`, `--exclude-backlog` and `--allow-merge` are gone, and `--no-merge` is new. A machine that was enabled before keeps working.

## What changed in 0.23.2

Product Studio says what really happened when it cannot check GitHub, and naming a product no longer asks for a project ID.

| Change | What it is |
| --- | --- |
| No project ID to type | Naming the product asks for its name, vision and outcomes. MACH makes the project's ID from the name. |
| A check of GitHub that fails says why | MACH names what went wrong: no network, GitHub limiting how often the account may ask, GitHub not answering, something on your computer stopping the GitHub tool (a proxy, or a sandbox the session runs in), the sign-in, or a refusal. Each comes with the GitHub tool's own words. |
| One dropped connection is not a failure | A read of GitHub is tried twice more, a few seconds apart, before MACH reports it. |
| "GitHub not checked" is its own notice | The app's top bar shows it beside the saved state, with when the check failed and when the last one worked. It is no longer counted in "things not saved yet": a failed check loses nothing of yours. |
| The app checks again by itself | After a failed check the app tries again shortly, then at widening intervals up to fifteen minutes, and stops when a check works. "Check GitHub again" does it at once. |

## What changed in 0.23.1

A shorter command for Product Studio.

| Change | What it is |
| --- | --- |
| `/mach-studio` | Product Studio's command is now `/mach-studio`, in place of `/mach-product-studio`. With the plugin it is `/mach:studio`. It is still MACH Product Studio, and everything it does is the same. |

**After updating, type `/mach-studio`.** The old command is gone: updating removes it from the project.

## What changed in 0.23.0

Decisions in force: an engineer's page on the Factory Floor for the project's architecture decisions.

| Change | What it is |
| --- | --- |
| Decisions in force | A fourth workspace on the Factory Floor (key `4`). It lists every architecture decision with its number, title, status, what supersedes it and the topics it covers. A file MACH cannot read is listed with the reason. |
| The baseline at a glance | Each required topic is shown as covered, and by which decision, or missing. When one is missing the page says that no ticket is planned or built until it is covered. |
| What waits on a person | Proposals not yet accepted, and tickets stopped because a plan cannot follow a decision, each with the command that settles it. |
| One decision's page | Its text, the tickets planned under it, and any exception recorded against it, with when and why. |
| It only reads | Like the rest of the Factory Floor, the page changes nothing. Accepting, changing or excepting a decision stays with `/mach adr` in the terminal and a pull request for the file. It shows the decisions as they are in your main checkout, and reads again when you ask. |

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
| The app's link, every time | Every `/mach-studio` starts the app quietly on your computer and shows its link, to click or paste into a browser. A browser opens only when you say "open the app". A link works once; ask for a new link at any time, with no restart. One app runs for each project. |
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
- From 0.23.1 Product Studio's command is `/mach-studio` (plugin: `/mach:studio`); `/mach-product-studio` no longer exists after an update.
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
