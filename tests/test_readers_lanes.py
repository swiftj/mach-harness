"""M22 piece E, the readers: the change record, the explanation and cleanup of a ticket built in lanes.

Every lanes cell here is built by the real build station with the helpers of test_build_lanes: two lanes joined, one lane
set aside, a failure only the joined result shows with its fix task, and lanes still open. A build without lanes must read
exactly as before: the change record and the explanation are compared, byte for byte, with the modules as they were before
this change, loaded from the repository's history.
"""

import importlib.util
import io
import json
import subprocess
import sys
import tarfile
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
for folder in ("merge", "cleanup", "run"):
    sys.path.insert(0, str(ROOT / "skills" / folder / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))
import change_record  # noqa: E402
import cleanup  # noqa: E402
import explain  # noqa: E402
import merge  # noqa: E402
import test_build  # noqa: E402
import test_change_record  # noqa: E402
import test_cleanup  # noqa: E402
from test_build import IMPL, RED_TEST, git  # noqa: E402
from test_build_lanes import L1, L2, README, RELEASE, RELEASE_TEST, TICKET, LaneBase  # noqa: E402
from test_cleanup import RECORD_KEYS  # noqa: E402

# The readers as they were before lanes reached them (blobs at the merge of lanes in the build station).
BEFORE = {"change_record": ("f519542a68fd5cd284eb51d539d03de02194672c", ROOT / "skills/merge/scripts/change_record.py"),
          "explain": ("eafdb76ab21bbab0eb8333bce348500dbdbbee92", ROOT / "skills/run/scripts/explain.py")}
WHY = "Product cancelled the feature on 2026-11-01."


