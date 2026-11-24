# Engineer Guide

For an engineer who installs MACH, takes in approved product work and decides what may run on their machine: Product Studio, intake, the supervisor, the Factory Floor and release qualification. Nothing here claims readiness for regulated or enterprise production use. For the security detail, see `OPERATOR_SECURITY_GUIDE.md`.

In the commands below, `RUN` means `python3 .claude/skills/mach/scripts/run.py --project .` in a script install. With the plugin, ask Claude Code to run the `/mach:run` skill; it uses the same script.

## 1. Installation and repository requirements

You need Claude Code, `git` 2.36 or later and `python3` 3.8 or later. Install as a plugin (`/plugin marketplace add swiftj/mach-harness`, `/plugin install mach@mach-harness`, then `/mach:init` in each project) or with `install.sh` (script install, commands such as `/mach`). `--dry-run` shows what would change. Install again to update in place. An update brings every one of MACH's own files (`.claude/skills/mach*/`, `.claude/agents/mach-*`, `.claude/workflows/mach-*`, `.factory/bin/`, `.factory/mach.mk`) to the new version, because the scripts import each other across skills. One you changed is saved to `.factory/mach-backup-<time>/` first and then replaced, without `--force`. `python3 .factory/bin/mach status` and `/mach doctor` say when MACH's files do not match the installed version. `python3 .factory/bin/mach uninstall` removes only what the manifest lists, and keeps files you changed and everything under `.factory/` that is state.

**Each ticket's workspace.** MACH builds each ticket in its own Git worktree, `.factory/worktrees/<ticket>/repo`, on the branch `feature/<ticket>`. That worktree never holds `.claude/` or `.mcp.json`, at any depth, because Claude Code's sandbox does not let an agent write them. The branch still carries them, so commits, merges and pull requests are unchanged. If Git cannot make the workspace, the ticket stops with what Git said and what to do; it never runs in the project root instead. `/mach doctor` makes and removes a throwaway workspace to check this. A plan that would change a file under `.claude/` or a `.mcp.json` is refused: make that change yourself, outside the factory. A workspace needs one Git setting in the repository, `extensions.worktreeConfig`. The installer turns it on. If you use MACH as a plugin, or made the repository after installing, and Claude Code runs in a sandbox, turn it on yourself once, in a terminal in the project: `git config extensions.worktreeConfig true`. MACH tells you when it is missing.

A missing Git or Python stops the installer with a message that names `xcode-select --install` on a Mac. Python 3.8 is the stated minimum. Only 3.9.6 and 3.15 were run.

**Which version, and what the installer checks.** The one-line installer installs a release, not the `main` branch: the newest full release, or a specific one with `MACH_VERSION=<x.y.z>` (a release candidate is `MACH_VERSION=<x.y.z>-rc.N`, since a candidate is a pre-release and the default never picks one). It downloads that release's source archive and `SHA256SUMS` over HTTPS, compares the archive's SHA-256 and, if `gh` is installed and signed in, runs `gh attestation verify` on it, all before any downloaded code runs. The two prebuilt programs (`mach-studio`, `mach-observer`) get the same two checks. Anything that fails is refused, nothing is installed and the downloads are removed; there is no fallback to an unchecked source. If `gh` is missing the install goes ahead and the note says provenance was not verified; `MACH_REQUIRE_PROVENANCE=1` refuses instead. Installing a branch (`MACH_REF=<branch>`) or a local copy (`MACH_SOURCE=<path>`) is possible only by that explicit choice and the note says the source was not verified. Releases up to v0.12.0 have no source archive, so they install with a note that the source was not verified. Programs exist for darwin/arm64, linux/arm64 and linux/amd64, none for Intel Macs or Windows. They are ad hoc signed and **not notarised**: a program downloaded through a browser carries macOS's quarantine mark and is blocked on first run until you allow it. The installer's own download leaves no such mark, and its checksum and attestation checks are the protection. What is not checked: `install.sh` itself, which is fetched from `main`. You trust the script you ran. Only the rc.2 candidate was verified against GitHub, through a patched copy of its installer; the current candidate's installer has not yet been checked there.

### The audit and its tiers

Autonomous work needs a repository that builds, tests and lints cleanly. `/mach-audit` scores five areas out of 100 and writes `.factory/audit-report.json`.

| Tier | Score | Effect |
|---|---|---|
| Gold | 90 to 100 | Full autonomy permitted. |
| Silver | 70 to 89 | Building permitted; a person must approve every change before merge. |
| Bronze | under 70 | Autonomous work blocked. Only `repo-hardening` tickets build. |

A build or test suite that fails, is missing or cannot be run is Bronze whatever the score. The report goes stale after `audit.max_age_days` and is bound to a commit. The secret-scanning check only looks for a scanner's name in configuration. It runs no scanner (2 of 100 points).

