"""Tests for run.py schedule (schedule.py): which of several tickets may start now, and why the others wait.

The rule is pure (schedule.decide) and is tested on its own; the command is tested on small projects made of
cells and plans, and, for dependencies, on a real intake ledger built by the product intake tests' fixture.
"""

import hashlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "skills" / "run" / "scripts"))
import run  # noqa: E402
import schedule  # noqa: E402
from test_mach_product_intake import Base as IntakeBase  # noqa: E402


def facts(ticket, phase="line", risk="Medium", files=("a.py",), waits_for=()):
    return {"ticket_id": ticket, "phase": phase, "risk": risk, "files": None if files is None else list(files), "waits_for": list(waits_for)}


def plan_md(*files):
    rows = "\n".join(f"| `{name}` | modify | T01 |" for name in files)
    return ("# Plan\n\n## Tasks\n\n- [ ] T01 [test] A test for the change (FR-01)\n\n"
            "## File touch map\n\n| File | Change | Tasks |\n|------|--------|-------|\n" + rows + "\n")


def tree(root):
    """Every file under the project with a digest of its content: what the command must leave as it was."""
    found = {str(path.relative_to(root)) + "/": "" for path in root.rglob("*") if path.is_dir()}
    found.update({str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest() for path in root.rglob("*") if path.is_file()})
    return found


