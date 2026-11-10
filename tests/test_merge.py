"""Tests for merge.py: approvals bound to a commit, revalidation against main, local and pull-request merges."""

import io
import json
import os
import stat
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "skills" / "merge" / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))
import merge  # noqa: E402
from test_build import git  # noqa: E402
from test_run import Base as RunBase  # noqa: E402

FAKE_GH = '''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
state = os.environ["FAKE_GH_STATE"]
with open(os.environ["FAKE_GH_LOG"], "a") as log:
    log.write(json.dumps(args) + "\\n")
if args[:2] == ["pr", "create"]:
    print("https://github.com/acme/app/pull/12")
elif args[:2] == ["pr", "merge"]:
    if os.environ.get("FAKE_GH_BLOCK"):
        sys.stderr.write("Pull request is not mergeable: required status checks are pending\\n")
        sys.exit(1)
    open(state, "w").write("merged")
elif args[:2] == ["pr", "view"]:
    merged = os.path.exists(state)
    print(json.dumps({"state": "MERGED" if merged else "OPEN", "mergeCommit": {"oid": "f" * 40} if merged else None, "headRefOid": "x"}))
'''


class Base(RunBase):
    def approved(self, **config):
        self.verified()
        head = git(self.work, "rev-parse", "HEAD").stdout.strip()
        self.put(self.cellroot, {"review/decision.json": json.dumps({
            "outcome": "APPROVED", "head": head, "round": 1, "votes": {"architecture": "APPROVE", "security": "APPROVE", "product": "APPROVE"},
            "blockers": 0, "human_approval_required": False, "human_approval": None, "findings": str(self.cellroot / "review/round-1/findings.md")})})
        self.set_cell(stage="approved", review="APPROVED")
        if config:
            self.put(self.project, {".factory/config.json": json.dumps({"merge": config})})
        return head

    def m(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = merge.main(["--project", str(self.project), *argv])
        return code, out.getvalue(), err.getvalue()

    def m_ok(self, *argv):
        code, out, err = self.m(*argv)
        self.assertEqual(code, 0, err + out)
        return json.loads(out)

    def m_refused(self, *argv):
        code, out, err = self.m(*argv)
        self.assertEqual(code, 1, out)
        return err

    def main_log(self):
        return git(self.project, "log", "--format=%s", "main").stdout.splitlines()


class PolicyTest(Base):
    def test_manual_mode_leaves_the_merge_to_a_person(self):
        self.approved()
        plan = self.m_ok("plan", "LOCAL-001")
        self.assertEqual((plan["allowed"], plan["mode"], plan["approval_valid"]), (False, "manual", True))
        self.assertIn("a person merges this ticket", plan["refusals"][0])
        self.assertIn("a person merges this ticket", self.m_refused("run", "LOCAL-001"))
        self.assertEqual(self.main_log(), ["work"])
        self.assertTrue(self.m_ok("plan", "LOCAL-001", "--by-person")["allowed"])
        self.assertEqual(self.next()["needs"], "merge")

    def test_auto_mode_merges_locally_and_the_line_cleans_up(self):
        head = self.approved(mode="auto")
        self.assertEqual((self.next()["action"], self.next()["prompt"]), ("merge", "Use the MACH merge skill: /mach:merge LOCAL-001"))
        done = self.m_ok("run", "LOCAL-001")
        self.assertEqual((done["status"], done["approved_commit"], done["landed_commit"], done["revalidated"]), ("MERGED", head, head, None))
        self.assertEqual(self.main_log()[0], "Merge LOCAL-001: Invite a teammate by email")
        self.assertEqual(git(self.project, "merge-base", "--is-ancestor", head, "main").returncode, 0)
        self.assertEqual(self.cell_json()["stage"], "merged")
        self.assertEqual(self.next()["action"], "cleanup")
        self.assertIn("already merged", self.m_refused("run", "LOCAL-001"))

    def test_a_risk_tier_can_be_kept_for_a_person(self):
        self.approved(mode="auto", auto={"medium": False})
        self.assertIn("Medium-risk tickets are merged by a person", self.m_refused("run", "LOCAL-001"))
        self.assertEqual(self.next()["needs"], "merge")
        self.assertEqual(self.m_ok("run", "LOCAL-001", "--by-person")["status"], "MERGED")

    def test_only_an_approved_ticket_with_any_required_sign_off_merges(self):
        self.verified()
        self.put(self.project, {".factory/config.json": json.dumps({"merge": {"mode": "auto"}})})
        refusal = self.m_refused("run", "LOCAL-001")
        self.assertIn("Only an approved ticket can be merged", refusal)
        self.assertIn("no approval on record", refusal)
        self.approved_decision = json.loads((self.cellroot / "review/decision.json").read_text()) if (self.cellroot / "review/decision.json").exists() else {}
        head = git(self.work, "rev-parse", "HEAD").stdout.strip()
        self.put(self.cellroot, {"review/decision.json": json.dumps({"outcome": "APPROVED", "head": head, "human_approval_required": True, "human_approval": None})})
        self.set_cell(stage="approved")
        self.assertIn("requires a person's approval and none is recorded", self.m_refused("run", "LOCAL-001"))

    def test_main_checkout_must_be_clean_and_on_the_main_branch(self):
        self.approved(mode="auto")
        self.put(self.project, {"scratch.txt": "x", "app/__pycache__/a.pyc": "x"})
        self.assertIn("uncommitted changes (scratch.txt)", self.m_refused("run", "LOCAL-001"))
        (self.project / "scratch.txt").unlink()
        git(self.project, "checkout", "-q", "-b", "other")
        self.assertIn("not on main", self.m_refused("run", "LOCAL-001"))


class ApprovalTest(Base):
    def test_a_commit_added_after_approval_voids_it(self):
        self.approved(mode="auto")
        self.put(self.work, {"app/extra.py": "SNEAKY = True\n"})
        git(self.work, "add", "-A")
        git(self.work, "commit", "-q", "-m", "added after review")
        plan = self.m_ok("plan", "LOCAL-001")
        self.assertEqual((plan["allowed"], plan["approval_valid"]), (False, False))
        self.assertEqual(self.cell_json()["stage"], "approved", "plan changes nothing")
        self.assertEqual(self.next()["action"], "merge", "the line sends it to the merge station, which voids the approval")
        refusal = self.m_refused("run", "LOCAL-001")
        self.assertIn("something was added after review", refusal)
        self.assertEqual(self.main_log(), ["work"])
        cell = self.cell_json()
        self.assertEqual((cell["stage"], cell["review"]), ("built", "VOID"))
        self.assertEqual(json.loads((self.cellroot / "review/decision.json").read_text())["outcome"], "VOID")
        self.assertEqual(self.next()["action"], "verify", "it is verified and reviewed again")


class RevalidationTest(Base):
    def test_main_moved_cleanly_the_branch_is_updated_retested_and_merged(self):
        head = self.approved(mode="auto")
        self.put(self.project, {"app/later.py": "VALUE = 1\n"})
        self.commit_main()
        self.assertTrue(self.m_ok("plan", "LOCAL-001")["behind_main"])
        done = self.m_ok("run", "LOCAL-001")
        self.assertEqual(done["status"], "MERGED")
        self.assertNotEqual(done["landed_commit"], head)
        self.assertEqual(done["revalidated"]["head"], done["landed_commit"])
        self.assertTrue((self.project / "app/invite.py").is_file() and (self.project / "app/later.py").is_file())

    def test_main_moved_and_the_suite_now_fails_goes_back_to_build(self):
        self.approved(mode="auto")
        self.put(self.project, {"tests/test_clash.py": "import unittest\n\nclass C(unittest.TestCase):\n    def test_clash(self):\n        import app.invite\n        self.fail('main now disagrees with this ticket')\n"})
        self.commit_main()
        self.put(self.project, {".factory/config.json": json.dumps({"merge": {"mode": "auto"}})})
        refusal = self.m_refused("run", "LOCAL-001")
        self.assertIn("the test suite fails, so nothing was merged", refusal)
        self.assertNotIn("Merge LOCAL-001", " ".join(self.main_log()))
        decision = json.loads((self.cellroot / "review/decision.json").read_text())
        self.assertEqual((decision["outcome"], decision["rejected_by"]), ("REJECTED", "merge station"))
        self.assertIn("main now disagrees", (self.cellroot / "review/merge-findings.md").read_text())
        step = self.next()
        self.assertEqual((step["action"], step["reason"]), ("revise", "The merge station sent this build back."))
        self.assertTrue(step["findings"].endswith("merge-findings.md"))
        self.assertEqual(self.ok("revise", "LOCAL-001", "--findings", step["findings"])["status"], "REVISING")

    def test_main_moved_with_a_conflict_needs_a_person(self):
        self.approved(mode="auto")
        self.put(self.project, {"README.md": "# Sample\n\nmain rewrote this\n"})
        self.commit_main()
        refusal = self.m_refused("run", "LOCAL-001")
        self.assertIn("conflicts in README.md", refusal)
        self.assertEqual(self.cell_json()["stage"], "approved")
        self.assertEqual(git(self.work, "status", "--porcelain").stdout, "")


class PullRequestTest(Base):
    def setUp(self):
        super().setUp()
        root = Path(self.tmp.name).resolve()
        origin = root / "origin.git"
        git(root, "init", "-q", "--bare", str(origin))
        git(self.project, "remote", "add", "origin", str(origin))
        git(self.project, "push", "-q", "-u", "origin", "main")
        self.origin = origin
        bin_dir = root / "fakebin"
        bin_dir.mkdir()
        fake = bin_dir / "gh"
        fake.write_text(FAKE_GH)
        fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
        self.gh_log = root / "gh.log"
        env = {"PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}", "FAKE_GH_LOG": str(self.gh_log), "FAKE_GH_STATE": str(root / "merged.flag")}
        patcher = mock.patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)

    def calls(self):
        return [json.loads(line) for line in self.gh_log.read_text().splitlines()] if self.gh_log.exists() else []

    def test_pull_request_is_opened_and_merged_at_the_approved_commit(self):
        head = self.approved(mode="auto", method="pr")
        done = self.m_ok("run", "LOCAL-001")
        self.assertEqual((done["status"], done["pull_request"], done["merge_commit"]), ("MERGED", "https://github.com/acme/app/pull/12", "f" * 40))
        self.assertEqual(git(self.project, "ls-remote", str(self.origin), "refs/heads/feature/LOCAL-001").stdout.split()[0], head)
        created = next(call for call in self.calls() if call[:2] == ["pr", "create"])
        self.assertEqual(created[created.index("--title") + 1], "LOCAL-001: Invite a teammate by email")
        body = created[created.index("--body") + 1]
        for expected in ("**Risk tier:** Medium", "PASS: 8 of 8 checks passed", "architecture APPROVE", "No person's approval was required", f"Approved commit: `{head}`"):
            self.assertIn(expected, body)
        merged = next(call for call in self.calls() if call[:2] == ["pr", "merge"])
        self.assertEqual(merged[merged.index("--match-head-commit") + 1], head, "the platform merges only the approved commit")
        self.assertEqual(self.cell_json()["stage"], "merged")
        self.assertEqual(self.main_log(), ["work"], "with a pull request, nothing is merged into the local checkout")

    def test_pull_request_that_cannot_merge_yet_is_left_open(self):
        self.approved(mode="auto", method="pr")
        with mock.patch.dict(os.environ, {"FAKE_GH_BLOCK": "1"}):
            code, out, _ = self.m("run", "LOCAL-001")
        result = json.loads(out)
        self.assertEqual((code, result["status"]), (3, "PR_OPEN"))
        self.assertIn("required status checks are pending", result["note"])
        cell = self.cell_json()
        self.assertEqual((cell["stage"], cell["pull_request"]), ("pr-open", "https://github.com/acme/app/pull/12"))
        self.assertEqual(self.next()["action"], "merge")
        done = self.m_ok("run", "LOCAL-001")
        self.assertEqual(done["status"], "MERGED")
        self.assertEqual(sum(1 for call in self.calls() if call[:2] == ["pr", "create"]), 1, "the pull request is not opened twice")

    def test_manual_mode_opens_the_pull_request_for_a_person_to_merge(self):
        self.approved(mode="manual", method="pr")
        self.assertIn("a person merges this ticket", self.m_refused("run", "LOCAL-001"))
        self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    unittest.main()
