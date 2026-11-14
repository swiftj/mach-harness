# Operator Security Guide

For the person who decides whether MACH may run on a machine and under what limits. It states what MACH does and does not protect against, from the code and the M7 review documents (`docs/mach-next/M7_THREAT_MODEL.md`, `M7_REVIEW_GATE_AUDIT.md`, `M7_DISTRIBUTION.md`, `M7_SECURITY_SCANS.md`, `M6_6_ACCEPTANCE.md`). MACH is experimental. This guide makes no claim that it is ready for regulated or enterprise production use, and none of it is a confidentiality or compliance claim.

## 1. Local service boundaries

| Program | Listens | Who can use it | What it can do |
|---|---|---|---|
| `mach-studio` (Product Studio app host) | `127.0.0.1`, a port it picks | A browser holding its session | Runs a fixed list of Product Studio operations. Starts no station, dispatches nothing, enables nothing. |
| `mach-observer` (Control Tower) | `127.0.0.1` only | A browser holding its session | Reads Factory files. GET only. Starts no process, takes no lock. |
| The supervisor (`factory serve`) | Nothing | The person who enabled it | Starts `claude -p` executions, if enabled. |

Both programs bind loopback only. No flag or environment value changes it. Each prints a one-time link. The link is exchanged once for a session cookie (`HttpOnly`, `SameSite=Strict`). The host checks the exact Host header, the Origin, a CSRF header and a JSON content type. The pages load nothing from another origin (CSP `default-src 'none'`, `connect-src 'self'`). There is no analytics or telemetry. A cookie without `Secure` is accepted because the service is plain HTTP on loopback.

Residual: another process run by the same user can read the printed link in the terminal or in `.factory/local/observer/link`. Do not paste links anywhere.

A socket snapshot after install found only two loopback listeners and no outbound connection. It was a snapshot, not a packet capture.

## 2. Factory permissions

Enabling is local, explicit and confirmed with a code (see the Engineer Guide). An unattended execution is one `claude -p` run in restricted mode: `--restricted`, `--strict-mcp-config`, MACH loaded as the only plugin, `--permission-mode default`, `--permission-prompts none` (anything that would ask is refused and raised to a person), a spending cap and a known session ID. The preflight refuses a Claude Code that lacks any of these flags.

**The tool list, exactly** (`BASE_TOOLS` in `skills/run/scripts/policy.py`, plus the interpreter entry):

`Workflow`, `Skill`, `Agent`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash(python3 *)`, `Bash(git status *)`, `Bash(git log *)`, `Bash(git diff *)`, `Bash(git show *)`, and `Bash(<path of the Python that runs the stations> *)`.

Anything a person adds with `--allow-tool` is also on it. A list that allows every shell command (`Bash`, `Bash(*)`, `*`, or anything containing "dangerously") is refused. The file tools may not edit the MACH plugin, `.factory/local/` or `.claude/`. That is a second layer only.

**Limits** (defaults; the project's tracked settings can lower them, never raise): 2 cells at once, 120 minutes per execution, 20 executions a day, USD 25 per execution, USD 100 a day, 2 attempts that end without moving a ticket. By default every execution stops before the merge station.

**What a successful prompt injection could do inside that boundary.** From the threat model, entry T2 (severity Major, accepted design). A station's agent reads untrusted text: the approved spec's prose, the ticket, the code in the cell, test output and, in review, the diff. Through the tools themselves, a successful injection could not run `git push`, `git commit`, `gh` or `curl` as a direct command, edit `.factory/local/`, `.claude/` or the plugin with the file tools, or load a new skill or server. But `Bash(python3 *)` allows `python3 -c "..."`, which is arbitrary code running as you, with your `HOME` and the network. From inside it, an injected run could push with your Git credential helper or SSH key files, call the network, read `~/.config/gh`, plant a Git hook, write outside the cell, change the plugin files, or write a valid `runner.json` for this machine and folder with wider tools. The supervisor reads that file again on its next pass. **The allow list, restricted mode and the credential-free environment do not bound this.** There is no operating-system sandbox. This was assessed from the code. No model was run under injection, so real model behaviour is not assessed.

What still catches the result inside the line, not its side effects: a task may change only the files its plan lists, committed tests are frozen, verification reruns the suite and accepts only evidence it hashed in this run, review runs in fresh context with the security rule, High risk needs a person, an approval is bound to a commit, and an unattended run stops before merge. None of these sees a push to another branch, an exfiltration, or a change outside the repository.

Before enabling supervised mode, consider a machine or account with no credentials you cannot afford to lose. The planned remedy (an operating-system sandbox with no network and only the cell writable) is deferred.

## 3. Credential handling

- An execution's environment is a fixed list: `HOME`, `USER`, `LOGNAME`, `PATH`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TMPDIR`, `SHELL`, `TERM`, `CLAUDE_CONFIG_DIR`, plus proxy variables that carry no user:password. Any name matching key, token, secret and similar is dropped. `GIT_TERMINAL_PROMPT=0` makes a Git command that wants a password fail.
- Files under `HOME` (`~/.ssh`, `~/.config/gh/hosts.yml`, the keychain through a Git credential helper) remain readable by any Python the run starts (section 2).
- Product Studio's interview turn is narrower: tools `Read`, `Glob`, `Grep`, `Edit`, `Write` and `Bash` limited to listed Studio operations. Editing is limited to that slice's draft spec and why. Approve, send and reconcile are denied. The host passes a filtered environment to it.
- The M7 tests used the real `gh` login only through an environment variable and masked it in logs. Do not put tokens in project files or tracked settings.
- Machine-local authorization (`runner.json`) is mode `0600`, owner-checked, and refused if tracked by Git, symlinked, group or world writable, or written for another machine or folder.