class DecideTest(unittest.TestCase):
    """Every rule of design 1.3, on the pure function."""

    def ids(self, items):
        return [item["ticket_id"] for item in items]

    def test_a_ticket_already_running_is_skipped(self):
        decided = schedule.decide([facts("A", files=["a.py"]), facts("B", files=["b.py"])], [facts("A", files=["a.py"])], 3, 1)
        self.assertEqual((self.ids(decided["start"]), decided["held"], decided["running"]), (["B"], [], ["A"]))

    def test_the_ceiling_counts_running_and_started(self):
        decided = schedule.decide([facts(name, files=[name]) for name in "ABC"], [facts("R", files=["r"])], 3, 3)
        self.assertEqual(self.ids(decided["start"]), ["A", "B"])
        self.assertEqual(decided["held"], [{"ticket_id": "C", "rule": "ceiling", "why": "all 3 place(s) are in use", "after": ["R", "A", "B"]}])

    def test_a_dependency_that_is_not_integrated_holds(self):
        decided = schedule.decide([facts("A", waits_for=["X"]), facts("B", files=["b"])], [], 3, 1)
        self.assertEqual(self.ids(decided["start"]), ["B"])
        self.assertEqual(decided["held"], [{"ticket_id": "A", "rule": "dependency", "why": "it waits for X to be integrated", "after": ["X"]}])

    def test_high_risk_tickets_in_the_line_are_limited(self):
        tickets = [facts("A", risk="High", files=["a"]), facts("B", risk="High", files=["b"]), facts("C", risk="Low", files=["c"])]
        decided = schedule.decide(tickets, [], 3, 1)
        self.assertEqual(self.ids(decided["start"]), ["A", "C"])
        (held,) = decided["held"]
        self.assertEqual((held["ticket_id"], held["rule"], held["after"]), ("B", "high-risk", ["A"]))
        self.assertIn("its risk tier is High", held["why"])
        self.assertEqual(self.ids(schedule.decide(tickets, [], 3, 2)["start"]), ["A", "B", "C"])

    def test_unknown_risk_in_the_line_counts_as_high_and_prepare_tickets_do_not_count(self):
        decided = schedule.decide([facts("A", risk=None, files=["a"]), facts("B", risk="High", files=["b"])], [], 3, 1)
        self.assertEqual((self.ids(decided["start"]), decided["held"][0]["rule"]), (["A"], "high-risk"))
        self.assertIn("not known, so it counts as High", schedule.decide([facts("B", risk=None, files=["b"])], [facts("A", risk="High", files=["a"])], 3, 1)["held"][0]["why"])
        prepare = [facts("P", phase="prepare", risk=None, files=None), facts("Q", phase="prepare", risk="High", files=None), facts("A", risk="High", files=["a"])]
        self.assertEqual(self.ids(schedule.decide(prepare, [], 3, 1)["start"]), ["P", "Q", "A"])

    def test_the_high_risk_ceiling_is_never_above_the_ceiling(self):
        decided = schedule.decide([facts("A", risk="High", files=["a"]), facts("B", risk="High", files=["b"])], [], 1, 5)
        self.assertEqual(decided["held"][0]["rule"], "ceiling")

    def test_file_overlap_holds_and_names_the_other_ticket_and_up_to_five_files(self):
        shared = [f"src/f{n}.py" for n in range(7)]
        decided = schedule.decide([facts("A", files=shared + ["a"]), facts("B", files=shared + ["b"]), facts("C", files=["c"])], [], 3, 1)
        self.assertEqual(self.ids(decided["start"]), ["A", "C"])
        (held,) = decided["held"]
        self.assertEqual((held["ticket_id"], held["rule"], held["after"]), ("B", "overlap", ["A"]))
        self.assertEqual(held["why"], "it shares files with A: src/f0.py, src/f1.py, src/f2.py, src/f3.py, src/f4.py and 2 more")

    def test_overlap_counts_running_tickets_and_ignores_prepare_ones(self):
        decided = schedule.decide([facts("B", files=["x"])], [facts("R", files=["x"])], 3, 1)
        self.assertEqual((decided["start"], decided["held"][0]["after"]), ([], ["R"]))
        self.assertEqual(self.ids(schedule.decide([facts("B", files=["x"])], [facts("R", phase="prepare", files=None)], 3, 1)["start"]), ["B"])

    def test_a_ticket_with_no_readable_plan_runs_alone_in_the_line(self):
        alone = schedule.decide([facts("U", files=None), facts("B", files=["b"])], [], 3, 1)
        self.assertEqual(self.ids(alone["start"]), ["U"])
        self.assertEqual((alone["held"][0]["ticket_id"], alone["held"][0]["rule"], alone["held"][0]["after"]), ("B", "overlap", ["U"]))
        self.assertIn("U has no file touch map", alone["held"][0]["why"])
        second = schedule.decide([facts("B", files=["b"]), facts("U", files=None)], [], 3, 1)
        self.assertEqual(self.ids(second["start"]), ["B"])
        self.assertIn("its plan has no file touch map that could be read, so it runs on its own", second["held"][0]["why"])
        self.assertEqual(self.ids(schedule.decide([facts("U", files=None), facts("P", phase="prepare", files=None)], [], 3, 1)["start"]), ["U", "P"])

    def test_prepare_tickets_go_only_as_far_as_build(self):
        decided = schedule.decide([facts("P", phase="prepare", files=None), facts("L", files=["l"])], [], 3, 1)
        self.assertEqual(decided["start"], [{"ticket_id": "P", "until": "build"}, {"ticket_id": "L", "until": None}])

    def test_the_order_given_decides_and_the_same_inputs_give_the_same_answer(self):
        first = [facts("A", files=["x"]), facts("B", files=["x"])]
        self.assertEqual(self.ids(schedule.decide(first, [], 3, 1)["start"]), ["A"])
        self.assertEqual(self.ids(schedule.decide(list(reversed(first)), [], 3, 1)["start"]), ["B"])
        mixed = [facts("A", risk="High", files=["x"]), facts("B", files=["x"]), facts("C", waits_for=["A"]), facts("D", phase="prepare", files=None)]
        answers = [json.dumps(schedule.decide(mixed, [facts("R", files=["r"])], 3, 1), sort_keys=True) for _ in range(5)]
        self.assertEqual(len(set(answers)), 1)

    def test_every_held_ticket_has_a_reason_and_what_it_waits_for(self):
        decided = schedule.decide([facts("A", files=["x"]), facts("B", files=["x"]), facts("C", waits_for=["Z"]), facts("D", files=["d"])], [], 2, 1)
        for item in decided["held"]:
            self.assertTrue(item["why"] and item["after"], item)

    def test_the_simulation_assumes_each_batch_finishes(self):
        tickets = [facts("A", files=["x"]), facts("B", files=["x"]), facts("C", waits_for=["A"], files=["c"]), facts("D", waits_for=["Y"])]
        self.assertEqual(schedule.simulate(tickets, [], 3, 1), {"batches": [["A"], ["B", "C"]], "never": ["D"]})
        self.assertEqual(schedule.simulate([facts("B", files=["x"])], [facts("R", files=["x"])], 3, 1), {"batches": [["B"]], "never": []})