On Bronze, MACH offers to file one ticket labelled `repo-hardening` with the failed checks as its acceptance criteria. Like every ticket MACH files itself (the observe station's tuning ticket, your own ticket started from a description), it goes where `tickets.provider` says: in a project on GitHub it is an issue, named by its number (`/mach 12`), and its labels are read from the issue. If GitHub cannot take it (no `gh`, not signed in, no network, no permission), MACH files it in `.factory/tickets/` as `LOCAL-NNN`, says why, and carries on with it there.

### Starting from documents you already have

MACH plans no ticket until the project's basic technical decisions are accepted ADRs on the main branch. You may already have them written down somewhere: an ARCHITECTURE.md, a high-level design, a stack or deployment note, coding standards, or ADRs in another format.

Run `/mach adr baseline`. MACH asks whether you have such documents. Name the files or a folder, inside the repository or anywhere on your machine. MACH reads Markdown and plain text; it does not read PDFs. It never edits, moves or commits your documents. It keeps their path, SHA-256 and line count in `.factory/adr-baseline.json`, which Git ignores.

MACH reads every document and works out, for each required topic, whether the documents decide it, decide part of it or say nothing. It drafts one proposed ADR per topic from the lines that decide it, and lists each document's path, SHA-256 and lines in the ADR. It also lists the other decisions the documents make, such as an ADR written in another format; you take all of them, some or none. Where your documents leave a gap, or two of them disagree, or one disagrees with the code, MACH asks you, one question at a time. Where one disagrees with a technical need the product manager published, MACH asks you which to follow and says the product manager owns the need; it never changes the need.

When nothing is open, MACH asks once whether to accept the drafts, then offers to commit them your project's way. Once they are on the main branch, MACH plans and builds tickets. Change a document later and MACH says so the next time; it uses that document again only after you name it again.

## 2. Product intake, plan and dispatch

**The one command: `/mach pull`** (`RUN pull [--limit n] [--sequential] [--dry-run]`). It takes in every slice marked ready, picks the next batch with the schedule's rules (dependencies merged first, the product manager's order within an epic, oldest ready first; never more than `factory.max_parallel`, at most `factory.max_parallel_high` High-risk, no two tickets whose plans touch the same file, a ticket another worker holds left to it), dispatches the slices it picked, and prints what starts now, what waits and why, what was not accepted, what waits for you, and the tickets to run. Tickets already in the line count against the limit and are carried on in the same run. The skill then runs them (the belt workflow for several, in the conversation for one) and walks you through what waits for you. `--dry-run` changes nothing. It is refused inside a supervised execution and enables nothing. The `product` commands below remain for looking and for doing one step.

Slices product managers marked ready in Product Studio are taken in through `RUN product ...`. A slice arrives as a GitHub issue (`mach:slice` and `mach:ready`) in the repository the `origin` remote names, or, without GitHub, as a `product/ready/SLICE-NNN/` folder committed on the integration branch, or as a folder handed to you (`product import <folder>`). Nothing runs unless you say so, or a supervisor you enabled on this machine.

- `product status` and `product plan` only read. Status shows each slice marked ready (`new`, `known`, `modified`) and everything `not_accepted` with its reason in plain words. Plan lists every slice as `completed`, `active`, `ready` or `blocked`, with reasons, and the order they go in.
- `product intake` takes each new slice revision in once. `--dry-run` first. A slice from GitHub is its own ticket: the issue number names the ticket, the cell, the branch and the pull request (`/mach 41`). A folder gets one local ticket. Repeating it takes nothing in twice.
- An issue counts only when the last person who added `mach:ready` has the triage, write, maintain or admin role, wrote an unedited approval comment for that revision and those hashes, the body is intact, the epic's issue is Product Studio's, and the spec passes the intent gates. This guards against accidents and edits, not against someone with write access who sets out to forge an approval.
- A slice waits until what it depends on is merged (its commit on the integration branch); then the product manager's order within the epic; then the oldest marked ready. An approved cell is still `active`, and dependents stay blocked.
- `product dispatch <SLICE-ID or issue number>...` or `--ready` opens the cells, commits each spec on its ticket's branch with a header line naming its epic and issue, and stops at `spec-ready`. It starts no agent. Product-sourced work is never reviewed below Medium.
- `product reconcile` is intake plus a recorded plan plus the status writes. It never dispatches.

### What the slice's issue is told

Through `ticket.py slice-status`, from fixed templates with a hidden marker, recorded in the ledger before they are tried and retried on the next pass; they never block the line: `mach:building` when the cell opens; `mach:question` with the contract engineer's question (redacted, bounded, mentioning nobody) when the spec has a defect only the product manager can settle; `mach:shipped`, and the issue closed, once its merge is on the integration branch; a comment when the cell is blocked; and a comment when the slice changed while it was being built. `tickets.github.status_comments: false` stops the comments and keeps the labels. The Factory writes nothing to a request's issue.

### When a slice changes

- Waiting work takes the new revision on the same ticket.
- Work in the line is never changed: it is flagged for you. Let it finish (the new revision follows on the same ticket once it ships), or abandon it with the cleanup station and the next intake takes the new revision.
- A cell stopped for the product manager's answer (`needs: product-answer`) takes the new revision and plans again.
- Shipped work changed comes as a new issue that says `Changes #N, which has shipped.`
- `product intake --reissue <SLICE-ID>` puts abandoned work back in the queue on the same ticket, only when you say so.

### Working as a team

Several engineers may run `/mach pull`, or their own supervisor, against one repository at the same time. No slice belongs to anyone in advance. A Factory takes a slice nobody is building; another Factory skips it and takes the next. You can take one over by saying so.

