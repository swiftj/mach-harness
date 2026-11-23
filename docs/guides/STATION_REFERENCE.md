# Station Reference

What each station does, what its script refuses, and how to run one yourself. Most people never need to: `/mach <ticket>` calls each station in turn. Commands are shown for a one-project install (`/mach-build`); with the plugin they are `/mach:build` and so on. For the short guide, see the [README](../../README.md).

## Grooming a ticket

```
/mach-intent LOCAL-001
```

The ticket's work happens in its cell: `.factory/worktrees/<ticket>/repo`, a Git worktree on `feature/<ticket>`. It holds every file of the branch except `.claude/` and `.mcp.json`, which Claude Code's sandbox does not let an agent write. If Git cannot make it, the ticket is not opened and the message says what Git said; nothing is left behind and no work happens in the project root.

The interview and what it produces are described in the README. Two details:

### What is checked by script, not by a model

- The spec's structure, grammar, and traceability; that the decision matrix covers every combination with no two rules in conflict; that every outside dependency has a failure requirement and a scenario (`validate_slice.py`, 47 rule codes).
- That no open question remains before contracts are written (`cell.py finalize`).
- That slice IDs are unique across every ticket being groomed at once, the main checkout and Product Studio's draft workspace. A slice Product Studio handed over is one slice on both sides: the product manager's draft of it and the Factory's copy share its ID, even under different file names, and neither is called a duplicate of the other.
- That the plan puts tests first, assigns every requirement and scenario, and lists only contracts that exist (`cell.py check-plan`).
- That the plan changes no file under `.claude/` and no `.mcp.json` (`cell.py check-plan`). A cell never holds them, so a person makes that change outside the factory.

### Headless grooming

For tickets no person is available to answer, such as ones generated from crash telemetry:

```bash
claude -p "/mach-intent AUTO-20261109 --headless"
```

Each question is answered from facts in the project or a strict default and recorded as "Decided without a PM". Anything involving money, access, irreversible deletion, or two rules in conflict is never guessed: it becomes an open question, the ticket is labelled `blocked-requires-sme`, and no contracts or plan are written until a person finishes the interview.

## Building a groomed ticket

```
/mach-build LOCAL-001
```

The builder implements the ticket inside its cell, following `plan.md` one task at a time. It writes the tests and the code; a script runs the tests, decides whether each step counts, and makes every commit. The script refuses:

- starting on a repository the audit has not cleared, or on a ticket that is not fully groomed;
- a task out of order;
- a test that was never seen failing, or code committed while the suite fails;
- a change to a test that is already committed;
- a change to a file the plan did not give the task;
- finishing while any requirement or scenario in the spec is not named by a test.

Each refusal has an override that needs a written reason, and every use is recorded in `build-report.json` for the reviewers. After a failed verification or a rejected review, `/mach-build LOCAL-001 --revise findings.md` starts a revision. A ticket gets three judging rounds in all; on the third failure it is escalated to a person.

To run the builder on the model tier the factory assigns, start it as the `builder` agent (`mach:builder` with the plugin, `mach-builder` in a project install).

## Verifying a built ticket

```
/mach-verify LOCAL-001
```

Run this in a fresh session, or as the `verifier` agent, never in the conversation that built the ticket. The verifier runs the slice the way its user would and saves what it captures in the cell's `evidence/` folder: screenshots and recordings for a web app, a terminal session and exit codes for a command-line tool, request and response dumps for an API, a consumer-side transcript for a library.

It must prove every scenario in the spec with the scenario's own data, and every decision matrix rule with data of its own choosing. A script checks that each claim points at an evidence file captured in this run, refuses the builder's own test log as proof, catches evidence edited after it was recorded, and gives the verdict:

| Verdict | Meaning |
|---------|---------|
| `PASS` | Everything is proven with evidence. The ticket goes to review. |
| `FAIL_WITH_EVIDENCE` | A behavior does not match the spec. The findings go back to the build station, using one of the three review loops. |
| `INCOMPLETE_EVIDENCE` | Something is unproven, or a required kind of evidence is missing. |

To give the verifier an extra check the builder never sees, put a file describing it in `.factory/holdouts/<ticket>/`.

## Reviewing a verified ticket

```
/mach-review LOCAL-001
```

The session you run this in chairs the panel; it does not review. It starts one reviewer per seat, each a fresh sub-agent that has seen nothing of the build or of the other reviewers, and tells them only where to look:

| Risk tier | Panel | Needed to pass |
|-----------|-------|----------------|
| High | Architecture, security, product, on the `opus` tier | All three, then a person's approval |
| Factory tuning | The same three seats, on the `opus` tier | All three; no person, if only rule files change |
| Medium | The same three seats, on the `sonnet` tier | Two of three |
| Low | One general reviewer | That reviewer |