class CeilingTest(unittest.TestCase):
    """The table of design 1.4."""

    def test_the_table(self):
        factory = {"max_parallel": 3, "max_parallel_high": 1}
        cases = [
            ({}, (3, 1, None, False)),
            ({"limit": 2}, (2, 1, None, False)),
            ({"limit": 5}, (3, 1, 5, False)),
            ({"sequential": True}, (1, 1, None, False)),
            ({"sequential": True, "limit": 5}, (1, 1, None, False)),
            ({"limit": 5, "by_person": True}, (5, 1, None, True)),
            ({"limit": 2, "by_person": True}, (2, 1, None, False)),
            ({"limit": 12, "by_person": True}, (8, 1, 12, True)),
        ]
        for kwargs, expected in cases:
            with self.subTest(**kwargs):
                got = schedule.ceilings(factory, **kwargs)
                self.assertEqual((got["in_force"], got["high"], got["clamped_from"], got["raised_by_person"]), expected)
                self.assertEqual(got["settings"], 3)
        self.assertIn("Only a person can raise it", schedule.ceilings(factory, limit=5)["note"])

    def test_the_high_risk_ceiling(self):
        self.assertEqual(schedule.ceilings({})["high"], 1)
        self.assertEqual(schedule.ceilings({"max_parallel": 3, "max_parallel_high": 2})["high"], 2)
        self.assertEqual(schedule.ceilings({"max_parallel": 3, "max_parallel_high": 5})["high"], 3)
        self.assertEqual(schedule.ceilings({"max_parallel": 3, "max_parallel_high": 3}, limit=2)["high"], 2)
        for bad in (0, -1, "2", True, 1.5, None):
            self.assertEqual(schedule.ceilings({"max_parallel": 3, "max_parallel_high": bad})["high"], 1, bad)
        self.assertEqual(schedule.ceilings({"max_parallel": "x"})["settings"], schedule.DEFAULT_MAX_PARALLEL)

    def test_refusals(self):
        with self.assertRaises(schedule.ScheduleError):
            schedule.ceilings({}, limit=0)
        with self.assertRaisesRegex(schedule.ScheduleError, "pass --limit too"):
            schedule.ceilings({}, by_person=True)