- **The claim.** Just before MACH opens a cell for a slice from an issue, it posts a claim on the issue: "The MACH Factory is taking SLICE-011 revision 2 to build it." It then reads the comments again. Only the Factory whose claim came first, in GitHub's own order, goes on.
- **Each machine is its own Factory.** MACH keeps a random value for this clone in `.factory/local/factory.json`. Your two machines are two Factories, even when both are signed in to GitHub as you.
- **A slice someone else is building** is skipped. `product status`, `product plan` and `/mach pull` say "SLICE-011 is being built by @x since 2026-11-23 14:02 UTC", and pull starts the next slice nobody is building. If two Factories reach for the same slice at the same moment, the one that came second starts nothing and says who has it. When everything ready is being built elsewhere, pull says so.
- **A slice reopened and marked ready again** stays with the Factory building it. That Factory decides about the new revision.
- **When a claim goes quiet.** A claim with no activity from its Factory for 3 days is stale. The plan says "Claimed by @x, no activity for 4 days: free to take", and the next pull may take it. Activity is a MACH comment on the issue from that account, or a commit on the slice's branch on GitHub. Change the number of days with `intake.claim_stale_days` in `.factory/config.json`.
- **Taking a slice over.** Run `product dispatch SLICE-011 --take-over` after checking who has it. MACH builds it here, and the issue says it was taken over. MACH never takes a slice over by itself, and a supervisor never does.
- **Releasing a claim.** Abandon the work on your machine, and MACH withdraws its claim. A reissue on the same machine claims it again.
- **An open pull request.** When you start a slice and a pull request for it is already open, MACH tells you, so you can look at it first.
- **The main branch takes a slice once.** Before your copy is merged, MACH looks at the main branch, including the shared one as last fetched. If this revision is already there, it stops and says: "SLICE-011 was already shipped from another Factory (merged as 4be1c09a2f3d). This copy was not merged." Put the copy aside with `cleanup run <ticket> --abandon "already shipped from another Factory"`. The branch's commits are kept in the archive. To keep the branch itself, copy it first with `git branch feature/<ticket>-copy feature/<ticket>`. The merge station checks the same again before it merges, pushes or opens a pull request. If your copy's pull request is already open, MACH leaves it open and tells you to close it on GitHub.
- **Slice numbers for your own tickets.** When you groom a ticket, MACH takes the next slice number after the ones on this computer, on the shared main as last fetched, and, on GitHub, on every slice issue. If GitHub cannot be read, MACH says so. Two engineers who number a ticket in the same minute can still take one number. The merge station then refuses the second: "SLICE-011 is already on main as ..., which is another slice than this ticket's ...". Give that slice a free number on its branch.
- **Architecture decision numbers.** A new ADR takes the next number after the ones on main, in your working tree, in your open cells, and on the shared repository's branches as last fetched, open pull requests' among them. Fetch before you write one. Two engineers can still take one number in the same hour. Then neither ADR binds, and every plan is refused, until one is renumbered. The refusal names both files and gives the command for the later one: `/mach adr renumber docs/adr/0007-use-sqlite.md`. It renames the file and changes the references to it in the other ADRs and the overview. It lists any file it cannot be sure about for you to check. Commit the change by pull request.
- **Several project issues.** If the repository has more than one open project issue, MACH stops grooming your ticket instead of going on without the product principles. It names the issues. A person closes the one that should not be there, and grooming carries on.
- **A dependency built on another machine** counts as done once its approved spec is on your main branch. The plan shows it as "Another Factory built it".
- **The issue stays truthful.** Only the Factory whose merge landed marks the issue shipped and closes it.
- A claim from an account without at least the triage role does not count. Slices from ready folders are not claimed: with folders, agree who pulls.


### A small change

A small change is a fix to a shipped rule that is not holding, or an adjustment to wording, presentation, a default or a limit. It has a short interview and a shorter spec. No station after grooming does less for it: the plan, the failing test first, verification, the review panel at the ticket's risk tier and the merge station are the same.

- **From Product Studio.** The slice's issue and its approval say it is a small change, and whether it is a fix (with the shipped rule) or an adjustment. Intake checks that the two agree; one edited after approval is not accepted. It is taken in, scheduled and dispatched as any slice.
- **Your own ticket.** Say it is a small change when the interview starts (`/mach new "..."`, then say so), or label the ticket `small-change`. Headless grooming and `AUTO-` tickets never take the short interview.
- **MACH decides what is small**, by fixed rules, when the spec is checked: one actor and one epic; at most three functional requirements, four scenarios and one decision matrix; at most one shipped rule changed or replaced and none retired; no principle answered with an exception; no policy concern; no new permission and no dependency on a slice that has not shipped; risk Low or Medium. A change that is not small is never refused for its size and never trimmed: it becomes a full slice, with one fixed sentence naming the rule, and the interview carries on in full.
- **After the plan.** `check-plan` applies what only a plan can show: an existing contract changed, a file in a high-risk area, a proposed ADR, or a plan that raises the risk to High. Your own ticket goes back to the interview in full, with its plan kept under `plan-history/`. A Product Studio slice stops with a question for the product manager on its issue (`needs: product-answer`); they reopen it, it comes back as a new revision that is a full slice, and the line plans it again.
- **Limits.** `intent.small_change` in `.factory/config.json`: `requirements` (3), `scenarios` (4), `questions` (5) and `changed_shipped_rules` (1, which can only be lowered).
- **Where it shows.** The pull request title and the change record say "small change" beside the ticket; one that became a full slice says so, with the rule. The Line names it on the ticket, and Analytics sets time at Groom for small changes beside full slices.

