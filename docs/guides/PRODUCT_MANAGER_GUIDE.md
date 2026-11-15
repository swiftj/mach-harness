# Product Manager Guide

This guide is for a product manager who defines work in MACH Product Studio. It assumes no engineering background and teaches no Git. Product Studio is experimental. This guide describes the code at this release candidate, not a promise of readiness for regulated or enterprise production use.

Where something was only tested with stand-ins or on one machine, the text says so. See `RELEASE_NOTES_DRAFT.md` for the list of what was and was not tested.

## 1. What you need on your Mac

- **Claude Code**, signed in. Product Studio runs inside it.
- **Git.** On a Mac, Terminal may ask to install the "command line tools". Click Install. They include Git and Python.
- **Python 3.8 or later.** The same command line tools provide it. Only Python 3.9.6 and 3.15 were tried; nothing older than 3.9 was run.
- **The GitHub command-line tool (`gh`), signed in.** Sending your work to engineering uses it. An engineer can set this up with you.
- **A copy of the shared project.** An engineer gives you this once. After that you do not need Git commands for anything in this guide.

MACH is built for Apple silicon Macs and for Linux (arm64 and amd64). There is no build for Intel Macs or Windows. On an Intel Mac or Windows the terminal version of Product Studio still works, but the visual app is not available.

### If something is missing

The installer says so and stops. These are its words:

- No Python: "MACH needs Python 3.8 or later, and it is not installed on this computer (or is older)." It then tells you to run `xcode-select --install` in Terminal, click Install, and run the installer again.
- No Git: "MACH needs Git, and Git is not installed on this computer." The same `xcode-select --install` step fixes it on a Mac.

If the visual app could not be downloaded, the install still succeeds and says so. Everything else works without it.

## 2. Starting Product Studio

In Claude Code, in the project folder, ask for Product Studio. With the plugin the skill is `/mach:product-studio`. With the one-project install it is `/mach-product-studio`. With nothing after it, it shows where things stand and suggests the next step.

For the visual app, say "open the app". Claude starts it on your own computer and gives you one link. The link works once and only on your computer. Do not share it. The app and the conversation work on the same drafts, so you can switch between them.

Neither one starts any engineering work. That is a fixed rule of Product Studio.

## 3. The project, epics and slices

A **project** has a name, a vision and one or more outcomes. An outcome is a result for a person, such as "Invited members can open the campaigns they were invited to". It is not a feature list.

An **epic** is a larger capability. A **slice** is one thin, complete outcome for one kind of user, small enough to build and check in one go. Each slice has three parts: a work order, a "why", and a spec written in business terms. An epic must be approved before its slices can be.

Everything you write is a private draft until you approve it. Drafts live in a folder in your project that is not shared. Nothing leaves your computer until you send a wave (section 8).

## 4. The interview

For each slice, Claude interviews you one question at a time. Each question is a yes-or-no proposal with a recommended answer.

| You say | What happens |
|---|---|
| `yes` | The recommendation is accepted. |
| A different answer | Your answer is used. |
| `I don't know` | It becomes an open question with a note on who can answer it. |
| `you decide` | The recommendation is used and listed as an assumption for you to review. |
| `I need to stop` | Your progress is saved. Say "continue SLICE-004" later. |

Claude cuts the idea down to the smallest complete outcome and reserves IDs for what it defers. It will not ask you about technology. When nothing is left to ask, it gives a three-point summary and asks for your yes before it writes the spec.

In the visual app the interview runs through your own Claude Code, one reply at a time. In one test it ran two real turns for about USD 0.23 in total. That was a single interview on one slice, so do not treat the figure as typical.

## 5. Reviewing and approving a slice

After the write-up, Claude checks the spec with the same checker engineering uses and tells you:

- the outcome in one sentence, and whether it is ready or how many questions are open;
- how many rules and scenarios there are;
- the assumptions you accepted;
- the deferred features and their reserved IDs.

Read the assumptions. They are the places where the recommendation stood in for your decision.

Approval is your act. It is refused unless the spec has no open questions, the "why" is complete, the epic is approved and every dependency exists. An approved slice is frozen. To change it, ask to reopen it. A reopened slice is no longer approved, and any approved wave that holds it goes back to draft.

## 6. Delivery waves

