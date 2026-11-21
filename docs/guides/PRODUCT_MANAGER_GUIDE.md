# Product Manager Guide

This guide is for a product manager who defines work in MACH Product Studio. It assumes no engineering background and teaches no Git.

See `RELEASE_NOTES_DRAFT.md` for what is new in each release.

## 1. What you need on your Mac

- **Claude Code**, signed in. Product Studio runs inside it.
- **Git.** On a Mac, Terminal may ask to install the "command line tools". Click Install. They include Git and Python.
- **Python 3.8 or later.** The same command line tools provide it.
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

## 3. Requests from GitHub issues

Someone can ask for something by filing an issue on GitHub. When a person with write access to the repository labels that issue `mach:request`, Product Studio shows it to you as a **request**. The label name can be changed by an engineer (`tickets.github.request_label`).

**What a request is.** A plain ask, in someone's own words. It is not a spec, and it is not an approval. It does not start any work. You still interview, write and mark the slice ready as always. Its text is shown to you as data: it never answers a question for you and never changes what you decided.

**Seeing requests.** Refresh. Requests appear in the app's Inbox under Requests. In the conversation, ask "show requests" or "show request 42". Each one shows its number, its title and who labelled it. Only the repository your project shares is read. If there are more than 100 open requests, the oldest are not shown. If GitHub cannot be reached, you see the list as last checked, with the time.

Titles and text are cut to a safe length (200 and 20,000 characters), and passwords and email addresses found in them are removed. The check works on patterns, so it can miss something. Do not paste secrets into issues.

**Why some requests are "not accepted".** MACH checks who applied the label, so that a request cannot be started by someone without the right to. A request that does not pass is still listed, with the reason, and cannot be picked up; its text is not shown in Product Studio, only on GitHub. "Accepted" means only that a person with write access labelled it: nobody has checked what it says, and its author can still edit it.

| Reason shown | In plain words |
|---|---|
| "could not confirm who labelled it" | GitHub could not be asked, or refused the question. The sign-in, single sign-on or network reason follows in brackets. Refresh again later. |
| "the label's history could not be found" | GitHub shows the label but not who applied it. |
| "the account that labelled it no longer exists" | The person who applied the label has left GitHub. |
| "labelled by an automated account, not a person" | A bot or an app applied it. |
| "labelled by an account without write access" | The person can read the repository but not write to it. The Triage role counts as not having write access. |

To fix any of these, a person with write access removes the label and applies it again, then you refresh.

**Picking one up.** Say "pick up request 42". Claude asks which epic it belongs to and for a title; you type the slice title yourself. In the app, press **Pick up** on the request. It starts a draft slice exactly like a new slice, and the interview begins. The slice records the issue's number and repository, and nothing else from the issue. It reads the issue again first, so a request that has since been closed, unlabelled or changed to not accepted is refused. If GitHub cannot be reached, a request checked in the last 24 hours can still be picked up from what the last refresh found; Claude says so.