def before(name):
    """The module as it was before this change, from the repository's history; None where the history is not here."""
    blob, real = BEFORE[name]
    done = subprocess.run(["git", "cat-file", "-p", blob], cwd=str(ROOT), capture_output=True, text=True)
    if done.returncode != 0:
        return None
    folder = Path(tempfile.mkdtemp(prefix="mach-reader-before-"))
    path = folder / f"{name}_before.py"
    path.write_text(done.stdout, encoding="utf-8")
    previous = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        spec = importlib.util.spec_from_file_location(f"mach_{name}_before", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = previous
    module.__file__ = str(real)  # it finds its sibling helpers from where it is installed
    return module


def render(module, cellroot, head="a" * 40):
    info = json.loads((cellroot / "cell.json").read_text())
    return module.render(cellroot, info, TICKET, {"approved": head, "base": head}, merge.issue_rules())


class Built(LaneBase):
    """Builds through the real station, in lanes."""

    def finished_in_two_lanes(self):
        self.through_lanes()
        self.put(self.work, {"README.md": README})
        self.ok("done", TICKET, "T05")
        self.ok("finish", TICKET)

    def finished_with_a_lane_set_aside(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.open_lanes()
        self.build_lane("L1", L1[:1])
        self.put(self.lane_work("L1"), {"app/invite.py": IMPL, "app/util.py": "def tidy(x):\n    return x\n"})
        self.ok("green", TICKET, "T02", "--allow-extra", "a helper both lanes need")
        self.build_lane("L2", L2[:1])
        self.put(self.lane_work("L2"), {"app/release.py": RELEASE, "app/util.py": "def tidy(x):\n    return x.strip()\n"})
        self.ok("green", TICKET, "T04", "--allow-extra", "a helper")
        self.ok("join", TICKET)
        self.put(self.work, {"tests/test_release.py": RELEASE_TEST})
        self.ok("red", TICKET, "T03")
        self.put(self.work, {"app/release.py": RELEASE})
        self.ok("green", TICKET, "T04")
        self.put(self.work, {"README.md": README})
        self.ok("done", TICKET, "T05")
        self.ok("finish", TICKET)

    def joined_with_an_interaction(self, finish=True):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.open_lanes()
        self.build_lane("L1", [L1[0], ("T02", "green", {"app/invite.py": "import os\nos.environ['MACH_MODE'] = 'invite'\n\n" + IMPL})])
        self.build_lane("L2", [L2[0], ("T04", "green", {"app/release.py": "import os\n\ndef release():\n    return os.environ.get('MACH_MODE', 'released')\n"})])
        self.assertEqual(self.ok("join", TICKET)["status"], "INTERACTION")
        if finish:
            self.put(self.work, {"app/invite.py": IMPL})
            self.ok("green", TICKET, "J-T01")
            self.put(self.work, {"README.md": README})
            self.ok("done", TICKET, "T05")
            self.ok("finish", TICKET)

    def report(self):
        return json.loads((self.cellroot / "build-report.json").read_text())

    def edit_report(self, change):
        report = self.report()
        change(report)
        (self.cellroot / "build-report.json").write_text(json.dumps(report))


# ---------------------------------------------------------------- the change record

class ChangeRecordTest(Built):
    def test_two_lanes_joined(self):
        self.finished_in_two_lanes()
        text = render(change_record, self.cellroot)
        report = self.report()
        lanes = report["lanes"]
        self.assertIn(f"Built in 2 lanes at the same time, each in its own worktree from commit `{lanes['fork']}`, then joined onto the ticket's "
                      f"branch, one commit per task in the plan's order, ending at commit `{lanes['join']['tip']}`.", text)
        for line in ("- Lane L1 held T01, T02.", "- Lane L2 held T03, T04.", "- After the lanes, in the cell: T05.",
                     "- The whole test suite on the joined result: passed."):
            self.assertIn(line + "\n", text)
        timing = report["timing"]
        self.assertIn(f"- Time: the lanes took {change_record.duration(timing['lanes']['wall_seconds'])} of wall time, and their own times add up to "
                      f"{change_record.duration(timing['lanes']['summed_lane_seconds'])}. The whole build took {change_record.duration(timing['elapsed_seconds'])}", text)
        self.assertIn("A summed time is not what a build one task at a time would have taken; that build was not run.", text)
        self.assertIn("Overrides the builder recorded, each with its reason:\n\n- None.", text, "no override, and nothing by the station")
        self.assertNotIn("set aside", text)
        self.assertLess(text.index("Built in 2 lanes"), text.index("Overrides the builder recorded"))
        self.assertEqual(text, render(change_record, self.cellroot), "the same files give the same record")

    def test_a_lane_set_aside(self):
        self.finished_with_a_lane_set_aside()
        text = render(change_record, self.cellroot)
        self.assertIn("- Lane L2 held T03, T04. It was set aside at the join (it and lane L1 both changed app/util.py), so its commits were not "
                      "landed; its tasks were then built again one at a time in the cell, after the join.", text)
        self.assertIn("Overrides the builder recorded, and what the build station recorded itself, each with its reason:", text)
        self.assertIn("- T02 (lane L1), files-outside-plan: app/util.py: a helper both lanes need", text)
        self.assertIn("- no task, lane-set-aside, recorded by the build station: Lane L2 was set aside:", text)

    def test_a_failure_only_the_joined_result_showed(self):
        self.joined_with_an_interaction()
        text = render(change_record, self.cellroot)
        fix = next(task for task in self.report()["tasks"] if task["id"] == "J-T01")
        self.assertIn("- The whole test suite on the joined result: failed.", text)
        self.assertIn("- The whole suite failed on the joined result: test_release.S.test_release", text)
        self.assertIn(". It held the work of lanes L1 and L2. ", text)
        self.assertIn(f"The build station added J-T01, which made them pass together, at commit `{fix['commit']}`.", text)
        self.assertNotIn("Every lane passed its own suite, but", text.split("Overrides the builder recorded")[0],
                         "the record's own words claim only what was recorded: no lane's own suite is recorded at its end")
        self.assertIn("- J-T01, lanes-interaction, recorded by the build station: Every lane passed its own suite", text, "the station's words, as recorded")

    def handed_back_then_joined(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.open_lanes()
        self.build_lane("L1", L1)
        self.build_lane("L2", L2[:1])
        self.ok("hand-back", TICKET, "--lane", "L2", "--reason", "T04 needs app/invite.py, which L1 owns")
        self.assertEqual(self.ok("join", TICKET)["status"], "INTERACTION")

    def finished_after_a_hand_back(self):
        self.handed_back_then_joined()
        self.put(self.work, {"app/release.py": RELEASE})
        self.ok("green", TICKET, "T04")
        self.ok("green", TICKET, "J-T01", "--already-done", "T04 made the whole suite pass")
        self.put(self.work, {"README.md": README})
        self.ok("done", TICKET, "T05")
        self.ok("finish", TICKET)

    def test_a_lane_handed_back_is_named_with_its_reason_and_where_each_task_was_built(self):
        self.finished_after_a_hand_back()
        text = render(change_record, self.cellroot)
        self.assertIn("- Lane L2 held T03, T04. It was handed back to the cell before it finished, because \"T04 needs app/invite.py, which L1 owns\": "
                      "T03 landed from the lane at the join, and T04 was then built in the cell, one at a time, after the join.", text)
        self.assertIn("- Lane L1 held T01, T02.\n", text)
        self.assertIn("- The whole suite failed on the joined result: ", text)
        self.assertIn(". It held the work of lane L1 and what lane L2 finished before it was handed back (T03). ", text)
        self.assertNotIn("Every lane passed its own suite", text, "a lane was handed back, and neither the record nor the station says otherwise")
        self.assertIn("- no task (lane L2), lane-handed-back:", text, "the hand-back is listed with the other deviations too")

    def test_a_handed_back_task_not_built_is_said_so_and_old_reports_are_read_from_the_deviations(self):
        self.finished_after_a_hand_back()

        def change(report):
            for task in report["tasks"]:
                if task["id"] == "T04":
                    task["status"] = "pending"
            for lane in report["lanes"]["lanes"]:
                lane.pop("handed_back", None)  # only the deviations say it now
        self.edit_report(change)
        text = render(change_record, self.cellroot)
        self.assertIn("It was handed back to the cell before it finished, because \"T04 needs app/invite.py, which L1 owns\": T03 landed from the "
                      "lane at the join, and T04 is to be built in the cell after the join; it is pending.", text)

    def test_a_command_set_during_the_build_is_named_with_old_new_reason_and_when(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        old = self.state()["test_cmd"]
        new = old + " -b"
        self.ok("set-commands", TICKET, "--test-cmd", new, "--reason", "the project's tests say more with -b")
        self.open_lanes()
        self.build_lane("L1", L1)
        self.build_lane("L2", L2)
        self.ok("join", TICKET)
        self.put(self.work, {"README.md": README})
        self.ok("done", TICKET, "T05")
        self.ok("finish", TICKET)
        self.edit_report(lambda report: report["deviations"].append(
            {"task": None, "type": "lint-command-set", "detail": "The lint command was set while building (first build): null -> \"ruff check\". Reason: lint",
             "command": "lint", "old": None, "new": "ruff check", "reason": "the project lints with ruff", "during": "first build", "at": "2026-11-24T10:00:00Z"}))
        text = render(change_record, self.cellroot)
        at = next(d for d in self.report()["deviations"] if d["type"] == "test-command-set")["at"]
        self.assertIn("Commands set or changed during the build, as recorded:\n\n", text)
        inert = lambda command: command.replace("@", "@\u200b")  # a mention is broken, as in all of the record's text
        self.assertIn(f"- The test command was changed at {at} (lanes planned): it was \"{inert(old)}\", and is now \"{inert(new)}\". "
                      "Reason: the project's tests say more with -b.", text)
        self.assertIn("- The lint command was set at 2026-11-24T10:00:00Z (first build): there was none before, and it is now \"ruff check\". "
                      "Reason: the project lints with ruff.", text)
        self.assertLess(text.index("Commands set or changed"), text.index("Overrides the builder recorded"))

    def test_a_fix_task_not_done_is_said_so(self):
        self.joined_with_an_interaction()
        self.edit_report(lambda report: [task.update({"status": "pending"}) for task in report["tasks"] if task["id"] == "J-T01"])
        self.assertIn("The build station added J-T01 to make them pass together; it is pending.", render(change_record, self.cellroot))

    def test_an_unknown_deviation_is_shown_with_its_words_and_made_inert(self):
        self.finished_in_two_lanes()
        self.edit_report(lambda report: report["deviations"].extend([
            {"task": None, "type": "test-command-changed", "by": "build station", "detail": "From `make test` to `make check`: the suite moved. @octocat #3"},
            {"task": "T04", "type": "tasks-handed-back", "lane": "L2", "detail": "T04 went back to the cell."}]))
        text = render(change_record, self.cellroot)
        self.assertIn("- no task, test-command-changed, recorded by the build station: From 'make test' to 'make check': the suite moved. @​octocat #​3", text)
        self.assertIn("- T04 (lane L2), tasks-handed-back: T04 went back to the cell.", text)

    def test_times_not_recorded_are_said_so(self):
        self.finished_in_two_lanes()
        self.edit_report(lambda report: report["timing"].update({"lanes": {}, "elapsed_seconds": None, "steps": []}))
        self.assertIn("- Time: the lanes took not recorded of wall time, and their own times add up to not recorded. The whole build took "
                      "not recorded from start to finish, and its tasks' recorded times add up to not recorded.", render(change_record, self.cellroot))

    def test_lanes_planned_but_not_run(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.assertEqual(self.ok("lanes-open", TICKET, "--holder", "a" * 32, "--grant", "1")["status"], "SEQUENTIAL")
        for task, step, files in L1 + L2 + [("T05", "done", {"README.md": README})]:
            self.put(self.work, files)
            self.ok(step, TICKET, task)
        self.ok("finish", TICKET)
        text = render(change_record, self.cellroot)
        self.assertIn("Lanes were planned for this build but did not run: Only 1 builder(s) may run for this ticket now", text)
        self.assertIn("It was built one task at a time in the cell.", text)

    def test_the_facts_for_release_qualification_are_unchanged(self):
        old = before("change_record")
        if old is None:
            self.skipTest("the change record from before lanes is not in this repository's history")
        self.finished_with_a_lane_set_aside()
        new_text, old_text = render(change_record, self.cellroot), render(old, self.cellroot)
        self.assertEqual(change_record.read_facts(new_text), old.read_facts(old_text))
        self.assertIsNotNone(change_record.read_facts(new_text))


class RecordWithoutLanesTest(test_change_record.Base):
    """A build without lanes gives exactly the record it gave before, byte for byte."""

    def test_the_merge_fixture_with_every_round_is_unchanged(self):
        old = before("change_record")
        if old is None:
            self.skipTest("the change record from before lanes is not in this repository's history")
        head = self.approved(mode="auto")
        self.rounds(head)
        cell = merge.Cell(self.project, "LOCAL-001")
        commits = {"approved": head, "base": head}
        rules = merge.issue_rules()
        self.assertEqual(change_record.render(cell.root, cell.info, "LOCAL-001", commits, rules, None, "b" * 64),
                         old.render(cell.root, cell.info, "LOCAL-001", commits, rules, None, "b" * 64))
        report = json.loads((cell.root / "build-report.json").read_text())
        report["deviations"].append({"type": "test-amended", "task": "T03", "detail": "Fixed a typo in the test's name."})
        (cell.root / "build-report.json").write_text(json.dumps(report))
        self.assertEqual(change_record.render(cell.root, cell.info, "LOCAL-001", commits, rules),
                         old.render(cell.root, cell.info, "LOCAL-001", commits, rules))


class RecordOfAPlainBuildTest(test_build.Base):
    def test_a_build_one_task_at_a_time_is_unchanged(self):
        old = before("change_record")
        if old is None:
            self.skipTest("the change record from before lanes is not in this repository's history")
        self.ready()
        self.ok("start", TICKET)
        for task, step, files in [("T01", "red", {"tests/test_invite.py": RED_TEST}), ("T02", "green", {"app/invite.py": IMPL}),
                                  ("T03", "red", {"tests/test_scenarios.py": test_build.SCENARIO_TEST}), ("T04", "green", {"app/invite.py": test_build.IMPL2}),
                                  ("T05", "done", {"README.md": README})]:
            self.put(self.work, files)
            self.ok(step, TICKET, task)
        self.ok("finish", TICKET)
        self.assertEqual(render(change_record, self.cellroot), render(old, self.cellroot))


# ---------------------------------------------------------------- the explanation

class ExplainTest(Built):
    def explain(self):
        report, code = explain.explain(self.project, TICKET, {"action": "build", "stage": "building"}, {})
        self.assertEqual(code, 0)
        return report

    def test_a_build_at_its_lanes_says_how_far_each_has_got(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        planned = self.explain()["lanes"]
        self.assertEqual((planned["state"], planned["count"]), ("planned", 2))
        self.assertEqual(planned["summary"], "The build is planned in 2 lanes (L1: T01, T02; L2: T03, T04). The line opens them once the tasks before the lanes are done.")
        self.open_lanes()
        self.build_lane("L1", L1[:1])
        self.build_lane("L2", L2)
        lanes = self.explain()["lanes"]
        self.assertEqual([(lane["lane"], lane["done"], lane["of"], lane["status"]) for lane in lanes["lanes"]], [("L1", 1, 2, "open"), ("L2", 2, 2, "done")])
        self.assertEqual(lanes["summary"], "The build is at its lanes: 2 lanes, built at the same time (L1 1 of 2 done, L2 2 of 2 done (finished)). "
                                           "When every lane is done the line joins them.")
        self.assertEqual(explain.lanes_line(self.cellroot), lanes["summary"])
        text = explain.human({**self.explain(), "digest": {}})
        self.assertIn("- [lanes] The build is at its lanes: 2 lanes", text)
        self.assertIn("- [lanes] L1 (T01, T02): 1 of 2 done, open, last step at ", text)
        text = explain.human({**self.explain(), "digest": {"lanes": lanes["summary"]}})
        self.assertIn(f"Lanes: {lanes['summary']}", text)
        self.assertEqual(text.count("The build is at its lanes"), 1, "said once")

    def test_two_lanes_joined(self):
        self.finished_in_two_lanes()
        facts = self.explain()["lanes"]
        tip = self.state()["lanes"]["join"]["tip"]
        self.assertEqual(facts["summary"], f"The build ran in 2 lanes, joined at commit {tip}; the whole suite passed on the joined result.")
        self.assertNotIn("set_aside", facts)
        self.assertNotIn("interaction", facts)

    def test_a_lane_set_aside_and_what_was_done(self):
        self.finished_with_a_lane_set_aside()
        facts = self.explain()["lanes"]
        self.assertIn("; 1 lane set aside;", facts["summary"])
        self.assertEqual(facts["set_aside"][0]["text"], "Lane L2 was set aside at the join: it and lane L1 both changed app/util.py. Its commits were not "
                                                        "landed; its tasks (T03, T04) are built again in the cell, one at a time: 2 of 2 done.")
        self.assertIn("- [lanes] Lane L2 was set aside at the join", explain.human({**self.explain(), "digest": {}}))

    def test_lanes_that_fail_together_and_the_fix_task(self):
        self.joined_with_an_interaction(finish=False)
        facts = self.explain()["lanes"]
        self.assertIn("the whole suite failed on the joined result.", facts["summary"])
        self.assertEqual(facts["interaction"]["task"], "J-T01")
        self.assertIn("Every lane passed its own suite, but the whole suite failed on the joined result (test_release.S.test_release", facts["interaction"]["text"])
        self.assertTrue(facts["interaction"]["text"].endswith("J-T01 was added to make them pass together; it is still to do."))
        self.put(self.work, {"app/invite.py": IMPL})
        self.ok("green", TICKET, "J-T01")
        self.assertTrue(self.explain()["lanes"]["interaction"]["text"].endswith("it is done."))

    def test_an_unknown_deviation_is_said_with_its_words(self):
        self.finished_in_two_lanes()
        state = self.state()
        state["deviations"] += [{"task": None, "type": "test-command-changed", "by": "build station", "detail": "From make test to make check.\x1b[31m"},
                                {"task": "T04", "type": "tasks-handed-back", "lane": "L2", "detail": "T04 went back to the cell."},
                                {"task": "T02", "type": "files-outside-plan", "lane": "L1", "detail": "an override like any other"}]
        (self.cellroot / "build.json").write_text(json.dumps(state))
        texts = [item["text"] for item in self.explain()["lanes"]["recorded"]]
        self.assertEqual(texts, ["The build station recorded test-command-changed: From make test to make check.[31m",
                                 "Lane L2 recorded tasks-handed-back for T04: T04 went back to the cell."])

    def test_nothing_is_said_for_a_build_without_lanes(self):
        old = before("explain")
        if old is None:
            self.skipTest("the explanation from before lanes is not in this repository's history")
        self.ready()
        self.ok("start", TICKET)
        self.put(self.work, {"tests/test_invite.py": RED_TEST})
        self.ok("red", TICKET, "T01")
        for module in (explain, old):
            module._ADR.clear()
            module._POLICIES.clear()
        new_report, _ = explain.explain(self.project, TICKET, {"action": "build"}, {})
        old_report, _ = old.explain(self.project, TICKET, {"action": "build"}, {})
        self.assertNotIn("lanes", new_report)
        self.assertEqual(new_report, old_report)
        self.assertEqual(explain.human(new_report), old.human(old_report))
        self.assertIsNone(explain.lanes_line(self.cellroot))


# ---------------------------------------------------------------- cleanup

class CleanupTest(Built):
    def run_cleanup(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = cleanup.main(["--project", str(self.project), *argv])
        return code, out.getvalue(), err.getvalue()

    def c_ok(self, *argv):
        code, out, err = self.run_cleanup(*argv)
        self.assertEqual(code, 0, err + out)
        return json.loads(out)

    def members(self):
        with tarfile.open(str(self.project / ".factory/archive/LOCAL-001.tar.gz")) as tar:
            return tar.getnames()

    def member(self, name):
        with tarfile.open(str(self.project / ".factory/archive/LOCAL-001.tar.gz")) as tar:
            return tar.extractfile(name).read()

    def all_worktrees(self):
        return [line for line in git(self.project, "worktree", "list", "--porcelain").stdout.splitlines() if line.startswith("worktree ")]

    def assert_clean(self):
        self.assertEqual(self.all_worktrees(), [f"worktree {self.project}"], "only the main checkout is left in Git's records")
        self.assertEqual(git(self.project, "branch", "--list", "mach-lane/*").stdout, "", "no lane branch is left")
        self.assertFalse(self.cellroot.exists())
        names = self.members()
        self.assertFalse([n for n in names if n.split("/")[1:2] == ["lanes"] and n.split("/")[3:4] == ["repo"]], "no lane's checked-out tree is archived")
        self.assertFalse([n for n in names if n.startswith("LOCAL-001/repo")])
        return names

    def test_a_merged_ticket_built_in_lanes(self):
        self.finished_in_two_lanes()
        lane_commits = [t["lane_commit"] for t in self.state()["tasks"] if t.get("lane") == "L1"]
        # What a join that could not remove everything leaves behind: a lane's worktree and branch, with its lane commits.
        git(self.project, "worktree", "add", "-q", "-b", "mach-lane/LOCAL-001/L1", str(self.lane_work("L1")), lane_commits[-1])
        self.assertEqual(git(self.project, "merge", "--no-ff", "-q", "-m", "Merge LOCAL-001", "feature/LOCAL-001").returncode, 0)
        info = json.loads((self.cellroot / "cell.json").read_text())
        (self.cellroot / "cell.json").write_text(json.dumps({**info, "stage": "approved"}))
        plan = self.c_ok("plan", TICKET)
        self.assertEqual(plan["would"]["remove_lane_worktrees"], [".factory/worktrees/LOCAL-001/lanes/L1/repo"])
        self.assertEqual(plan["would"]["delete_lane_branches"], ["mach-lane/LOCAL-001/L1"])
        self.assertFalse([m for m in plan["would"]["archive_members"] if "/lanes/L1/repo" in m])
        done = self.c_ok("run", TICKET)
        names = self.assert_clean()
        for name in ("LOCAL-001/lanes/L1/lane.json", "LOCAL-001/lanes/L2/lane.json", "LOCAL-001/build.json", "LOCAL-001/lanes.bundle"):
            self.assertIn(name, names)
        self.assertEqual(done["lanes"]["branches_deleted"], ["mach-lane/LOCAL-001/L1"])
        self.assertEqual(done["lanes"]["left"], [])
        self.assertEqual(done["record"]["outcome"], "merged")
        self.assertEqual(set(done["record"]), RECORD_KEYS, "the run record keeps its shape")

    def test_a_ticket_abandoned_with_lanes_open_loses_nothing(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.open_lanes()
        self.build_lane("L1", L1)
        self.build_lane("L2", L2[:1])
        tips = {name: git(self.lane_work(name), "rev-parse", "HEAD").stdout.strip() for name in ("L1", "L2")}
        self.put(self.lane_work("L2"), {"app/release.py": "def release():\n    return 'half done'\n", "README.md": "# Sample, changed in L2\n"})
        plan = self.c_ok("plan", TICKET, "--abandon", WHY)
        self.assertTrue(plan["allowed"], plan["refusals"])
        self.assertEqual(plan["would"]["save_lane_uncommitted"], ["L2"])
        self.assertTrue(plan["would"]["bundle_lanes"])
        done = self.c_ok("run", TICKET, "--abandon", WHY)
        names = self.assert_clean()
        for name in ("LOCAL-001/lanes/L1/lane.json", "LOCAL-001/lanes/L2/lane.json", "LOCAL-001/lanes.bundle",
                     "LOCAL-001/lanes-saved/L2/uncommitted.patch", "LOCAL-001/lanes-saved/L2/untracked/app/release.py"):
            self.assertIn(name, names)
        lanes = done["lanes"]
        self.assertEqual(lanes["bundle"], "LOCAL-001/lanes.bundle")
        self.assertEqual(sorted(lanes["branches_deleted"]), ["mach-lane/LOCAL-001/L1", "mach-lane/LOCAL-001/L2"])
        self.assertEqual(len(lanes["restore"]), 2)
        self.assertTrue(lanes["restore"][0].startswith("The lane branches' "))
        self.assertIn("git fetch LOCAL-001/lanes.bundle 'refs/heads/mach-lane/LOCAL-001/*:refs/heads/mach-lane/LOCAL-001/*'", lanes["restore"][0])
        self.assertIn(f"made against commit {tips['L2']}", lanes["restore"][1])

        # Getting it back, as the result says, in a fresh clone that never had the lanes' commits.
        out = Path(self.tmp.name).resolve() / "out"
        out.mkdir()
        with tarfile.open(str(self.project / ".factory/archive/LOCAL-001.tar.gz")) as tar:
            tar.extractall(str(out), members=[m for m in tar.getmembers() if m.name.startswith(("LOCAL-001/lanes.bundle", "LOCAL-001/lanes-saved/"))])
        clone = Path(self.tmp.name).resolve() / "clone"
        self.assertEqual(git(self.project.parent, "clone", "-q", "--no-local", str(self.project), str(clone)).returncode, 0)
        self.assertNotEqual(git(clone, "cat-file", "-e", tips["L1"]).returncode, 0)
        fetched = git(clone, "fetch", "-q", str(out / "LOCAL-001/lanes.bundle"), "refs/heads/mach-lane/LOCAL-001/*:refs/heads/mach-lane/LOCAL-001/*")
        self.assertEqual(fetched.returncode, 0, fetched.stderr)
        self.assertEqual({name: git(clone, "rev-parse", f"mach-lane/LOCAL-001/{name}").stdout.strip() for name in ("L1", "L2")}, tips)
        lane = Path(self.tmp.name).resolve() / "lane-L2"
        self.assertEqual(git(clone, "worktree", "add", "-q", str(lane), tips["L2"]).returncode, 0)
        applied = git(lane, "apply", str(out / "LOCAL-001/lanes-saved/L2/uncommitted.patch"))
        self.assertEqual(applied.returncode, 0, applied.stderr)
        self.assertEqual((lane / "README.md").read_text(), "# Sample, changed in L2\n")
        self.assertEqual((out / "LOCAL-001/lanes-saved/L2/untracked/app/release.py").read_text(), "def release():\n    return 'half done'\n")
        self.assertIn("T04", self.member("LOCAL-001/lanes/L2/lane.json").decode(), "the lane's state is kept")

    def test_a_half_made_join_is_removed_too(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.open_lanes()
        self.build_lane("L1", L1)
        self.build_lane("L2", L2)
        import build
        build.workspace.create(self.project, self.cellroot / "lanes/join/repo", "mach-lane/LOCAL-001/join", start=self.state()["lanes"]["fork"])
        done = self.c_ok("run", TICKET, "--abandon", WHY)
        self.assert_clean()
        self.assertIn("mach-lane/LOCAL-001/join", done["lanes"]["branches_deleted"])

    def test_a_folder_that_is_not_a_lane_worktree_is_left_for_a_person(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.open_lanes()
        self.put(self.cellroot, {"lanes/L7/repo/notes.txt": "mine\n"})
        code, out, err = self.run_cleanup("run", TICKET, "--abandon", WHY)
        self.assertEqual(code, 1)
        self.assertIn("lanes/L7/repo is not a Git worktree, so nothing else holds what is in it. Nothing was touched. Move it out of", err)
        self.assertEqual((self.cellroot / "lanes/L7/repo/notes.txt").read_text(), "mine\n")
        self.assertEqual(len([w for w in self.all_worktrees() if "/lanes/" in w]), 2)
        self.assertFalse((self.project / ".factory/archive/LOCAL-001.tar.gz").exists())


class CleanupWithoutLanesTest(test_cleanup.Base):
    def test_a_ticket_without_lanes_is_planned_and_cleaned_as_before(self):
        self.merged_and_approved()
        plan = self.c_ok("plan", "LOCAL-001")
        self.assertNotIn("lanes", plan)
        self.assertEqual(set(plan["would"]), {"archive", "archive_members", "remove_worktree", "remove_folder", "bundle_branch", "delete_branch",
                                              "bundle_replans", "delete_replan_refs", "append_record"})
        done = self.c_ok("run", "LOCAL-001")
        self.assertNotIn("lanes", done)
        self.assertFalse([n for n in self.members() if "lanes" in n])


if __name__ == "__main__":
    unittest.main()
