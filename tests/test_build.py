"""Tests for build.py: start gates, task order, red/green enforcement, finish and revision rounds."""

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "skills" / "build" / "scripts"))
sys.path.insert(0, str(ROOT / "skills" / "intent" / "scripts"))
import build  # noqa: E402
import cell as cell_script  # noqa: E402

SPEC_NAME = "SLICE-001-invite-teammate.md"
SPEC = (ROOT / "tests" / "fixtures" / SPEC_NAME).read_text(encoding="utf-8")
ALL_IDS = "FR-01 FR-02 FR-03 FR-04 FR-05 FR-06 FR-07 FR-08 FR-09 INV-01 INV-02 INV-03 INV-04 AC-01 AC-02 AC-03"
TEST_CMD = f"{sys.executable} -m unittest discover -s tests"

INTENT = """# Intent: Invite a teammate by email

- **Ticket:** LOCAL-001 (local)
- **Slice:** SLICE-001 at specs/slices/SLICE-001-invite-teammate.md
- **Mode:** Interactive
- **Status:** Ready for contracts

## Why

- **Problem:** Admins cannot add teammates.
- **Who it is for:** Workspace admin
- **Success looks like:** An admin adds a teammate without help.

## Goal ancestry

- **Goal:** Not stated.
- **Epic:** Not stated.
- **Ticket:** LOCAL-001: Invite teammates
- **Slice:** SLICE-001: an admin invites one teammate by email

## Constraints

- None.

## Risk

- **Tier:** Medium
- **Reason:** Ordinary product behavior.

## Deferred work

- None.
"""

PLAN = """# Plan: SLICE-001: Invite a teammate by email

- **App type:** library
- **Risk tier:** Medium
- **Contracts:** None. This sample changes no boundary.

## Contracts

- None.

## Tasks

- [ ] T01 [test] Table-driven test of rules R1 to R5 — `tests/test_invite.py` (FR-01, FR-02, FR-03, FR-04, FR-05, FR-07, INV-01, INV-02, INV-04)
- [ ] T02 [impl] Invitation service — `app/invite.py` (FR-01, FR-02)
- [ ] T03 [test] Scenarios (AC-01, AC-02, AC-03, FR-06, FR-08, FR-09, INV-03)
- [ ] T04 [impl] Failure handling (FR-06, FR-08)
- [ ] T05 [docs] Describe invitations in the README (FR-01)

## File touch map

| File | Change | Tasks |
|------|--------|-------|
| `tests/test_invite.py` | create | T01 |
| `app/invite.py` | create | T02, T04 |
| `tests/test_scenarios.py` | create | T03 |
| `README.md` | modify | T05 |

## Engineering decisions

- None.
"""

RED_TEST = "import unittest\nfrom app.invite import invite\n\n# Proves FR-01 FR-02 FR-03 FR-04 FR-05 FR-07 INV-01 INV-02 INV-04\nclass T(unittest.TestCase):\n    def test_invite(self):\n        self.assertEqual(invite('a@example.com'), 'sent')\n"
IMPL = "def invite(email):\n    return 'sent'\n"
SCENARIO_TEST = "import unittest\nfrom app.invite import invite, release\n\n# AC-01 AC-02 AC-03 FR-06 FR-08 FR-09 INV-03\nclass S(unittest.TestCase):\n    def test_release(self):\n        self.assertEqual(release(), 'released')\n"
IMPL2 = IMPL + "\n\ndef release():\n    return 'released'\n"


def git(folder, *args):
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.com", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.com")
    return subprocess.run(["git", *args], cwd=str(folder), capture_output=True, text=True, env=env)