## 4. Outbound dependencies

MACH's own programs and scripts contact only:

- **GitHub:** `git` and `gh` for refresh, send, feedback and the optional `pr` merge method; the release page for the Studio and Control Tower programs and `SHA256SUMS` (HTTPS only, 200 MB cap); `codeload.github.com` for the Python source in `install.sh`; `gh attestation verify` when present.
- **The Claude service:** through Claude Code, for interviews and executions. The repository content an agent reads goes to it.

Nothing else: no CDN, no analytics, no remote fonts. Claude Code's own network use, your tracker commands (Jira, Gitea, Fossil) if you configure them, and any scanners you run (rule or advisory downloads) are outside MACH's control.

## 5. GitHub governance

MACH relies on the repository's rules and does not replace them. It expects you to set: a protected default branch, required pull-request review (CODEOWNERS where you use them), required status checks, signed commits if you want them, and single sign-on where your organisation uses it. MACH never force-pushes, rewrites history, uses an admin merge or deletes a remote branch. Product Studio pushes only to `product/...`.

**These rules were not tested for real.** The test repository's plan refused branch protection, signed-commit requirements and rulesets. Their refusals were simulated with a local hook, a stand-in `gh` and a mocked single-sign-on message. A real approval review was not tested because one account cannot approve its own pull request. If the repository's rules refuse a push, the product manager is told the rules refused it and to ask an engineer.

## 6. Threat model on one page

Trust boundaries: the person at the terminal (the only authority); Product Studio's engine; the Studio host; product files in Git (untrusted data until checked); GitHub text (data); intake; the supervisor and its local authorization; each station's script versus the model (the model is untrusted relative to the script); the cell; the observer; the installer and release.

| Threat | Held by | Residual |
|---|---|---|
| Spec edited after approval | SHA-256 bound at approval, rechecked at intake and dispatch | An approved spec's prose still reaches agents as text. |
| Injection through repository content or review text | Scripts own the gates; reviewers have fresh context; text passed to `gh` and `git` as argv only | Section 2. |
| Escalating tools or editing `runner.json` | Refusals in policy and executor; `runner.json` rules above | Python in the allow list. |
| Browser attacks on local services | Loopback, one-time link, Host, Origin, CSRF | Same-user processes can read the link. |
| Path and symlink tricks | ID patterns, tracked-file checks, symlink refusals | None found. |
| Tampered release | Checksum; attestation when `gh` is present; actions pinned by commit | Source for `install.sh` is unchecked; without `gh`, only the checksum. |
| Generated code with vulnerable dependencies or secrets | Security review seat, audit, release scan check | MACH runs no scanner on generated code at build, verify or review. |

Open items from the review: none of the three below remain. (corrected: a deeply nested or oversized (over 1 MiB) JSON value in a merged product file is now refused instead of crashing intake; a ticket title containing `{body}` is no longer substituted into other fields; and an authorization file that Git tracks, a link, or a file owned by someone else or writable by others reads as disabled. All three were fixed in `d68f83f` with unit tests and not re-observed live.) Still open from the same review: an unattended run can run Python (see section 7), and names in free text are shown.