Reviewers do not vote. Each submits findings, and any finding marked `blocker` makes that seat a reject. A blocker must name the requirement or rule it breaks and the file that shows it, so a reviewer cannot block on taste. A script counts the result:

- `APPROVED`: the branch may be merged, by the merge station or by you, depending on your settings.
- `AWAITING_HUMAN`: the panel approved a high-risk change. You are shown the findings; say you approve and it is recorded with your name.
- `REJECTED`: the findings go back to the build station.
- `ESCALATE`: this was the third failed round. The ticket is labelled `blocked-requires-sme` and waits for a person.

When a reviewer's blocker is outvoted on a medium-risk change, the outcome says so.

A blocker from the security seat, and a security blocker of high or critical impact from any seat, is never outvoted: it rejects the round whatever the count. If you have read such a finding and accept it for this commit, you can say so before the builder starts again:

```
/mach except LOCAL-001 1/security/1 "<why, in your words>"
```

The reference is the round, the seat and the finding's place in that seat's findings, as `/mach explain` lists them. Name every blocker that vetoed and that you accept in one request. The round is then counted again: a seat whose only blockers you excepted counts as approving (its vote is kept as cast), and a seat with any other blocker still rejects. The script refuses, saying which seat and finding still block, unless that count meets the tier's threshold with no vetoing blocker left; it also refuses once a revision has started, when the branch is no longer the commit reviewed, and for a `factory-tuning` ticket, and it never accepts an ordinary blocker. This works at every tier: on a high-risk change where the security seat's only blocker is excepted, the round moves to waiting for your approval. Add `--expires 2026-12-31` in your request to limit it in time. The round is then approved, or waits for a person's approval where one is needed anyway. The exception is not that approval. It is never recorded unattended, and `review.security_exception_by` can name the only people who may grant one.

**Secrets and new dependencies.** The build station refuses to commit lines that look like a credential (a private key, a cloud or service token, an API key, a password in a URL, or a long random string assigned to a name like `secret` or `token`) and says where. A real credential is read at run time from the environment or a secret store. If what it found is not a secret, the builder records why with `--not-a-secret`, and the reviewers see the place and the reason. At review, the packet lists every secret candidate and every dependency the change adds or changes. If there is a candidate or a new runtime dependency, the security reviewer runs on the strongest model and a low-risk change gets three reviewers instead of one. The security reviewer answers each item: a secret is real (and the round is rejected) or not, and a dependency is acceptable or a concern (needed? a typosquat? pinned? unmaintained?). Dependencies are not checked against a vulnerability database. The decision, the findings, `/mach explain` and the pull request show what was flagged and the answers. `security.scan.enabled: false` in `.factory/config.json` turns this off; the review then says so, and the unattended Factory refuses to run.

A ticket that is sent back and revised gets a narrower second review: reviewers see what changed since the last round and check that the earlier blockers are fixed. A blocker on code that did not change and was not blocked before is refused; it can only be a note. Reviewers also report a recurring defect once, as a class listing every place, so one revision can clear it.

## Merging an approved ticket

```
/mach-merge LOCAL-001
```

Review approves one exact commit, and the merge station lands that commit or refuses:

- **Approval is bound to the commit.** If anything was added to the branch after review, the approval is void and the ticket goes back to verification. An approval that rests on a person's security exception is bound the same way, and an exception past its expiry stops the merge until a person records a new one or abandons the ticket.
- **It is re-tested against today's main.** If main has moved since approval, the branch is brought up to date inside the cell and the test suite runs again before anything lands, so two tickets that each passed alone cannot break main together. A failing suite sends the ticket back to the build station; a conflict stops for a person.
- **It looks at the shared main.** When the repository has a remote named `origin`, MACH fetches `origin/main` first. If origin cannot be reached, MACH merges nothing and says so.
- **Locally or through a pull request.** With `merge.method` set to `local` (the default) it makes a merge commit on your main checkout. If `origin/main` has commits your main does not have, MACH merges nothing and asks you to pull main first. MACH never pushes a local merge; it tells you to push main yourself. With `pr` it does every check against `origin/main`, pushes the branch, opens a pull request summarising the verification and review, and merges it at the approved commit, so your CI, review bots and team see a normal pull request.
- **With `pr`, it checks main once more just before merging.** If `origin/main` moved after the re-test, MACH says "main moved again; re-validating", re-tests on the new main, and then merges. It tries this twice at most, then stops and leaves the pull request open.

Who merges is a setting, by risk tier:

```json
"merge": { "mode": "auto", "method": "local", "auto": { "low": true, "medium": true, "high": true } }
```

