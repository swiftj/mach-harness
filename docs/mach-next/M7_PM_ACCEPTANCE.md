# M7 Phase 1: Product Manager acceptance (up to the Factory handoff)

**Read this first.** PM A, PM B and the engineer were simulated on **one Mac**. Each has its own clone, `HOME`
folder and Git identity. They are not separate MacBooks. All three used **one GitHub account** (the one `gh`
is logged in to). GitHub therefore refused every "approve" or "request changes" review, because a person
cannot review their own pull request (see G4). Nothing in this report counts as a test on separate machines.
`scratch/m7/agents/pm/SECOND_MACHINE_CHECKLIST.md` holds a 20-minute checklist to repeat the key steps on a
second MacBook.

## Environment

- MACH snapshot: `fb6226c` (`git archive` of the M7 worktree), unpacked into `scratch/m7/agents/pm/src`. Every
  PM and engineer command ran from that snapshot.
- Host: `apps/studio` was built from the snapshot with `go build` (placeholder web UI). The tests drove it
  over HTTP. The installer also fetched the released `mach-studio` 0.12.0 into the engineer clone, but that
  copy was not used.
- Repository: **`swiftj/mach-m7-acceptance`**, private, on real GitHub. It was created with
  `gh repo create --private` and is never deleted.
- PATH for the PM commands: `<world>/pmbin:/usr/bin:/bin` under `env -i HOME=<pm home>`. `pmbin` holds only a
  symlink to `gh`, so Go, Node, pnpm and npm were absent. The system folders still provide `/usr/bin/git`,
  `python3` (3.9.6), `make`, `cc` and `clang` (Xcode CLT shims), recorded in `ev/pma-path.jsonl`.
- GitHub authentication: the token from the real `gh` login was passed as `GH_TOKEN` in the environment only.
  It was never printed or written, and logs mask it. Each home's gitconfig uses `gh auth git-credential`.
- Evidence root: `scratch/m7/agents/pm/ev/`. Here and below, `scratch` means
  `/private/tmp/claude-501/-Users-johnswift-Projects-mach-harness/4cf98ed8-7452-4d90-8d38-55769b828040/scratchpad`.
  Driver scripts are `p0_engineer.py`, `p0_protect.py`, `p1_pms.py`, `p2_review.py`, `p3_pmb.py`,
  `p4_conflict_host.py`, `p5.py`, `p7_interview.py` and `p8_handoff.py`, all next to `PROGRESS.md`.

## The product: Team Lending Desk

A JSON HTTP service written with the Python standard library only.

- **Epics:** EPIC-001 Catalogue (PM A) and EPIC-002 Loans (PM B).
- **Slices:**
  - SLICE-001 List and add items (S1).
  - SLICE-002 Loan limit (S5). This is the shared rule "a member may hold at most 3 items at once".
  - SLICE-005 Borrow an item (S2). Depends on SLICE-001 and SLICE-002.
  - SLICE-006 Return an item (S3). Depends on SLICE-005.
  - SLICE-003 Overdue report (S4). Depends on SLICE-005 and shows each member's item count.
- **Specs:** every spec passes `validate_slice.py --ready` (SLICE-003 carries one `ears-coverage` warning).
- **Non-functional requirement:** SLICE-001 FR-05 says every request is answered within 200 ms with 1,000
  items in the catalogue.
- **Constraints in every why:** an OpenAPI contract (`proto/openapi.yaml`) and a real integration test over
  HTTP.
- **Engineer's seed:** a `/health` endpoint and an integration test that starts the real server. Both
  `make lint` and `make test` pass. The seed also has `pyproject.toml` (ruff config), CODEOWNERS, a GitHub
  Actions `test` workflow, and the rule files from `bin/mach install`.
- **Audit:** not run, because it is a station. Silver is therefore **not assessed**.

## Steps

The Kind column says how each step ran: T = terminal (`studio.py` / `run.py`), H = visual host HTTP API,
GH = real GitHub, SIM = simulated, MOCK = mocked.