**Re-planning a wrong plan.** `cell.py replan <ticket> --reason "<why>"` (the intent station's script), only when you say so, returns a `planned` or `building` cell to `spec-ready` so the line plans it again. Nothing is lost: the old `plan.md`, `build.json` and `build-report.json` go under `plan-history/<n>/`, the branch goes back to the slice's latest spec, and if the branch had moved its old tip is kept as `refs/mach/replan/<ticket>/<n>`, with any uncommitted files in the cell saved on top of it. The result lists any commit MACH did not recognise with the `git cherry-pick` that brings it back, and the uncommitted files with the `git checkout` that brings them back. It refuses a cell that has been through a judging round, task work already on main, and an empty reason. It adds no judging round. `RUN next` then says `plan`. A spec corrected after building started needs no re-plan: the intent station sets the old plan and build aside the same way, by itself, and plans again.

Open question from testing: nothing distinguishes a product manager's copy from an engineer's. A refused dispatch there was refused only because the copy had no intake ledger. `factory enable` ran its preflight and issued a code there. Treat "only an engineer dispatches" as a convention until this is decided.

### Building in lanes

A plan's independent parts can be built at the same time, each by its own builder. Each part is a **lane**: a chain of tasks that shares no file and no requirement with another lane. Each lane works in its own worktree under the ticket's cell (`.factory/worktrees/<ticket>/lanes/<L>/repo`, on the branch `mach-lane/<ticket>/<L>`), from the same starting commit, under the same gates as any task: test first and seen failing, committed tests frozen, the plan's files only, the whole suite after each code task, the secrets scan before each commit. When every lane is done, MACH joins them: it lands their commits on the ticket's branch, one per task, in the plan's order, runs the whole test suite on the result, and only then moves the branch. The history then looks like a build done one task at a time. Verification and review are unchanged.

**It is on by default, and only for plans written for it.** `build.max_lanes` is 3 unless you set it. But only a plan whose author divided its tasks under `### Before the lanes`, `### Lanes` and `### After the lanes`, or marked a task `after T04`, is built in lanes. The contract engineer is told to plan that way where the slice really has separate parts, and never to split work only to look parallel. A plan written the old way is built one task at a time, exactly as before, whatever the setting. So is a revision round, a `repo-hardening` ticket, and a ticket whose suite is not green when the lanes would open. `cell.py check-plan` shows the lanes a plan gives, and why any two tasks were put in one lane.

**Turning it down or off.** In `.factory/config.json`:

```json
{ "build": { "max_lanes": 1 } }
```

1 builds one task at a time; 2 allows two lanes at once. `factory.max_builders` (default `factory.max_parallel`) caps builders on this machine across every ticket. Lanes take only the places other building tickets leave free, so lanes on their own never put more builders on the machine than that; a ticket whose lanes are open always keeps at least one. With no place for a second builder when the lanes would open, the ticket is built one task at a time.

**Measuring your past builds.** Before you rely on it, see what your own plans would have allowed. In a script install:

```
python3 .claude/skills/mach-build/scripts/lanes.py measure --project .
python3 .claude/skills/mach-build/scripts/lanes.py show .factory/worktrees/<ticket>/plan.md
```

With the plugin, ask Claude Code to run `lanes.py measure --project .` from the `mach:build` skill's `scripts` folder; it is the same script. `measure` reads each ticket's cell, or its archive once cleaned up, and changes nothing. For each build it prints the tasks, the lanes the plan's shape gives and why tasks were joined, the time the build took and its share of test time, and estimates of the time in lanes with two, three and four at once. The estimates come from recorded numbers and are labelled as such; making worktrees and landing are assumed at 30 seconds each unless you give `--worktree-seconds` and `--landing-seconds`. `measure` applies the lane rule to every plan, so for a plan written the old way it says what its shape would have allowed, not what MACH does with it.

**What you see.** In `/mach`, when the tasks before the lanes are done: how many builders start and what each is building ("Two builders are now working at the same time: one on who may invite (T03, T04), one on the invitation e-mail (T05, T06)"); after the join, how many tasks landed and whether the whole suite passed. `/mach status` and `/mach explain` carry one line on the ticket's lanes. On the Factory Floor's Line, a ticket built in lanes has a strip under its row from the Build column on: one chip per lane with its current task and how many of its tasks are done, and the moment of the join ("The lanes are being joined", joined, a lane set aside, or the lanes failing together). Its side panel groups the tasks by lane, each with its time.

**When a lane does not work out.** Nothing stops the ticket, and nothing is lost:

- **A lane that cannot finish** (it truly needs a file the plan gives another lane, or its builder stopped twice with nothing more done) is handed back to the cell, by its builder or by the line. Its finished tasks land at the join; its other tasks are built in the cell, one at a time, after it.
- **A lane that proves not independent** (two lanes changed one file, one changed a test file another lane holds, two file names differ only by letter case, or one lane's file is another's folder) is set aside at the join, by MACH, the later one in plan order. So is a lane whose branch holds a commit no task recorded, or one of whose commits does not apply. Its tasks are built again in the cell, one at a time, where they see the landed work, and its commits are kept under `refs/mach/lanes-set-aside/<ticket>/<L>/<n>`: `git log <ref>` shows them and `git cherry-pick <commit>` brings one back.
- **You committed in the cell while the lanes were open**: your commit stays. The lanes land on top of it; a lane that changed a file your commit changed is set aside as above and its tasks are built on top of your work. Uncommitted edits in the cell's checkout hold the join until you commit them or set them aside.
- **A builder stopped mid-step**: if its commit was made but not recorded, the next step (or the line opening the lanes again) finds it and records the task as done. A lane folder you deleted is made again at its last recorded commit; a lane folder or branch left by an earlier build of the ticket is set aside, kept, and the lane starts fresh.
- **Lanes that fail together**: the whole suite fails on the joined result (each lane's own suite at its end is recorded, and only when every one was passing is that said). The joined result is kept, and MACH adds one task, `J-T01`, for the builder to make them pass together. Every test is then frozen, so the fix is in the code.
- **A join that cannot land** changes nothing on the ticket's branch and keeps every lane; run the ticket again and the join starts over.

Cleanup keeps every ref MACH made for the ticket (set-aside lanes, a lane's set-aside files, a re-plan's old work) in the ticket's archive, and says the command that brings them back.

Each of these is recorded with its reason and shown to the reviewers, in `/mach explain` and in the change record.

**The cost.** Each lane's builder reads the plan, the spec, the contracts and the code next to its files again, so with three lanes expect about two extra readings of that, plus small calls to start and join the lanes. Token use rises when lanes run. MACH records cost only for supervised executions, as one total per execution, never per lane. The time a lane takes includes any time its builder sat idle. Lanes run their test suites at the same time, so where a suite already keeps every core busy, or uses a fixed port, a shared database or a fixed temporary path, the gain is small or the runs can clash; set `build.max_lanes` to 1 for such a project.

### The test command

Every step of a build runs the project's tests, so a build always has a test command. MACH looks for it in this order: `--test-cmd` given to the build's start, `build.commands.test` or `audit.commands.test` in `.factory/config.json`, then the command the audit found. When none is known, the build does not start: the cell stays planned, nothing is recorded, and the message says how to give one.

The builder may choose the command itself: the one the plan or the project's documents name, or one that fits the project's language and layout. It may also set or change it at any time while the ticket is building, in lanes or not, in a revision round, or after its tasks are finished but before it is verified:

```
python3 .claude/skills/mach-build/scripts/build.py set-commands <ticket> --test-cmd "<command>" --reason "<why>"
```

With the plugin it is the same script, in the `mach:build` skill's `scripts` folder. Nothing done is undone: done tasks stay done, and the build carries on where it was. Each change is recorded with the old and the new command, the reason and when, and the reviewers, `/mach explain` and the change record show it. A missing or wrong test command never means starting the ticket over.

### Running Claude Code in a sandbox

Claude Code's sandbox lets a command write in the project and the temporary folder, not in your home folder, so a package manager whose cache is there (npm's `~/.npm`, pip's, Gradle's `~/.gradle` ...) fails on every install. MACH handles this by itself, for the commands its stations run (the audit, the build, verification, the merge and release qualification):

- For each package manager the project uses, MACH tests whether its usual cache can be written from here. When it can, nothing changes. When it cannot, MACH points the tool's own variable (for npm, `npm_config_cache`) at `.factory/cache/<tool>/` in the project, for those commands only. Your settings files are never changed, and a variable you set yourself is never overridden. The folder stays between runs, so only the first install downloads everything; every ticket and every lane of the project share it, and it is never committed.
- The audit report, the build's start, the verification's start and the merge's result say which tool was pointed where, and why. `/mach doctor` lists each tool's cache and what MACH will do about it.
- For any other tool, add its variable to `commands.env` in `.factory/config.json`. `{cache}` is MACH's cache folder and `{project}` the project's folder:

  ```json
  "commands": { "env": { "CARGO_HOME": "{cache}/cargo" } }
  ```

  A command's own leading `VAR=value` wins over this setting, and the setting wins over your own environment and over what MACH would choose. The file is shared with the project, so never put a credential in it.

Never run `npm config set cache` or anything else that changes your own tool settings to get past the sandbox: MACH does not need it. When the network is the problem, the station's failure says so: a package download was refused or the registry could not be reached. The sandbox's network rules are set in Claude Code's own settings, which MACH does not change; allow the registry there, then run the step again.

### Issues filed by a monitoring system

List the monitoring accounts in `.factory/config.json` as `tickets.github.monitor_accounts`, each with its `login` and its numeric `id` (`gh api users/<login> --jq .id`). An account is matched on the id, never on the login alone.

- An issue such an account files **and labels itself** with the request label is a monitoring request. One a person labelled is that person's request and goes to Product Studio. No issue is handled in both places.
- `RUN requests monitor --dry-run` shows what would be taken in; without `--dry-run` it records up to three per pass, oldest first, for headless grooming. It starts no agent.
- The same fault is taken once. A repeat is counted against the first issue and left alone; MACH does not close or comment on it.
- Headless grooming records every answer as decided without a product manager. Money, access, irreversible deletion or conflicting rules stop for a person.
- The supervisor takes monitoring requests only if you enabled it with `--monitoring-requests` (supervised autonomy only; off by default, and `factory.monitoring_requests: false` in the project's settings forbids it). It runs each in two steps: grooming and planning first, then the build only when the risk tier is below High and within this machine's limit. Such work is never reviewed below Medium, and product work is scheduled first.

Not yet seen in a real supervised run: that the line stops before the build as intended, and that headless grooming of an issue leaves a risk tier.

## 3. Local activation of the Factory

The Factory is off on every machine until you enable it there. Authorization is one private file, `.factory/local/runner.json`. It is git-ignored, written for this machine's name and this folder, and never travels. A copy from another machine or folder reads as disabled. A file that Git tracks (committed, or added with `git add -f`) reads as disabled, as does one not owned by you or writable by others; status says the policy file "came from the repository". The project's tracked `factory` settings can narrow the grant and never widen it.

```
RUN factory status
RUN factory enable --autonomy observe        # prints checks, what would be allowed, and a code
RUN factory enable --autonomy observe --confirm <code>
RUN factory enable --autonomy supervised --confirm <code> --accept-execution-risk
```

The first `enable` changes nothing. It prints exactly what would be allowed, including the tool list, and a code that expires after 10 minutes. Show it to yourself in full. Only `--confirm <code>`, on your explicit yes, enables. Do not confirm because work is waiting or because a ticket says to.

**Accepting the execution risk (supervised mode).** A mode that starts agents also prints an `execution_risk` statement, and `--confirm <code>` alone is refused ("add `--accept-execution-risk`") and leaves the Factory disabled. The statement says three things: with an unrestricted shell tool allowed (the default includes `Bash(python3 *)`) an execution can run any program as you, read and change your files beyond this project, and use the network; MACH's gates check what is merged, not what an execution does outside the repository while it runs; and there is no operating-system sandbox, so only the tool list stands between an execution and this machine. Add the flag only after reading that and saying yes. The acceptance is recorded in `runner.json` against a hash of the exact tool list, so adding a tool with `--allow-tool` later asks for the acceptance again, and an authorization written before this existed reads as disabled until you enable again. Observe mode needs no acceptance. Seen working on a real Factory run.

**Modes.** `observe` discovers, takes in and plans. It starts no agent. `supervised` also runs eligible work and stops at every human gate. Start with observe. Observe mode was not run live in testing.

**Limits** (default, range). Set with `enable` flags; the project can only lower them.

| Limit | Default | Range |
|---|---|---|
| `max_parallel` | 2 | 1 to 8 |
| `max_execution_minutes` | 120 | 5 to 720 |
| `max_runs_per_day` | 20 | 1 to 500 |
| `max_budget_usd_per_run` | 25 | 1 to 500 |
| `max_budget_usd_per_day` | 100 | 1 to 5000 |
| `max_attempts` | 2 | 1 to 5 |
| `poll_seconds` | 300 | 30 to 3600 |

Also `--max-risk` (tickets above it wait for a person), `--allow-merge` (default off; every execution then stops before merge), `--allow-tool` (an extra tool, such as `Bash(make test)`), `--auto-sync`, `--hooks` and `--persistent` (a macOS per-user service). Each of the last three is its own yes.

**Controls.** `pause` starts nothing new; running work finishes. `resume` re-checks readiness first (`--retry <ticket>` for named tickets). `disable` revokes authorization here (`--stop` also ends running work). `stop` is the emergency stop: running executions end now, the Factory pauses and each outcome is recorded as unknown. Check each ticket before resuming it.

Enabling does not start a supervisor. Run `RUN factory serve` for the session, or use `--persistent`. `RUN factory tick` makes one pass.

**What a supervised execution may touch.** One execution works on the one ticket it was started for. Inside it, `RUN next`, `review-start` and `review-tally` for any other ticket are refused ("started for <ticket> only"), `status` lists only that ticket, and the belt starts no observe pass and no `factory-tuning` ticket. When an observe pass is due the supervisor starts nothing for it: it raises one `human.required` per count of finished tickets ("An observe pass is due: N tickets have finished since the last one") and you run the pass yourself. A person-started `/mach` or belt is unchanged. Observed live in a short run.

**A run that makes no progress is parked at once.** If an execution ends with the same refusal twice (a build stopped on the same task) or the belt reports `stuck` for the ticket, the supervisor records `not_progressing`, parks the ticket for a person and does not spend the remaining attempts ("Retrying would repeat it"). A killed execution (a signal, a negative exit code) is recorded as killed with its exit code and counts as a failed attempt; only a clean exit clears the count. The plan gate also refuses, at `cell.py check-plan`, a plan whose later `[impl]` task names a requirement that all of its tests already preceded, which is the plan that cannot go green. Observed live: the plan check refusing a real plan, a stuck belt parked at once (at the plan station, not a build) and a killed execution recorded as killed. The same-refusal build case has tests only. Where a parked ticket's plan is wrong, use `replan` above.

**One runner per project per machine.** An ownership lease with a heartbeat enforces that. Several engineers may each enable a supervisor on their own machine for one repository. Every supervisor claims through the same rule as `/mach pull`, skips a slice another Factory is building and never takes one over (see "Working as a team" in section 2), so each builds only what it claimed.

## 4. Human gates

The scripts decide the order. These stay with a person:

- **High-risk approval.** The panel approves first; only then can `review.py approve-human` record a person's approval, on their explicit word and after seeing the findings. A person cannot approve over a rejection. A Silver tier also needs it.
- **The merge.** By default an unattended run stops before it. `merge.py --by-person` lifts only the merge mode and the per-tier setting. It still needs an approved stage, the commit review approved and any required human approval. A new commit voids the approval.
- **Open questions, escalation after three rounds** (`blocked-requires-sme`), and anything under `needs_person`.

**Merging in a team.** When several engineers merge into one shared main, use `merge.method: "pr"`. MACH fetches `origin/main` and re-tests each ticket against it, so it sees what the others merged. It reads `origin/main` again just before it merges and re-tests if it moved. If origin cannot be reached, MACH merges nothing. The `local` method, the default, suits one person: it merges on your machine only, after checking your main already has everything on `origin/main`, and you push main yourself. `/mach doctor` warns when more than one person can push to the GitHub repository and the method is still `local`. On GitHub, protect the main branch: require a pull request, require status checks to pass, and require branches to be up to date before merging. Then GitHub refuses a merge onto a main that moved in the last instant. `/mach doctor` warns when this is not set and says how to set it.

The supervisor never: approves a high-risk change, answers an interview, merges unless you chose `--allow-merge` and the project's merge settings permit it, widens its own tools through its own commands, or retries a lost merge or cleanup. Its tool list has no `git push` or `gh`. Section 8 explains why that is not a hard barrier.

### The security review rule

A reviewer finding may carry `class: security` and an `impact` (critical, high, medium or low); the security seat's findings are security-class without saying so, and an `impact` without the class is refused. A blocker of class security with impact high or critical, from any seat, rejects the round at every risk tier whatever the vote count, and `review.security_veto: false` does not switch it off. In rounds 2 and 3 such a blocker may be raised on any file. There is no exception record: the only ways past it are a fix and a new round, escalation, or abandoning the ticket. The supervisor also refuses unattended work while tracked settings remove the security seat (`security_veto: false`, `reviewers: 1` for Medium or High, or `high.human_approval: false`), checked on every pass.

Still open: a blocker from a non-security seat that is not marked as security is outvoted at Medium as before, and Low tickets have no security seat.

## 5. The Factory Floor

Ask the run skill to "open the Factory Floor". It starts `mach-observer` (from `.factory/bin/` or a checkout's build) and gives you a one-time link to `127.0.0.1`. A second browser takes the link kept in `.factory/local/observer/link`. It is read-only: it enables, starts, pauses, dispatches, approves and merges nothing, takes no lock and runs no MACH script. Stopping it never affects the line.

Four workspaces: the **Line** (stations as columns and tickets as rows; the default, key 1), the **Floor** (the isometric Factory Atlas, key 2), **Analytics** (key 3) and **Decisions** (key 4): the project's architecture decisions, the required baseline and what is covered or missing, the tickets stopped on a decision and the proposals waiting to be accepted, and each decision's text, the live tickets planned under it and the exceptions recorded against it. Decisions only reads: you accept, change or except a decision with `/mach adr ...` in Claude Code and a pull request for the ADR file. It shows the Factory as it is now; there is no playback. It is labelled **Live Factory** when it reads this machine's state, and **Simulation** (invented work) when there is none.

"Held at an earlier moment" means the playhead sits behind the live edge, so Analytics counts only what was recorded up to that moment. Nothing recorded after it is read. `L` or `End` returns to live.

Known limits: a supervisor hold is prose with no reason code, so the Factory Floor cannot show it as a wait on a person. Repeated lifecycle lines are counted again. Analytics cost leaves out failed executions. A 240,000-event history switches between workspaces in 598 to 874 ms against a 300 ms budget. Names in free text are served, labelled (see the operator guide).

What the real supervised runs of M7 (a throwaway project, one Mac) showed and what was done about it. Seen again live after its fix: the plan check refusing a plan that cannot go green, a killed execution recorded as killed, a released claim left out of the execution counts, the release-readiness line following the acceptance record, a re-review after a voided approval kept in its own `round-N.k` folder, and the shared-contract rule in release qualification. Fixed afterwards with unit tests only, not re-observed on a page or in a live run: a killed execution reading "killed (exit code)" on the floor, the Timeline and the retries lens (it read "failed"); a "Parked: ..." reason for a build that stopped making progress; an abandoned ticket dropped from the waiting list ("Abandoned, reissued as ..."); the product state after a revision. Still open: Analytics cost leaves out failed executions, and a killed execution has no recorded cost, so real spend can be higher than shown ("a lower bound"); a repeated review round and a voided approval are **not shown on the Factory Floor page** (the observer serves them, the page does not word them); an abandoned cell's tile still shows its last stage word, though its mast and inspector say Abandoned; a supervisor restart has not been checked on the page.

## 6. Recovering an interrupted run

Every execution is written as `claimed` before any process exists. A restarted supervisor tells these apart:

| Situation | What happens |
|---|---|
| Claimed, never started | The claim is released. Nothing ran. |
| Still running | Adopted. Not started again. |
| Ended while unwatched | Closed from its result file and the cell's records. |
| Outcome unknown | See below. |
| The line says stop, or the ticket is parked | Left for a person. |

For an unknown outcome the cell's stage is compared with the stage at the start. If stations recorded progress, it stands. If nothing moved and the station was **merge or cleanup, the ticket is parked for a person and never retried automatically**. Otherwise it counts as a failed attempt, up to `max_attempts`, and then the ticket is parked. No exactly-once guarantee is made: an interrupted station may repeat work it had not recorded. This was tested with stand-ins and also seen live: a supervisor killed with SIGKILL and restarted adopted both running executions and dispatched nothing twice; a killed execution was retried and finished. **Not seen live:** a machine reboot or loss of the network during an execution.

The line itself is driven by what stations recorded, so running `RUN <ticket>` again resumes where it stopped.

## 7. Release qualification

`RUN release status` lists snapshots. `RUN release qualify --epic <EPIC-ID or issue number> | <SLICE-ID>... [--release <id>] [--commit <sha>]` evaluates an epic, or the slices you name, on the integration branch at one commit and writes `.factory/release/<id>/readiness.json`. It reruns the project's test suite on a clean tree, which runs the repository's own code. `RUN release show <id>` prints the checks.

Qualify on any machine that has the integration branch. MACH reads each slice's ticket, verdicts, contracts and evidence hashes from the change record merged with it (`docs/changes/`), so a Factory that built none of an epic's slices reaches the same outcome as the Factories that built them. Evidence files stay on the machine that built the ticket: where this machine holds one, MACH checks it against the SHA-256 in the record, and the result's `evidence_files` counts those checked here and those held on another machine. Never edit a change record after it merges: MACH then stops counting it and the slice is blocked. A slice merged by MACH 0.21.0 or earlier has no such facts in its record and shows as `missing`.

Four outcomes:

1. **blocked**: a check failed, or a review blocker is open, with no exception.
2. **incomplete**: a required check is missing, not run or not configured, with no exception.
3. **qualified_with_exceptions**: everything else passed, but a person recorded an exception.
4. **qualified**: every check passed.

A missing check is never a pass. No scanner report means `not_run`, which makes the result `incomplete`. An exception is recorded only on a person's explicit word, after they have seen that check: `RUN release except --release <id> --check <check-id> --by <role> --reason "<text>"`. Use a role, never a name. It counts only at the commit it was recorded for; qualify again afterwards. Qualification ships, merges, tags and deploys nothing. Product's acceptance is separate: the product manager records it as a comment on the epic's issue, and the snapshot reports it (`accepted`, `rejected` or `not_recorded`) only from a comment written by the account it names, unedited, with the triage role or above.

Scanners are not run by MACH. Someone runs them and puts their reports under `.factory/release/scans/<name>.json` for the exact commit. A report counts as a scan only if it carries every fact MACH needs to judge it: `tool`, `version`, `commit` (the release commit), `exit_code`, `scanned` (a number greater than zero), `scanned_at` and `findings` (each with `id`, `severity`, `title`; `critical` or `high` fail). One example, a clean gitleaks run:

```json
{"tool": "gitleaks", "version": "8.18.4", "commit": "<40-hex release commit>", "exit_code": 0, "scanned": 214,
 "scanned_at": "2026-11-14T10:00:00Z", "findings": []}
```

A report that lacks a field is `not_run` with "report lacks <field>"; so is one that records an `error`, an exit code other than 0 (clean) or 1 (findings found), or `scanned` of 0. A scanner that found nothing to read (osv-scanner on a project with no dependency manifest exits 128) must be written down as exactly that, not as an empty list of findings, or a false "clean" results. This is stricter than earlier versions: an older report without these fields is now `not_run`.

**The outcome line.** `qualify` prints a one-line outcome that names every check that is missing, not run or not configured, required or optional, with its reason, whatever the outcome, for example `qualified; not assessed: performance (not configured)` or `incomplete; not assessed: security.scan.osv-scanner (not run: report lacks scanned)`. Read it before you read the word qualified. Optional checks (performance with no command) never change the outcome and are never hidden. The record is deterministic: the same inputs give the same bytes. Qualification across five slices of one delivery, including slices that share one contract file, was run live (before M11, as a wave) and gave `qualified`; a sixth slice's scanner report with zero sources gave `incomplete`. The new report format and the outcome-line wording were checked by tests only.

## 8. Security boundaries in brief

- Local services bind `127.0.0.1` only and need a one-time link.
- An unattended run gets an explicit tool list, a spending cap and a time limit, and nothing else.
- That list includes `Bash(python3 *)`. A prompt injection that succeeds could therefore run arbitrary code as you. There is no operating-system sandbox. Read the operator guide before enabling supervised mode on a machine with credentials you care about.
- Build, test and verify commands run the repository's own code with your privileges.
- Credentials: nothing in a key, token or secret-like environment name reaches an unattended run.

See `OPERATOR_SECURITY_GUIDE.md`.
