# MACH Next — M4: the Autonomous Factory Supervisor

Status: **built**, on `feature/mach-next-m4-supervisor`, from M3 commit `6b93828`.

M4 turns M3's intake and scheduler into an opt-in, locally hosted Factory that keeps approved work moving on a machine whose engineer has enabled it. The engineer becomes the Factory's steward: they decide whether it runs, within what limits, and they are asked whenever a person is needed. On every other machine, including a product manager's clone of the same repository, nothing changes.

## 1. Integration assessment: what the Supervisor calls

The Supervisor adds no scheduling, eligibility or station logic. It calls exactly these:

| It needs to | It calls | Owner |
|-------------|----------|-------|
| bring the Factory level with the integration branch | `intake.Factory.reconcile()` (intake, then a recorded plan, under the ledger's lock) | M3 |
| know what is ready, blocked, active or done | the plan `reconcile()` returns: `dispatchable`, `runnable`, `needs_person`, `slices` | M3 |
| put a ready slice into the line | `intake.Factory.dispatch([slice], by="supervisor", authorize=...)` | M3 |
| hold the ledger while it writes | `intake.Factory.lock()`, `ledger()`, `save()`, `emit()` | M3 |
| know a ticket's next station, and whether the line has stopped for a person | `run.next_step(project, ticket, headless=True)` | run.py |
| know whether building is allowed | `run.Project.audit()` | run.py / audit |
| run the stations | the existing `mach:belt` Dynamic Workflow, with `{tickets: [id], until: "merge"}` | belt |

Changes to existing contracts, all additive:

- **Events are version 2.** Every event gains `runner_id`, `execution_id`, `source`, `cause` and `refs`, and twelve supervisor event types are added. Version 1 fields are unchanged.
- **The belt accepts `until`.** `{tickets, until: "merge"}` stops each ticket before that station. A list, or `{tickets}`, behaves as before.
- **Fetched work is visible.** When the local integration branch is simply behind the remote, product definitions are read from the remote branch as fetched. Dispatch still refuses until a person updates the checkout.
- **A dispatched slice records its `owner`** (`engineer` or `supervisor`).
- **A security reviewer's blocker can no longer be outvoted** (section 7).

## 2. Runtime architecture

Four modules in the run skill, behind `run.py factory ...`. No new command-line tool.

| Module | Holds |
|--------|-------|
| `policy.py` | the machine-local policy, its validation, the project's restrictions, the preflight, and the two-step activation |
| `executor.py` | the Claude command, the detached wrapper around one execution, and the reader of its result |
| `supervisor.py` | the ownership lease, one pass (tick), recovery, scheduling within limits, and the serve loop |
| `service.py` | advisory Git hooks and the per-user LaunchAgent |
| `activation.py` | status, enable, pause, resume, disable, stop |

One pass does this, in order:

1. Read the policy from disk. If the Factory is not enabled here, do nothing at all: no intake, no fetch.
2. Confirm this process owns the project (heartbeat on its lease).
3. Fetch, only if the policy allows it. Being offline is a note, not an error.
4. Settle executions left by an earlier pass or an earlier supervisor (section 5).
5. `reconcile()`.
6. In observe mode, or when paused, stop here.
7. For each slice the plan marks dispatchable: M3's `dispatch`, with an authorization that re-reads the policy, the lease and the audit at that moment.
8. For each runnable ticket this supervisor owns: claim durably, check authorization and the ticket's next step once more, then start one execution.

State: the supervisor's claims and executions are kept in M3's ledger under a `supervisor` key, written under M3's lock and reported through M3's event log. There is one record and one order of events. Where a ticket stands is never stored there; it is read from the cell.

## 3. The verified execution mechanism

Verified against Claude Code 2.1.322. The first version of this section (the M4 build) passed only `--permission-mode default` and `--allowedTools`. That was found not to be a boundary on a machine like the engineer's (3.2), and the mechanism was hardened (`executor.py`, `policy.py`). This section describes the hardened mechanism and the evidence for it.

### 3.1 The command

```
claude -p "Run the workflow named mach:belt with args {"tickets": ["<id>"], "until": "merge"}. Use the Workflow tool. ..."
       --output-format stream-json --verbose
       --restricted                      the person's settings files, plugins, agents and hooks are not loaded;
                                         file tools stay in the working folders
       --strict-mcp-config               no MCP server at all
       --plugin-dir <MACH>               the run's only plugin (3.3)
       --permission-mode default
       --permission-prompts none         anything that would ask is refused automatically
       --tools <built-in tools the list names>        e.g. Workflow,Skill,Agent,Read,Write,Edit,Glob,Grep,Bash
       [--add-dir <MACH>]                only when MACH is a plugin outside the project, so reviewers can read their briefs
       --disallowedTools Edit(//<MACH>/**) Edit(//<project>/.factory/local/**) Edit(//<project>/.claude/**)
       --max-budget-usd <limit>
       --session-id <a new UUID>
       --allowedTools <the list in the policy, exactly as the person consented to it; always last>
```

It runs in the project folder with a minimal environment (`executor.environment()`): `HOME`, `USER`, `LOGNAME`, `PATH`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TMPDIR`, `SHELL`, `TERM` and `CLAUDE_CONFIG_DIR` when set, proxy variables only when they carry no `user:password@`, plus `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` (the run waits for the workflow however long it takes) and `GIT_TERMINAL_PROMPT=0`. Any name containing `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, `AUTH` or `COOKIE` is dropped even if listed. The run signs in with the person's own Claude Code login (`apiKeySource: "none"`).

`--tools` is derived from the consented list, never added to it: `Bash(git log *)` names `Bash`, and a name that is not a built-in tool (an `mcp__…` entry) is left out. The `--disallowedTools` rules only narrow; they protect MACH's own code, the Factory's policy and execution records, and the project's `.claude/` from the file tools. Nothing passes `--dangerously-skip-permissions`, `bypassPermissions`, `--bare` or `--setting-sources`; tests hold that.

### 3.2 Why: the evidence (before and after)

Both runs were made in a scratch project with MACH script-installed, on this machine, whose `~/.claude/settings.json` has `defaultMode: auto` and allows `Bash(git push:*)`, `Bash(curl:*)`, `Bash(rm:*)` and `Bash(python3:*)`, among others, and which has 21 plugins, 23 MCP servers (including Gmail, Google Drive, Asana and Discord), hooks and 28 agents. Same request, same minimal environment, same allow list (the policy's default), model haiku: *run `git push --dry-run origin main`, `curl -s -m 3 http://127.0.0.1:9/`, `rm scratch-delete-me.txt`, `python3 -c "print(42)"`, and count your `mcp__` tools*.

| | Before: `--permission-mode default --allowedTools <list>` | After: 3.1 |
|---|---|---|
| `git push --dry-run` | **ran** (`Everything up-to-date`) | refused: `permission_denied`, listed in `result.permission_denials` |
| `curl` to a local address | **ran** (connection refused, so the request was made) | refused, as above |
| `rm scratch-delete-me.txt` | **ran; the file was deleted** | refused; the file is still there |
| `python3 -c …` | ran | ran: `Bash(python3 *)` is in the consented list (8.2) |
| `init.mcp_servers` | 23, including `claude.ai Gmail` and `plugin:discord:discord-stdio` | `[]` |
| `init.tools` | 249 | 9: `Task, Bash, Edit, Glob, Grep, Read, Skill, Workflow, Write` |
| `init.plugins` | 21 of the person's plugins | `mach` and Claude Code's four built-in `cc-plugin-*` |
| `init.agents` | 27, including the person's own | built-ins and `mach:builder`, `mach:verifier`, `mach:reviewer`, `mach:contract-engineer` |
| hooks | `hook_started` / `hook_response` events | none |

The refusal as streamed: `{"type":"system","subtype":"permission_denied","tool_name":"Bash","decision_reason_type":"asyncAgent","decision_reason":"no approval surface in this session; permission request denied automatically"}`, and `"permission_denials":[{"tool_name":"Bash","tool_input":{"command":"git push --dry-run origin main"}}, …]` in the result. `executor.outcome()` already reads both.

File tools under the final flags (MACH as a plugin from outside the project): reading a reviewer brief inside the plugin folder ran; writing into the plugin folder, into `.factory/local/` or editing `.claude/workflows/mach-belt.js` was refused (`File is in a directory that is denied by your permission settings`); reading `~/.zshrc` or `/etc/hosts` was refused (`--restricted: path outside the working directory`); writing a file in the project ran. All five refusals were in `result.permission_denials`.

Environment: the same probe with the supervisor's own environment inherited reported `apiKeySource: "ANTHROPIC_API_KEY"` (it signed in with a key it was not meant to have); with `environment()` it reported `"none"`.

### 3.3 Loading MACH in restricted mode

Restricted mode ignores the project's `.claude/` folder: neither `--add-dir <project>` nor `--setting-sources project` brings its skills, agents or workflows back (both tried). `--plugin-dir` does, and **a Dynamic Workflow loads from a plugin directory in restricted mode**: `init.skills` lists `mach:belt`, and the belt runs.

- **MACH installed as a plugin:** `--plugin-dir` is the plugin's own folder. If it lies outside the project, it is also passed with `--add-dir`, because restricted mode confines the file tools to the working folders and reviewers read their briefs and checklists from the plugin. The file tools may read it but not change it (`--disallowedTools`).
- **MACH installed by script** (`.claude/skills/mach-*`, `.claude/agents/mach-*.md`, `.claude/workflows/mach-belt.js`): `executor.plugin()` generates a plugin at **`.factory/local/claude-plugin/`**, inside the git-ignored local state, never a temporary folder. It holds copies of the installed files with the installer's renames undone (`mach-build` back to `build`; `/mach-run` back to `/mach:run` where a skill command is typed, never inside a path), so the run sees exactly the plugin MACH was installed from: a test asserts every file equals the source. Copies, not links: linked agent files were not loaded at all, and the station scripts decide their naming from their resolved path. Product Studio's skill is left out. The plugin is rewritten only when the installed files change (a digest is kept), beside the old one and then swapped in, at the same path. A symbolic link at that path, or at `.factory/` or `.factory/local/`, is refused.

In both cases the names are the plugin's: the workflow is `mach:belt`, the agents `mach:builder` and so on, and the station scripts inside print plugin names, so everything the belt asks for exists.

### 3.4 What the proof established

| Question | Finding |
|----------|---------|
| Can a non-interactive run launch the existing Dynamic Workflow? | Yes, in restricted mode, from `--plugin-dir`, for both install kinds. |
| Do workflow agents and sub-agents inherit the restrictions? | Yes. Their tool calls were refused with the same `permission_denied` event, carrying the worker's `agent_id`; they had the same 9 tools and no MCP server. |
| Which tools does the belt need? | `Workflow`, `Agent`, `Skill`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash` (via `--tools`, from the list). The workers use `StructuredOutput`, which the workflow provides itself. |
| How must allow rules be spelled? | As before: `Bash(python3 *)` and the exact interpreter path `Bash(/…/python3.x *)`, because the belt's clerks run `"<interpreter>" "<run.py>" --project "<project>" …`. Quoted script paths match these prefix rules. A compound command is checked part by part: `cd <project> && python3 …/cell.py open …` ran; anything containing a variable (`echo exit=$?`) or an unlisted program was refused. |
| Is a structured status available? | Yes: a final `result` event with `is_error`, `subtype`, `total_cost_usd` (it includes workflow agents: the plan run's `modelUsage` lists Opus and Haiku), `permission_denials`, and the workflow's JSON as `result`. |
| Is the session identifiable? | Yes. `--session-id` sets it in advance; it is recorded with the claim. |
| How do failure and interruption show? | A spent budget: exit 1, `is_error` true, `subtype` `error_max_budget_usd`. A killed process: no result at all. The wrapper records which. |

**Live runs under the final flags** (Claude Code 2.1.322, the person's default model for the run; the stations pick their own):

| Run | Install | Result | Time, cost |
|-----|---------|--------|-----------|
| belt for a finished ticket | script | `{"ticket":"POC-001","outcome":"stopped","waiting_for":"nothing"}` | 32 s, $0.40 |
| the same | plugin (`--plugin-dir` = the MACH repository, `--add-dir` it) | the same | $0.19 |
| belt to `until: build`, ticket at `spec-ready` | script | the plan station ran (`/mach:intent LOCAL-002 --headless`): read its references from the generated plugin, wrote the contract and `plan.md` with Write, ran `cell.py`, committed; stage `planned` | 136 s, $0.74 |
| belt to `until: verify`, the same ticket at `planned` | script | the build station ran test-first through `build.py` (14 tasks, one commit each, the project's own test suite run at every step); stage `built` | 179 s, $0.68 |

In those runs the workers were refused, and carried on without: a long chained command with `find`, `cat` and a second `cd`; the builder's `B="python3 …/build.py"; $B red …` (it then ran the script plainly); and the audit agent's `cd … && python3 …/audit.py run; echo exit=$?` (a variable cannot be checked). The second meant the audit did not run inside the belt (8.9).

A refused tool is never granted. If the ticket still made progress, the refusals are listed with the execution's result. If it made none, the ticket is parked and a `human.required` event names what was asked for. A refused shell command is recorded as its program and subcommand only, never its arguments, paths or variables.

**Earlier live result (the M4 build, before hardening).** With Supervised Autopilot enabled, one supervisor pass adopted a planned ticket and started one execution. In 432 seconds and $2.82 the belt built, verified and reviewed it, reached `approved`, and stopped before merge.

### 3.5 The preflight checks the same boundary

`policy.probe_claude` first reads `claude --help` and refuses activation if any flag the boundary depends on is missing (`--restricted`, `--strict-mcp-config`, `--plugin-dir`, `--permission-mode`, `--permission-prompts`, `--tools`, `--allowedTools`, `--disallowedTools`, `--add-dir`, `--max-budget-usd`, `--session-id`, `--output-format`). It then prepares the plugin and asks for one word with exactly the execution's flags, no tools and the same minimal environment, and refuses unless `init` shows permission mode `default`, no MCP server, no tool, and `mach:belt` loaded. It is not run, and fails, while `.factory/local/` is not ignored by Git, because the plugin would be written there.

**Limits of this mechanism.** The tool list is now enforced by Claude Code's permission system without the person's own settings; it is still not a sandbox (section 8).

## 4. Local configuration and lifecycle

### The policy

`.factory/local/runner.json`, schema version 2 (`schemas/runner-policy.schema.json`). Git-ignored, mode 0600.

It reads as **disabled** when it is missing, unreadable, a symlink, writable by other users, the wrong version, malformed, written on another machine, or written for another folder. A fresh clone has no file. Copying an enabled file to another clone does not enable that clone.

Fields: `enabled`, `paused`, `autonomy` (`observe` or `supervised`), `limits` (places, minutes per execution, runs and dollars per day, dollars per run, attempts, poll interval), `max_risk`, `allow_merge`, `allowed_tools`, `excluded_slices`, `auto_sync`, `persistent`, and who enabled it, when, where, with which runner ID.

**The local grant is an upper bound.** `factory` in the project's tracked `.factory/config.json` can turn the supervisor off, cap autonomy at observe, lower any limit, lower the risk ceiling and forbid merging. It cannot enable, raise a limit, add a tool or allow merging. Product files are never read for any of this.

### Commands

| Command | Effect |
|---------|--------|
| `factory status` | Reads only. Never enables, wakes or dispatches. |
| `factory enable ...` | Runs the preflight and prints what would be enabled and a code valid for ten minutes. Enables nothing. |
| `factory enable --confirm <code>` | Checks again, then enables. A code works once. |
| `factory pause` | Nothing new is dispatched or started. Running executions finish their run. |
| `factory resume [--retry <ticket>]` | Readiness is checked again first. Parked tickets stay parked unless named. |
| `factory disable [--stop]` | Revokes automatic execution here; removes hooks and the service. |
| `factory stop` | Emergency stop: ends running executions now and pauses. Outcomes are recorded as unknown. |
| `factory serve`, `factory tick` | The supervisor itself: until disabled, or one pass. |

The preflight requires: a MACH project; M3's intake loading; a resolvable integration branch; the checkout on it; `.factory/local/` ignored by Git; Python and git; Claude Code installed, offering the flags the execution boundary depends on, and answering a non-interactive request under exactly those flags (section 3.5); the belt installed; a current audit that is not Bronze; the security veto in force; free disk and no more places than processors; no other live supervisor; the project not forbidding it; and macOS for a persistent service.

**Work already here.** If slices were waiting or in the line before activation, supervised autopilot is not offered until the engineer says whether to include them. Included work in the line is handed to the supervisor; excluded work stays the engineer's, and only work that arrives later is automatic.

**Confirmation.** The script cannot tell a person from a model. The two steps, the expiry, and the run skill's rule (show `would_enable`, wait for an explicit yes, never confirm in the same turn) are what make activation a person's act. This is a stated limit, not a guarantee.

### Two ways to run

- **Session-bound.** `factory serve` started for a session, or `factory tick`. Nothing is installed.
- **Persistent.** `--persistent` at activation installs a per-user LaunchAgent (`~/Library/LaunchAgents/com.mach.factory.<hash>.plist`) that runs `factory serve`. It restarts after a crash and stays stopped after a clean exit, which is what disabling causes. It binds no port. `factory disable` removes it.

Neither the installer, a clone, nor `/mach:run` on a ticket installs or enables anything.

### Git hooks and polling

`--hooks` adds a marked block to `post-merge`, `post-checkout` and `post-rewrite`. The block runs `factory wake` in the background, discards its output and cannot fail the Git command. `wake` writes a note if the Factory is enabled and does nothing otherwise. A serving supervisor sees the note and makes a pass early.

Existing hook content is kept and only the marked block is removed again. `core.hooksPath` is never set; a project that sets it is left alone.

Correctness never depends on a hook: the supervisor reconciles when it starts and every `poll_seconds`.

## 5. Recovery and concurrency

**Ownership.** `.factory/local/supervisor.json` names the runner, the process, a per-process instance ID, the last heartbeat and when the lease expires. A second supervisor on the machine is refused while the first is alive and its lease is current. A lease whose process is gone, or which has expired, is taken over, and that is recorded. A supervisor that finds it no longer owns the lease stops, and its authorization answers no.

**This is one runner per project, on one machine.** Two engineers' machines are not coordinated by anything here.

**Claims.** An execution is written to the ledger as `claimed` before any process exists. Then authorization and the ticket's next step are checked again, then the process is started and the record becomes `started`.

**What a restarted supervisor can tell apart:**

| Situation | How it is recognised | What happens |
|-----------|----------------------|--------------|
| not yet dispatched | the plan says ready | dispatched normally |
| claimed, never started | `claimed`, no process ID, no start file | the claim is released; nothing ran, so nothing is uncertain |
| still running | the wrapper's process is alive and its command line carries the execution ID | adopted; not started again |
| ended while nobody watched | a result file exists | closed from the result and the cell's records |
| outcome unknown | started, no result, no process | see below |
| needs a person | the line's next step is a stop, or the ticket is parked | left for a person |

**Unknown outcomes are not rerun blindly.** The cell's stage is compared with the stage at the start:

- If the stations recorded progress, that progress stands and the line continues from it.
- If nothing moved and the station was merge or cleanup, the ticket is parked for a person. It is never retried automatically.
- Otherwise it counts as a failed attempt. Planning, building, verifying and reviewing each record their own progress and are safe to resume, so one more counted attempt is allowed, up to `max_attempts`. Then the ticket is parked.

**No exactly-once claim is made.** Intake and dispatch are idempotent, claims are durable, and an uncertain side effect goes to a person. A station that was interrupted may repeat work it had not recorded.

## 6. Events

`.factory/intake/events.jsonl`, schema version 2 (`schemas/factory-event.schema.json`). In addition to M3's:

`factory.activated`, `factory.disabled`, `factory.paused`, `factory.resumed`, `revision.discovered`, `scheduling.decided`, `work.claimed`, `execution.started`, `station.observed`, `recovery.started`, `execution.completed`, `execution.failed`, and `human.required`.

Each carries stable identifiers (project, wave, slice, ticket, runner, execution), the time, `source` (engineer, intake or supervisor), `cause` where known, and `refs`: the paths where the authoritative state is kept. Events describe changes; they are not the state.

No event contains a prompt, a command line, an environment variable or a credential. A refused shell command is recorded by its program name only. The full stream of an execution stays in `.factory/local/executions/<id>/`, on the machine.

## 7. Security decisions

- **Default deny for tools**, with an explicit list a person consented to, enforced in restricted mode: the person's own settings, allow rules, plugins, MCP servers, agents and hooks are not loaded into a run, only the built-in tools the list names exist, the file tools stay inside the project (and a plugin MACH is loaded from), and anything that would ask is refused (section 3). `would_enable` says so, and that it is not a sandbox.
- **No credential is handed to a run.** The run gets a minimal environment and signs in with the person's own Claude Code login. A key or token in the supervisor's environment, such as `ANTHROPIC_API_KEY`, never reaches it; a test holds that.
- **MACH protects itself from the file tools.** A run may not edit MACH's own files, the Factory's policy and execution records, or the project's `.claude/` with Edit or Write.
- **The preflight fails closed** when Claude Code lacks the flags the boundary depends on, or when a probe under the execution's own flags shows an MCP server, a tool, another permission mode, or no MACH workflow.
- **A security blocker is a veto.** A Medium-risk ticket needs two of three approvals, so the security reviewer could be outvoted. `review.py` now rejects the round when the security seat has a blocker, whatever the count, and records `security_veto`. A project can set `review.security_veto: false`; the preflight then refuses supervised autopilot.
- **No merge by default.** Every execution stops before the merge station unless the engineer chose `--allow-merge`, and the project's own merge settings still apply then.
- **No human gate is passed.** Approval of a high-risk change, a Silver repository's sign-off, open questions and the three-round escalation are all stops in `run.py`; the supervisor starts nothing for a ticket whose next step is a stop.
- **Budgets and time.** Dollars per run are enforced by Claude Code; minutes per execution by the wrapper; runs and dollars per day by the supervisor.
- **A risk ceiling.** Tickets above `max_risk` are parked for a person.

## 8. Limits and unresolved risks

1. **Unattended building runs the repository's own code.** Tests, build scripts and dependencies run as the engineer, on their machine, with their network access. The controls are consent, an audited repository, merged and approved definitions, and limits. It is not sandboxed. Restricted mode bounds which tools Claude may call; it does not contain what an allowed command does.
2. **`Bash(python3 *)` is broad, and makes the other file rules a second layer.** The stations are Python scripts, so the interpreter must be allowed, and that also allows `python3 -c` (it ran in the after-run of section 3.2). A run can therefore still read or write any file the engineer can, open network connections, or run `git push` from inside Python. In particular, the `--disallowedTools` rules that protect MACH and `.factory/local/` stop the file tools, not Python. Narrowing the interpreter rule to the stations' own scripts was not reliable enough to ship.
3. **The policy file is protected by its location and mode, not by a signature.** Any process running as the engineer, including a run's Python, could rewrite `.factory/local/runner.json`, for example to add a tool for the next execution. The policy is re-validated on every read, but its content is trusted.
4. **Managed (enterprise) settings and `--settings` still apply under restricted mode.** An organisation's managed settings can add allow rules or MCP servers; the preflight's probe would refuse an MCP server, but not a managed allow rule. Not tested.
5. **Claude Code's built-in plugins and skills still load** (`cc-plugin-agents-md`, `cc-plugin-telemetry`, `cc-plugin-privacy`, `cc-plugin-plugin-authoring`, and bundled skills such as `schedule` or `loop`). They get no tool beyond the run's own. Their behaviour was not examined further.
6. **Read access inside the project is not narrowed.** A `.env` or other secret in the project can be read and could reach the model. Reads outside the project (and outside a MACH plugin folder) are refused.
7. **Merging by pull request over SSH has no SSH agent.** `SSH_AUTH_SOCK` is not passed, so a `git push` to an SSH remote from inside the merge station fails (an HTTPS remote with a credential helper or `gh`'s own sign-in is unaffected). This only matters with `--allow-merge` and `merge.method: pr`, and was not tested live.
8. **Confirmation is procedural** (section 4).
9. **Workers' compound shell commands are refused when a part is not allowed or contains a variable.** The skills were written for interactive use; in the restricted runs the audit agent wrote `…/audit.py run; echo exit=$?`, was refused, and did not retry, so the belt's own audit refresh did not happen. The supervisor does not start a ticket without a current audit, so this matters only if the audit goes stale mid-run. The fix belongs in the skills ("one plain command per call"), not in the allow list.
10. **One runner per project is assumed, not enforced across machines.**
11. **A paused or disabled Factory does not interrupt running work** unless `--stop` or `factory stop` is used. The belt has no checkpoint signal; an execution runs to its next stop.
12. **The LaunchAgent has been tested against a stand-in for `launchctl` only.** It has never been registered with the real one.
13. **Local ticket numbers** can still collide between two engineers who have not fetched each other's branches.
14. **Verified on one machine and version.** macOS, Claude Code 2.1.322, the person's default model (the probe and the top-level run used it). Linux, older Claude Code (the preflight refuses one without the flags), the verify, review, merge and cleanup stations under the restricted flags, and a full supervisor pass (`factory tick`) against the real `claude` were not run; section 3.4 lists what was (the belt's stop path for both install kinds, and the plan and build stations for a script install).

**Closed by the hardening:** "The user's own Claude settings still apply" (formerly 8.3). Under restricted mode their allow rules, plugins, MCP servers, agents and hooks are not loaded (section 3.2). Likewise the run no longer inherits the supervisor's environment and any key or token in it.

## 9. How to run the live smoke test

Opt-in, in a scratch project with MACH installed and a merged, approved wave. It starts a real agent and spends real money.

```
RUN factory status                                   # disabled
RUN factory enable --autonomy supervised --include-backlog --max-parallel 1 --budget-per-run 15 --max-minutes 60
RUN factory enable --confirm <code>                  # after reading what it printed
RUN factory tick                                     # claims and starts one execution
# wait for .factory/local/executions/<id>/result.json
RUN factory tick                                     # reads where the ticket now stands
RUN factory disable
```

## 10. What M5 and M6 need from here

**M5 (Product Studio web app).** Nothing in M4 changes Product Studio. The web app must call `studio.py`'s operations, as the terminal skill does, so both write identical artifacts. It needs no knowledge of the Factory's policy, and must not be given any: a test holds that Product Studio's scripts never name it.

**M6 (Control Tower).**

- **Feed:** `run.py product events --since N`, version 2. One ordered stream covering intake, scheduling and execution.
- **State:** `run.py factory status` and `run.py product plan` are the read-only snapshots. A dashboard reads these and the paths in `refs`; it never writes.
- **Execution detail:** `.factory/local/executions/<id>/stream.jsonl` holds each run's event stream, including sub-agent activity, for an inspector. It can contain tool inputs and must stay local.
- **Gaps to close first:** events have no `cause` filled in yet beyond the field existing; station transitions are observed once per pass, not as they happen; and there is no local endpoint, so a live view would poll the files or add a loopback-only server with its own origin checks.