class CommandBase(unittest.TestCase):
    def setUp(self):
        self.project = Path(tempfile.mkdtemp(prefix="mach-schedule-"))
        self.addCleanup(shutil.rmtree, self.project, ignore_errors=True)
        (self.project / ".factory").mkdir()
        self.settings({"tickets": {"provider": "local"}, "factory": {"max_parallel": 3}})
        os.environ.pop(run.EXECUTION_ENV, None)

    def settings(self, config):
        (self.project / ".factory/config.json").write_text(json.dumps(config))

    def cell(self, ticket, stage="planned", risk="Medium", files=None):
        folder = self.project / ".factory/worktrees" / ticket
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "cell.json").write_text(json.dumps({"ticket_id": ticket, "stage": stage, "risk": risk, "isolation": "none"}))
        if files is not None:
            (folder / "plan.md").write_text(plan_md(*files))

    def run_cmd(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = run.main(["--project", str(self.project), "schedule", *argv])
        return code, out.getvalue(), err.getvalue()

    def schedule(self, *argv):
        code, out, err = self.run_cmd(*argv)
        self.assertEqual(code, 0, err)
        return json.loads(out)


class CommandTest(CommandBase):
    def test_the_report_and_what_to_hand_the_belt(self):
        self.cell("LOCAL-001", files=["app/x.py"])
        self.cell("LOCAL-002", files=["app/x.py", "app/y.py"])
        self.cell("LOCAL-003", stage="spec-ready")
        report = self.schedule("LOCAL-001", "LOCAL-002", "LOCAL-003", "LOCAL-004")
        self.assertEqual(report["start"], [{"ticket_id": "LOCAL-001", "until": None}, {"ticket_id": "LOCAL-003", "until": "build"},
                                           {"ticket_id": "LOCAL-004", "until": "build"}])
        self.assertEqual(report["held"], [{"ticket_id": "LOCAL-002", "rule": "overlap", "why": "it shares files with LOCAL-001: app/x.py", "after": ["LOCAL-001"]}])
        self.assertEqual(report["ceiling"], {"settings": 3, "high": 1, "high_settings": 1, "in_force": 3, "raised_by_person": False, "clamped_from": None, "note": None})
        self.assertEqual(report["batches"], [["LOCAL-001", "LOCAL-003", "LOCAL-004"], ["LOCAL-002"]])
        self.assertEqual((report["started"], report["workflow"], report["dependencies_known"]), (False, "mach:belt", False))
        self.assertEqual(report["workflow_args"], {"tickets": ["LOCAL-001", "LOCAL-002", "LOCAL-003", "LOCAL-004"]})
        phases = {item["ticket_id"]: (item["phase"], item["files"]) for item in report["tickets"]}
        self.assertEqual(phases["LOCAL-002"], ("line", ["app/x.py", "app/y.py"]))
        self.assertEqual(phases["LOCAL-004"], ("prepare", None))  # no cell yet

    def test_the_touch_map_is_read_by_the_build_stations_own_parser(self):
        parser = schedule.plan_parser(run.sibling)
        self.assertEqual(Path(parser.__code__.co_filename).resolve(), (ROOT / "skills/build/scripts/build.py").resolve())
        source = (ROOT / "skills/run/scripts/schedule.py").read_text()
        for copied in ("def parse_plan", "TASK_RE", "## File touch map"):
            self.assertNotIn(copied, source)
        self.assertIsNone(schedule.plan_parser(None))

    def test_running_tickets_are_skipped_and_count_against_the_ceiling(self):
        for ticket in ("LOCAL-001", "LOCAL-002", "LOCAL-003"):
            self.cell(ticket, files=[ticket])
        report = self.schedule("LOCAL-001", "LOCAL-002", "LOCAL-003", "--running", "LOCAL-001", "--limit", "2")
        self.assertEqual(([item["ticket_id"] for item in report["start"]], report["running"], report["skipped_as_running"]),
                         (["LOCAL-002"], ["LOCAL-001"], ["LOCAL-001"]))
        self.assertEqual(report["held"][0]["rule"], "ceiling")
        self.assertEqual(report["workflow_args"], {"tickets": ["LOCAL-002", "LOCAL-003"], "limit": 2})

    def test_a_high_limit_is_clamped_and_said_so_and_sequential_is_one(self):
        for ticket in ("LOCAL-001", "LOCAL-002", "LOCAL-003", "LOCAL-004"):
            self.cell(ticket, files=[ticket])
        report = self.schedule("LOCAL-001", "LOCAL-002", "LOCAL-003", "LOCAL-004", "--limit", "6")
        self.assertEqual((report["ceiling"]["in_force"], report["ceiling"]["clamped_from"], len(report["start"])), (3, 6, 3))
        self.assertIn("--limit 6 is above the settings ceiling of 3", report["ceiling"]["note"])
        report = self.schedule("LOCAL-001", "LOCAL-002", "--sequential")
        self.assertEqual(([item["ticket_id"] for item in report["start"]], report["workflow_args"]), (["LOCAL-001"], {"tickets": ["LOCAL-001", "LOCAL-002"], "sequential": True}))
        self.assertEqual(self.run_cmd("LOCAL-001", "--limit", "0")[0], 1)

    def test_a_person_may_raise_it_for_one_run_up_to_eight(self):
        names = [f"LOCAL-{n:03d}" for n in range(1, 11)]
        for ticket in names:
            self.cell(ticket, files=[ticket])
        report = self.schedule(*names, "--limit", "5", "--by-person")
        self.assertEqual((report["ceiling"]["in_force"], report["ceiling"]["raised_by_person"], len(report["start"])), (5, True, 5))
        self.assertEqual(report["workflow_args"], {"tickets": names, "limit": 5, "by_person": True})
        report = self.schedule(*names, "--limit", "20", "--by-person")
        self.assertEqual((report["ceiling"]["in_force"], report["ceiling"]["clamped_from"], len(report["start"])), (8, 20, 8))
        code, _, err = self.run_cmd("LOCAL-001", "--by-person")
        self.assertEqual(code, 1)
        self.assertIn("pass --limit too", err)

    def test_by_person_is_refused_inside_a_supervised_execution(self):
        self.cell("LOCAL-001", files=["a"])
        ledger = self.project / ".factory/intake/ledger.json"
        ledger.parent.mkdir()
        ledger.write_text(json.dumps({"supervisor": {"executions": {"x0123456789ab": {"ticket_id": "LOCAL-001"}}}}))
        with mock.patch.dict(os.environ, {run.EXECUTION_ENV: "x0123456789ab"}):
            code, out, err = self.run_cmd("LOCAL-001", "--limit", "4", "--by-person")
            self.assertEqual((code, out), (1, ""))
            self.assertIn("supervised Factory execution", err)
            code, _, err = self.run_cmd("LOCAL-001", "LOCAL-002")
            self.assertEqual(code, 1)
            self.assertIn("started for LOCAL-001 only", err)

    def supervised(self, executions):
        ledger = self.project / ".factory/intake/ledger.json"
        ledger.parent.mkdir(exist_ok=True)
        ledger.write_text(json.dumps({"supervisor": {"executions": executions}}))
        return mock.patch.dict(os.environ, {run.EXECUTION_ENV: "x0123456789ab"})

    def test_inside_a_supervised_execution_the_supervisors_other_executions_count(self):
        mine = {"x0123456789ab": {"ticket_id": "LOCAL-001", "state": "started"}}
        other = {"y0123456789ab": {"ticket_id": "LOCAL-002", "state": "started"}}
        ended = {"y0123456789ab": {"ticket_id": "LOCAL-002", "state": "finished"}}
        self.cell("LOCAL-001", files=["src/a.py", "src/shared.py"])
        self.cell("LOCAL-002", files=["src/shared.py"])
        with self.supervised({**mine, **other}):
            report = self.schedule("LOCAL-001")
            self.assertEqual((report["start"], report["beside"], report["running"]), ([], ["LOCAL-002"], []))
            (held,) = report["held"]
            self.assertEqual((held["rule"], held["after"]), ("overlap", ["LOCAL-002"]))
            self.assertIn("src/shared.py", held["why"])
        with self.supervised({**mine, **ended}):  # an execution that has ended runs beside nothing
            self.assertEqual([item["ticket_id"] for item in self.schedule("LOCAL-001")["start"]], ["LOCAL-001"])
        self.cell("LOCAL-002", files=["src/b.py"])
        with self.supervised({**mine, **other}):  # no file in common: it takes no place from this run's ceiling either
            self.settings({"tickets": {"provider": "local"}, "factory": {"max_parallel": 1}})
            self.assertEqual([item["ticket_id"] for item in self.schedule("LOCAL-001")["start"]], ["LOCAL-001"])

    def test_a_supervised_peer_with_no_plan_yet_holds_a_ticket_in_the_line(self):
        self.cell("LOCAL-001", files=["src/a.py"])
        self.cell("LOCAL-002", stage="spec-ready")
        executions = {"x0123456789ab": {"ticket_id": "LOCAL-001", "state": "started"}, "y0123456789ab": {"ticket_id": "LOCAL-002", "state": "claimed"}}
        with self.supervised(executions):
            report = self.schedule("LOCAL-001")
            self.assertEqual(report["start"], [])
            self.assertEqual((report["held"][0]["rule"], report["held"][0]["after"]), ("overlap", ["LOCAL-002"]))
        self.cell("LOCAL-001", stage="spec-ready")  # being prepared itself: it writes no code yet, so it goes as far as build
        with self.supervised(executions):
            self.assertEqual(self.schedule("LOCAL-001")["start"], [{"ticket_id": "LOCAL-001", "until": "build"}])
        self.assertEqual(self.schedule("LOCAL-001")["beside"], [])  # a person driving: no execution counts

    def test_bare_numbers_resolve_as_for_next_and_an_ambiguous_one_is_refused(self):
        self.cell("LOCAL-001", files=["a"])
        self.cell("LOCAL-002", files=["b"])
        report = self.schedule("1", "LOCAL-002", "--running", "2")
        self.assertEqual(report["start"], [{"ticket_id": "LOCAL-001", "until": None, "given": "1"}])
        self.assertEqual((report["running"], report["resolved_from"]), (["LOCAL-002"], {"LOCAL-001": "1", "LOCAL-002": "2"}))
        (self.project / ".factory/inbox").mkdir()
        (self.project / ".factory/inbox/JIRA-1.json").write_text(json.dumps({"ticket_id": "JIRA-1"}))
        code, out, err = self.run_cmd("1", "LOCAL-002")
        self.assertEqual((code, out), (1, ""))
        self.assertIn("JIRA-1, LOCAL-001", err)
        self.assertIn("No known ticket has the number 9", self.run_cmd("9")[2])

    def test_it_writes_nothing(self):
        self.cell("LOCAL-001", files=["a"])
        self.cell("LOCAL-002", stage="spec-ready")
        before = tree(self.project)
        self.schedule("LOCAL-001", "LOCAL-002", "LOCAL-003", "--limit", "9", "--dry-run")
        self.schedule("1", "--sequential")
        self.assertEqual(tree(self.project), before)
        self.assertFalse((self.project / ".factory/intake").exists(), "no intake ledger is created")

    def test_a_ticket_named_twice_is_scheduled_once(self):
        self.cell("LOCAL-001", files=["a"])
        report = self.schedule("LOCAL-001", "1", "LOCAL-001")
        self.assertEqual(([item["ticket_id"] for item in report["start"]], report["held"], report["workflow_args"]["tickets"]), (["LOCAL-001"], [], ["LOCAL-001"]))


class DependencyTest(IntakeBase):
    """Dependencies come from the intake ledger through Factory.plan, which reads only."""

    def schedule(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = run.main(["--project", str(self.eng), "schedule", *argv])
        self.assertEqual(code, 0, err.getvalue())
        return json.loads(out.getvalue())

    def test_a_ticket_waits_for_the_tickets_its_slice_depends_on(self):
        self.chain()  # SLICE-001 <- SLICE-002 <- SLICE-003, tickets LOCAL-001..003
        self.product("dispatch", "SLICE-001")
        ledger = (self.eng / ".factory/intake/ledger.json").read_bytes()
        events = (self.eng / ".factory/intake/events.jsonl").read_bytes()
        before = tree(self.eng / ".factory")
        report = self.schedule("LOCAL-003", "LOCAL-002", "LOCAL-001")
        self.assertEqual(report["start"], [{"ticket_id": "LOCAL-001", "until": "build"}])
        self.assertEqual([(item["ticket_id"], item["rule"], item["after"]) for item in report["held"]],
                         [("LOCAL-003", "dependency", ["LOCAL-002"]), ("LOCAL-002", "dependency", ["LOCAL-001"])])
        self.assertEqual(report["held"][0]["why"], "it waits for LOCAL-002 to be integrated")
        self.assertEqual((report["batches"], report["dependencies_known"]), ([["LOCAL-001"], ["LOCAL-002"], ["LOCAL-003"]], True))
        self.assertEqual(((self.eng / ".factory/intake/ledger.json").read_bytes(), (self.eng / ".factory/intake/events.jsonl").read_bytes()), (ledger, events))
        self.assertEqual(tree(self.eng / ".factory"), before)

    def test_integration_releases_the_dependent_ticket(self):
        self.chain()
        self.product("dispatch", "SLICE-001")
        self.integrate("LOCAL-001")
        report = self.schedule("LOCAL-002", "LOCAL-003")
        self.assertEqual(([item["ticket_id"] for item in report["start"]], report["held"][0]["after"]), (["LOCAL-002"], ["LOCAL-002"]))


class SupervisorUsesTheSameRuleTest(unittest.TestCase):
    def test_the_supervisor_calls_decide(self):
        source = (ROOT / "skills/run/scripts/supervisor.py").read_text()
        self.assertIn("schedule.decide(", source)
        self.assertIn('("high-risk", "overlap")', source)

    def test_the_command_starts_nothing(self):
        source = (ROOT / "skills/run/scripts/schedule.py").read_text()
        for word in ("subprocess", "Popen", "os.system", "write_text", "write_bytes", ".open(", "mkdir", "claude", "Workflow"):
            self.assertNotIn(word, source, word)


if __name__ == "__main__":
    unittest.main()
