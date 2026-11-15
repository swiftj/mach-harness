# M7: GitHub branch rules against Product Studio's real send and feedback

**The test repository `swiftj/mach-m7-acceptance` was switched from private to PUBLIC and is still public.** The
product owner approved the switch so that branch rules could be set. They can decide whether to switch it back.
All rules and rulesets added here were removed afterwards; `main` is unprotected.

This is **GitHub.com on a personal account, with one user**. It is not a GitHub Enterprise organisation with SSO,
teams or separate reviewers. "Approved and merged under enforced review" could not be shown.

- MACH snapshot: `git archive HEAD` of the M7 worktree at commit `3a4bb22ead707044999e2efcb77157b264ea8966`, so it
  includes the fix that classifies publication refusals. The snapshot was installed into a fresh PM clone with `MACH_SOURCE`.
  The work used `studio.py` (real `send` and `feedback`) in a new clone with its own `HOME` and Git identity.
- Before: private, no protection or rulesets (both calls returned 403 "Upgrade to GitHub Pro or make this repository public").
  After: **public**, `main` unprotected (`GET protection` returns 404, `protected: false`, rulesets `[]`).
- Secret scan: `gitleaks detect` over a fresh clone's full history (35 commits, 1.17 MB): "no leaks found". Switched.
- Left on `main`: the workflow `.github/workflows/test.yml` and `.github/CODEOWNERS` (`* @swiftj`) were already there
  from the earlier PM run, so they were not re-added through a pull request. Neither blocks a direct push once the
  rules are gone. One harmless file `docs-rules-test.txt` was merged by PR #7. PR #6 (WAVE-004) was closed unmerged and
  branch `product/WAVE-004` still exists. Branch `rules-test/merge-path` still exists. Product definitions on `main` are unchanged.
- Evidence (text, in scratch): `/private/tmp/claude-501/-Users-johnswift-Projects-mach-harness/4cf98ed8-7452-4d90-8d38-55769b828040/scratchpad/m7/agents/rules/ev/`.

## Results

All against real GitHub unless marked.

| Rule or scenario | Real / mocked | What GitHub said | What the PM was told | Result |
|---|---|---|---|---|
| Require pull request before merging | real | API accepted | n/a | PASS |
| Require 1 approving review | real | accepted | n/a | PASS |
| Require code owner review (CODEOWNERS `* @swiftj`) | real | accepted | n/a | PASS |
| Require status check `test` (workflow on pull_request; it passed on both PRs) | real | accepted | n/a | PASS |
| Require signed commits | real | accepted | n/a | PASS |
| Block force pushes (and deletions) | real | accepted | n/a | PASS |
| Include administrators | real | accepted | n/a | PASS |
| 3a `send` a new wave with rules on | real | PR #6 opened on `product/WAVE-004` | "Waiting for review", PR link, "No engineering work has started." | PASS |
| 3b direct push to `main` from the PM clone's Git | real | GH006: "Commits must have verified signatures", "Changes must be made through a pull request", "Required status check "test" is expected" | not applicable: a wrong tool, not MACH | PASS (refused) |
| 3b MACH never pushes the integration branch | code and tests, not a run | n/a | n/a | PASS: `collab.py` documents "never the integration branch"; no `send` or `feedback` call touched `main`. The only pushes to `main` in the tests are the engineer's fixture setup |
| 3c PR cannot merge without review and check | real | `mergeStateStatus: BLOCKED`, `reviewDecision: REVIEW_REQUIRED`, check `test` SUCCESS; a merge call: "Commits must have verified signatures. At least 1 approving review is required by reviewers with write access." | `feedback`: "Waiting for review. Nobody has decided yet." | PASS for the block; wording FAIL (D1) |
| 3d unsigned commit blocks merge | real | commit verification `unsigned`; merge refused with "Commits must have verified signatures" | `send` and `feedback` say nothing about it (D1) | PASS for GitHub; D1 for MACH |
| 3d signed case | not run | n/a | n/a | NOT RUN: registering a signing key (`gh ssh-key add --type signing`) needs the `admin:ssh_signing_key` scope, which the token lacks. I did not widen it |
| 3e approve own PR | real | 422 "Review Can not approve your own pull request" | n/a | NOT POSSIBLE with one account: approved-and-merged under enforced review was not shown |
| 3e merge path with approvals lowered | real | With approvals at 0 and code owners and signatures still on: refused, "Commits must have verified signatures". With code owners off, still refused. With signatures also off (PR requirement and `test` check kept): merged (PR #7, a harmless file) | not a MACH step (I merged through GitHub's API) | PASS for the path, but only after dropping the signature rule: with one account and unsigned MACH commits, signed commits plus one reviewer cannot be met together |
| 3f a push GitHub refuses (ruleset restricting creation of `product/**`) | real | GH013 "Repository rule violations found for refs/heads/product/WAVE-005 ... Cannot create ref due to creations being restricted" | "The shared project's rules refused this. WAVE-005 is prepared but could not be sent, and your drafts are unchanged. GitHub said: "error: GH013 ... Cannot create ref due to creations being restricted ...". Sending again will not change that: an engineer or the repository's owner can help." | PASS: quotes GitHub's reason, does not say "try again" |

## Defects

1. **D1, Minor.** `feedback` for a pull request that GitHub reports as blocked says only "Waiting for review. Nobody has
   decided yet.". It does not say the merge also needs a passing check or that the commit is unsigned, so a PM
   cannot tell why it will not land. (The PM cannot fix an unsigned commit, so the useful message is "ask an engineer".)
   Not fixed here.
2. **D2, Minor, environment.** In a clone with a fresh `HOME` and no Git credential helper, the first `send` was
   refused with a plain sign-in message ("GitHub did not accept your sign-in on this computer ..."). That is correct
   behaviour and a good message; recorded because it showed up as a test setup step.
3. **D3, Minor, qualification gap.** Signed-commit enforcement together with MACH's unsigned commit means a team that
   requires signatures needs the PM's Git to sign. MACH does not say so. Not shown with a real signed commit (NOT RUN).

No Major or Blocker defect found. Not assessed: GitHub Enterprise, SSO enforcement, organisation-owned rules, merge queues.
