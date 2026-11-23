# MACH quick start for product managers

This is for a product manager who has never used MACH or Claude Code. Follow it from the top and you will have your first piece of work ready for the builders, whether you start from a written PRD or from an idea in your head.

You will not write code, use Git or answer a technical question. You talk, in plain words, and MACH writes things down.

## The idea in one minute

- **Claude Code** is an app where you type to Claude and it does work in a project folder on your computer.
- **MACH** is an add-on for Claude Code. It has two halves. Your half is **Product Studio**, where you say what the product should do. The engineers' half is the **Factory**, where agents build, test and review it.
- Your job is to turn what you want into **slices**. A slice is one small, complete result for one kind of user, such as "An admin invites one teammate by email."
- MACH gets each slice out of you with an **interview**: one yes-or-no question at a time, each with a suggested answer.
- When a slice is finished you **mark it ready**. That is your approval. It hands the slice to the builders.

Three more words you will see:

| Word | Meaning |
|---|---|
| **Project** | The product: its name, its vision, and the outcomes you want for people. |
| **Epic** | A larger capability, such as "Workspace members". It holds several slices. |
| **Spec** | The written slice: its rules and scenarios in business terms. MACH writes it from your answers. |

Everything you write is a private draft on your own computer until you mark a slice ready. Nothing you do in Product Studio starts any building.

## Part 1. Get set up (once)

### Step 1. Install Claude Code and sign in