| # | Step | What was done | Evidence | Result | Kind |
|---|------|---------------|----------|--------|------|
| 1.1 | Engineer seed and install | Seed code committed, `bin/mach install` run, pushed to `main` | `ev/eng-install.jsonl`, `ev/eng-seedtest.jsonl` | PASS | T, GH |
| 1.2 | Protect `main` | Classic protection (PR + CODEOWNERS review + `test` check), signed commits, and a ruleset were each attempted | `ev/github.jsonl` | Refused on this plan (G1) | GH |
| 2.1 | PM A clones the project | `gh repo clone` | `ev/pma-clone.jsonl` | PASS, but needs a `gh` command (D7) | T, GH |
| 2.2 | Objective, epic 1, S1, S5 | `project init`, `epic add/approve`, `slice new` ×2; specs written directly | `ev/pma.jsonl` | PASS | T |
| 2.3 | Save, close, resume | `slice pause --note`; status in a new process shows the note; `slice resume` returns it | `ev/pma.jsonl` | PASS | T |
| 2.4 | Approve and assemble WAVE-001 | `slice check --ready`, `slice approve` ×2, `wave new/approve`, `send --dry-run` | `ev/pma.jsonl` | PASS | T |
| 2.5 | `send` WAVE-001 | Real pull request #1 on `product/WAVE-001`; `factory_authorized: false` | `ev/pma.jsonl` | PASS | T, GH |
| 2.6 | One real Claude-assisted interview through the host's interview API | First attempt: the host reported "Claude Code is not signed in" (D6). Retried with the user's login environment on PM B's unpublished SLICE-004 | `ev/p4.json`, `ev/p7_interview.json`, `ev/interview-events.log` | PASS on the retry: 2 real turns (start, then the reply "yes"); state `waiting_for_reply`; stopped through the API | H |
| 3.1 | PM B drafts while A's wave is unmerged | Same `project init`, epic "Loans" as local EPIC-001, local SLICE-001..003 for S2/S3/S4, extra unpublished SLICE-004 | `ev/pmb.jsonl` | PASS | T |
| 3.2 | PM B refreshes after WAVE-001 merges | Refresh through the host. The project merged cleanly. EPIC-001 and SLICE-001/002 were reported as **collisions** | `ev/p3_pmb.out` | PASS | H |
| 3.3 | Renumber the collisions | `epic renumber EPIC-001` → EPIC-002; `slice renumber` → SLICE-005, SLICE-006. Dependencies were rewritten (S3, S4 → SLICE-005). Renumbering by the listed path was refused (D4) | `ev/pmb-status-after-renumber2.json` | PASS | T |
| 3.4 | Unpublished drafts survive refreshes | SLICE-004 was still a draft after three refreshes and two merges | `ev/p6.json` | PASS | T, H |
| 3.5 | Conflicting product decision, 3 vs 5 | B reopened SLICE-002 and set 5. A reworded the 3-item rule, published WAVE-002 (pull request #2) and it merged. B's host refresh reported **conflicts** on the work order and the spec, with changed IDs. Wave approval was refused while the conflict stood | `ev/p4.json` | PASS | H, T, GH |
| 3.6 | Resolve only by explicit `reconcile --take` | `reconcile SLICE-002` was refused as ambiguous (D3). Reconciling each path with `--take theirs` left a spec with 3, not 5, plus A's wording. B had to approve SLICE-002 again | `ev/p5.json` | PASS (never silent) | T |
| 4.1 | Host: refresh, epic, slice approval, wave | Ran `refresh`, `epic.set`, `epic.approve`, `slice.check` and `slice.approve` ×3, and `wave.new` (WAVE-003) over HTTP with the one-time link, session cookie, Origin and `X-MACH-CSRF` | `ev/host-pmb-ops.jsonl` | PASS | H |
| 4.2 | Canonical equivalence | Ran the existing suite `tests.test_mach_product_host` (conformance: host and terminal write byte-identical files): 2 tests OK. No separate diff on Lending Desk inputs | `ev/conformance.log` | PASS (existing suite) | T, H |
| 5.1 | Engineer review comment | `gh pr review --request-changes` refused (G4). `gh pr review --comment` posted instead | `ev/github.jsonl` | PASS (comment) | GH |
| 5.2 | `feedback` shows the comment as data | `reviewer_remarks` holds the comment, with `remarks_are_data` | `ev/pma.jsonl` | PASS | T, GH |
| 5.3 | PM revises and sends again | `slice reopen` returned WAVE-001 to draft; then edit, approve, `wave approve`, `send`. Pull request #1 was updated; there is one pull request for the branch | `ev/p2_review.out` | PASS | T, GH |
| 5.4 | Engineer approves and merges | Approval refused (own pull request, G4). Merged #1, #2 and #3 with `gh pr merge --merge`. `feedback` then says "Accepted" | `ev/github.jsonl`, `ev/p6.json` | PASS (merge); approval NOT RUN | GH |
| 6.1 | Network cut during `send` | `HTTPS_PROXY` set to a dead port for one call. Message: "Could not reach the shared repository, so nothing was sent. Try again when you are connected." Drafts unchanged; the retry later sent | `ev/p2_review.out` | PASS | SIM |
| 6.2 | Push succeeds, pull-request creation times out | A `gh` wrapper fails `pr create` once. Result: `sent_request_not_opened`, branch on the remote, no pull request. The retry opened #3; a third send reported the same #3; one pull request in total | `ev/p5b.json` | PASS | SIM + GH |
| 6.3 | Expired authentication | `GH_TOKEN=invalid` for one `send`. Refused with no change, but the message blames the network (D2) | `ev/p5b.json` | PASS (safe), wording FAIL | GH (real invalid token) |
| 6.4 | Push to a protected branch rejected | `pushurl` pointed at a local bare repository whose pre-receive hook prints GH006. Refused, drafts unchanged, no duplicate later. The reason was lost from the message (D1) | `ev/p2_review.out` | PASS (safe), wording FAIL | SIM |
| 6.5 | SSO enforcement | Same mechanism with a SAML SSO message. The same loss of reason (D1) | `ev/p2_review.out` | PASS (safe), wording FAIL | MOCK |
| 7.1 | Engineer pulls; `product status` | Three waves, all `new` | `ev/p8_handoff.json` | PASS | T |
| 7.2 | `intake`, `plan` | Five tickets: LOCAL-001 = SLICE-001, -002 = SLICE-002, -003 = SLICE-005, -004 = SLICE-006, -005 = SLICE-003. Ready: SLICE-001 and 002. Blocked with reasons: SLICE-005 waits for 001 and 002; SLICE-006 and SLICE-003 wait for SLICE-005 to be integrated | `ev/p8_handoff.json` | PASS | T |
| 7.3 | Repeat `intake` | `created: []`, all `unchanged`. Still five tickets and no cells; the checkout is clean | `ev/p8_handoff.json` | PASS | T |
| 7.4 | Dispatch from a PM clone | Refused for both PM clones, but only because "It is not in the intake ledger. Run intake first." This is not a role check (D5) | `ev/p8_handoff.json` | PASS as observed; see D5 | T |
| 7.5 | `factory enable` (no `--confirm`) from a PM clone | Preflight `ready: true`, `enabled: false`, and a confirmation code was printed. Not confirmed (D5) | `ev/p8_handoff.json` | Not enabled; see D5 | T |
| 7.6 | Factory disabled everywhere | `.factory/local/runner.json` is absent in all three clones | `ev/p8_handoff.json` | PASS | T |

## GitHub rules: enforced versus mocked

| Rule | API result | How its test ran |
|------|------------|------------------|
| G1 Required pull request + CODEOWNERS review + required `test` status check (classic protection) | 403 "Upgrade to GitHub Pro or make this repository public to enable this feature." | Not available on this plan. The protected-branch push rejection was SIMULATED (6.4) |
| G2 Required signed commits | Same 403 | Not available on this plan. NOT RUN |
| G3 Repository ruleset (pull request, status check, signatures, non-fast-forward) | Same 403 | Not available on this plan. NOT RUN |
| G4 Review approval or request-changes by the engineer | GraphQL: "Can not approve your own pull request" / "Can not request changes on your own pull request" | Single account. Comment-only review used. NOT RUN as an approval |
| CODEOWNERS file, Actions `test` workflow | Committed; the check ran (pending at the first merge) | Present but not required. Nothing was enforced |
| SSO | Not applicable (personal account) | MOCK (6.5) |

## Defects

Severities follow the brief: Blocker, Major, Minor.

1. **D1, Major.** When a push is refused by a protected branch or by SSO, the PM sees only Git's last line,
   "error: failed to push some refs to '<remote>'", followed by "Run send again; nothing will be sent twice."
   GitHub's actual reason (GH006, SAML SSO) is lost. The message also advises retrying a refusal that will
   never succeed. Evidence: `ev/p2_review.out`, `ev/pma-failures.jsonl`.
   Source: `collab.last_line` (the last stderr line) in `skills/product-studio/scripts/collab.py`.
2. **D2, Major.** With expired or invalid GitHub authentication, `send` says "Could not reach the shared
   repository ... Try again when you are connected." The PM is told to check the network when the real fix
   is to sign in again. Evidence: `ev/p5b.json`, `ev/pmb-failures.jsonl`.
3. **D3, Minor.** `reconcile SLICE-002 --take theirs` is refused with "matches more than one item". The
   `--help` text says it accepts "the path or ID listed under needs_reconciling". A PM must reconcile the
   work order and the spec separately, and taking theirs on the work order withdraws the local approval, so
   the slice must then be approved again. Evidence: `ev/p4.json`, `ev/p5.json`.
4. **D4, Minor.** `needs_reconciling.collisions` lists file paths such as `product/epics/EPIC-001.json`, but
   `epic renumber` and `slice renumber` refuse a path ("not a usable epic ID"). A collision of one slice is
   listed as two files (the why and the work order). Evidence: `ev/p3_pmb.out`.
5. **D5, Major (open question for the lead).** Nothing distinguishes a PM clone from an engineer's.
   - `run.py product dispatch` in a PM clone was refused only because that clone had no intake ledger.
   - `factory enable` in a PM clone passed preflight (`ready: true`) and issued a confirmation code.
   - Not tested (would change the PM clone): whether intake followed by dispatch, or `enable --confirm`, would
     succeed there.

   The design says the authorization is machine-local, so a PM who confirms on their own machine may be
   intended behaviour. If so, the M3 "only on an engineer's explicit command" rule is a convention, not a
   check. Evidence: `ev/p8_handoff.json`.
6. **D6, Minor (test environment).** Started with only `HOME` and `PATH`, the host reported "Claude Code is
   not signed in". `claude auth status` needs `USER` (Keychain) as well. The message is accurate, but a PM
   whose shell lacks `USER` would see "not signed in" while actually signed in. Evidence: `ev/p4.json`.
7. **D7, Minor.** Getting the shared project onto a PM's machine needs `gh repo clone` (or `git clone`).
   After that, no PM step needed a `git` or `gh` command: refresh, send, feedback and reconcile all ran
   through `studio.py` or the host.
8. **D8, Minor.** PM B reopened SLICE-002, a slice in A's already-merged WAVE-001. That returned the
   published WAVE-001 to a draft in B's workspace. After reconciling, `status` still suggests "WAVE-001 holds
   only approved slices: approve it (wave approve WAVE-001)", a wave that was sent and merged by someone
   else. While B's SLICE-002 copy was unapproved, approving WAVE-003 was refused with an error about
   *published* WAVE-002. Evidence: `ev/p5.json`.

There are no Blockers.

## Claude cost

There was one interview, on PM B's unpublished SLICE-004 through the host's `/api/interview` (start, one
reply "yes", stop), with a cap of USD 0.60 per turn.

- Turn 1: USD 0.2203.
- Turn 2: USD 0.0125.
- **Session: USD 0.2328**, within the USD 1.50 cap.
- The first attempt failed before any turn (D6), at a cost of USD 0.

The host and its interview turns ran with the user's own `HOME`, because Claude Code's login lives there.
Git identity came from PM B's gitconfig through `GIT_CONFIG_GLOBAL`. This is a deviation from "separate
HOME".

## To hand over

- **Clones:**
  - Engineer: `scratch/m7/agents/pm/world/eng`, home `world/home-eng`.
  - PM A: `world/pma`, home `world/home-pma`.
  - PM B: `world/pmb`, home `world/home-pmb`.
  - Remote: `https://github.com/swiftj/mach-m7-acceptance` (private).
- **Engineer clone state:**
  - On `main` at `5fe41ed`, matching origin, with a clean checkout.
  - MACH 0.12.0 is script-installed, with the released `mach-studio` in `.factory/bin`; this snapshot's code
    is under `.claude/skills`.
  - Intake done: five tickets (LOCAL-001..005) in `.factory/tickets`, the ledger in `.factory/intake`, no
    cells.
  - Factory disabled: no `runner.json`.
  - Audit not run.
  - Pull requests #1, #2 and #3 are merged. No pull request is open.
- **PM workspaces:**
  - PM A: everything published.
  - PM B: one unpublished draft, SLICE-004 "Reserve an item ahead" (the interview's slice). B also has a
    stale local draft of WAVE-001 (D8).
- **Commands to continue** (engineer, from the engineer clone; `GH_TOKEN` only if pushing):

      cd <scratch>/m7/agents/pm/world/eng
      HOME=../home-eng python3 .claude/skills/mach-run/scripts/run.py --project . product plan
      HOME=../home-eng python3 .claude/skills/mach-audit/scripts/audit.py        # the station the Factory task runs first
      HOME=../home-eng python3 .claude/skills/mach-run/scripts/run.py --project . factory enable   # then --confirm <code> only on a person's yes

  The PM commands are the same `studio.py` commands with `--project <clone>`; see `p1_pms.py` for the exact
  calls.
- **Processes:** every host started here was stopped. No Factory, supervisor, station or `claude -p` ran.

## Corrected in M7

Fixed after the run above, in `skills/product-studio/scripts/collab.py`, `studio.py` (messages only) and
`SKILL.md`. Tested in `tests/test_mach_product_collab.py` with a local bare repository and stand-ins for
`git` and `gh` (no network, no real credentials). The live run was not repeated against GitHub.

- **D1, corrected.** `collab.classify` reads a failed push, fetch or `gh` call's exit status and output and
  names one of: no network, sign-in not accepted, single sign-on required, refused by the shared project's
  rules (protected branch, ruleset, permission, a pre-receive hook), or other. `collab.explain` words each
  for the PM. A refusal by the rules says so, quotes the remote's own reason (its `remote:` lines) as data,
  says sending again will not change it and that an engineer or the repository's owner can help. Single
  sign-on quotes the address GitHub printed, as data. Any other reason is passed on, bounded to 300
  characters, with control characters and credentials inside URLs removed. No message names a Git command.
  Tests: `FailureWordingTest` (protected branch with GH006, SSO, other).
- **D2, corrected.** An invalid or expired sign-in, at fetch or at push, now reads "GitHub did not accept your
  sign-in on this computer ... Sign in to GitHub again". `refresh` gives the same news in `problem`.
  The terminal adds the one step (`gh auth login`); the web app says an engineer can show how. A real
  network failure keeps the earlier wording. Tests: `test_an_invalid_sign_in_*`, `test_no_network_at_push_*`.
- The ledger is unchanged: each new test asserts that the failed send leaves the approved wave and the
  prepared commit as they were, and that a later send lands one branch at the same commit and one request.
  The list of Git and `gh` commands Product Studio may run is unchanged.
- **D3, wording corrected.** Reconciling by a slice ID that has several files waiting now says each file is
  decided on its own and lists the paths to use. Behaviour unchanged (each file is still reconciled
  separately, and taking theirs on the work order still withdraws the approval). Not covered by a new test.
- **D4, wording corrected.** `epic|slice|wave renumber <path>` is still refused, but the refusal now names the
  ID to use. Test: one assertion in `test_a_number_taken_by_someone_else`.
- **D5, untouched.** A design question for the lead (who may dispatch or enable), not a wording change.
- **D6, untouched.** The sign-in check is in the Studio host (`apps/studio`), outside this change; the
  message is accurate for the environment it saw.
- **D7, untouched.** Getting a copy of the shared project is a one-time step outside Product Studio by design.
- **D8, untouched.** The `status` suggestion for a wave someone else already sent, and the refusal naming
  WAVE-002, need a change to how status and wave approval treat published waves, not wording.
- **Factory acceptance D1 and PM D8, corrected.** `send` now reads the real state of the latest pull request
  from the wave's branch (`gh pr view`, already allowed; no new command). Open and this workspace's: it is
  updated, never duplicated. Merged or closed: the recorded request is kept under `earlier_requests` in the
  ledger and a new request is opened for the later revision; the new commit is built on top of the old branch
  when it still exists (a fast-forward, never a force-push) or from the integration branch when it was
  deleted. "Another product manager already has WAVE-NNN in review" is said only when an open request for the
  wave is not this workspace's; for a wave already in the shared project the PM is told to wait for that
  decision rather than to renumber. `feedback` reports the latest request. `status` now shows, for a wave
  whose shared revision differs from the draft, `shared` (revision, status) and `shared_note`, for example
  "merged at revision 4; your draft is revision 5, not sent". Tests: `LaterRevisionTest` (merged, merged by
  another PM then a competing open one, closed), with the fake `gh`; the allowed-command test is unchanged
  and passes. The next-step suggestion text for such a wave is unchanged.