class Base(unittest.TestCase):
    commit_first = True

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.project = Path(self.tmp.name).resolve() / "project"
        self.project.mkdir()
        self.put(self.project, {".gitignore": ".factory/\n__pycache__/\n", "README.md": "# Sample\n", "app/__init__.py": "",
                                "tests/test_base.py": "import unittest\n\nclass B(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n"})
        git(self.project, "init", "-q", "-b", "main")
        for key, value in (("user.name", "t"), ("user.email", "t@example.com"), ("commit.gpgsign", "false")):
            git(self.project, "config", key, value)
        if self.commit_first:
            self.commit_main()
        self.cellroot = self.project / ".factory/worktrees/LOCAL-001"
        self.work = self.cellroot / "repo"

    def commit_main(self):
        git(self.project, "add", "-A")
        git(self.project, "commit", "-q", "-m", "work")

    @staticmethod
    def put(folder, files):
        for name, text in files.items():
            path = folder / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)

    def cell_cmd(self, *argv):
        with redirect_stdout(io.StringIO()) as out, redirect_stderr(io.StringIO()):
            code = cell_script.main(["--project", str(self.project), *argv])
        self.assertEqual(code, 0, out.getvalue())
        return out.getvalue()

    def audit_report(self, tier="Gold", **changes):
        report = {"timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"), "head": git(self.project, "rev-parse", "HEAD").stdout.strip(),
                  "readiness_tier": tier, "blockers": [] if tier != "Bronze" else ["The baseline tests do not pass."],
                  "commands": {"test": {"command": TEST_CMD}, "lint": {"command": None}}}
        report.update(changes)
        self.put(self.project, {".factory/audit-report.json": json.dumps(report)})

    def groom(self, plan=PLAN):
        info = json.loads(self.cell_cmd("open", "LOCAL-001"))
        self.put(Path(info["workdir"]), {f"specs/slices/{SPEC_NAME}": SPEC})
        self.put(self.cellroot, {"intent.md": INTENT})
        self.cell_cmd("finalize", "LOCAL-001", "--spec", f"specs/slices/{SPEC_NAME}")
        self.put(self.cellroot, {"plan.md": plan})
        self.cell_cmd("check-plan", "LOCAL-001")

    def ready(self, tier="Gold", plan=PLAN):
        self.groom(plan)
        self.audit_report(tier)

    def run_build(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = build.main(["--project", str(self.project), *argv])
        return code, out.getvalue(), err.getvalue()

    def ok(self, *argv):
        code, out, err = self.run_build(*argv)
        self.assertEqual(code, 0, err + out)
        return json.loads(out)

    def refused(self, *argv):
        code, out, err = self.run_build(*argv)
        self.assertEqual(code, 1, out)
        return err + out

    def state(self):
        return json.loads((self.cellroot / "build.json").read_text())

    def log(self):
        return git(self.work, "log", "--format=%s").stdout.splitlines()

    def build_through(self, last):
        """Do tasks T01..last honestly."""
        steps = [("T01", "red", {"tests/test_invite.py": RED_TEST}), ("T02", "green", {"app/invite.py": IMPL}),
                 ("T03", "red", {"tests/test_scenarios.py": SCENARIO_TEST}), ("T04", "green", {"app/invite.py": IMPL2}),
                 ("T05", "done", {"README.md": "# Sample\n\nAdmins can invite teammates.\n"})]
        for task, step, files in steps:
            self.put(self.work, files)
            self.ok(step, "LOCAL-001", task)
            if task == last:
                return


class StartTest(Base):
    def test_start_records_plan_and_baseline(self):
        self.ready()
        started = self.ok("start", "LOCAL-001")
        self.assertEqual((started["status"], started["tasks"], started["next"], started["test_cmd"]), ("STARTED", 5, "T01 [test]", TEST_CMD))
        state = self.state()
        self.assertEqual((state["suite"], state["loop"], [t["files"] for t in state["tasks"]][:2]), ("green", 0, [["tests/test_invite.py"], ["app/invite.py"]]))
        self.assertEqual(json.loads((self.cellroot / "cell.json").read_text())["stage"], "building")
        self.assertIn("already started", self.refused("start", "LOCAL-001"))

    def test_next_gives_the_task_and_its_spec_text(self):
        self.ready()
        self.ok("start", "LOCAL-001")
        task = self.ok("next", "LOCAL-001")
        self.assertEqual((task["task"], task["complete_with"], task["files"], task["progress"]), ("T01", "red", ["tests/test_invite.py"], "0 of 5 done"))
        self.assertEqual(task["spec"]["matrix"], {"rules": ["R1", "R2", "R3", "R4", "R5"], "cases": 16, "read": "decision_matrix.cases in spec.json"})
        self.assertIn("FR-03", [r["id"] for r in task["spec"]["requirements"]])

    def test_gates(self):
        self.groom()
        self.assertIn("no audit report", self.refused("start", "LOCAL-001"))
        self.audit_report(timestamp=(datetime.now(timezone.utc) - timedelta(days=30)).isoformat(timespec="seconds"))
        self.assertIn("stale", self.refused("start", "LOCAL-001"))
        self.audit_report(head="0" * 40)
        self.assertIn("stale", self.refused("start", "LOCAL-001"))
        self.audit_report("Bronze")
        self.assertIn("Bronze", self.refused("start", "LOCAL-001"))
        self.audit_report("Silver")
        self.put(self.work, {"stray.txt": "x"})
        self.assertIn("uncommitted changes", self.refused("start", "LOCAL-001"))
        (self.work / "stray.txt").unlink()
        started = self.ok("start", "LOCAL-001")
        self.assertTrue(started["audit"]["human_review_required"])
        self.assertTrue(json.loads((self.cellroot / "cell.json").read_text())["human_review_required"])

    def test_high_risk_always_needs_a_person_even_on_a_gold_repository(self):
        self.ready()
        cell = json.loads((self.cellroot / "cell.json").read_text())
        cell["risk"] = "High"
        (self.cellroot / "cell.json").write_text(json.dumps(cell))
        self.ok("start", "LOCAL-001")
        self.assertTrue(json.loads((self.cellroot / "cell.json").read_text())["human_review_required"])

    def test_bronze_allows_only_hardening_tickets(self):
        self.groom()
        self.audit_report("Bronze")
        self.put(self.project, {".factory/tickets/LOCAL-001.md": '---\nid: LOCAL-001\ntitle: "Harden"\nstate: open\nlabels: ["repo-hardening"]\n---\n'})
        started = self.ok("start", "LOCAL-001")
        self.assertTrue(started["audit"]["human_review_required"])
        self.assertEqual(self.state()["suite"], "unknown", "a hardening ticket may start before a test suite exists")

    def test_audit_gate_can_be_switched_off_and_failing_baseline_refuses(self):
        self.groom()
        self.put(self.project, {".factory/config.json": json.dumps({"build": {"require_audit": False, "commands": {"test": f"{sys.executable} -c 'raise SystemExit(3)'"}}})})
        self.assertIn("already fail in the cell", self.refused("start", "LOCAL-001"))
        self.put(self.project, {".factory/config.json": json.dumps({"build": {"require_audit": False}})})
        self.assertIn("No test command is known", self.refused("start", "LOCAL-001"))
        env_cmd = f"MACH_PROBE=1 {sys.executable} -c 'import os, sys; sys.exit(0 if os.environ.get(\"MACH_PROBE\") == \"1\" else 9)'"
        self.assertEqual(self.ok("start", "LOCAL-001", "--test-cmd", env_cmd)["test_cmd"], env_cmd)

    def test_no_baseline_needs_the_gate_off_and_is_recorded(self):
        self.ready()
        self.assertIn("only for a project that has no test suite yet", self.refused("start", "LOCAL-001", "--no-baseline", "new project"))
        self.put(self.project, {".factory/config.json": json.dumps({"build": {"require_audit": False}})})
        self.ok("start", "LOCAL-001", "--test-cmd", f"{sys.executable} -c 'raise SystemExit(5)'", "--no-baseline", "new project, no tests yet")
        state = self.state()
        self.assertEqual((state["suite"], state["deviations"][0]["type"]), ("unknown", "no-baseline"))

    def test_ungroomed_or_changed_spec_refuses(self):
        self.cell_cmd("open", "LOCAL-001")
        self.assertIn("not 'planned'", self.refused("start", "LOCAL-001"))
        self.assertIn("No cell for LOCAL-404", self.refused("start", "LOCAL-404"))
        self.groom()
        self.audit_report()
        spec = self.work / "specs/slices" / SPEC_NAME
        spec.write_text(SPEC.replace("7 days", "14 days"))
        git(self.work, "commit", "-qam", "edit spec")
        self.assertIn("changed after it was finalized", self.refused("start", "LOCAL-001"))


class LateIsolationTest(Base):
    commit_first = False

    def test_cell_groomed_before_history_is_isolated_at_start(self):
        self.groom()
        self.assertEqual(json.loads((self.cellroot / "cell.json").read_text())["isolation"], "none")
        self.put(self.project, {".factory/config.json": json.dumps({"build": {"require_audit": False}})})
        self.assertIn("no commits", self.refused("start", "LOCAL-001", "--test-cmd", TEST_CMD))
        git(self.project, "add", "-A", ":!specs")
        git(self.project, "commit", "-q", "-m", "first")
        self.assertIn(f"Commit specs/slices/{SPEC_NAME}", self.refused("start", "LOCAL-001", "--test-cmd", TEST_CMD))
        self.commit_main()
        started = self.ok("start", "LOCAL-001", "--test-cmd", TEST_CMD)
        self.assertEqual(started["branch"], "feature/LOCAL-001")
        self.assertTrue((self.work / "specs/slices" / SPEC_NAME).is_file())


class StepTest(Base):
    def setUp(self):
        super().setUp()
        self.ready()
        self.ok("start", "LOCAL-001")

    def test_order_and_step_kind_are_enforced(self):
        self.put(self.work, {"app/invite.py": IMPL})
        self.assertIn("The next task is T01 [test], not T02", self.refused("green", "LOCAL-001", "T02"))
        self.assertIn("complete it with 'red', not 'green'", self.refused("green", "LOCAL-001", "T01"))
        self.assertIn("is not a task in this plan", self.refused("red", "LOCAL-001", "T99"))

    def test_red_requires_a_change_inside_the_plan_and_a_failing_suite(self):
        self.assertIn("changed no files", self.refused("red", "LOCAL-001", "T01"))
        self.put(self.work, {"tests/test_invite.py": RED_TEST, "app/invite.py": IMPL})
        self.assertIn("files the plan did not give it: app/invite.py", self.refused("red", "LOCAL-001", "T01"))
        (self.work / "app/invite.py").unlink()
        self.put(self.work, {"tests/test_invite.py": "import unittest\n\nclass T(unittest.TestCase):\n    def test_nothing(self):\n        pass\n"})
        self.assertIn("never seen failing", self.refused("red", "LOCAL-001", "T01"))
        self.assertEqual(self.log()[0], "spec(SLICE-001): Invite a teammate by email [LOCAL-001]", "a refused step commits nothing")
        self.put(self.work, {"tests/test_invite.py": RED_TEST})
        done = self.ok("red", "LOCAL-001", "T01")
        self.assertEqual((done["suite"], done["next"]), ("red", "T02 [impl]"))
        self.assertEqual(self.log()[0], "test(SLICE-001): T01 Table-driven test of rules R1 to R5 — tests/test_invite.py [LOCAL-001]")
        state = self.state()
        self.assertEqual((state["test_files"], state["tasks"][0]["first_run"]), (["tests/test_invite.py"], "fail"))
        self.assertIn("- [x] T01 [test]", (self.cellroot / "plan.md").read_text())

    def test_red_must_involve_the_new_test(self):
        state = self.state()
        state["test_cmd"] = f"{sys.executable} -c 'import sys; print(\"ImportError: Start directory is not importable\"); sys.exit(1)'"
        (self.cellroot / "build.json").write_text(json.dumps(state))
        self.put(self.work, {"tests/test_invite.py": RED_TEST})
        refusal = self.refused("red", "LOCAL-001", "T01")
        self.assertIn("never mentions the test you wrote (test_invite)", refusal)
        self.assertIn("Start directory is not importable", refusal)
        self.assertEqual(self.state()["tasks"][0]["status"], "pending")
        self.ok("red", "LOCAL-001", "T01", "--unrelated-failure", "The runner prints only a summary line; I ran the test file directly and it fails on the missing function.")
        self.assertEqual(self.state()["deviations"][0]["type"], "red-not-attributed")

    def test_green_requires_a_passing_suite_and_untouched_tests(self):
        self.build_through("T01")
        self.put(self.work, {"app/invite.py": "def invite(email):\n    return 'nope'\n"})
        self.assertIn("does not pass yet, so nothing was committed", self.refused("green", "LOCAL-001", "T02"))
        self.put(self.work, {"app/invite.py": "def invite(email):\n    return 'nope'\n", "tests/test_invite.py": RED_TEST.replace("'sent'", "'nope'")})
        refusal = self.refused("green", "LOCAL-001", "T02")
        self.assertIn("changes tests that are already committed: tests/test_invite.py", refusal)
        self.assertEqual(len(self.log()), 3, "a refused step commits nothing")
        done = self.ok("green", "LOCAL-001", "T02", "--amend-test", "The expected word was wrong in T01.")
        self.assertEqual(done["suite"], "green")
        self.assertEqual([d["type"] for d in self.state()["deviations"]], ["test-amended"])
        self.assertTrue(self.log()[0].startswith("feat(SLICE-001): T02 Invitation service"))

    def test_test_that_passes_first_time_needs_a_reason(self):
        self.build_through("T02")
        self.put(self.work, {"app/invite.py": IMPL2})
        self.assertIn("files the plan did not give it", self.refused("red", "LOCAL-001", "T03"))
        git(self.work, "checkout", "-q", "--", "app/invite.py")
        self.put(self.work, {"tests/test_scenarios.py": "import unittest\nfrom app.invite import invite\n\nclass S(unittest.TestCase):\n    def test_again(self):\n        self.assertEqual(invite('x'), 'sent')\n"})
        self.assertIn("rerun with --covered", self.refused("red", "LOCAL-001", "T03"))
        done = self.ok("red", "LOCAL-001", "T03", "--covered", "T02 already implements sending.")
        self.assertEqual(done["suite"], "green")
        state = self.state()
        self.assertEqual((state["tasks"][2]["first_run"], state["deviations"][0]["type"]), ("pass", "test-passed-first-run"))

    def test_test_committed_by_an_earlier_task_can_be_recorded_not_padded(self):
        self.assertIn("needs an earlier committed test", self.refused("red", "LOCAL-001", "T01", "--written-early", "x"))
        self.build_through("T02")
        self.put(self.work, {"tests/test_scenarios.py": "x = 1\n"})
        self.assertIn("has uncommitted changes", self.refused("red", "LOCAL-001", "T03", "--written-early", "T01 wrote it"))
        (self.work / "tests/test_scenarios.py").unlink()
        commits = len(self.log())
        done = self.ok("red", "LOCAL-001", "T03", "--written-early", "T01 committed the scenario tests with the matrix test.")
        self.assertEqual((done["commit"], done["next"], len(self.log())), (None, "T04 [impl]", commits))
        state = self.state()
        self.assertEqual((state["tasks"][2]["first_run"], state["deviations"][0]["type"]), ("not-run", "test-written-early"))

    def test_done_keeps_a_green_suite_green(self):
        self.build_through("T04")
        self.put(self.work, {"README.md": "# Sample\n\nInvitations.\n", "app/invite.py": "broken("})
        self.assertIn("files the plan did not give it", self.refused("done", "LOCAL-001", "T05"))
        refusal = self.refused("done", "LOCAL-001", "T05", "--allow-extra", "x")
        self.assertIn("this change broke it", refusal)
        git(self.work, "checkout", "-q", "--", "app/invite.py")
        self.ok("done", "LOCAL-001", "T05")
        self.assertTrue(self.log()[0].startswith("docs(SLICE-001): T05"))
        self.assertEqual(self.ok("next", "LOCAL-001")["status"], "ALL_TASKS_DONE")


class FinishTest(Base):
    def setUp(self):
        super().setUp()
        self.ready()
        self.ok("start", "LOCAL-001")

    def test_finish_refuses_unfinished_work(self):
        self.build_through("T02")
        self.put(self.work, {"notes.txt": "x"})
        out = self.refused("finish", "LOCAL-001")
        self.assertIn("Tasks not done: T03, T04, T05", out)
        self.assertIn("Uncommitted changes in the cell: notes.txt", out)
        self.assertIn("No test names these spec IDs: INV-03, FR-06", out)

    def test_test_run_byproducts_are_not_changes(self):
        junk = {"app/__pycache__/invite.cpython-312.pyc": "x", ".pytest_cache/v/cache/lastfailed": "{}", ".coverage": "x", "tests/__pycache__/t.pyc": "x"}
        (self.work / ".gitignore").unlink()
        git(self.work, "commit", "-qam", "project forgot to ignore byproducts")
        self.put(self.work, junk)
        self.assertIn("changed no files", self.refused("red", "LOCAL-001", "T01"))
        self.build_through("T05")
        self.put(self.work, junk)
        self.assertEqual(self.ok("finish", "LOCAL-001")["status"], "BUILT")
        self.assertFalse(any("pycache" in name or "coverage" in name for name in git(self.work, "ls-files").stdout.split()), "byproducts are never committed")
        self.assertTrue(build.is_byproduct("src/pkg/__pycache__/a.cpython-314.pyc") and build.is_byproduct("node_modules/x/index.js"))
        self.assertFalse(build.is_byproduct("src/coverage_report.py") or build.is_byproduct("docs/cache.md"))

    def test_finish_writes_the_report(self):
        self.build_through("T05")
        done = self.ok("finish", "LOCAL-001")
        self.assertEqual((done["status"], done["tasks"], done["tests_seen_failing_first"], done["deviations"], done["lint"]), ("BUILT", 5, 2, 0, "none configured"))
        report = json.loads((self.cellroot / "build-report.json").read_text())
        self.assertEqual(sorted(report["files_changed"]), ["README.md", "app/invite.py", "tests/test_invite.py", "tests/test_scenarios.py"])
        self.assertEqual((report["review_loop"], report["human_review_required"], report["tests"]["passed"]), (0, False, True))
        self.assertEqual(json.loads((self.cellroot / "cell.json").read_text())["stage"], "built")
        self.assertEqual(git(self.project, "log", "--format=%s").stdout.splitlines(), ["work"], "main is never committed to")
        self.assertIn("already built", self.refused("red", "LOCAL-001", "T01"))

    def test_lint_failure_blocks_and_styling_is_reported(self):
        state = self.state()
        state["lint_cmd"] = f"{sys.executable} -c 'raise SystemExit(1)'"
        (self.cellroot / "build.json").write_text(json.dumps(state))
        self.build_through("T04")
        self.put(self.work, {"README.md": "x\n", "web/Card.tsx": '<div style={{color: "red"}}>\n<p className="t" color="#3b82f6">\n<a href="#top">\n'})
        self.ok("done", "LOCAL-001", "T05", "--allow-extra", "sample interface file")
        self.assertIn("The linter reports problems", self.refused("finish", "LOCAL-001"))
        state = self.state()
        state["lint_cmd"] = "no-such-linter-xyz"
        (self.cellroot / "build.json").write_text(json.dumps(state))
        done = self.ok("finish", "LOCAL-001")
        self.assertEqual((done["lint"], done["styling_findings"], done["deviations"]), ("unverified", 2, 1))


class RevisionTest(Base):
    def test_two_revisions_then_the_third_failure_escalates(self):
        self.ready()
        self.ok("start", "LOCAL-001")
        self.assertIn("only during a revision round", self.refused("add-task", "LOCAL-001", "--kind", "impl", "--text", "x"))
        self.assertIn("starts from a built cell", self.refused("revise", "LOCAL-001"))
        self.build_through("T05")
        self.ok("finish", "LOCAL-001")
        findings = Path(self.tmp.name) / "findings.md"
        findings.write_text("1. invite() ignores the email.\n")
        for loop in (1, 2):
            revising = self.ok("revise", "LOCAL-001", "--findings", str(findings))
            self.assertEqual((revising["status"], revising["loop"], revising["round"], revising["rounds_left"]), ("REVISING", loop, loop + 1, 2 - loop))
            self.assertTrue((self.cellroot / f"review-findings-{loop}.md").is_file())
            added = self.ok("add-task", "LOCAL-001", "--kind", "docs", "--text", f"Explain round {loop} (FR-01)", "--file", "README.md")
            self.assertEqual(added["task"], f"R{loop}-T01")
            self.put(self.work, {"README.md": f"# Sample\n\nRound {loop}.\n"})
            self.ok("done", "LOCAL-001", f"R{loop}-T01")
            self.assertEqual(self.ok("finish", "LOCAL-001")["status"], "BUILT")
        self.assertIn("- [x] R2-T01 [docs] Explain round 2 (FR-01) — `README.md`", (self.cellroot / "plan.md").read_text())
        self.assertEqual(json.loads((self.cellroot / "build-report.json").read_text())["review_loop"], 2)
        code, out, _ = self.run_build("revise", "LOCAL-001")
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(out)["status"], "ESCALATE")
        self.assertEqual(json.loads((self.cellroot / "cell.json").read_text())["stage"], "blocked")


class PlanParsingTest(unittest.TestCase):
    def test_tasks_and_touch_map(self):
        tasks, touch = build.parse_plan(PLAN + "\n- [ ] T99 [impl] not a task: outside the Tasks section\n")
        self.assertEqual([(t["id"], t["kind"]) for t in tasks], [("T01", "test"), ("T02", "impl"), ("T03", "test"), ("T04", "impl"), ("T05", "docs")])
        self.assertEqual(tasks[2]["files"], ["tests/test_scenarios.py"])
        self.assertEqual(tasks[2]["ids"], ["AC-01", "AC-02", "AC-03", "FR-06", "FR-08", "FR-09", "INV-03"])
        self.assertEqual(touch["app/invite.py"], ["T02", "T04"])
        self.assertEqual(ALL_IDS.split(), sorted({i for t in tasks for i in t["ids"]}, key=ALL_IDS.split().index))


if __name__ == "__main__":
    unittest.main()