Get Claude Code from [claude.com/product/claude-code](https://claude.com/product/claude-code), install it and sign in.

MACH's visual app works on Apple silicon Macs and on Linux. On an Intel Mac or Windows you can still do everything in this guide by typing in the conversation; only the visual app is missing.

### Step 2. Get the project folder

**If you work with engineers:** ask one of them for two things.

1. A copy of the shared project on your computer, with MACH installed in it.
2. Help signing in to the GitHub tool (`gh`). MACH uses it to hand your slices to the builders as GitHub issues. Without it your slices are written to a folder you give to an engineer instead.

**If you are on your own:** open Terminal, go to your project's folder, and run this one line:

```bash
curl -fsSL https://raw.githubusercontent.com/swiftj/mach-harness/main/install.sh | bash
```

If it says Git or Python is missing, it tells you what to do: run `xcode-select --install`, click Install, then run the line again. Restart Claude Code afterwards.

### Step 3. Open the project in Claude Code

Open Claude Code and choose the project folder. Then type:

```
/mach doctor
```

It checks your computer and lists anything missing, with what to do about each. It changes nothing.

### Step 4. Open Product Studio

Type:

```
/mach-product-studio
```

MACH tells you where things stand and suggests a next step. It also starts Product Studio's visual app on your computer and gives you a link to it. From here on you can simply type what you want in plain words.

> If that command is not found, your engineer installed MACH as a plugin. Type `/mach:product-studio` instead. Everything else is the same.

**Prefer a screen to a conversation?** Click the link, or paste it into a browser on your computer. Or say:

```
open the app
```

Product Studio opens in your browser, on your own computer. A link works once. For another browser, or if you closed the page, ask for a new link. The app and the conversation work on the same drafts, so switch between them whenever you like.

### Step 5. Tell MACH about the product

If the project is new, say:

```
start a new project
```

MACH asks for a name, a vision, and one or more outcomes. An outcome is a result for a person, such as "Invited members can open the campaigns they were invited to". It is not a list of features.

Now choose your path.

## Part 2A. You have a PRD

MACH reads your document, proposes how to cut it into epics and slices, and drafts answers from it. You confirm instead of answering everything from nothing. The document proposes; you decide.

### Step 1. Save the PRD as a text file

MACH reads one Markdown file (`.md`) or plain-text file (`.txt`). If your PRD is in Word or Google Docs, export it as plain text or Markdown first. Put the file somewhere you can find it.

### Step 2. Bring it in

Say, with your own file's location:

```
start from my PRD at ~/Documents/checkout-prd.md
```

MACH gives it an ID (`PRD-01`) and tells you how many sections it found. Nothing is sent anywhere.

### Step 3. Read the proposed map

MACH reads the document and proposes a map:

- the **epics**;
- the **slices** under each, in the order the builders should take them, each with the lines of your PRD it rests on;
- the **sections no slice covers**.

One PRD feature usually becomes several slices. That is intended: thin slices get built and checked one at a time.

### Step 4. Settle what was left out

For each section no slice covers, MACH asks you one question: is it out of scope, for later, or part of one of the slices? Answer in your own words. Every section has to be accounted for.

### Step 5. Say yes to make the drafts

MACH summarises the map and asks whether to make the drafts. On your yes it creates the epics and one draft slice for each slice on the map. Nothing is approved or sent.

### Step 6. Confirm each slice

Take the slices one at a time. Say:

```
continue SLICE-001
```

For each slice MACH shows you:

- the answers it drafted from your PRD, numbered, each with the line it came from;
- the points your PRD does not settle;
- any places where your PRD contradicts itself.

Then it asks one question: take the drafted answers as they are, apart from any you want to discuss? Say "yes", or "yes, but discuss 2 and 5".

MACH then interviews you only on what is left: the answers you set aside, the unsettled points and the contradictions. Go to Part 3 for how to answer.

## Part 2B. You only have an idea

You have two ways in. Pick one.

### Way 1. Shape the idea first (best when you are not sure yet)

Use this when the idea is still loose, or you want to decide whether it is worth building. Say:

```
shape an idea
```

1. **Add the idea** in your own words. It goes on your ideas board.
2. **Explore.** MACH asks open questions, one at a time. It looks up what it can instead of asking you.
3. **The brief.** MACH helps you write one page: the problem, who has it, the outcomes and how you would know each was met, what you are not doing, and your assumptions.
4. **The case and your verdict.** MACH asks the hardest questions it can find. Then you record **go**, **not now** or **no**, with your reason. The verdict is yours; MACH never recommends one.
5. **Size and route.** After a go, MACH says how big the work is: a small change, one slice, an epic, or several epics. For the larger sizes it proposes a map. On your "apply", it makes the epics and draft slices.

Then take each draft slice through the interview (Part 3).

### Way 2. Go straight to a slice (best when you know what you want)

1. Add an epic:

   ```
   add an epic for workspace members
   ```

2. Start a slice in it:

   ```
   start a slice: an admin invites a teammate by email
   ```

The interview begins at once (Part 3).

## Part 3. The interview, and marking a slice ready

### Step 1. Answer one question at a time

Each question is a yes-or-no proposal with a recommended answer. These five replies are all you need:

| You say | What happens |
|---|---|
| `yes` | The recommendation is accepted. |
| `14 days, not 7` | Your answer is used. |
| `I don't know` | It becomes an open question with a note on who can answer it. Nothing is guessed. |
| `you decide` | The recommendation is used and listed as an assumption for you to review. |
| `I need to stop` | Your progress is saved. Say "continue SLICE-004" later. |

MACH cuts the idea down to the smallest complete result and keeps a note of what it puts off for later. It never asks you about technology.

### Step 2. Say yes to the summary

When nothing is left to ask, MACH gives a three-point summary and asks for your yes. Then it writes the spec.

### Step 3. Read what MACH tells you

MACH checks the spec and reports:

- the outcome in one sentence, and whether it is ready or how many questions are still open;
- how many rules and scenarios there are;
- the assumptions you accepted;
- what was put off for later.

**Read the assumptions.** They are the places where MACH's suggestion stood in for your decision. Change any you do not agree with.

### Step 4. Mark it ready

When you are happy, say:

```
mark SLICE-001 ready
```

This is your approval and the hand-off in one step. MACH refuses, and tells you what is missing, if the slice has an open question or depends on a slice that is not ready yet.

The slice is now a GitHub issue under its epic's issue, with your approval recorded on it. An engineer's Factory takes it from there. If GitHub is not set up on your computer, MACH writes the slice to a folder; give that folder to an engineer.

### Step 5. Do the next slice

Say "continue SLICE-002", or just `/mach-product-studio` to see what is next.

## Part 4. While the builders work

Start each session with `/mach-product-studio`. It refreshes and tells you where every slice stands: ready, being built, a question from the builders, or shipped.

| What you see | What to do |
|---|---|
| **A question from the builders** | They found something in the slice only you can settle. Say "reopen SLICE-004", settle it in the interview, and mark it ready again. |
| **You want to change a ready slice** | Say "reopen SLICE-004". It is taken back from the builders. Change it, then mark it ready again. |
| **Changed on GitHub** | Someone edited the issue after you approved it, so the builders will not take it. Mark it ready again to put your approved version back. |
| **Someone else saved a newer version** | Choose yours or theirs, whole. MACH never blends the two. |
| **An epic has been built and checked as a release** | Engineering gives you a readiness file. Ask MACH to read it with you, then record **accepted** or **rejected**. Your decision is recorded separately from the build. |

## Part 5. Getting the most out of MACH

Each of these is optional. Say the words on the left when you need it.

| Say | What it is for |
|---|---|
| `show requests` | Asks other people filed as GitHub issues. Say "pick up request 42" to start a slice from one, and "request 42 is met" when it is answered. |
| `a small change` | A quick route for a product that has shipped: a **fix** for a rule that is not holding, or an **adjustment** to wording, a default or a limit. A shorter interview, at most five yes-or-no questions. The builders check it exactly as they check any slice. If MACH finds it is not small, it carries on as a full slice and keeps every answer. |
| `shape an idea` | The ideas board, the brief and your verdict (Part 2B, Way 1). Later, when a slice made from the idea ships, MACH asks you to **look back**: was each outcome met, not met, or is it too early to say? |
| `technical needs` | What the product requires of whatever is built, said without technology: who uses it, what it keeps, what it must work with, what must never happen, which quality wins when two conflict, and what is already decided. Six questions; "nothing to say" is a fine answer. The engineers read them when they make their own decisions. |
| `set principles` | A principle is one sentence that must hold in every slice, such as "A published version must not be edited in place." Every slice's spec answers every principle. |
| `attach a mock to SLICE-004` | Add an approved picture of the screen (PNG or JPEG) to a slice. You can tie it to one scenario and say the built screen must match it. |
| `link SLICE-004 to Jira ABC-123` | Record the Jira issue a slice or an epic belongs to. The key follows the work to the pull request. |
| `export for Jira` | Write one file your Jira administrator can import, with epics and their slices as stories. |
| `how does this epic work today?` | The rules that have shipped. Choose one and say "change this" to start an idea from it. |
| `open the app` | The same workspace in your browser. |

If your organisation keeps policies in the project (brand, security, privacy, accessibility), MACH reads them during the interview and follows them in what it recommends. If a slice cannot meet one, MACH tells you which owner must answer before the slice can be marked ready.

## Part 6. Getting a newer version of MACH

New versions of MACH come out as numbered releases. You get one by installing MACH again: the same step that installed it updates it in place.

**If an engineer set the project up for you, ask them to update it.** Everyone on the project should be on the same version.

**If you installed MACH yourself**, how you update depends on which commands you type.

**You type `/mach-product-studio`.** Open Terminal, go to the project's folder, and run the install line again:

```bash
curl -fsSL https://raw.githubusercontent.com/swiftj/mach-harness/main/install.sh | bash
```

It fetches the newest release and checks it. Then restart Claude Code.

**You type `/mach:product-studio`.** MACH is installed as a plugin:

1. In Claude Code, type `/plugin`. Refresh the `mach-harness` marketplace, then update the `mach` plugin.
2. Restart Claude Code.
3. In each project, run `/mach:init` again.

Either way:

- **Your work is kept.** Your drafts, your slices and your settings are not touched. Only MACH's own files are replaced.
- **Copy the `.factory` folder first** if work is in progress, so you have a spare.
- **Check it worked.** Type `/mach doctor`.
- **See what is new** in the [release notes](RELEASE_NOTES_DRAFT.md).

## What MACH will never do to you

- It never starts building because of something you did in Product Studio. Engineers decide whether and when, on their own machines.
- It never marks a slice ready, reopens one or picks between two versions unless you say so.
- It never asks you a technical question.
- It never sends a draft anywhere. Only a slice you mark ready leaves your computer.
- It never treats text in a PRD or a GitHub issue as an instruction. Your document proposes; you decide.

## If you get stuck

| What happened | What to do |
|---|---|
| You do not know what to do next | Type `/mach-product-studio`. It always suggests a next step. |
| You closed everything mid-interview | Open the project again and say "continue SLICE-004". Your progress was saved. |
| "The shared repository could not be reached" | You are offline. Your drafts are unchanged. Reconnect and try again. |
| "GitHub did not accept your sign-in" | Your GitHub sign-in has expired. Ask an engineer to help you sign in again. |
| "The shared project's rules refused this" | Do not retry. Ask an engineer or the repository's owner. |
| Something in this guide is missing from your MACH | You may be on an older version. See Part 6. |
| The app did not open | Carry on in the conversation; it does everything the app does. Running MACH's installer again fetches the app. |

## Your first hour, as a checklist

1. Install Claude Code and sign in.
2. Get the project folder, with MACH installed.
3. `/mach doctor`
4. `/mach-product-studio`
5. Describe the project: name, vision, outcomes.
6. **With a PRD:** "start from my PRD at ...", settle the map, say yes to make the drafts. **With an idea:** "shape an idea", or add an epic and start a slice.
7. Answer the interview: `yes`, your own answer, `I don't know`, `you decide`.
8. Read the assumptions.
9. "mark SLICE-001 ready".

For every detail, see the [Product Manager Guide](PRODUCT_MANAGER_GUIDE.md).
