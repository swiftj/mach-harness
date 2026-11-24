"""Tests for lanes in the build station (M22 design, piece C1): build.py builds a plan's independent parts at the same time,
each lane in its own worktree with its own state file, under the same gates, and joins them at the end.

Every scenario runs real Git in a temporary project with a small Python project and its test suite, as test_build does.
The join calls landing.py (piece C2), the real module.
"""

import importlib.util
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "skills" / "build" / "scripts"
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(ROOT / "skills" / "intent" / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))
import build  # noqa: E402
import test_build  # noqa: E402  (its fixtures: the sample project, the spec and the plan)
from test_build import IMPL, IMPL2, PLAN, RED_TEST, SCENARIO_TEST, git  # noqa: E402

# build.py as it was before lanes were added to it (blob of skills/build/scripts/build.py at the lane calculator's merge).
BEFORE_LANES_BLOB = "67f37ddd1ce0378d7094f624ce38d2bab3daf3df"


def build_before_lanes():
    """The build station from before this change, loaded from the repository's history; None where the history is not here."""
    done = subprocess.run(["git", "cat-file", "-p", BEFORE_LANES_BLOB], cwd=str(ROOT), capture_output=True, text=True)
    if done.returncode != 0:
        return None
    folder = Path(tempfile.mkdtemp(prefix="mach-build-before-"))
    path = folder / "build_before_lanes.py"
    path.write_text(done.stdout, encoding="utf-8")
    previous = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        spec = importlib.util.spec_from_file_location("mach_build_before_lanes", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = previous
    return module


TIME_RE = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?")
HEX_RE = re.compile(r"\b[0-9a-f]{7,40}\b")
RAN_RE = re.compile(r"\bin \d+\.\d+s\b")


def mask(value, project):
    """A recorded value with what differs between two identical builds made a moment apart masked: the project's folder,
    clock times, durations and commit IDs. Nothing else."""
    if isinstance(value, dict):
        return {key: ("<seconds>" if "seconds" in key and isinstance(item, (int, float)) else mask(item, project))
                for key, item in value.items()}
    if isinstance(value, list):
        return [mask(item, project) for item in value]
    if isinstance(value, str):
        text = value.replace(str(project), "<P>")
        text = TIME_RE.sub("<T>", text)
        text = RAN_RE.sub("in <S>s", text)
        return HEX_RE.sub("<H>", text)
    return value


class SequentialAsBeforeTest(test_build.Base):
    """Design 15, scenario 12, with the owner's decision: a plan written without the parts or `after` marks is built exactly as
    before, whatever build.max_lanes says. The fixture plan would split into two lanes by the lane rule (T05 touches only the
    README), so it is the plan that decides, not the rule."""

    module = build

    def run_build(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = self.module.main(["--project", str(self.project), *argv])
        return code, out.getvalue(), err.getvalue()

    def script(self, setting):
        """A whole build through the station: start, every task (with refusals on the way), finish, one revision round and its
        finish. Returns everything it printed and recorded, masked."""
        if setting is not None:
            self.put(self.project, {".factory/config.json": json.dumps({"build": {"max_lanes": setting}})})
        self.ready()
        outputs = []

        def call(*argv):
            code, out, err = self.run_build(*argv)
            try:
                printed = json.loads(out)
            except ValueError:
                printed = out
            outputs.append([code, printed, err])

        call("start", "LOCAL-001")
        call("next", "LOCAL-001")
        call("red", "LOCAL-001", "T01")
        call("green", "LOCAL-001", "T02")
        steps = [("T01", "red", {"tests/test_invite.py": RED_TEST}), ("T02", "green", {"app/invite.py": IMPL}),
                 ("T03", "red", {"tests/test_scenarios.py": SCENARIO_TEST}), ("T04", "green", {"app/invite.py": IMPL2}),
                 ("T05", "done", {"README.md": "# Sample\n\nAdmins can invite teammates.\n"})]
        for task, step, files in steps:
            self.put(self.work, files)
            call(step, "LOCAL-001", task)
            call("next", "LOCAL-001")
        call("status", "LOCAL-001")
        call("finish", "LOCAL-001")
        report = json.loads((self.cellroot / "build-report.json").read_text())
        findings = Path(self.tmp.name) / "findings.md"
        findings.write_text("1. The README does not say who may invite.\n")
        call("revise", "LOCAL-001", "--findings", str(findings))
        call("add-task", "LOCAL-001", "--kind", "docs", "--text", "Say who may invite (FR-01)", "--file", "README.md")
        self.put(self.work, {"README.md": "# Sample\n\nAdmins can invite teammates.\n"})
        call("done", "LOCAL-001", "R1-T01")
        self.put(self.work, {"README.md": "# Sample\n\nOnly admins can invite teammates.\n"})
        call("done", "LOCAL-001", "R1-T01")
        call("finish", "LOCAL-001")
        lifecycle = [{"type": r["type"], "data": r["data"]} for r in
                     (json.loads(line) for line in (self.cellroot / "lifecycle.jsonl").read_text().splitlines())]
        recorded = {
            "outputs": outputs, "first_report": report,
            "build.json": json.loads((self.cellroot / "build.json").read_text()),
            "build-report.json": json.loads((self.cellroot / "build-report.json").read_text()),
            "cell.json": json.loads((self.cellroot / "cell.json").read_text()),
            "plan.md": (self.cellroot / "plan.md").read_text(), "lifecycle": lifecycle,
            "cell files": sorted(p.name for p in self.cellroot.iterdir()),
        }
        history = git(self.work, "log", "--format=%T %s").stdout  # trees are content only, so they are compared unmasked
        return mask(recorded, self.project), history

    def recorded_before(self):
        cached = getattr(type(self), "_recorded", None)
        if cached is not None:
            return cached
        old = build_before_lanes()
        if old is None:
            self.skipTest("the build station from before lanes is not in this repository's history")
        self.module = old
        try:
            result = self.script(None)
        finally:
            self.module = build
        type(self)._recorded = result
        return result

    def check_same(self, setting):
        fresh = getattr(type(self), "_recorded", None) is None
        before = self.recorded_before()
        if fresh:  # the build before used this test's project: start again from a new one at the same path
            self.tmp.cleanup()
            Path(self.tmp.name).mkdir()
            test_build.class_template.step(self, "project", self.project.parent, self.sample_project)
        after = self.script(setting)
        self.maxDiff = None
        self.assertEqual(after[1], before[1], "the same commits, with the same trees and messages")
        self.assertEqual(after[0]["outputs"], before[0]["outputs"], "every command prints the same")
        for name in ("build.json", "build-report.json", "first_report", "cell.json", "plan.md", "lifecycle", "cell files"):
            self.assertEqual(after[0][name], before[0][name], name)
        self.assertFalse((self.cellroot / "lanes").exists(), "no lane is ever made")

    def test_with_no_setting(self):
        self.check_same(None)

    def test_at_one(self):
        self.check_same(1)

    def test_at_three(self):
        self.check_same(3)

    def test_at_an_unusable_setting(self):
        self.check_same("four")


def landing():
    return build.sibling("landing")


# ---------------------------------------------------------------- a plan with two lanes

HOLDER = "a" * 32
OTHER = "b" * 32
TICKET = "LOCAL-001"

# Written in two pieces on purpose: test_cell_lanes holds that no single string in the suite is a plan using the additions.
LANE_PLAN_HEAD = """# Plan: SLICE-001: Invite a teammate by email

- **App type:** library
- **Risk tier:** Medium
- **Contracts:** None. This sample changes no boundary.
- **ADRs:** None.

## Contracts

- None.

## Tasks

"""
LANE_PLAN = LANE_PLAN_HEAD + """### Lanes
- [ ] T01 [test] Table-driven test of rules R1 to R5 — `tests/test_invite.py` (FR-01, FR-02, FR-03, FR-04, FR-05, FR-07, INV-01, INV-02, INV-04)
- [ ] T02 [impl] Invitation service — `app/invite.py` (FR-01, FR-02)
- [ ] T03 [test] Scenarios — `tests/test_release.py` (AC-01, AC-02, AC-03, FR-06, FR-08, FR-09, INV-03)
- [ ] T04 [impl] Release — `app/release.py` (FR-06, FR-08)

### After the lanes
- [ ] T05 [docs] Describe invitations in the README — `README.md` (FR-01)

## File touch map

| File | Change | Tasks |
|------|--------|-------|
| `tests/test_invite.py` | create | T01 |
| `app/invite.py` | create | T02 |
| `tests/test_release.py` | create | T03 |
| `app/release.py` | create | T04 |
| `README.md` | modify | T05 |

## Engineering decisions

- None.
"""

THREE_LANES = LANE_PLAN.replace("\n### After the lanes\n", "\n")
RELEASE_TEST = ("import unittest\nfrom app.release import release\n\n# AC-01 AC-02 AC-03 FR-06 FR-08 FR-09 INV-03\nclass S(unittest.TestCase):\n"
                "    def test_release(self):\n        self.assertEqual(release(), 'released')\n")
RELEASE = "def release():\n    return 'released'\n"
README = "# Sample\n\nAdmins can invite teammates.\n"
L1 = [("T01", "red", {"tests/test_invite.py": RED_TEST}), ("T02", "green", {"app/invite.py": IMPL})]
L2 = [("T03", "red", {"tests/test_release.py": RELEASE_TEST}), ("T04", "green", {"app/release.py": RELEASE})]


class LaneBase(test_build.Base):
    settings = None  # .factory/config.json, when a class needs one

    def sample_project(self):
        """The sample project, with Claude Code's configuration committed: a lane's worktree must leave it out."""
        self.project.mkdir()
        self.put(self.project, {".claude/settings.json": "{}\n", ".mcp.json": "{}\n", ".gitignore": ".factory/\n__pycache__/\n", "README.md": "# Sample\n", "app/__init__.py": "",
                                "tests/test_base.py": "import unittest\n\nclass B(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n",
                                **test_build.adr_baseline_fixture.files()})
        git(self.project, "init", "-q", "-b", "main")
        for key, value in (("user.name", "t"), ("user.email", "t@example.com"), ("commit.gpgsign", "false")):
            git(self.project, "config", key, value)
        self.commit_main()

    def ready_lanes(self, plan=LANE_PLAN, settings=None):
        config = settings if settings is not None else self.settings
        if config is not None:
            self.put(self.project, {".factory/config.json": json.dumps(config)})
        self.ready(plan=plan)

    def lane_work(self, name):
        return self.cellroot / "lanes" / name / "repo"

    def lane_state(self, name):
        return json.loads((self.cellroot / "lanes" / name / "lane.json").read_text())

    def open_lanes(self, holder=HOLDER, *extra):
        return self.ok("lanes-open", TICKET, "--holder", holder, *extra)

    def build_lane(self, name, steps):
        for task, step, files in steps:
            self.put(self.lane_work(name), files)
            self.ok(step, TICKET, task)

    def lifecycle(self):
        return [json.loads(line) for line in (self.cellroot / "lifecycle.jsonl").read_text().splitlines()]

    def through_lanes(self):
        """Start, open both lanes, build each, and join."""
        self.ready_lanes()
        self.ok("start", TICKET)
        self.open_lanes()
        self.build_lane("L1", L1)
        self.build_lane("L2", L2)
        return self.ok("join", TICKET)

    def branches(self):
        return [line.strip("* ").strip() for line in git(self.project, "branch", "--list", "mach-lane/*").stdout.splitlines() if line.strip()]

    def worktrees(self):
        return [line for line in git(self.project, "worktree", "list", "--porcelain").stdout.splitlines() if line.startswith("worktree ") and "/lanes/" in line]


class TwoLanesTest(LaneBase):
    """Design 15, scenario 1: two independent lanes and a task after them."""

    def test_a_build_in_two_lanes(self):
        self.ready_lanes()
        started = self.ok("start", TICKET)
        self.assertEqual(started["lanes"]["count"], 2)
        self.assertEqual([lane["tasks"] for lane in started["lanes"]["lanes"]], [["T01", "T02"], ["T03", "T04"]])
        self.assertEqual(self.state()["lanes"]["state"], "planned")
        self.assertEqual(self.ok("next", TICKET), {"status": "LANES", "lanes": ["L1", "L2"], "next": build.LANES_NEXT})
        self.put(self.work, {"tests/test_invite.py": RED_TEST})
        self.assertIn("is built in lane L1, and the lanes are not open yet", self.refused("red", TICKET, "T01"))
        (self.work / "tests/test_invite.py").unlink()

        opened = self.open_lanes()
        self.assertEqual(opened["status"], "OPEN")
        self.assertEqual([(lane["lane"], lane["tasks"], lane["agent_type"], lane["model"]) for lane in opened["lanes"]],
                         [("L1", ["T01", "T02"], "mach:builder", "sonnet"), ("L2", ["T03", "T04"], "mach:builder", "sonnet")])
        self.assertIn("Build lane L2 of MACH ticket LOCAL-001.", opened["lanes"][1]["prompt"])
        self.assertIn("next LOCAL-001 --lane L2", opened["lanes"][1]["prompt"])
        for name in ("L1", "L2"):
            work = self.lane_work(name)
            self.assertEqual(opened["lanes"][int(name[1]) - 1]["workdir"], str(work))
            self.assertTrue(build.workspace.is_sparse(work))
            self.assertFalse((work / ".claude").exists() or (work / ".mcp.json").exists(), "a lane never holds Claude Code's configuration")
            self.assertEqual(git(work, "symbolic-ref", "--short", "HEAD").stdout.strip(), f"mach-lane/LOCAL-001/{name}")
            self.assertEqual(git(work, "rev-parse", "HEAD").stdout.strip(), self.state()["lanes"]["fork"])

        self.assertIn("The lanes of LOCAL-001 are open", self.refused("next", TICKET))
        self.assertIn("The lanes of LOCAL-001 are open", self.refused("done", TICKET, "T05"))
        shared = {name: (self.cellroot / name).read_bytes() for name in ("build.json", "plan.md", "cell.json")}

        task = self.ok("next", TICKET, "--lane", "L2")
        self.assertEqual((task["task"], task["lane"], task["workdir"], task["progress"]), ("T03", "L2", str(self.lane_work("L2")), "0 of 2 done in lane L2"))
        self.build_lane("L1", L1[:1])
        self.build_lane("L2", L2[:1])
        self.assertEqual(self.lane_state("L1")["tasks"][0]["first_run"], "fail", "seen failing in its own lane")
        self.build_lane("L1", L1[1:])
        done = self.ok("next", TICKET, "--lane", "L1")
        self.assertEqual(done, {"status": "LANE_DONE", "lane": "L1", "next": build.LANE_DONE_NEXT})
        self.assertIn("Not every lane is done (L2 still open), so the lanes cannot be joined yet.", self.refused("join", TICKET))
        self.put(self.lane_work("L2"), L2[1][2])
        finished = self.ok("green", TICKET, "T04")
        self.assertEqual(finished["next"], "Lane L2 is done. Report and stop. The line joins the lanes.")
        self.assertEqual({name: (self.cellroot / name).read_bytes() for name in shared}, shared, "no lane writes build.json, plan.md or cell.json")
        self.assertEqual(self.ok("lanes-open", TICKET, "--holder", HOLDER)["status"], "NONE_LEFT")

        joined = self.ok("join", TICKET)
        self.assertEqual((joined["status"], joined["landed"], joined["set_aside"], joined["suite"]["passed"]), ("JOINED", 4, [], True))
        self.assertEqual(self.log()[:4], [
            "feat(SLICE-001): T04 Release — app/release.py [LOCAL-001]", "test(SLICE-001): T03 Scenarios — tests/test_release.py [LOCAL-001]",
            "feat(SLICE-001): T02 Invitation service — app/invite.py [LOCAL-001]",
            "test(SLICE-001): T01 Table-driven test of rules R1 to R5 — tests/test_invite.py [LOCAL-001]"], "one commit per task, in plan order")
        self.assertEqual(git(self.work, "rev-list", "--merges", f"{self.state()['baseline']}..HEAD").stdout, "", "no merge commit")
        self.assertEqual((self.branches(), self.worktrees()), ([], []), "no lane worktree or branch is left")
        self.assertTrue((self.cellroot / "lanes/L1/lane.json").is_file(), "each lane's record is kept")
        state = self.state()
        self.assertEqual([lane["status"] for lane in state["lanes"]["lanes"]], ["joined", "joined"])
        self.assertEqual(state["test_files"], ["tests/test_invite.py", "tests/test_release.py"])
        for task in state["tasks"][:4]:
            self.assertEqual(task["status"], "done")
            self.assertNotEqual(task["commit"], task["lane_commit"])
            self.assertEqual(task["ran_on"], task["lane_commit"])
        self.assertIn("- [x] T04 [impl]", (self.cellroot / "plan.md").read_text())
        self.assertIn("- [ ] T05 [docs]", (self.cellroot / "plan.md").read_text())

        self.assertEqual(self.ok("next", TICKET)["task"], "T05")
        self.assertIn("has been joined", self.refused("next", TICKET, "--lane", "L1"))
        self.put(self.work, {"README.md": README})
        self.ok("done", TICKET, "T05")
        self.ok("finish", TICKET)
        report = json.loads((self.cellroot / "build-report.json").read_text())
        self.assertEqual(sorted(report["files_changed"]), ["README.md", "app/invite.py", "app/release.py", "tests/test_invite.py", "tests/test_release.py"])
        self.assertEqual([(t["id"], t.get("lane")) for t in report["tasks"]], [("T01", "L1"), ("T02", "L1"), ("T03", "L2"), ("T04", "L2"), ("T05", None)])
        self.assertEqual(report["tests"]["reused_from"], "T05")
        lanes = report["lanes"]
        self.assertEqual((lanes["state"], lanes["setting"], lanes["fork"]), ("joined", 3, state["lanes"]["fork"]))
        self.assertEqual([(r["task"], r["lane"]) for r in lanes["reds"]], [("T01", "L1"), ("T03", "L2")])
        self.assertEqual([item["task"] for item in lanes["join"]["landed"]], ["T01", "T02", "T03", "T04"])
        self.assertTrue(lanes["join"]["suite"]["passed"])
        timing = report["timing"]
        self.assertEqual([(s["task"], s.get("lane")) for s in timing["steps"]], [("T01", "L1"), ("T02", "L1"), ("T03", "L2"), ("T04", "L2"), ("T05", None)])
        self.assertTrue(all(isinstance(s["seconds_since_previous_step"], (int, float)) for s in timing["steps"]))
        self.assertTrue(isinstance(timing["lanes"]["wall_seconds"], (int, float)) and isinstance(timing["lanes"]["summed_lane_seconds"], (int, float)))
        self.assertIn("not what a build one task at a time would have taken", timing["lanes"]["note"])
        self.assertEqual(timing["whole_suite_runs"], 5, "baseline, two code tasks, the join, the docs task")

        records = self.lifecycle()
        completed = [(r["data"]["task"], r["data"].get("lane")) for r in records if r["type"] == "build.task_completed"]
        self.assertEqual(sorted(completed), [("T01", "L1"), ("T02", "L1"), ("T03", "L2"), ("T04", "L2"), ("T05", None)])
        lane_commits = {r["data"]["task"]: r["data"]["commit"] for r in records if r["type"] == "build.task_completed" and r["data"].get("lane")}
        self.assertEqual(lane_commits["T02"], state["tasks"][1]["lane_commit"][:12], "the commit made at that moment: the lane commit")
        gates = [(r["data"]["gate"], r["data"]["outcome"], r["data"]["reason_code"]) for r in records if r["type"] == "gate.evaluated"
                 and r["data"]["gate"] in ("build.lanes-open", "build.join")]
        self.assertEqual(gates, [("build.lanes-open", "pass", None), ("build.join", "refuse", "lanes-not-done"), ("build.join", "pass", "join-started"),
                                 ("build.join", "pass", None)], "the join's start is said when it really starts, never for a join refused at the door")
        self.assertEqual(state["lanes"]["join_started_at"], state["lanes"]["join"]["started_at"])
        self.assertNotIn("join_running", state["lanes"], "gone once the join has its result")
        self.assertEqual({r["type"] for r in records}, {"gate.evaluated", "station.entered", "station.exited", "build.task_completed"})

    def test_a_finish_straight_after_the_join_reuses_its_run_and_nothing_else(self):
        self.ready_lanes(plan=LANE_PLAN.replace("\n### After the lanes\n- [ ] T05 [docs] Describe invitations in the README — `README.md` (FR-01)\n", "\n")
                         .replace("| `README.md` | modify | T05 |\n", ""))
        self.ok("start", TICKET)
        self.open_lanes()
        self.build_lane("L1", L1)
        self.build_lane("L2", L2)
        self.ok("join", TICKET)
        self.ok("finish", TICKET)
        report = json.loads((self.cellroot / "build-report.json").read_text())
        self.assertEqual(report["tests"]["reused_from"], "join", "T04 ran on its lane's tree; only the join ran on the tip")
        self.assertEqual(report["timing"]["final_run_reused_from"], "join")


class ConcurrentLanesTest(LaneBase):
    """Two lanes' builders at work at once, from two processes: neither can lose the other's writes."""

    def run_at_once(self, *commands):
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.com",
                   GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.com")
        barrier = threading.Barrier(len(commands))
        results = [None] * len(commands)

        def one(index, argv):
            barrier.wait()
            results[index] = subprocess.run([sys.executable, str(SCRIPTS / "build.py"), "--project", str(self.project), *argv],
                                            capture_output=True, text=True, env=env)

        threads = [threading.Thread(target=one, args=(index, argv)) for index, argv in enumerate(commands)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        return results

    def test_two_lanes_interleaved_keep_both_lanes_work(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.open_lanes()
        shared = {name: (self.cellroot / name).read_bytes() for name in ("build.json", "plan.md", "cell.json")}
        for (first, second) in zip(L1, L2):
            self.put(self.lane_work("L1"), first[2])
            self.put(self.lane_work("L2"), second[2])
            results = self.run_at_once((first[1], TICKET, first[0]), ("next", TICKET, "--lane", "L1"),
                                       (second[1], TICKET, second[0]), ("next", TICKET, "--lane", "L2"))
            for done in results:
                self.assertEqual(done.returncode, 0, done.stderr + done.stdout)
        for name, tasks in (("L1", ["T01", "T02"]), ("L2", ["T03", "T04"])):
            state = self.lane_state(name)
            self.assertEqual([(t["id"], t["status"]) for t in state["tasks"]], [(task, "done") for task in tasks])
            self.assertEqual(state["status"], "done")
            self.assertEqual(int(git(self.lane_work(name), "rev-list", "--count", f"{state['fork']}..HEAD").stdout), 2)
        self.assertEqual({name: (self.cellroot / name).read_bytes() for name in shared}, shared)
        records = self.lifecycle()
        self.assertEqual(sorted(r["data"]["task"] for r in records if r["type"] == "build.task_completed"), ["T01", "T02", "T03", "T04"])
        self.assertEqual(self.ok("join", TICKET)["landed"], 4)

    def test_two_drivers_opening_at_once_never_share_a_lane(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        results = self.run_at_once(("lanes-open", TICKET, "--holder", HOLDER), ("lanes-open", TICKET, "--holder", OTHER))
        codes = sorted(done.returncode for done in results)
        self.assertEqual(codes, [0, 1])
        refused = next(done for done in results if done.returncode == 1)
        self.assertIn("is being built by another holder", refused.stderr)
        self.assertEqual(len(self.worktrees()), 2)


class LaneGatesTest(LaneBase):
    def setUp(self):
        super().setUp()
        self.ready_lanes()
        self.ok("start", TICKET)
        self.open_lanes()

    def test_allow_extra_or_amend_test_never_reach_another_lanes_file(self):
        """Design 15, scenario 3; and a lane cannot change a test another lane owns."""
        self.put(self.lane_work("L2"), {"tests/test_release.py": RELEASE_TEST, "app/invite.py": IMPL})
        refusal = self.refused("red", TICKET, "T03", "--allow-extra", "needed")
        self.assertIn("is in lane L2 but changes files the plan gives another lane: app/invite.py", refusal)
        self.assertIn("no override allows it", refusal)
        (self.lane_work("L2") / "app/invite.py").unlink()
        self.build_lane("L2", L2[:1])
        self.put(self.lane_work("L2"), {"app/release.py": RELEASE, "tests/test_invite.py": RED_TEST})
        self.assertIn("gives another lane: tests/test_invite.py", self.refused("green", TICKET, "T04", "--amend-test", "x", "--allow-extra", "y"))
        codes = [r["data"]["reason_code"] for r in self.lifecycle() if r["type"] == "gate.evaluated" and r["data"]["outcome"] == "refuse"]
        self.assertEqual(codes[-2:], ["lane-scope", "lane-scope"])
        self.assertEqual(self.lane_state("L2")["deviations"], [], "nothing is recorded as an override")

    def test_frozen_tests_and_scope_hold_inside_a_lane(self):
        self.build_lane("L1", L1[:1])
        self.put(self.lane_work("L1"), {"app/invite.py": IMPL, "tests/test_invite.py": RED_TEST + "\n# edited\n"})
        self.assertIn("changes tests that are already committed: tests/test_invite.py", self.refused("green", TICKET, "T02"))
        self.put(self.lane_work("L1"), {"tests/test_invite.py": RED_TEST, "app/other.py": "X = 1\n"})
        self.assertIn("files the plan did not give it: app/other.py", self.refused("green", TICKET, "T02"))
        (self.lane_work("L1") / "app/other.py").unlink()
        self.put(self.lane_work("L1"), {"app/invite.py": "def invite(email):\n    return 'nope'\n"})
        self.assertIn("does not pass yet", self.refused("green", TICKET, "T02"))
        self.put(self.lane_work("L1"), {"app/invite.py": IMPL + "AWS = 'AKIA" + "ABCDEFGHIJKLMNOP'\n"})
        self.assertIn("looks like it holds a secret", self.refused("green", TICKET, "T02"))
        self.assertIn("T01 is already done", self.refused("red", TICKET, "T01"))
        self.assertIn("The next task is T03 [test], not T04", self.refused("green", TICKET, "T04"), "each lane keeps its own order")

    def test_a_lane_test_must_fail_before_its_code(self):
        self.put(self.lane_work("L2"), {"tests/test_release.py": RELEASE_TEST, "app/release.py": RELEASE})
        self.assertIn("files the plan did not give it", self.refused("red", TICKET, "T03"))
        self.put(self.lane_work("L2"), {"tests/test_release.py": "import unittest\n\n# AC-01 AC-02 AC-03 FR-06 FR-08 FR-09 INV-03\nclass S(unittest.TestCase):\n"
                                                                 "    def test_nothing(self):\n        pass\n"})
        (self.lane_work("L2") / "app/release.py").unlink()
        self.assertIn("never seen failing", self.refused("red", TICKET, "T03"))
        self.assertEqual(self.lane_state("L2")["tasks"][0]["status"], "pending")

    def test_add_task_is_never_in_a_lane(self):
        self.assertIn("only during a revision round", self.refused("add-task", TICKET, "--kind", "impl", "--text", "x"))


class SharedFileTest(LaneBase):
    """Design 15, scenario 2: two lanes that secretly share a file the plan gives neither."""

    def test_the_later_lane_is_set_aside_and_built_again_in_the_cell(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.open_lanes()
        util = {"app/util.py": "def tidy(x):\n    return x\n"}
        self.build_lane("L1", L1[:1])
        self.put(self.lane_work("L1"), {"app/invite.py": IMPL, **util})
        self.assertIn("files the plan did not give it: app/util.py", self.refused("green", TICKET, "T02"))
        self.ok("green", TICKET, "T02", "--allow-extra", "a helper both lanes need")
        self.build_lane("L2", L2[:1])
        self.put(self.lane_work("L2"), {"app/release.py": RELEASE, "app/util.py": "def tidy(x):\n    return x.strip()\n"})
        self.ok("green", TICKET, "T04", "--allow-extra", "a helper")
        joined = self.ok("join", TICKET)
        self.assertEqual(joined["status"], "JOINED")
        self.assertEqual(joined["landed"], 2)
        self.assertEqual(joined["set_aside"], [{"lane": "L2", "tasks": ["T03", "T04"], "because": [{"other": "L1", "file": "app/util.py", "why": "same-file"}]}])
        state = self.state()
        self.assertEqual([(t["id"], t["status"]) for t in state["tasks"]], [("T01", "done"), ("T02", "done"), ("T03", "pending"), ("T04", "pending"), ("T05", "pending")])
        self.assertEqual([lane["status"] for lane in state["lanes"]["lanes"]], ["joined", "set-aside"])
        aside = [d for d in state["deviations"] if d["type"] == "lane-set-aside"]
        self.assertEqual((aside[0]["lane"], aside[0]["because"]), ("L2", [{"other": "L1", "file": "app/util.py", "why": "same-file"}]))
        self.assertEqual([d["type"] for d in state["deviations"]], ["files-outside-plan", "lane-set-aside"], "the landed lane's override is copied in; the set-aside lane's is not")
        self.assertEqual(state["deviations"][0]["lane"], "L1")
        self.assertEqual((self.branches(), self.worktrees()), ([], []))
        self.assertEqual(self.ok("next", TICKET)["task"], "T03", "the set-aside tasks are done in the cell, in plan order")
        self.assertEqual((self.work / "app/util.py").read_text(), util["app/util.py"], "where the first lane's work is committed")
        self.put(self.work, {"tests/test_release.py": RELEASE_TEST})
        self.ok("red", TICKET, "T03")
        self.put(self.work, {"app/release.py": RELEASE})
        self.ok("green", TICKET, "T04")
        self.put(self.work, {"README.md": README})
        self.ok("done", TICKET, "T05")
        self.ok("finish", TICKET)
        report = json.loads((self.cellroot / "build-report.json").read_text())
        self.assertEqual(report["lanes"]["join"]["set_aside"][0]["lane"], "L2")
        self.assertIn("lane-set-aside", [d["type"] for d in report["deviations"]])
        steps = {s["task"]: s.get("lane") for s in report["timing"]["steps"]}
        self.assertEqual(steps, {"T01": "L1", "T02": "L1", "T03": None, "T04": None, "T05": None})
        events = [(r["data"]["gate"], r["data"]["reason_code"], r["data"].get("lane")) for r in self.lifecycle() if r["type"] == "gate.evaluated"
                  and r["data"]["gate"] == "build.join"]
        self.assertEqual(events, [("build.join", "join-started", None), ("build.join", "lane-set-aside", "L2"), ("build.join", None, None)])


class FrozenAcrossLanesTest(LaneBase):
    """Design 15, scenario 4: a lane writes a test file another lane committed (both through --allow-extra)."""

    def test_the_later_lane_is_set_aside_and_the_file_is_frozen_in_the_cell(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.open_lanes()
        helper = "tests/test_helpers_extra.py"
        self.put(self.lane_work("L1"), {"tests/test_invite.py": RED_TEST, helper: "import unittest\n"})
        self.ok("red", TICKET, "T01", "--allow-extra", "a shared helper")
        self.build_lane("L1", L1[1:])
        self.put(self.lane_work("L2"), {"tests/test_release.py": RELEASE_TEST, helper: "import unittest\nX = 2\n"})
        self.ok("red", TICKET, "T03", "--allow-extra", "a helper")
        self.build_lane("L2", L2[1:])
        joined = self.ok("join", TICKET)
        self.assertEqual([(item["lane"], [(b["file"], b["why"]) for b in item["because"]]) for item in joined["set_aside"]],
                         [("L2", [(helper, "frozen-test")])])
        self.assertIn(helper, self.state()["test_files"])
        self.put(self.work, {"tests/test_release.py": RELEASE_TEST})
        self.ok("red", TICKET, "T03")
        self.put(self.work, {"app/release.py": RELEASE, helper: "import unittest\nX = 2\n"})
        self.assertIn(f"changes tests that are already committed: {helper}", self.refused("green", TICKET, "T04", "--allow-extra", "x"))


class InteractionTest(LaneBase):
    """Design 15, scenario 7: each lane passes, the joined result does not."""

    def test_a_fix_task_is_added_and_tests_stay_frozen(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.open_lanes()
        noisy = "import os\nos.environ['MACH_MODE'] = 'invite'\n\n" + IMPL
        self.build_lane("L1", [L1[0], ("T02", "green", {"app/invite.py": noisy})])
        self.build_lane("L2", [L2[0], ("T04", "green", {"app/release.py": "import os\n\ndef release():\n    return os.environ.get('MACH_MODE', 'released')\n"})])
        joined = self.ok("join", TICKET)
        self.assertEqual((joined["status"], joined["suite"]["passed"]), ("INTERACTION", False))
        self.assertEqual(joined["interaction"]["task"], "J-T01")
        self.assertIn("test_release.S.test_release", joined["interaction"]["failing"])
        named = [item["lane"] for item in joined["interaction"]["lanes_named"]]
        recorded = [d for d in self.state()["deviations"] if d["type"] == "lanes-interaction"][0]
        self.assertEqual(recorded["lanes"], named or ["L1", "L2"], "where the output names no lane's file, every lane is involved")
        self.assertEqual(recorded["failing"], joined["interaction"]["failing"])
        state = self.state()
        self.assertEqual(state["suite"], "red")
        self.assertEqual([t["id"] for t in state["tasks"]], ["T01", "T02", "T03", "T04", "J-T01", "T05"])
        self.assertEqual(state["tasks"][4]["files"], ["app/invite.py", "app/release.py"])
        self.assertEqual(self.log()[0], "feat(SLICE-001): T04 Release — app/release.py [LOCAL-001]", "the branch moved to the landed tip")
        self.assertIn("- [ ] J-T01 [impl] Make the lanes pass together", (self.cellroot / "plan.md").read_text())
        self.assertEqual(self.ok("next", TICKET)["task"], "J-T01")
        self.put(self.work, {"tests/test_release.py": RELEASE_TEST.replace("'released')", "'invite')")})
        self.assertIn("changes tests that are already committed", self.refused("green", TICKET, "J-T01"))
        git(self.work, "checkout", "-q", "--", "tests/test_release.py")
        self.put(self.work, {"app/invite.py": IMPL})
        self.ok("green", TICKET, "J-T01")
        self.put(self.work, {"README.md": README})
        self.ok("done", TICKET, "T05")
        self.ok("finish", TICKET)
        report = json.loads((self.cellroot / "build-report.json").read_text())
        interaction = [d for d in report["deviations"] if d["type"] == "lanes-interaction"]
        self.assertEqual(interaction[0]["task"], "J-T01")
        self.assertTrue(self.log()[1].startswith("feat(SLICE-001): J-T01 Make the lanes pass together"))
        gates = [(r["data"]["gate"], r["data"]["outcome"], r["data"]["reason_code"]) for r in self.lifecycle() if r["type"] == "gate.evaluated"
                 and r["data"]["gate"] == "build.join"]
        self.assertEqual(gates, [("build.join", "pass", "join-started"), ("build.join", "refuse", "lanes-interaction")])


NEW_CMD = test_build.NEW_CMD


class HandBackTest(LaneBase):
    """A lane that cannot finish is not a dead end: its finished tasks land, the rest are built in the cell after the join."""

    def test_a_lane_needing_another_lanes_file_hands_its_tasks_back_and_nothing_is_lost(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.open_lanes()
        self.build_lane("L1", L1)
        self.build_lane("L2", L2[:1])
        self.put(self.lane_work("L2"), {"app/release.py": RELEASE, "app/invite.py": IMPL})
        refusal = self.refused("green", TICKET, "T04")
        self.assertIn('build.py hand-back LOCAL-001 --lane L2 --reason "<which file, and why>"', refusal)
        self.assertIn("This lane's committed work is kept and lands at the join", refusal)
        for name in ("app/release.py", "app/invite.py"):
            (self.lane_work("L2") / name).unlink()
        self.assertIn("--reason is required", self.refused("hand-back", TICKET, "--lane", "L2", "--reason", " "))
        handed = self.ok("hand-back", TICKET, "--lane", "L2", "--reason", "T04 needs app/invite.py, which L1 owns", "--holder", HOLDER)
        self.assertEqual((handed["status"], handed["finished"], handed["handed_back"]), ("HANDED_BACK", ["T03"], ["T04"]))
        self.assertIn("build.py join LOCAL-001", handed["next"])
        self.assertIn("already handed back", self.refused("hand-back", TICKET, "--lane", "L2", "--reason", "again"))
        self.assertIn("was handed back to the cell (T04 needs app/invite.py, which L1 owns)", self.refused("next", TICKET, "--lane", "L2"))
        self.put(self.lane_work("L2"), {"app/release.py": RELEASE})
        self.assertIn("was handed back", self.refused("green", TICKET, "T04"))
        (self.lane_work("L2") / "app/release.py").unlink()
        self.assertEqual(self.ok("lanes", TICKET)["next"], "build.py join LOCAL-001")
        self.assertEqual(self.ok("lanes-open", TICKET, "--holder", HOLDER)["status"], "NONE_LEFT", "a handed-back lane is never handed out again")

        joined = self.ok("join", TICKET)
        self.assertEqual((joined["landed"], joined["handed_back"]), (3, [{"lane": "L2", "tasks": ["T04"]}]))
        self.assertEqual(joined["status"], "INTERACTION", "T03's test waits for T04's code")
        state = self.state()
        self.assertEqual([(t["id"], t["status"], bool(t.get("handed_back"))) for t in state["tasks"]],
                         [("T01", "done", False), ("T02", "done", False), ("T03", "done", False), ("T04", "pending", True), ("J-T01", "pending", False),
                          ("T05", "pending", False)])
        self.assertEqual([lane["status"] for lane in state["lanes"]["lanes"]], ["joined", "handed-back"])
        handed_back = [d for d in state["deviations"] if d["type"] == "lane-handed-back"][0]
        self.assertEqual((handed_back["lane"], handed_back["tasks"], handed_back["finished"], handed_back["holder"]), ("L2", ["T04"], ["T03"], HOLDER))
        self.assertIn("--already-done", [d for d in state["deviations"] if d["type"] == "lanes-interaction"][0]["detail"])
        self.assertEqual((self.branches(), self.worktrees()), ([], []), "the handed-back lane's finished work landed, so nothing of it is left")
        self.assertEqual(self.ok("next", TICKET)["task"], "T04")
        self.put(self.work, {"app/release.py": RELEASE})
        self.ok("green", TICKET, "T04")
        self.assertIn("changed no files", self.refused("green", TICKET, "J-T01"))
        self.ok("green", TICKET, "J-T01", "--already-done", "T04 made the whole suite pass")
        self.put(self.work, {"README.md": README})
        self.ok("done", TICKET, "T05")
        self.assertEqual(self.ok("finish", TICKET)["status"], "BUILT")
        report = json.loads((self.cellroot / "build-report.json").read_text())
        self.assertEqual([(t["id"], t.get("lane"), t.get("handed_back")) for t in report["tasks"]][:4],
                         [("T01", "L1", False), ("T02", "L1", False), ("T03", "L2", False), ("T04", "L2", True)])
        self.assertEqual({s["task"]: s.get("lane") for s in report["timing"]["steps"]}["T04"], None, "T04 was built in the cell")
        self.assertEqual(report["lanes"]["join"]["handed_back"], {"L2": ["T04"]})
        self.assertIn(("build.hand-back", "pass", "lane-handed-back"),
                      [(r["data"]["gate"], r["data"]["outcome"], r["data"]["reason_code"]) for r in self.lifecycle() if r["type"] == "gate.evaluated"])

    def test_a_lane_with_nothing_finished_is_handed_back_whole(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.open_lanes()
        self.build_lane("L1", L1)
        self.assertIn("Lane L1 of LOCAL-001 is done", self.refused("hand-back", TICKET, "--lane", "L1", "--reason", "x"))
        handed = self.ok("hand-back", TICKET, "--lane", "L2", "--reason", "the driver could not start a builder for it")
        self.assertEqual((handed["finished"], handed["handed_back"]), ([], ["T03", "T04"]))
        joined = self.ok("join", TICKET)
        self.assertEqual((joined["status"], joined["landed"]), ("JOINED", 2))
        self.assertEqual(self.ok("next", TICKET)["task"], "T03")
        self.put(self.work, {"tests/test_release.py": RELEASE_TEST})
        self.ok("red", TICKET, "T03")
        self.put(self.work, {"app/release.py": RELEASE})
        self.ok("green", TICKET, "T04")
        self.put(self.work, {"README.md": README})
        self.ok("done", TICKET, "T05")
        self.assertEqual(self.ok("finish", TICKET)["status"], "BUILT")
        self.assertIn("already joined", self.refused("hand-back", TICKET, "--lane", "L2", "--reason", "x"))

    def test_before_the_lanes_open_the_refusal_names_the_way_to_build_in_order(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        refusal = self.refused("hand-back", TICKET, "--lane", "L2", "--reason", "x")
        self.assertIn("--grant 1", refusal)
        self.assertEqual(self.ok("lanes-open", TICKET, "--holder", HOLDER, "--grant", "1")["status"], "SEQUENTIAL")


class TakeOverTest(LaneBase):
    def test_a_lane_taken_over_refuses_its_earlier_holder_plainly(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        opened = self.open_lanes()
        self.assertIn(f"--holder {HOLDER}", opened["lanes"][0]["prompt"])
        self.assertEqual(self.ok("next", TICKET, "--lane", "L1", "--holder", HOLDER)["task"], "T01")
        self.ok("lanes-open", TICKET, "--holder", OTHER, "--take-over")
        refusal = self.refused("next", TICKET, "--lane", "L1", "--holder", HOLDER)
        self.assertIn("Lane L1 of LOCAL-001 has been taken over", refusal)
        self.assertIn("Stop and report", refusal)
        self.assertIn("build.py next LOCAL-001 --lane L1", refusal)
        self.put(self.lane_work("L1"), {"tests/test_invite.py": RED_TEST})
        self.assertIn("has been taken over", self.refused("red", TICKET, "T01", "--holder", HOLDER))
        self.assertIn("has been taken over", self.refused("hand-back", TICKET, "--lane", "L1", "--reason", "x", "--holder", HOLDER))
        self.assertEqual(self.lane_state("L1")["tasks"][0]["status"], "pending", "a refused step changes nothing")
        self.ok("red", TICKET, "T01", "--holder", OTHER)
        self.assertEqual([item["holder"] for item in self.lane_state("L1")["earlier_holders"]], [HOLDER])


class SetCommandsInLanesTest(LaneBase):
    def test_with_lanes_open_every_lane_takes_the_new_command_from_its_next_step(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.open_lanes()
        self.build_lane("L1", L1[:1])
        before = (self.cellroot / "lanes/L1/lane.json").read_bytes()
        done = self.ok("set-commands", TICKET, "--test-cmd", NEW_CMD, "--reason", "the project names its test files test_*.py")
        self.assertIn("lanes are open", done["suite"]["not_run"])
        self.assertIn("--lane <L>", done["next"])
        self.assertEqual((self.cellroot / "lanes/L1/lane.json").read_bytes(), before, "no lane's state file is written by anyone but its lane")
        self.assertEqual([d["during"] for d in self.state()["deviations"] if d["type"] == "test-command-set"], ["lanes open"])
        self.build_lane("L1", L1[1:])
        self.build_lane("L2", L2)
        for name in ("L1", "L2"):
            state = self.lane_state(name)
            self.assertEqual(state["test_cmd"], NEW_CMD)
            self.assertEqual(state["tasks"][-1]["test_run"]["command"], NEW_CMD)
        self.assertEqual(self.lane_state("L1")["tasks"][0]["test_run"].get("scope"), "new tests only", "T01 ran before the change, and keeps its record")
        joined = self.ok("join", TICKET)
        self.assertEqual((joined["status"], joined["suite"]["command"]), ("JOINED", NEW_CMD))
        self.put(self.work, {"README.md": README})
        self.ok("done", TICKET, "T05")
        self.ok("finish", TICKET)
        report = json.loads((self.cellroot / "build-report.json").read_text())
        self.assertEqual(report["tests"]["command"], NEW_CMD)
        self.assertIn("test-command-set", [d["type"] for d in report["deviations"]])

    def test_after_the_join(self):
        self.through_lanes()
        done = self.ok("set-commands", TICKET, "--test-cmd", NEW_CMD, "--reason", "the joined suite should name test files")
        self.assertEqual((done["suite"]["passed"], self.state()["suite"]), (True, "green"))
        self.assertEqual([d["during"] for d in self.state()["deviations"] if d["type"] == "test-command-set"], ["lanes joined"])
        self.put(self.work, {"README.md": README})
        self.ok("done", TICKET, "T05")
        self.ok("finish", TICKET)
        self.assertEqual(json.loads((self.cellroot / "build-report.json").read_text())["tests"]["command"], NEW_CMD)


class ResumeTest(LaneBase):
    """Design 15, scenarios 8 and 9: a builder killed mid-lane, and a join stopped part way."""

    def test_a_builder_killed_mid_lane_is_picked_up_by_its_holder_only(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.open_lanes()
        self.build_lane("L1", L1[:1])
        self.put(self.lane_work("L1"), {"app/invite.py": "def invite(email):\n"})  # half written when the builder stopped
        self.build_lane("L2", L2)
        self.assertIn("is being built by another holder", self.refused("lanes-open", TICKET, "--holder", OTHER))
        again = self.open_lanes()
        self.assertEqual([lane["lane"] for lane in again["lanes"]], ["L1"], "the done lane is not handed out again")
        task = self.ok("next", TICKET, "--lane", "L1")
        self.assertEqual(task["task"], "T02")
        self.put(self.lane_work("L1"), {"app/invite.py": IMPL})
        self.ok("green", TICKET, "T02")
        self.assertEqual(self.ok("join", TICKET)["status"], "JOINED")

    def test_another_holder_takes_a_lane_once_it_is_stale_or_on_a_persons_word(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.open_lanes()
        self.ok("next", TICKET, "--lane", "L1")
        self.assertIn("another holder",self.refused("lanes-open", TICKET, "--holder", OTHER))
        self.assertEqual([lane["lane"] for lane in self.ok("lanes-open", TICKET, "--holder", OTHER, "--take-over")["lanes"]], ["L1", "L2"])
        self.assertEqual(self.lane_state("L1")["holder"], OTHER)
        old = (datetime.now(timezone.utc) - timedelta(minutes=91)).isoformat(timespec="seconds")
        for name in ("L1", "L2"):
            path = self.cellroot / "lanes" / name / "lane.json"
            data = json.loads(path.read_text())
            data.update({"last_step_at": old, "handed_at": old})
            path.write_text(json.dumps(data))
        self.assertEqual(len(self.open_lanes()["lanes"]), 2, "stale after factory.claim_minutes (90)")

    def test_a_missing_worktree_is_made_again_on_its_committed_work(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.open_lanes()
        self.build_lane("L1", L1[:1])
        git(self.project, "worktree", "remove", "--force", str(self.lane_work("L1")))
        self.assertIn("has no worktree", self.refused("next", TICKET, "--lane", "L1"))
        self.open_lanes()
        self.assertTrue((self.lane_work("L1") / "tests/test_invite.py").is_file())
        self.assertEqual(self.ok("next", TICKET, "--lane", "L1")["task"], "T02")

    def test_a_lost_branch_is_put_back_at_the_lanes_last_commit(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.open_lanes()
        self.build_lane("L1", L1[:1])
        git(self.project, "worktree", "remove", "--force", str(self.lane_work("L1")))
        git(self.project, "branch", "-D", "mach-lane/LOCAL-001/L1")
        self.open_lanes()
        self.assertTrue((self.lane_work("L1") / "tests/test_invite.py").is_file(), "no committed work is lost")
        self.build_lane("L1", L1[1:])
        self.build_lane("L2", L2)
        self.assertEqual(self.ok("join", TICKET)["landed"], 4)

    def test_a_folder_that_is_not_the_lanes_worktree_is_left_for_a_person(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.open_lanes()
        git(self.project, "worktree", "remove", "--force", str(self.lane_work("L2")))
        self.put(self.lane_work("L2"), {"notes.txt": "mine\n"})
        self.assertIn("is not this lane's worktree", self.refused("lanes-open", TICKET, "--holder", HOLDER))
        self.assertEqual((self.lane_work("L2") / "notes.txt").read_text(), "mine\n")

    def test_a_join_stopped_before_the_branch_moved_carries_on(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.open_lanes()
        self.build_lane("L1", L1)
        self.build_lane("L2", L2)
        fork = self.state()["lanes"]["fork"]
        from unittest import mock
        with mock.patch.object(landing(), "fast_forward", side_effect=landing().LandingError("stopped", code="branch-not-moved")):
            code, out, _ = self.run_build("join", TICKET)
        self.assertEqual((code, json.loads(out)["status"], json.loads(out)["refused"]["code"]), (1, "REFUSED", "branch-not-moved"))
        self.assertIn("run build.py join LOCAL-001 again", json.loads(out)["next"])
        self.assertEqual(git(self.work, "rev-parse", "HEAD").stdout.strip(), fork, "the ticket's branch has not moved")
        self.assertEqual((self.state()["lanes"]["state"], self.state()["lanes"]["join_refusals"][0]["reason"]), ("open", "branch-not-moved"))
        joined = self.ok("join", TICKET)
        self.assertEqual((joined["status"], joined["landed"]), ("JOINED", 4))
        self.assertEqual((self.branches(), self.worktrees()), ([], []))

    def test_a_join_stopped_while_landing_starts_again_from_the_fork_point(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.open_lanes()
        self.build_lane("L1", L1)
        self.build_lane("L2", L2)
        state = self.state()
        fork = state["lanes"]["fork"]
        # What a join killed after landing two of four commits leaves: its worktree and branch, part way.
        join_repo = self.cellroot / "lanes/join/repo"
        build.workspace.create(self.project, join_repo, "mach-lane/LOCAL-001/join", start=fork)
        for sha in [t["commit"] for t in self.lane_state("L1")["tasks"]]:
            git(join_repo, "cherry-pick", sha)
        joined = self.ok("join", TICKET)
        self.assertEqual((joined["status"], joined["landed"]), ("JOINED", 4))
        self.assertEqual(int(git(self.work, "rev-list", "--count", f"{fork}..HEAD").stdout), 4)
        self.assertEqual((self.branches(), self.worktrees()), ([], []))

    def test_stray_files_in_a_lane_are_set_aside_by_the_station_and_the_join_goes_on(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.open_lanes()
        self.build_lane("L1", L1)
        self.build_lane("L2", L2)
        self.put(self.lane_work("L2"), {"app/stray.py": "X = 1\n", "app/release.py": RELEASE + "# half a thought\n"})
        joined = self.ok("join", TICKET)
        self.assertEqual((joined["status"], joined["landed"]), ("JOINED", 4))
        ref = "refs/mach/lane-files/LOCAL-001/L2/1"
        where = f'git -C "{self.work}"'
        self.assertEqual([(item["lane"], item["ref"], item["paths"], item["bring_back"]) for item in joined["files_set_aside"]],
                         [("L2", ref, ["app/release.py", "app/stray.py"], f"{where} checkout {ref} -- <path>")])
        self.assertFalse((self.work / "app/stray.py").exists(), "a lane's stray files are never part of what lands")
        self.assertEqual((self.work / "app/release.py").read_text(), RELEASE)
        self.assertEqual((self.branches(), self.worktrees()), ([], []), "the lane's worktree is removed as after any join")
        self.assertEqual(git(self.work, "show", f"{ref}:app/stray.py").stdout, "X = 1\n", "nothing is lost: the ref keeps every file")
        deviation = [d for d in self.state()["deviations"] if d["type"] == "lane-files-set-aside"]
        self.assertEqual([(d["lane"], d["ref"], d["by"]) for d in deviation], [("L2", ref, "build station")])
        self.assertIn(f"To bring one back in the cell's checkout: {where} checkout {ref} -- <path>.", deviation[0]["detail"])
        self.assertEqual(self.state()["lanes"]["join"]["files_set_aside"][0]["ref"], ref)
        # The command it names works as written.
        done = subprocess.run(["git", "-C", str(self.work), "checkout", ref, "--", "app/stray.py"], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual((self.work / "app/stray.py").read_text(), "X = 1\n")

    def test_a_join_that_never_finished_leaves_its_start_and_runs_again(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.open_lanes()
        self.build_lane("L1", L1)
        self.build_lane("L2", L2)
        from unittest import mock
        with mock.patch.object(landing(), "join_lanes", side_effect=RuntimeError("the process was stopped")):
            with self.assertRaises(RuntimeError):
                self.run_build("join", TICKET)
        lanes = self.state()["lanes"]
        self.assertEqual(lanes["state"], "open")
        self.assertEqual(lanes["join_running"]["since"], lanes["join_started_at"])
        self.assertEqual((lanes["join_running"]["pid"], lanes["join_running"]["host"]), (os.getpid(), build.platform.node()))
        started = [r for r in self.lifecycle() if r["type"] == "gate.evaluated" and r["data"]["reason_code"] == "join-started"]
        self.assertEqual(len(started), 1)
        joined = self.ok("join", TICKET)
        self.assertEqual(joined["status"], "JOINED")
        self.assertNotIn("join_running", self.state()["lanes"])
        self.assertEqual(len([r for r in self.lifecycle() if r["type"] == "gate.evaluated" and r["data"]["reason_code"] == "join-started"]), 2)

    def test_a_join_refused_at_the_door_never_says_it_started(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.open_lanes()
        self.refused("join", TICKET)
        self.assertNotIn("join_started_at", self.state()["lanes"])
        self.assertFalse([r for r in self.lifecycle() if r["type"] == "gate.evaluated" and r["data"]["reason_code"] == "join-started"])


class JoinRefusedTest(LaneBase):
    def lanes_built(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.open_lanes()
        self.build_lane("L1", L1)
        self.build_lane("L2", L2)
        return self.state()["lanes"]["fork"]

    def test_a_lane_commit_that_does_not_apply_stops_the_join(self):
        """Design 15, scenario 5."""
        fork = self.lanes_built()
        side = self.project / ".factory/side"
        git(self.project, "worktree", "add", "-q", "--detach", str(side), fork)
        self.put(side, {"README.md": "# Other\n"})
        git(side, "commit", "-qam", "base elsewhere")
        self.put(side, {"README.md": "# Other, changed\n"})
        git(side, "commit", "-qam", "change elsewhere")
        stray = git(side, "rev-parse", "HEAD").stdout.strip()
        path = self.cellroot / "lanes/L2/lane.json"
        data = json.loads(path.read_text())
        data["tasks"][1]["commit"] = stray
        path.write_text(json.dumps(data))
        code, out, _ = self.run_build("join", TICKET)
        self.assertEqual(code, 1)
        answer = json.loads(out)
        self.assertEqual(answer["status"], "REFUSED")
        self.assertIn("Nothing was landed", answer["refused"]["reason"])
        self.assertEqual(git(self.work, "rev-parse", "HEAD").stdout.strip(), fork, "the ticket's branch is unchanged")
        self.assertFalse((self.cellroot / "lanes/join/repo").exists(), "the join's worktree is removed")
        self.assertEqual(len(self.worktrees()), 2, "every lane is kept")
        self.assertEqual(self.state()["lanes"]["state"], "open")
        self.assertEqual(self.lifecycle()[-1]["data"]["reason_code"], answer["refused"]["code"])


class CapTest(LaneBase):
    """Design 7.5 and 15, scenario 11: lanes use only free places."""

    def other_building(self, ticket, lanes=0):
        folder = self.project / ".factory/worktrees" / ticket
        self.put(folder, {"cell.json": json.dumps({"ticket_id": ticket, "stage": "building"}),
                          "claim.json": json.dumps({"step": "build", "stage": "building", "holder": "c" * 32,
                                                    "at": datetime.now(timezone.utc).isoformat(timespec="seconds")})})
        for n in range(1, lanes + 1):
            self.put(folder, {f"lanes/L{n}/lane.json": json.dumps({"status": "open", "last_step_at": datetime.now(timezone.utc).isoformat(timespec="seconds")})})

    def test_with_two_other_tickets_building_the_plan_is_built_in_order(self):
        self.ready_lanes(settings={"factory": {"max_builders": 3}})
        self.other_building("OTHER-1")
        self.other_building("OTHER-2")
        self.ok("start", TICKET)
        opened = self.ok("lanes-open", TICKET, "--holder", HOLDER)
        self.assertEqual(opened["status"], "SEQUENTIAL")
        self.assertIn("other tickets use 2", opened["why"])
        self.assertFalse((self.cellroot / "lanes/L1").exists(), "no lane worktree is made")
        self.assertEqual(self.ok("next", TICKET)["task"], "T01")
        self.build_through_in_cell()
        report = json.loads((self.cellroot / "build-report.json").read_text())
        self.assertEqual(report["lanes"]["state"], "sequential")
        self.assertNotIn("lane", report["tasks"][0])
        gates = [(r["data"]["gate"], r["data"]["reason_code"]) for r in self.lifecycle() if r["type"] == "gate.evaluated" and r["data"]["gate"] == "build.lanes-open"]
        self.assertEqual(gates, [("build.lanes-open", "sequential")])

    def build_through_in_cell(self):
        for task, step, files in L1 + L2 + [("T05", "done", {"README.md": README})]:
            self.put(self.work, files)
            self.ok(step, TICKET, task)
        self.ok("finish", TICKET)

    def test_another_tickets_live_lanes_count_one_place_each(self):
        self.ready_lanes(settings={"factory": {"max_parallel": 4}})
        self.other_building("OTHER-1", lanes=3)
        self.ok("start", TICKET)
        self.assertEqual(self.ok("lanes-open", TICKET, "--holder", HOLDER)["status"], "SEQUENTIAL")

    def test_a_grant_below_two_builds_in_order(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.assertEqual(self.ok("lanes-open", TICKET, "--holder", HOLDER, "--grant", "1")["status"], "SEQUENTIAL")

    def test_three_lanes_and_a_grant_of_two_come_in_batches(self):
        self.ready_lanes(plan=THREE_LANES)
        self.ok("start", TICKET)
        first = self.ok("lanes-open", TICKET, "--holder", HOLDER, "--grant", "2")
        self.assertEqual([lane["lane"] for lane in first["lanes"]], ["L1", "L2"])
        self.assertIn("1 more after them", first["why"])
        self.assertFalse(self.lane_work("L3").exists())
        self.build_lane("L1", L1)
        self.build_lane("L2", L2)
        second = self.ok("lanes-open", TICKET, "--holder", HOLDER, "--grant", "2")
        self.assertEqual([lane["lane"] for lane in second["lanes"]], ["L3"])
        self.build_lane("L3", [("T05", "done", {"README.md": README})])
        self.assertEqual(self.ok("lanes-open", TICKET, "--holder", HOLDER)["status"], "NONE_LEFT")
        self.assertEqual(self.ok("join", TICKET)["landed"], 5)
        self.assertEqual([b["lanes"] for b in self.state()["lanes"]["batches"]], [["L1", "L2"], ["L3"]])

    def test_the_setting_caps_the_lanes(self):
        self.ready_lanes(plan=THREE_LANES, settings={"build": {"max_lanes": 2}})
        self.ok("start", TICKET)
        self.assertEqual(len(self.ok("lanes-open", TICKET, "--holder", HOLDER)["lanes"]), 2)


class NoStallTest(LaneBase):
    """No state without a way forward: a red suite where the lanes would open, and a ticket whose lanes are open while other tickets
    hold every builder's place."""

    other_building = CapTest.other_building
    build_through_in_cell = CapTest.build_through_in_cell

    def test_a_red_suite_where_the_lanes_would_open_builds_the_plan_in_order_and_records_why(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        state = self.state()
        state["suite"] = "red"
        (self.cellroot / "build.json").write_text(json.dumps(state))
        opened = self.ok("lanes-open", TICKET, "--holder", HOLDER)
        self.assertEqual(opened["status"], "SEQUENTIAL")
        self.assertIn("The cell's suite is red where the lanes would open, so no lane could start from a passing suite.", opened["why"])
        self.assertIn("the cell's builder makes the suite pass on the way: build.py next LOCAL-001 names the step", opened["why"])
        self.assertEqual(opened["recorded"], "A deviation for the reviewers, with this reason.")
        self.assertFalse((self.cellroot / "lanes/L1").exists(), "no lane worktree is made")
        state = self.state()
        self.assertEqual((state["lanes"]["state"], state["lanes"]["suite"]), ("sequential", "red"))
        self.assertEqual([(d["type"], d["detail"], d["by"]) for d in state["deviations"]], [("lanes-sequential", opened["why"], "build station")])
        self.assertEqual(self.ok("next", TICKET)["task"], "T01", "the cell's builder carries on, one task at a time")
        self.assertEqual(self.ok("lanes-open", TICKET, "--holder", HOLDER)["status"], "SEQUENTIAL", "asked again, the same answer")
        gates = [(r["data"]["gate"], r["data"]["outcome"], r["data"]["reason_code"]) for r in self.lifecycle() if r["type"] == "gate.evaluated"
                 and r["data"]["gate"] == "build.lanes-open"]
        self.assertEqual(gates, [("build.lanes-open", "refuse", "sequential")])
        self.build_through_in_cell()
        report = json.loads((self.cellroot / "build-report.json").read_text())
        self.assertIn("lanes-sequential", [d["type"] for d in report["deviations"]])

    def test_a_suite_not_known_names_the_command_that_gives_one(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        state = self.state()
        state["suite"] = "unknown"
        (self.cellroot / "build.json").write_text(json.dumps(state))
        opened = self.ok("lanes-open", TICKET, "--holder", HOLDER)
        self.assertEqual(opened["status"], "SEQUENTIAL")
        self.assertIn('build.py set-commands LOCAL-001 --test-cmd "<command>" --reason "<why>"', opened["why"])

    def test_open_lanes_keep_one_builder_when_other_tickets_hold_every_place(self):
        self.ready_lanes(plan=THREE_LANES, settings={"factory": {"max_builders": 2}})
        self.ok("start", TICKET)
        self.assertEqual([lane["lane"] for lane in self.open_lanes()["lanes"]], ["L1", "L2"])
        self.build_lane("L1", L1)
        self.build_lane("L2", L2)
        self.other_building("OTHER-1")
        self.other_building("OTHER-2")
        again = self.ok("lanes-open", TICKET, "--holder", HOLDER, "--grant", "0")
        self.assertEqual((again["status"], [lane["lane"] for lane in again["lanes"]]), ("OPEN", ["L3"]), "the ticket's own place runs a lane")
        self.assertEqual(self.state()["lanes"]["batches"][-1]["granted"], 1)

    def test_with_two_lanes_left_and_no_place_one_runs_and_the_answer_says_why(self):
        self.ready_lanes(plan=THREE_LANES, settings={"factory": {"max_builders": 1}})
        self.ok("start", TICKET)
        # The first time, one place is too few for lanes: built one task at a time. So open the lanes with room, then take the places.
        self.put(self.project, {".factory/config.json": json.dumps({"factory": {"max_builders": 3}})})
        self.assertEqual([lane["lane"] for lane in self.ok("lanes-open", TICKET, "--holder", HOLDER, "--grant", "2")["lanes"]], ["L1", "L2"])
        self.put(self.project, {".factory/config.json": json.dumps({"factory": {"max_builders": 1}})})
        self.other_building("OTHER-1")
        # L1 and L2 are this holder's own: handed again (their builders stopped), but only one place: L1 runs, and the answer says why.
        again = self.ok("lanes-open", TICKET, "--holder", HOLDER)
        self.assertEqual([lane["lane"] for lane in again["lanes"]], ["L1"])
        self.assertIn("2 more after them", again["why"])
        self.assertIn("Only 1 started because every builder's place on this machine is in use (build.max_lanes 3; factory.max_builders 1, "
                      "of which other tickets use 1): this ticket keeps its own place, so one lane runs now and the others follow as places "
                      "come free.", again["why"])

    def test_fewer_lanes_than_are_left_says_which_limit(self):
        self.ready_lanes(plan=THREE_LANES, settings={"factory": {"max_builders": 3}})
        self.other_building("OTHER-1")
        self.ok("start", TICKET)
        opened = self.ok("lanes-open", TICKET, "--holder", HOLDER)
        self.assertEqual([lane["lane"] for lane in opened["lanes"]], ["L1", "L2"])
        self.assertIn("Only 2 of the 3 started now, because of the limits in force (build.max_lanes 3; factory.max_builders 3, of which other "
                      "tickets use 1); the others follow as places come free.", opened["why"])

    def test_another_holders_builders_at_work_and_no_place_is_a_wait_with_nothing_lost(self):
        self.ready_lanes(plan=THREE_LANES, settings={"factory": {"max_builders": 2}})
        self.ok("start", TICKET)
        self.open_lanes()
        self.ok("next", TICKET, "--lane", "L1")
        self.other_building("OTHER-1")
        refusal = self.refused("lanes-open", TICKET, "--holder", OTHER)
        self.assertIn("this ticket already has builders at work: lane(s) L1", refusal)
        self.assertIn("Nothing is lost.", refusal)


class WhenLanesDoNotApplyTest(LaneBase):
    def test_the_setting_at_one_never_makes_a_lane(self):
        self.ready_lanes(settings={"build": {"max_lanes": 1}})
        started = self.ok("start", TICKET)
        self.assertNotIn("lanes", started)
        self.assertNotIn("lanes", self.state())
        self.assertEqual(self.ok("next", TICKET)["task"], "T01")
        self.assertEqual(self.ok("lanes-open", TICKET, "--holder", HOLDER)["status"], "NONE_LEFT")
        self.assertFalse((self.cellroot / "lanes").exists() and any((self.cellroot / "lanes").glob("L*")))

    def test_a_plan_with_other_sub_headings_is_built_as_before(self):
        plan = LANE_PLAN.replace("### Lanes\n", "### Backend\n").replace("### After the lanes\n", "### Docs\n")
        self.ready_lanes(plan=plan)
        self.assertNotIn("lanes", self.ok("start", TICKET))
        self.assertEqual(self.ok("next", TICKET)["task"], "T01")

    def test_a_plan_with_an_after_mark_only_is_built_in_lanes(self):
        plan = LANE_PLAN.replace("### Lanes\n", "").replace("### After the lanes\n", "").replace("(FR-01)\n", "(FR-01, after T02)\n", 1)
        self.ready_lanes(plan=plan)
        started = self.ok("start", TICKET)
        self.assertEqual([lane["tasks"] for lane in started["lanes"]["lanes"]], [["T01", "T02", "T05"], ["T03", "T04"]])
        self.open_lanes()
        self.build_lane("L1", L1 + [("T05", "done", {"README.md": README})])
        self.build_lane("L2", L2)
        self.ok("join", TICKET)
        self.assertEqual(self.log()[0], "docs(SLICE-001): T05 Describe invitations in the README — README.md [LOCAL-001]",
                         "landed last, in plan order; the after mark is not in the message")

    def test_a_revision_round_never_fans_out(self):
        self.through_lanes()
        self.put(self.work, {"README.md": README})
        self.ok("done", TICKET, "T05")
        self.ok("finish", TICKET)
        findings = Path(self.tmp.name) / "findings.md"
        findings.write_text("1. Say more.\n")
        self.ok("revise", TICKET, "--findings", str(findings))
        self.assertEqual(self.ok("lanes-open", TICKET, "--holder", HOLDER)["status"], "NONE_LEFT")
        self.ok("add-task", TICKET, "--kind", "docs", "--text", "Say more (FR-01)", "--file", "README.md")
        self.put(self.work, {"README.md": README + "More.\n"})
        self.ok("done", TICKET, "R1-T01")
        self.assertEqual(self.ok("finish", TICKET)["status"], "BUILT")
        self.assertEqual(self.worktrees(), [])

    def test_a_hardening_ticket_is_built_in_order(self):
        self.ready_lanes()
        self.put(self.project, {".factory/tickets/LOCAL-001.md": '---\nid: LOCAL-001\ntitle: "Harden"\nstate: open\nlabels: ["repo-hardening"]\n---\n'})
        self.assertNotIn("lanes", self.ok("start", TICKET))


class SettingsTest(unittest.TestCase):
    def test_the_default_is_the_plan_stages_default(self):
        import cell as cell_script
        self.assertEqual(build.DEFAULT_MAX_LANES, cell_script.DEFAULT_MAX_LANES)
        self.assertEqual(build.DEFAULT_MAX_LANES, 3)

    def test_only_a_whole_number_is_taken_as_given(self):
        for value, expected in ((1, 1), (2, 2), (8, 8), (0, 3), (-1, 3), (2.0, 3), ("2", 3), (True, 3), (None, 3)):
            self.assertEqual(build.max_lanes({"build": {"max_lanes": value}}), expected, value)
        self.assertEqual(build.max_lanes({}), 3)
        self.assertEqual(build.max_builders({}), 3)
        self.assertEqual(build.max_builders({"factory": {"max_parallel": 5}}), 5)
        self.assertEqual(build.max_builders({"factory": {"max_parallel": 5, "max_builders": 2}}), 2)

    def test_the_plan_additions_are_recognised_as_the_plan_stage_recognises_them(self):
        import cell as cell_script
        lanes_module = build.sibling("lanes")
        plans = [PLAN, LANE_PLAN, THREE_LANES, LANE_PLAN.replace("### Lanes", "###   lanes"),
                 LANE_PLAN.replace("### Lanes\n", "### Backend\n").replace("### After the lanes\n", "### Docs\n"),
                 PLAN.replace("(FR-01)\n", "(FR-01, after T02)\n"), PLAN.replace("(FR-01)\n", "(FR-01, AFTER t02)\n"),
                 PLAN.replace("## Tasks\n", "## Tasks\n\n```\n### Lanes\n```\n"), PLAN.replace("## Engineering decisions\n", "## Engineering decisions\n\n### Lanes\n")]
        for text in plans:
            sections = cell_script.markdown_sections(text)
            self.assertEqual(lanes_module.uses_additions(text), cell_script.lane_parts(sections.get("Tasks", []))["used"], text[:400])


class WorkspaceStartTest(unittest.TestCase):
    """workspace.create(start=...): a lane's worktree, made from the fork point, from the main checkout or from a worktree."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.project = Path(self.tmp.name).resolve() / "p"
        self.project.mkdir()
        git(self.project, "init", "-q", "-b", "main")
        for key, value in (("user.name", "t"), ("user.email", "t@example.com"), ("commit.gpgsign", "false")):
            git(self.project, "config", key, value)
        test_build.Base.put(self.project, {".claude/settings.json": "{}\n", ".mcp.json": "{}\n", "a.txt": "1\n", ".gitignore": ".factory/\n"})
        git(self.project, "add", "-A")
        git(self.project, "commit", "-q", "-m", "one")
        self.first = git(self.project, "rev-parse", "HEAD").stdout.strip()
        test_build.Base.put(self.project, {"a.txt": "2\n"})
        git(self.project, "commit", "-qam", "two")

    def test_a_new_branch_starts_at_the_commit_given_and_is_sparse(self):
        import workspace
        cell = self.project / ".factory/worktrees/T-1/repo"
        workspace.create(self.project, cell, "feature/T-1")
        lane = self.project / ".factory/worktrees/T-1/lanes/L1/repo"
        workspace.create(cell, lane, "mach-lane/T-1/L1", start=self.first)  # made from the cell's worktree: a worktree of a worktree
        self.assertEqual(git(lane, "rev-parse", "HEAD").stdout.strip(), self.first)
        self.assertEqual((lane / "a.txt").read_text(), "1\n")
        self.assertTrue(workspace.is_sparse(lane))
        self.assertFalse((lane / ".claude").exists() or (lane / ".mcp.json").exists())
        self.assertFalse(workspace.is_sparse(self.project), "the main checkout stays a full checkout")
        self.assertTrue((self.project / ".claude/settings.json").is_file())
        self.assertEqual(git(lane, "status", "--porcelain").stdout, "")

    def test_an_existing_branch_is_used_at_its_own_tip(self):
        import workspace
        git(self.project, "branch", "mach-lane/T-1/L1", self.first)
        lane = self.project / ".factory/worktrees/T-1/lanes/L1/repo"
        workspace.create(self.project, lane, "mach-lane/T-1/L1", start="HEAD")
        self.assertEqual(git(lane, "rev-parse", "HEAD").stdout.strip(), self.first)

    def test_a_bad_start_makes_nothing(self):
        import workspace
        lane = self.project / "lane"
        with self.assertRaises(workspace.WorkspaceError):
            workspace.create(self.project, lane, "mach-lane/T-1/L1", start="no-such-commit")
        self.assertFalse(lane.exists())
        self.assertEqual(git(self.project, "branch", "--list", "mach-lane/*").stdout, "")
        with self.assertRaises(workspace.WorkspaceError):
            workspace.create(self.project, lane, "x", start="--orphan")


if __name__ == "__main__":
    unittest.main()