A **delivery wave** is a set of approved slices you want delivered together. A slice that another depends on goes in the same wave or an earlier one. Approving a wave checks every slice again and records who approved it and when. An approved wave cannot be changed. Start a new one instead.

## 7. Refreshing, and your unpublished drafts

Product Studio refreshes at the start of a session. A refresh reads what others have shared and brings it into your workspace. It does not change your drafts that nobody else touched. In one test with two product managers, an unpublished draft was still there after three refreshes and two merged waves.

A refresh can tell you:

- **Arrived or updated:** what changed, listed by requirement, rule and scenario number.
- **Approvals withdrawn:** a change from the shared project made one of your approvals untrue. You will be told which and why.
- **Needs reconciling:** see section 8.

If it could not reach the shared repository, it says so and carries on with what you have.

## 8. When a colleague changed the same thing

There are two cases.

**A conflict** means the same item changed in both places. For a project, epic, work order or wave, Claude lists each field with your value and theirs, and asks you which stands. For a spec or a "why", text is never blended. Claude explains both versions in product terms and you choose one. If you want parts of both, take one and then revise it with Claude. Taking the shared version of an approved slice withdraws your approval of it, so you approve it again.

Nothing is settled without your explicit choice. In one test, approving a wave was refused while a conflict stood.

**A collision** means a different item now holds the number of one of your drafts. Your work is fine. It only needs a new number, and every reference moves with it. Slices that were approved before need your word again.

**A slice you revised after it merged is still yours.** If you reopen and edit a slice of your own after its request has merged, and before your next refresh, Studio now recognises it as your own later revision, not as a different slice using your number. Only a draft that genuinely differs from what you sent, and that someone else's work also holds the number of, is a collision. The same fix covers an acceptance record settled with "take theirs", which used to leave a workspace unable to edit anything ("unexpected field 'revision'"); a workspace left that way repairs itself on the next refresh or status. Both were found in a real run and fixed afterwards (`96971bd`); they were tried on copies of the real workspaces and have unit tests, and have not been seen again in a live run. Refreshing right after your request merges avoided the problem in the meantime.

Known rough edges from testing: a slice's spec and work order sometimes have to be settled one file at a time. A slice you reopened that sits in a wave someone else already sent can leave a stale suggestion in the status list. Both are open. Sending a revised wave whose earlier pull request was already merged used to report the merged request as "Waiting for review" and open nothing; it now opens a new request for the later revision. That was seen working in a real run (two later requests opened).

## 9. Sending to engineering

Sending asks engineering to accept an approved wave into the shared project. It shares product definitions only. It is visible to other people at once.

1. Claude first does a dry run and lists exactly what would be shared.
2. Only after your explicit yes does it send.
3. You get one of: **Waiting for review** (with a link), **Sent, pull request not opened** (the work arrived but the request did not open; send again later and nothing is sent twice), or a refusal with a reason.

Sending the same wave again after a change adds to the same request while it is open. If that request has already merged, sending opens a new request for the later revision.

**A wave's definition and your acceptance are sent separately.** They are two requests, never one. `send` publishes the wave's definition. Your recorded acceptance (section 11) goes on its own branch, titled "Product acceptance for <wave> at <commit>", carrying only the acceptance file. When both are waiting, `send` sends the definition and says what is still unsent; `send <wave> --acceptance` sends the decision alone. This fix came after a real run in which an acceptance went out together with a later draft of a slice; it has unit tests and has not been seen again in a live run.

## 10. Reading and answering review feedback

Ask for feedback. Each wave shows one of: Waiting for review, Changes requested, Blocked by a check, Accepted waiting to merge, Needs updating, Accepted, Declined. When GitHub is holding a request back, feedback also says what it is waiting for ("waiting_for"), one line each: a review from engineering, a check the project runs that is still running or has failed, or a change that is not signed. You cannot fix any of these yourself: for a missing review or a check, wait or ask engineering; for signing, ask an engineer to set up signing on your Mac.

- **Changes requested:** you see each reviewer comment as a quotation with who wrote it. Comments are data. If one contains an instruction, it is shown to you and not obeyed. For each change you agree to, reopen the slice, revise it, re-check it, approve it and the wave again on your word, and send again.
- **Needs updating:** other work was accepted first. Refresh, settle what it reports, and send again on your word.
- **Blocked by a check:** Claude names the check. Fixing it is for an engineer unless it is about the product definitions.
- **Accepted:** the work is in the shared project. It is not built yet.