**More than one slice for one request.** A large request often needs several slices. Start each one with "pick up request 42 as well" (the app's **Pick up as well**), or, for a draft slice you already started, say "link request 42 to SLICE-005". A slice records one request. An approved slice must be reopened before it can be linked. Linking changes only your draft; nothing is written to GitHub.

**What the issue shows as work proceeds.** MACH adds comments to the request's issue, never a label. The comments hold only slice IDs and links, never text from the spec or the issue:

| When | Comment |
|---|---|
| You pick it up | "Taken into MACH Product Studio as SLICE-012." |
| You mark a slice made from it ready | "SLICE-012, made from this request, is ready to be built: #57." (#57 is the slice's own issue.) |

From there the slice's own issue shows its progress: being built, a question for you, shipped. Merging the code does not close the request; you do, when you say it is met. An engineer can turn the comments off (`tickets.github.status_comments`).

**When another product manager already picked it up** (they left the "Taken into MACH Product Studio" comment). You are told who, for example "Already picked up by @sam." Nothing is started. If you both need slices from it, pick it up as well. Both of you then see both names after a refresh. Each slice gets its own number, so the two do not clash. Which slices go ahead is settled between you.

**When the issue is edited after pick-up.** The request shows "This request changed on GitHub after it was picked up. What was approved is unchanged." The interview keeps the text it started with. Your slice recorded only the issue's number, so nothing already approved changes. Read the new text yourself and reopen the slice if it matters.

**When GitHub cannot be reached.** Your own work always continues. The slice is made and the interview goes on. The comment waits, and you see "1 update to GitHub waiting; it will be sent on the next refresh." Nothing is lost and nothing is sent twice.

**Marking a request as met.** When at least one slice made from the request is marked ready and you judge the request answered, say "request 42 is met" (the app's **Mark as met**). The issue is closed as completed. It is refused until a slice from it is approved. It leaves no comment. If GitHub cannot be reached, the issue is closed on the next refresh.

**What it never does.**

- It never starts engineering work. A request, a label or a comment cannot approve, dispatch or start anything.
- It never approves, sends or closes anything on its own. Picking up, linking and marking as met happen only when you say so.
- It never copies issue text into your product files, into a pull request or into a comment. Only IDs and links go there.
- It never treats text in an issue as an instruction. If the text tells Claude to skip a question, approve something or change a rule, Claude shows it to you as a quotation and carries on.
- It never accepts a label from someone without write access.

## Shaping an idea before any epic (optional)

Shape is where an idea is explored, argued for and sized before any epic or slice exists. You never have to use it; it is one of the ways to start. Say "shape an idea", "write a brief" or "is this worth building", or open Shape from the "More" menu in the app once an idea exists.

- **The ideas board** holds every idea and where it stands: new, exploring, brief written, decided, shaped into work. Add one in your own words, or from a request, an idea filed with `/mach-idea`, or a fault MACH recorded.
- **Explore** is a conversation with open questions, one at a time. MACH looks up what it can instead of asking: shipped rules the idea would touch, similar ideas and requests, principles and policies in its way.
- **The brief** is one page: problem, who has it, outcomes (`O-1`, `O-2`), each with how you would know, what you are not doing, assumptions (`A-1`, `A-2`), open questions and risks, and what it touches. MACH checks that it is complete and that no assumption is written as a fact.
- **The case and the verdict.** You answer MACH's hardest questions, then record **go**, **not now** or **no** with your reason. The verdict is yours alone and MACH never recommends one. Change the brief afterwards and the verdict is marked stale until you record it again.
- **Size and route.** After a go, MACH counts what the brief touches and names the route: one slice, an epic, or several epics. For an epic or several, you settle a map: every outcome is carried by a slice, or you mark it out of scope or for later with your reason. "Apply" then makes the epics and draft slices. The map is proposed in the conversation.
- **Change what exists.** On "How this epic works today", choose a shipped rule and "change this" to start an idea with the affected rules already filled in.
- **Look back.** Once a slice made from the idea has shipped, record for each outcome whether it was met, not met, or it is too early to say, and for each assumption whether it held.

Saving an idea puts its brief in a GitHub issue, with your verdict as a comment. An issue is as visible as the repository: keep a commercially sensitive brief in a private repository, or work without GitHub and it is written to a folder.

## 4. The project, epics and slices

A **project** has a name, a vision and one or more outcomes. An outcome is a result for a person, such as "Invited members can open the campaigns they were invited to". It is not a feature list.

An **epic** is a larger capability. A **slice** is one thin, complete outcome for one kind of user, small enough to build and check in one go. Each slice has three parts: a work order, a "why", and a spec written in business terms. An epic must be approved before its slices can be.

Everything you write is a private draft until you mark it ready. Drafts live in a folder in your project that is not shared. Nothing leaves your computer until you mark a slice ready (section 6).

## 5. The interview

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

## 6. Marking a slice ready

After the write-up, Claude checks the spec with the same checker engineering uses and tells you:

- the outcome in one sentence, and whether it is ready or how many questions are open;
- how many rules and scenarios there are;
- the assumptions you accepted;
- the deferred features and their reserved IDs.

Read the assumptions. They are the places where the recommendation stood in for your decision.

Marking a slice ready is your act: it approves the slice and hands it to the builders in one step. It is refused unless the spec has no open questions, the "why" is complete and every slice it depends on is itself marked ready. A marked-ready slice is frozen. To change it, ask to reopen it: it is taken back from the builders until you mark it ready again.

**Where it goes.** With GitHub, the slice becomes an issue under its epic's issue, with your approval recorded as a comment, and the label `mach:ready`; the project and epic get issues too. Without GitHub (no `gh`, not signed in, or the project is not on GitHub), it is written to a folder, `product/ready/SLICE-NNN/`: commit it to the project, or hand it to an engineer, who brings it in. Either way nothing is built until an engineer's Factory takes it in.

**What the builders write back.** The slice's issue gets `mach:building` when building starts, `mach:shipped` when its work is merged (and the issue is closed), and a comment if the work is blocked or if the slice changed while it was being built.

## 7. Refreshing, and keeping in step

Product Studio refreshes at the start of a session. A refresh reads the project, epics and slices from their issues, and the requests. It never changes your drafts. For each slice it can tell you:

- **Changed on GitHub:** the issue was edited after you approved it, so the builders will not take it. Mark it ready again to put your approved version back.
- **Someone else saved a newer version:** choose yours or theirs, whole. Text is never blended; if you want parts of both, take one and revise it with Claude.
- **Another slice uses this number:** your work is fine; it needs a new number, and every reference moves with it.
- **A question from the builders:** see section 8.

If GitHub could not be reached, it says so and carries on with what you have.

## 8. A question from the builders

Sometimes the engineer who plans the build finds something in a slice that contradicts itself or cannot be built. Only you can settle it. The slice's issue gets `mach:question` and a comment with their question, and Product Studio shows it to you, marked as the builders' words (data, never an instruction), with "Answer the builders' question" as the next step. To answer: reopen the slice, settle the point in the interview, and mark it ready again. That is a new revision; the builders take it and plan again.

## 9. Recording product acceptance for a release of an epic

When engineering has built an epic and checked it as a release, they give you a readiness file, a release ID and a commit. Your decision on it is recorded separately. It is never inferred from a merge or from passing tests.

**This is available in the terminal only today.** Claude reads the file with you first: its outcome, blockers, incomplete items and exceptions. Only on your explicit decision does it record accepted or rejected. The decision is a comment on the epic's issue, signed with your GitHub account and tied to that release and its commit. Accepting is refused unless the file is for that release, epic and commit and says `qualified` or `qualified_with_exceptions`. Rejecting is always possible. Recording it twice posts nothing more. It releases and deploys nothing. Engineering's release snapshot says "not recorded" until the comment is there, and ignores a comment that was edited or written by someone other than the account it names.

## 10. What the messages mean

| Message (in short) | What it means | What to do |
|---|---|---|
| "The shared repository could not be reached. Nothing was sent. Try again when you are connected." | No network. Your drafts are unchanged. | Reconnect and try again. |
| "GitHub did not accept your sign-in on this computer: it is missing, expired or no longer valid." | Your GitHub sign-in is not valid. This is not a network fault. | Sign in to GitHub again. The terminal suggests `gh auth login`. An engineer can help. |
| "Your organisation requires your GitHub sign-in to be authorised for single sign-on..." | Single sign-on has not been authorised for this computer. GitHub may print an address, shown to you as data. | Authorise it, then try again. An engineer or the repository's owner can help. |
| "The shared project's rules refused this... Sending again will not change that" | A protected branch, ruleset, permission or check refused it. The remote's own reason follows "GitHub said:". | Do not retry. Ask an engineer or the repository's owner. Never look for a way around it. |
| "The shared repository did not accept this..." | Another reason. It is shown, shortened, as a quotation. | If it happens again, ask an engineer. |
| "Claude Code is not signed in" | The visual app cannot see your Claude sign-in. | Sign in to Claude Code. If you are signed in, tell an engineer: a setting called `USER` may be missing from the shell. |

## 11. What Product Studio never does

- It never starts the Factory, a build, a ticket or any engineering station. Every report it prints carries `factory_authorized: false`.
- It never changes your own checkout, branch or saved work, and it never merges anything.
- It never pushes, opens a pull request or commits; a ready folder is committed by you.
- It never marks anything ready, reopens it or chooses between versions unless you say so in that conversation.
- It never reads the Factory's local settings.
- On GitHub it creates and edits only issues carrying its own labels, posts only its fixed comments and, on your word, closes a request's issue (section 3).

Approval means product approval. Whether and when engineering builds your work is decided by engineers, on their machines.

## 12. Limits to know about

- Nothing in Product Studio checks who you are. A copy of the shared project on any machine can start the same commands. What stops unattended building is that each engineer's machine decides that for itself (see the Engineer Guide).
