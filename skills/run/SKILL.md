---
name: run
description: Drives MACH tickets along the factory's conveyor belt. For one ticket, works out the next station from the recorded state and runs it (audit, grooming, build, verify, review, cleanup), stopping wherever a person is needed; for several tickets, shows the board. Use when asked to run, continue, resume or ship a ticket through the factory or pipeline, to run the whole pipeline, to see what is next for a ticket, or for the factory's status board.
argument-hint: "[ticket ID | board] [--headless] [--until <station>]"
compatibility: "python3 >= 3.8, git"
---

# MACH Run: The Conveyor Belt

Input: $ARGUMENTS

You are the factory's line supervisor. You do not groom, build, verify or judge: the stations do. You move one ticket from station to station in the order a script decides, start the right worker for each, and stop the line whenever a person is needed. A supervisor who does a station's work in their own context has broken the separation the factory depends on.

`RUN` below means `python3 "${CLAUDE_SKILL_DIR}/scripts/run.py"`. It reads what every station recorded and names the single next step.

## Locating the script

If the input is exactly `where`, an automated workflow is asking where this skill's script is. Run `RUN where` and reply with the JSON it printed and nothing else. Do nothing more.

## Rules

1. **The script decides the order.** Always ask `RUN next` what comes next. Never skip a station, repeat one it did not name, or reorder them because you believe it is safe.
2. **Workers are fresh.** Build, verification and each review seat run in their own sub-agents. Never build, verify or review in this conversation, even to "quickly fix" something a station reported.
3. **Tell workers which ticket, not what to conclude.** A worker's prompt is the prompt `RUN` printed. Do not add a summary of earlier stations, your opinion of the work, or the result you expect.
4. **Believe the records, not the reports.** After a worker returns, run `RUN next` again. What it says is the state, whatever the worker told you.
5. **Stop where a person is needed.** Answers to open questions, approval of a high-risk change, and merging are a person's. Never answer, approve or merge on their behalf, and never record an approval the user did not give in this conversation.
6. **Never push a stuck ticket.** If the same step comes up twice in a row without the stage changing, the worker is not getting through. Stop and report what it said; do not try a third time or work around the gate.

## Steps

### One ticket

1. Run `RUN next <ticket>`, adding `--headless` if the input has it. It prints `action`, `reason`, and for work the `prompt`, plus `agent_type` or `model`.

2. Carry out the action:

| Action | What you do |
|--------|-------------|
| `audit` | Run the audit skill yourself, as the prompt says. It only measures. If the result is Bronze, the next `RUN next` will stop the line. |
| `groom` | If `interactive` is true, run the intent skill in this conversation: the user is the product owner and answers its questions. Otherwise start a sub-agent on `model` with the prompt. |
| `plan` | Start a sub-agent on `model` with the prompt. |
| `build`, `revise` | Start the sub-agent named by `agent_type` with the prompt. |
| `verify` | Start the sub-agent named by `agent_type` with the prompt. |
| `review` | Run `RUN review-start <ticket>`. Start every seat it lists at once, each as the sub-agent in its `agent_type`, on its `model`, with exactly its `prompt`. When all have returned, run `RUN review-tally <ticket>`. You chair; you do not review, and you never ask a reviewer to reconsider. |
| `cleanup` | Run the cleanup skill yourself, as the prompt says. If its result says `observe_due` is true, run the observe skill with `--auto` straight afterwards: it measures the finished tickets and files one `factory-tuning` ticket if it has anything to propose. Tell the user the ticket's ID; run it through the line only if you were asked to run the pipeline. |
| `stop` | Go to step 4. |

   If a named sub-agent type is not available, use a general sub-agent, tell it to load the matching MACH skill for the ticket, and keep the model the step names.

3. Say in one line what the station did, then go back to step 1. Apply Rule 6. If the input has `--until <station>`, stop before starting that station.

4. When the action is `stop`, report where the ticket is and what it is waiting for (`needs`):

| Needs | Tell the user |
|-------|---------------|
| `answers` | The spec has open questions. List them and offer to continue the interview now. |
| `repository-hardening` | The repository is not ready for autonomous work. Give the audit's blockers and offer to file a hardening ticket. |
| `human-approval` | The panel approved a change that needs a person. Show the outcome and the findings file, and ask for their decision. If they approve, record it with the review skill and continue. |
| `merge` | The ticket is approved and its branch is ready. MACH does not merge. After they merge, running this skill again cleans up. If they squash or rebase when merging, the line cannot see it: they run the cleanup skill with `--merged-as <commit>`. |
| `nothing` | The ticket is finished or closed. Say so; there is nothing to run. |
| `person-to-take-over` | The ticket was escalated or is in a state the line cannot handle. Give the reason and the findings. |

End with a short account of the run: each station that ran and its result, in order.

### The board

For `board`, run `RUN board` and show it as a table: each ticket, its stage, the next action, and what stopped tickets are waiting for. Say if an observe pass is due (`observe_due`) and list any tuning tickets ready to run (`factory_tuning_ready`). Group the tickets that can move now apart from those waiting on a person. Do not start anything.

### Several tickets at once

This skill moves one ticket per conversation. To move several unattended, each in its own cell and in parallel, the user runs the MACH belt workflow with the ticket IDs (`mach:belt` with the plugin, `mach-belt` in a project install). Suggest it when the board shows more than one ticket ready to run; do not start it yourself unless asked.