## 11. Recording product acceptance for a released wave

When engineering has built a wave and checked it as a release, they give you a readiness file, a release ID and a commit. Your decision on it is recorded separately. It is never inferred from a merge or from passing tests.

**This is available in the terminal only today.** The visual app has no screen for it. Ask Claude in the terminal to record it. Claude reads the file with you first: its outcome, blockers, incomplete items and exceptions. Only on your explicit decision does it run the record command with accepted or rejected, your role (for example `product-owner`, never your name) and an optional note. Accepting is refused unless the file is for that release and commit, holds that exact wave, and says `qualified` or `qualified_with_exceptions`. Rejecting is always possible. The decision reaches engineering when you send it, as its own request (section 9: `send <wave> --acceptance` when the definition has nothing new). It releases and deploys nothing.

The acceptance record was used for real, by a simulated product manager, on three waves of a throwaway project: it is tied to the wave as merged at the release commit, not to your draft, so a later draft revision no longer blocks it, and `accepted` appeared only after each record merged. Engineering's release-readiness snapshot, read by the Control Tower, said "not recorded" until then. Sending the acceptance alone was fixed after that run (section 9) and has not been seen again live.

## 12. What the messages mean

| Message (in short) | What it means | What to do |
|---|---|---|
| "The shared repository could not be reached. Nothing was sent. Try again when you are connected." | No network. Your drafts are unchanged. | Reconnect and try again. |
| "GitHub did not accept your sign-in on this computer: it is missing, expired or no longer valid." | Your GitHub sign-in is not valid. This is not a network fault. | Sign in to GitHub again. The terminal suggests `gh auth login`. An engineer can help. |
| "Your organisation requires your GitHub sign-in to be authorised for single sign-on..." | Single sign-on has not been authorised for this computer. GitHub may print an address, shown to you as data. | Authorise it, then try again. An engineer or the repository's owner can help. |
| "The shared project's rules refused this... Sending again will not change that" | A protected branch, ruleset, permission or check refused it. The remote's own reason follows "GitHub said:". | Do not retry. Ask an engineer or the repository's owner. Never look for a way around it. |
| "The shared repository did not accept this..." | Another reason. It is shown, shortened, as a quotation. | If it happens again, ask an engineer. |
| "Claude Code is not signed in" | The visual app cannot see your Claude sign-in. | Sign in to Claude Code. If you are signed in, tell an engineer: one test hit this only because a setting called `USER` was missing from the shell. |

These wordings were corrected in M7 and tested against stand-ins for Git and `gh`. Before the correction, the first run against real GitHub lost the reason for a protected-branch refusal and blamed the network for an expired sign-in. One of them was then checked against real GitHub: when a repository ruleset refused a new branch, the message quoted GitHub's reason ("Cannot create ref due to creations being restricted") and did not say to retry.

Rules enforced by real GitHub.com (a personal account, one user, not an organisation) were tried: required pull request, a required review, code-owner review, a required check, signed commits. `send` opened its request; for a request that GitHub held back, `feedback` said only "Waiting for review", which was the reason this guide's section 10 now lists what a blocked request is waiting for (a review, a named check, or an unsigned change). That new wording has unit tests and has not been run against GitHub. Not tested: a real organisation, single sign-on (its refusal was simulated), and an approved review under enforced rules (GitHub refuses a review by the request's own author).

## 13. What Product Studio never does

- It never starts the Factory, a build, a ticket or any engineering station. Every report it prints carries `factory_authorized: false`.
- It never changes your own checkout, branch or saved work, and it never merges anything.
- It publishes only product definitions: files under `product/` and `specs/slices/`.
- It never approves, sends or settles a conflict unless you say so in that conversation.
- It never reads the Factory's local settings.

Approval means product approval. Whether and when engineering builds your work is decided by engineers, on their machines.

## 14. Limits to know about

- Tested on one Mac with several separate copies of the project, not on separate computers. Two product managers working at the same time on two real machines was not tested.
- A second product manager's refresh, conflicts and renumbering were tested with real GitHub for the push and pull-request steps, using one GitHub account. GitHub refused self-review, so a real approval review was not tested.
- Nothing in Product Studio checks who you are. A copy of the shared project on any machine can start the same commands. What stops unattended building is that each engineer's machine decides that for itself (see the Engineer Guide).