`mode: "auto"` lets the line merge approved tickets; `"manual"` leaves every merge to you. Under `auto`, set a tier to `false` to keep that tier for a person. A high-risk ticket only reaches "approved" after a person has signed off in review, so with the defaults a person still decides every high-risk change. You can always merge one yourself: `/mach-merge LOCAL-001 --by-person`.

## After the merge

```
/mach-cleanup LOCAL-001
```

Once the approved branch is merged, by the merge station or by you, cleanup archives the cell's artifacts to `.factory/archive/LOCAL-001.tar.gz`, removes the cell's worktree, folder and local branch, and appends a one-line record of how the ticket went to `.factory/archive/runs.jsonl`. It shows you a plan first, archives before it deletes, and deletes nothing if the archive fails.

- If you squash-merge or rebase, tell it the commit: `/mach-cleanup LOCAL-001 --merged-as <commit>`.
- To drop a ticket that will not be finished: `/mach-cleanup LOCAL-001 --abandon "<why>"`. Uncommitted work and a git bundle of the branch are saved in the archive first.
- `/mach-cleanup orphans` lists cells that look finished or broken.

It never merges, pushes, or deletes anything on a remote.

## Learning from finished tickets

```
/mach-observe
```

Observe closes the loop: the factory tunes its own rules from what its finished tickets show.

1. **Measure.** It reads the run record of every finished ticket and reports a scorecard: average judging rounds per ticket, first-pass rate, escalation rate, and the share of tests seen failing before their code was written.
2. **Find what recurs.** The same review rule broken in several tickets, the same builder deviation, the same kind of verification failure, or a theme that keeps appearing in reviewers' non-blocking notes.
3. **Propose.** For each, the smallest rule that would have prevented it, aimed at `REVIEW.md`, `CLAUDE.md`, `AGENTS.md` or a skill's instructions, citing the tickets that prove it.
4. **File.** With `--auto`, or on your yes, it files one ticket labelled `factory-tuning` carrying every proposal.
5. **Apply through the line.** That ticket is groomed, built, verified and reviewed like any other, so each rule change is a reviewed diff you can revert.

It runs on its own: after every fifth finished ticket (`observe.every` in `.factory/config.json`), cleanup reports that a pass is due, and the line or the workflow starts one and then runs the tuning ticket.

A tuning ticket needs no person. It is decided by a unanimous three-reviewer panel on the strongest model tier, provided it changes only the factory's rule files. Reviewers are told to block any change that removes a rule, weakens a gate, lowers a threshold or raises a limit, and observe will not propose one; those remain your decisions. It proposes nothing until five tickets have finished.

## Is the repository ready?

```
/mach-audit
```

Agents working in a repository with a broken build, failing tests or no linter compound the damage, so MACH measures the repository first. The audit runs your build, tests and linter, scores five areas out of 100, and writes `.factory/audit-report.json`:

| Tier | Score | What it means |
|------|-------|---------------|
| Gold | 90 to 100 | Full autonomy. |
| Silver | 70 to 89 | Agents may build, but a person reviews every change before it merges. |
| Bronze | under 70 | Autonomous work is blocked until the repository is hardened. |

A build or test suite that fails, is missing, or could not be run makes the tier Bronze whatever the score. The scorecard lists each failed check with the points fixing it would add. Commands are detected from your Makefile and package manifests; set `audit.commands.build`, `test` or `lint` in `.factory/config.json` if yours are different. The audit executes your project's own commands, so run it only on code you would build yourself.

## Tickets and telemetry

```
/mach-ticket list
/mach-ticket view LOCAL-001
/mach-ticket update LOCAL-001 --state blocked --label blocked-requires-sme
/mach-ticket ingest-telemetry sentry crash.json
```

Tickets live in `.factory/tickets/` as Markdown files by default. That folder is a local working queue and is git-ignored, because stations update tickets as they work; to share tickets with a team, use a tracker. Set `tickets.provider` in `.factory/config.json` to `github`, `gitea-cli`, `jira` or `fossil` to use a tracker through its command-line tool; if your tool takes different arguments, replace any command under `tickets.commands`. MACH has five ticket states (`open`, `in_progress`, `needs_review`, `blocked`, `closed`); on trackers with only open and closed, the others are kept as `mach:<state>` labels.

`ingest-telemetry` turns a Sentry, PostHog or Datadog payload, a failed CI log, or an application error log into an `AUTO-<timestamp>` ticket with the error, the culprit file and line, and a trimmed trace. Email addresses, tokens and other credentials are redacted from everything it writes except the raw payload, which stays in the git-ignored `.factory/inbox/`. The same fault is not ticketed twice while its ticket is open. Groom the result with `/mach-intent AUTO-... --headless`.