## 7. Security gates

- **Review security rule:** a security blocker of high or critical impact from any seat rejects the round at every tier. `security_veto: false` does not disable it. No exception record exists.
- **Supervisor preflight:** refuses unattended work while tracked settings remove the security seat or the High-risk person, checked every pass.
- **Release check:** `release qualify` needs scanner reports for the exact commit. Missing means `not_run`, which makes the outcome `incomplete`. Open review blockers are listed.
- **Audit:** Bronze blocks autonomous work.
- **M7 scans** (one run, a snapshot of the code): gitleaks, Semgrep, OSV-Scanner, Trivy and Syft found no confirmed High or Critical finding and no real secret. Every secret hit was a fake value in a redaction test. One Moderate advisory (`minimatch`, lint tooling, not shipped) needs a person's decision. Workflow files and agent prompts were not covered by any tool.

## 8. Evidence retention

- **After a merge, cleanup** writes `.factory/archive/<ticket_id>.tar.gz`: everything in the cell folder except the `repo/` checkout (intent, spec, plan, build and verify records, evidence, review rounds). It checks the archive before deleting anything and never overwrites an earlier one. `--abandon` also saves uncommitted work and a Git bundle of the unmerged branch.
- `.factory/archive/runs.jsonl` holds one record per finished ticket.
- `.factory/release/<id>/` holds readiness snapshots, `run.json`, logs and `exceptions.jsonl`.
- `.factory/local/` holds authorization, the supervisor's lease and each execution's output. `.factory/local/observer/` holds the observer's redacted index. All are git-ignored.
- No automatic expiry or deletion of these is described in the code reviewed. Choose a retention period yourself.

## 9. Logs and privacy

The observer redacts before indexing. A review of 318 replies, the event stream, the index and its error output found no prompts, thinking, tool inputs or results, environment values, secrets or absolute paths. Studio's logs hold no tokens or contents.

**R1, stated plainly.** A person's name that appears only in free-text prose is **shown**, not removed. It appears in the declared free-text event fields and their copies, in artifact content, in file names and in the project folder name. It is labelled as free text and contained. Redaction of names is not comprehensive and is not claimed. On one engineer's laptop it adds no reader of files that engineer can already open. On a shared or screen-shared display, anyone who sees the screen sees the prose. **Make no confidentiality claim for free text.** Product Studio's browser also keeps a pending idea's text in `sessionStorage` until the tab closes.

## 10. Failure and incident recovery

- **Stop work now:** `factory stop`. Running executions end and the Factory pauses. Outcomes are recorded as unknown. Check each ticket before `factory resume`.
- **Revoke authorization on this machine:** `factory disable` (add `--stop`). It removes hooks and any service. Deleting `.factory/local/runner.json` also reads as disabled.
- **Suspected injection or stolen credentials:** disable, then rotate the credentials in `HOME` (Git, `gh`, SSH). Read `.git/hooks` in the project and its cells for hooks you did not write. Check `runner.json` and the plugin folder. Review commits on `feature/<ticket>` and anything pushed from the machine.
- **Where state is:** tickets and cells in `.factory/`; the intake ledger and events in `.factory/intake/`; Studio drafts in `.factory/studio/` (never read by a station); authorization and execution records in `.factory/local/`.
- **Upgrade and rollback:** reinstalling over an existing install kept Studio drafts, the intake ledger, cells, the archive, `runner.json` and the observer folder byte-identical in a hand-built test from v0.12.0. There is no documented rollback. Reinstalling the older installer worked in that test and the newer installer restored it. Back up `.factory/` first. The installer never changes it.

## 11. Known limitations

- No operating-system sandbox. An unattended run can run arbitrary code as you.
- One machine, local clones and a stand-in `gh` for almost all tests. No test on separate machines.
- No retry or supervisor restart seen in a live run.
- Names in free text are served. No confidentiality claim.
- `install.sh` fetches Python source from `main`, unchecked.
- No dependency, secret or static scan of generated code in the line.
- No exception record for security blockers. A non-security seat's unmarked blocker can still be outvoted at Medium.
- Windows and Intel Mac are not built or tested.
