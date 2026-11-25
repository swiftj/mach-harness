"""The owner's rule of 2026-11-25, stated as tests: a person's request is carried out, and MACH never blocks anyone.

"We should ALWAYS let anyone on the project 'take over' a slice that someone else is working on. MACH should warn that someone
else may be working on it but it should never prevent any MACH user from a human making a decision to work on the same thing."

For each hold that used to refuse a person (E1 to E6, and E9 at the merge), a person naming the ticket gets the work, with the
warnings said first, and exit code 0. Work the Factory picks by itself (a pull's choice, product dispatch --ready, a supervised
execution) keeps the scheduling rules and never takes anything over. A worker a take-over displaced is refused at its next station
call. And no sentence the stations print sends a person to another person or to "that conversation".

Tests never start a real supervisor, `claude` or `gh`: the GitHub stand-in and the fake supervisor here are the fixtures' own.
"""

import ast
import contextlib
import io
import json
import os
import re
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
for folder in ("run", "intent", "build", "merge", "cleanup", "verify", "review"):
    sys.path.insert(0, str(ROOT / "skills" / folder / "scripts"))
import run  # noqa: E402
import cell as cell_script  # noqa: E402
import build  # noqa: E402
import merge  # noqa: E402
import cleanup  # noqa: E402
import verify  # noqa: E402
import review  # noqa: E402
import executor  # noqa: E402
import supervisor as supervisor_module  # noqa: E402
from test_mach_claim import Base as ClaimBase, MINE, OTHER, ago  # noqa: E402
from test_run_lanes import Base as LanesBase  # noqa: E402
from test_build_lanes import HOLDER, OTHER as LANE_OTHER, TICKET  # noqa: E402
from test_mach_pull import PullBase  # noqa: E402
from test_team_factory import TwoFactories  # noqa: E402
from test_team_merge import SharedRemote, SPEC, spec_sha  # noqa: E402
from test_build import git  # noqa: E402

C = run.claims()
EXECUTION = "x0123456789ab"


def capture(main, argv):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = main(argv)
    return code, out.getvalue(), err.getvalue()


class OneTicketTest(ClaimBase):
    """E1, E3, E4: one ticket another worker has, on this machine."""

    def test_e1_naming_a_ticket_takes_another_workers_step_over_with_a_warning(self):
        self.cell(stage="building", isolation="none")
        self.put_claim(step="build", stage="building", holder=OTHER, at=ago(3))
        code, out, err = self.run_cmd("next", "T-1", "--holder", MINE, "--by-person")
        self.assertEqual(code, 0, err)
        step = json.loads(out)
        self.assertEqual((step["action"], step["stop"]), ("build", False))
        self.assertEqual(list(step)[0], "warnings")
        self.assertRegex(step["warnings"][0], r"^Another worker was handed the build step for this ticket at \d\d:\d\d UTC and may still be at work\. "
                                              r"You have taken it over; that worker is stopped at its next step\.$")
        self.assertNotIn(OTHER, out)

    def test_e1_without_the_marker_a_look_writes_nothing_and_says_how_to_take_it(self):
        self.cell()
        self.put_claim(holder=OTHER, at=ago(3))
        before = self.path().read_text()
        for extra in ((), ("--holder", MINE)):
            step = self.next("T-1", *extra)
            self.assertEqual((step["action"], step["needs"]), ("stop", "worker-in-cell"), extra)
            self.assertRegex(step["reason"], r"^Another worker was handed the plan step at \d\d:\d\d UTC\. Say /mach T-1 and MACH takes it over\.$")
        self.assertEqual(self.path().read_text(), before, "a look writes no claim")
        self.assertEqual(C.displaced_all(self.path().parent), {}, "and displaces nobody")

    def test_e1_reading_commands_never_displace_anyone(self):
        self.cell()
        (self.root / ".factory" / "intake").mkdir()
        (self.root / ".factory" / "intake" / "ledger.json").write_text(json.dumps(
            {"supervisor": {"executions": {EXECUTION: {"ticket_id": "T-1", "state": "started"}}}}))
        self.put_claim(holder=run.execution_holder(EXECUTION))
        before = self.path().read_text()
        with mock.patch.object(run, "factory_context", side_effect=AssertionError("a look stopped a Factory run")):
            for argv in (("next", "T-1"), ("next", "T-1", "--headless"), ("status",), ("explain", "T-1", "--json")):
                code, _, err = self.run_cmd(*argv)
                self.assertEqual(code, 0, (argv, err))
        self.assertEqual(self.path().read_text(), before)
        self.assertEqual(C.displaced_all(self.path().parent), {})

    def test_e1_the_displaced_driver_stops_at_its_next_step_and_a_person_can_take_it_back(self):
        self.cell()
        self.put_claim(holder=OTHER)
        self.next("T-1", "--holder", MINE, "--by-person")
        stopped = self.next("T-1", "--holder", OTHER)
        self.assertEqual((stopped["action"], stopped["needs"]), ("stop", "taken-over"))
        self.assertIn("This ticket was taken over by a person at", stopped["reason"])
        self.assertIn("nothing it had not committed is used", stopped["reason"])
        back = self.next("T-1", "--holder", OTHER, "--by-person")
        self.assertEqual((back["action"], back["claim"]["holder"]), ("plan", OTHER), "naming it again hands it back")
        self.assertEqual(self.next("T-1", "--holder", MINE)["needs"], "taken-over")

    def test_e1_the_supervised_execution_does_not_take_over_and_may_not_say_by_person(self):
        self.cell()
        self.supervise()
        self.put_claim(holder=OTHER)
        self.assertEqual(self.next("T-1", "--holder", MINE)["needs"], "worker-in-cell")
        code, _, err = self.run_cmd("next", "T-1", "--holder", MINE, "--by-person")
        self.assertEqual(code, 1)
        self.assertIn("supervised Factory execution", err)
        self.assertEqual(self.saved()["holder"], OTHER)

    def test_e1_an_execution_holder_without_the_variable_is_still_the_factory(self):
        self.cell()
        (self.root / ".factory" / "intake").mkdir()
        (self.root / ".factory" / "intake" / "ledger.json").write_text(json.dumps(
            {"supervisor": {"executions": {EXECUTION: {"ticket_id": "T-1", "state": "started"}}}}))
        self.put_claim(holder=OTHER)
        self.assertEqual(self.next("T-1", "--holder", run.execution_holder(EXECUTION))["needs"], "worker-in-cell")

    def test_e1_a_supervised_execution_taken_over_is_stopped_by_the_supervisors_own_stop(self):
        self.cell()
        (self.root / ".factory" / "intake").mkdir()
        (self.root / ".factory" / "intake" / "ledger.json").write_text(json.dumps(
            {"supervisor": {"executions": {EXECUTION: {"ticket_id": "T-1", "state": "started"}}}}))
        self.put_claim(holder=run.execution_holder(EXECUTION))
        calls = []

        class Sup:
            def stop_executions(self, only=None, reason=None):
                calls.append((only, reason))
                return [{"execution_id": only, "ticket_id": "T-1", "signalled": True}]

        with mock.patch.object(run, "factory", return_value=(None, None)), \
                mock.patch.object(run, "factory_context", return_value=mock.Mock(sup=Sup())):
            self.assertEqual(self.next("T-1", "--holder", MINE)["needs"], "worker-in-cell")
            self.assertEqual(calls, [], "a call without the person's word stops no Factory run")
            step = self.next("T-1", "--holder", MINE, "--by-person")
        self.assertEqual(calls, [(EXECUTION, "taken-over")])
        self.assertTrue(any("MACH stopped it" in line for line in step["warnings"]), step["warnings"])

    def test_e3_cell_claim_takes_over_for_a_person_and_refuses_for_the_factory(self):
        self.cell()
        self.put_claim(holder=OTHER)
        code, _, err = self.cell_claim("T-1", "plan", "--holder", MINE)
        self.assertNotEqual(code, 0, "without the person's word nothing is taken over")
        self.assertIn("Say /mach T-1 and MACH takes it over", err)
        code, out, err = self.cell_claim("T-1", "plan", "--holder", MINE, "--by-person")
        self.assertEqual(code, 0, err)
        self.assertIn("You have taken it over", json.loads(out)["warnings"][0])
        self.cell("T-2")
        self.put_claim("T-2", holder=OTHER)
        with mock.patch.dict(os.environ, {"MACH_EXECUTION_ID": EXECUTION}):
            code, _, err = self.cell_claim("T-2", "plan", "--holder", MINE)
            self.assertIn("a supervised execution never takes a step over", err)
            code2, _, err2 = self.cell_claim("T-2", "plan", "--holder", MINE, "--by-person")
        self.assertNotEqual(code, 0)
        self.assertNotEqual(code2, 0)
        self.assertIn("supervised Factory execution", err2)

    def test_e8_a_failure_says_once_that_it_was_started_before_its_dependency_was_merged(self):
        self.cell(stage="blocked", started_before=["#41"])
        step = self.next("T-1")
        self.assertEqual(step["reason"].count("It was started before #41, which it depends on, was merged"), 1)
        code, out, err = self.run_cmd("explain", "T-1", "--json")
        self.assertEqual(code, 0, err)
        self.assertIn("It was started before #41", json.loads(out)["started_before"])
        self.cell("T-2", stage="blocked")
        self.assertNotIn("started before", self.next("T-2")["reason"])

    def test_e4_a_persons_schedule_starts_a_claimed_ticket_and_a_supervised_one_holds_it(self):
        self.cell("T-1")
        self.put_claim("T-1", holder=OTHER)
        self.assertEqual(json.loads(self.run_cmd("schedule", "T-1", "--holder", MINE)[1])["held"][0]["rule"], "claimed",
                         "without --named the schedule holds it")
        code, out, err = self.run_cmd("schedule", "T-1", "--holder", MINE, "--named")
        self.assertEqual(code, 0, err)
        report = json.loads(out)
        self.assertEqual([item["ticket_id"] for item in report["start"]], ["T-1"])
        self.assertIn("This run takes it over when it starts T-1", report["warnings"][0])
        self.assertTrue(report["workflow_args"]["named"], "the belt's first next says a person named it")
        self.supervise("T-1")
        code, _, err = self.run_cmd("schedule", "T-1", "--holder", MINE, "--named")
        self.assertEqual(code, 1)
        code, out, err = self.run_cmd("schedule", "T-1", "--holder", MINE)
        self.assertEqual(json.loads(out)["held"][0]["rule"], "claimed")


class DisplacedWorkerTest(ClaimBase):
    """A worker a person's take-over displaced is refused at its next call to any station; any other worker is not."""

    STATIONS = (("build", build.main, ["status", "T-1"]), ("verify", verify.main, ["status", "T-1"]),
                ("review", review.main, ["status", "T-1"]), ("merge", merge.main, ["status", "T-1"]),
                ("cleanup", cleanup.main, ["plan", "T-1"]), ("cell", cell_script.main, ["status", "T-1"]))

    def test_every_station_refuses_a_displaced_holder(self):
        folder = self.cell()
        C.displace(folder, [OTHER], "build")
        for name, main, argv in self.STATIONS:
            code, out, err = capture(main, ["--project", str(self.root), *argv, "--holder", OTHER])
            self.assertNotEqual(code, 0, name)
            self.assertIn("This ticket was taken over by a person at", err, name)
            self.assertIn("This worker's part stops here; nothing it had not committed is used.", err, name)

    def make_repo(self, folder):
        work = folder / "repo"
        work.mkdir()
        git(work, "init", "-q")
        for key, value in (("user.name", "T"), ("user.email", "t@example.com"), ("commit.gpgsign", "false")):
            git(work, "config", key, value)
        (work / "a.py").write_text("A = 1\n")
        git(work, "add", "-A")
        git(work, "commit", "-q", "-m", "base")
        return work

    def test_a_holderless_call_that_changes_something_is_refused_while_a_take_over_stands(self):
        folder = self.cell(stage="building", isolation="none")
        self.put_claim(step="build", stage="building", holder=OTHER)
        self.next("T-1", "--holder", MINE, "--by-person")
        for name, main, argv in (("build", build.main, ["start", "T-1"]), ("verify", verify.main, ["start", "T-1"]),
                                 ("review", review.main, ["start", "T-1"]), ("cleanup", cleanup.main, ["run", "T-1"]),
                                 ("cell", cell_script.main, ["finalize", "T-1"])):
            code, _, err = capture(main, ["--project", str(self.root), *argv])
            self.assertNotEqual(code, 0, name)
            self.assertIn("this call names no holder, so MACH cannot tell it from the worker taken over", err, name)
            self.assertIn("run.py next T-1 --by-person --holder new", err, name)
        for name, main, argv in self.STATIONS:  # reading is never refused
            _, _, err = capture(main, ["--project", str(self.root), *argv])
            self.assertNotIn("names no holder", err, name)
        self.assertTrue(folder.exists())

    def take_build_over(self, stage="building"):
        folder = self.cell(stage=stage, isolation="worktree")
        work = self.make_repo(folder)
        self.put_claim(step="build" if stage == "building" else "plan", stage=stage, holder=OTHER)
        with mock.patch.object(run, "git", side_effect=lambda cwd, *args: git(work, *args)):
            self.next("T-1", "--holder", MINE, "--by-person")
        return folder, work

    def test_nothing_is_reset_after_a_take_over_a_hand_commit_stays_and_is_warned_about_once(self):
        folder, work = self.take_build_over()
        (work / "late.py").write_text("LATE = 1\n")
        git(work, "add", "-A")
        git(work, "commit", "-q", "-m", "a commit made by hand after the take-over")
        late = git(work, "rev-parse", "HEAD").stdout.strip()
        (work / "half.py").write_text("an uncommitted file\n")
        (folder / "build.json").write_text(json.dumps({"loop": 0, "deviations": []}))
        (folder / "build-report.json").write_text(json.dumps({"review_loop": 0, "deviations": []}))
        code, _, err = capture(build.main, ["--project", str(self.root), "status", "T-1", "--holder", MINE])
        self.assertRegex(err, r"1 commit\(s\) were made on this branch outside MACH's stations since the take-over at \d\d:\d\d UTC \("
                              + late[:10] + r"\)\. They are part of this change now: reviewers see them\. If they are not wanted, remove them "
                              r"before the next step\.")
        self.assertNotIn("worker taken over", err, "who made it is not known, so nobody is named")
        self.assertEqual(git(work, "rev-parse", "HEAD").stdout.strip(), late, "nothing is reset")
        self.assertTrue((work / "half.py").is_file(), "and no file is moved")
        deviations = json.loads((folder / "build.json").read_text())["deviations"]
        self.assertEqual([(item["type"], item["commits"]) for item in deviations], [("commits-outside-stations", [late])],
                         "recorded for the reviewers the way deviations are")
        report = json.loads((folder / "build-report.json").read_text())["deviations"]
        self.assertEqual([item["type"] for item in report], ["commits-outside-stations"], "the build report the review packet names shows it")
        _, _, again = capture(build.main, ["--project", str(self.root), "status", "T-1", "--holder", MINE])
        self.assertNotIn("outside MACH's stations", again, "said once")

    def test_a_merge_of_main_by_hand_stays_and_nothing_loops(self):
        folder, work = self.take_build_over()
        git(work, "checkout", "-q", "-b", "side")
        (work / "side.py").write_text("SIDE = 1\n")
        git(work, "add", "-A")
        git(work, "commit", "-q", "-m", "on main meanwhile")
        git(work, "checkout", "-q", "-")
        git(work, "merge", "-q", "--no-ff", "-m", "a person merges main by hand", "side")
        merged = git(work, "rev-parse", "HEAD").stdout.strip()
        for _ in range(2):
            capture(build.main, ["--project", str(self.root), "status", "T-1", "--holder", MINE])
            self.assertEqual(git(work, "rev-parse", "HEAD").stdout.strip(), merged)

    def test_a_commit_made_inside_a_station_call_is_never_warned_about(self):
        folder, work = self.take_build_over()
        self.assertIsNone(C.watch(folder, "T-1"))
        (work / "contract.proto").write_text("syntax = 1\n")
        git(work, "add", "-A")
        git(work, "commit", "-q", "-m", "a station's own commit, inside its call")
        C.record(folder)  # the station call ends on it
        self.assertIsNone(C.watch(folder, "T-1"))

    def test_an_old_pair_of_specs_under_one_number_does_not_block_re_finalizing_either(self):
        (self.root / "pair").mkdir()
        work = self.make_repo(self.root / "pair")
        names = ("SLICE-001-invite-teammate.md", "SLICE-001-engineers-own.md")
        (work / "specs" / "slices").mkdir(parents=True)
        for name in names:
            (work / "specs" / "slices" / name).write_text(f"# SLICE-001: {name}\n")
        git(work, "add", "-A")
        git(work, "commit", "-q", "-m", "an old pair under one number")
        used, _ = cell_script.scan_ids([work / "specs" / "slices"])
        self.assertEqual(sorted(used[1].split(" and ")), sorted(names), "the allocator names both files")
        import validate_slice
        finding = validate_slice.Finding("error", 0, "duplicate-slice-id", f"SLICE-001 is already used by {names[1]}. Choose a new ID with 'cell.py next-id'.")
        shown = cell_script.shared_number(work, work / "specs" / "slices" / names[0], finding)
        self.assertEqual(shown.severity, "warning")
        self.assertIn(f"{names[0]} (this one, which keeps its number) and {names[1]}", shown.message)
        fresh = cell_script.shared_number(work, work / "specs" / "slices" / "SLICE-001-brand-new.md", finding)
        self.assertEqual(fresh.severity, "error", "a new spec taking a used number still chooses another")

    def test_the_holderless_refusal_lasts_the_claim_window_once(self):
        folder, _ = self.take_build_over()
        from datetime import datetime, timedelta, timezone
        self.assertTrue(C.in_claim_window(folder, 90))
        self.assertFalse(C.in_claim_window(folder, 90, at=datetime.now(timezone.utc) + timedelta(minutes=91)))

    def test_a_holder_not_displaced_and_no_holder_pass_the_gate(self):
        folder = self.cell()
        C.displace(folder, [OTHER], "build")
        for name, main, argv in self.STATIONS:
            for extra in (["--holder", MINE], []):
                _, _, err = capture(main, ["--project", str(self.root), *argv, *extra])
                self.assertNotIn("taken over by a person", err, (name, extra))

    def test_the_take_over_of_a_build_keeps_the_old_workers_uncommitted_files_under_a_ref(self):
        folder = self.cell(stage="building", isolation="worktree")
        work = folder / "repo"
        work.mkdir()
        git(work, "init", "-q")
        for key, value in (("user.name", "T"), ("user.email", "t@example.com"), ("commit.gpgsign", "false")):
            git(work, "config", key, value)
        (work / "a.py").write_text("A = 1\n")
        git(work, "add", "-A")
        git(work, "commit", "-q", "-m", "base")
        (work / "a.py").write_text("A = 2\n")
        (work / "half.py").write_text("half written\n")
        self.put_claim(step="build", stage="building", holder=OTHER)
        with mock.patch.object(run, "git", side_effect=lambda cwd, *args: git(work, *args)):
            step = self.next("T-1", "--holder", MINE, "--by-person")
        self.assertTrue(any("refs/mach/cell-files/T-1/taken-over-1" in line for line in step["warnings"]), step["warnings"])
        self.assertEqual(git(work, "status", "--porcelain").stdout, "", "the new worker starts from the last commit")
        self.assertEqual(git(work, "show", "refs/mach/cell-files/T-1/taken-over-1:half.py").stdout, "half written\n")


class LanesTest(LanesBase):
    """E2: lanes another driver's builders hold."""

    def test_e2_a_lanes_join_after_a_take_over_stays_and_the_records_agree_with_the_branch(self):
        from test_build_lanes import L1, L2
        self.ready_lanes()
        self.ok("start", TICKET)
        self.next_step("--holder", HOLDER)
        self.assertEqual(self.lanes_start()["status"], "OPEN")
        self.next_step("--holder", LANE_OTHER, "--by-person")
        self.assertEqual(self.lanes_start(LANE_OTHER)["status"], "OPEN")
        for name, steps in (("L1", L1), ("L2", L2)):
            for task, step, files in steps:
                self.put(self.lane_work(name), files)
                code, _, err = self.run_build(step, TICKET, task, "--holder", LANE_OTHER)
                self.assertEqual(code, 0, err)
        joined = self.lanes_join("--holder", LANE_OTHER)
        self.assertEqual(joined["status"], "JOINED", joined)
        work = self.cellroot / "repo"
        head = git(work, "rev-parse", "HEAD").stdout.strip()
        code, _, err = self.run_build("status", TICKET, "--holder", LANE_OTHER)
        self.assertNotIn("outside MACH's stations", err, "the join is a station's commit")
        self.assertEqual(git(work, "rev-parse", "HEAD").stdout.strip(), head, "nothing is reset")
        state = json.loads((self.cellroot / "build.json").read_text())
        for task in state.get("tasks") or []:
            if task.get("status") == "done" and task.get("commit"):
                self.assertEqual(git(work, "merge-base", "--is-ancestor", task["commit"], "HEAD").returncode, 0, task["id"])

    def test_e2_a_person_takes_live_lanes_over_and_the_old_lane_builder_stops(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.next_step("--holder", HOLDER)
        self.assertEqual(self.lanes_start()["status"], "OPEN")
        self.assertEqual(self.next_step("--holder", LANE_OTHER)["needs"], "worker-in-cell", "without the person's word: nothing is taken")
        waiting = self.lanes_start(LANE_OTHER)
        self.assertEqual(waiting["status"], "WAIT")
        self.assertIn(f"Say /mach {TICKET} and MACH takes it over", waiting["next"])
        self.assertNotIn("supervised execution", waiting["next"], "a person is not told about a supervised execution")
        taken = self.next_step("--holder", LANE_OTHER, "--by-person")
        self.assertEqual(taken["action"], "build-lanes")
        self.assertTrue(taken["warnings"])
        opened = self.lanes_start(LANE_OTHER)
        self.assertEqual(opened["status"], "OPEN")
        code, _, err = self.run_build("next", TICKET, "--lane", "L1", "--holder", HOLDER)
        self.assertEqual(code, 1)
        self.assertIn("taken over by a person", err)


class PullTest(PullBase):
    """E5: the pull's own choice leaves a claimed ticket alone, and says how a person takes it: by naming it."""

    def test_e5_the_pull_says_how_to_take_it(self):
        a, _ = self.issues(2)
        self.pull()
        C.take(self.eng / ".factory/worktrees" / str(a), "plan", C.new_holder(), C.minutes({}))
        held = self.waiting(self.pull())["SLICE-001"]
        self.assertEqual(held["rule"], "claimed")
        self.assertIn(f"say /mach:run {a} and MACH takes it over", held["then"])


class OtherFactoryTest(TwoFactories):
    """E6: a slice another machine's Factory is building."""

    def test_e6_naming_the_slice_takes_it_over_without_a_flag_a_plan_or_a_yes(self):
        number = self.ready("SLICE-001", self.epic())
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.product2("intake")
        self.assertEqual(self.product2("dispatch", "--ready")["tickets"], [], "the Factory's own choice still skips it")
        plain = self.product2("dispatch", "SLICE-001")
        self.assertEqual(plain["tickets"], [], "without the engineer's word it is the Factory's rule")
        self.assertIn(f"An engineer who names it builds it here as well: /mach {number}, or product dispatch SLICE-001 --by-person.",
                      plain["refused"][0]["why"])
        code, out, err = self.run2("product", "dispatch", str(number), "--by-person")
        self.assertEqual(code, 0, err)
        done = json.loads(out)
        self.assertEqual((done["tickets"], done["refused"]), ([str(number)], []))
        self.assertEqual(list(done)[0], "warnings")
        self.assertTrue(done["warnings"][0].startswith("@erin-eng's Factory has been building SLICE-001 since"))
        self.assertEqual(done["dispatched"][0]["branch"], f"feature/{number}-erin-eng")
        self.assertNotIn("ask", " ".join(done["warnings"]).lower())

    def test_e6_an_unmerged_dependency_and_the_ceiling_are_warnings(self):
        config = self.eng / ".factory/config.json"
        data = json.loads(config.read_text())
        data["factory"] = {"max_parallel": 1}
        config.write_text(json.dumps(data))
        epic = self.epic()
        first = self.ready("SLICE-001", epic)
        self.ready("SLICE-002", epic, depends=[first], title="Remove a teammate")
        self.product("intake")
        done = self.product("dispatch", "SLICE-001", "SLICE-002", "--by-person")
        self.assertEqual(len(done["tickets"]), 2, done)
        dependent = json.loads((self.eng / ".factory/worktrees" / done["tickets"][1] / "cell.json").read_text())
        self.assertEqual(len(dependent["started_before"]), 1, "kept, so a failure later says it was started early")
        said = " ".join(done["warnings"])
        self.assertIn("SLICE-002 depends on", said)
        self.assertIn("which is not merged yet: its build may fail", said)
        self.assertIn("SLICE-002 is one more than the 1 at once this project's settings allow.", said)

    def test_e6_a_slice_not_taken_in_yet_is_taken_in_first(self):
        number = self.ready("SLICE-001", self.epic())
        done = self.product("dispatch", "SLICE-001", "--by-person")
        self.assertEqual(done["tickets"], [str(number)])
        self.assertIn("MACH took in what is marked ready first", done["warnings"][0])

    def test_e6_a_taken_over_slice_gets_a_branch_of_its_own_and_its_activity_and_pull_requests_are_seen(self):
        number = self.ready("SLICE-001", self.epic())
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.product2("intake")
        state = self.gh()
        state["pulls"] = [{"head": f"feature/{number}-erin-eng", "number": 78, "url": "https://github.com/acme/team-space/pull/78", "author": {"login": "ben-pm"}}]
        self.write_state(state)
        _, line = run.factory(run.Project(self.eng2))
        git(self.eng2, "update-ref", f"refs/remotes/origin/feature/{number}-erin-eng", "HEAD")
        self.assertIsNotNone(line.branch_active_at(number), "the taken-over copy's branch counts as activity")
        entry = line.ledger()["slices"]["SLICE-001"]
        branch = line.own_branch(dict(entry, claim={"login": "erin-eng"}))
        self.assertRegex(branch, rf"^feature/{number}-erin-eng-f[0-9a-f]{{6}}$", "the same account taking it over twice gets another name")
        done = self.product2("dispatch", "SLICE-001", "--by-person")
        notes = done["dispatched"][0].get("notes") or []
        self.assertTrue(any("#78" in note for note in notes), notes)

    def test_e6_a_supervised_execution_never_takes_a_slice_over(self):
        self.ready("SLICE-001", self.epic())
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.product2("intake")
        _, line = run.factory(run.Project(self.eng2))
        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(out):
            done = line.dispatch(["SLICE-001"], by="supervisor", authorize=lambda plan: (True, "ok"))
        self.assertEqual(done["tickets"], [])


class MeetingPointTest(SharedRemote):
    """E9: a person's merge of a second copy of a slice that already landed, and of a slice number another slice holds."""

    def slice_cell_like_main(self, **config):
        """Approved, from a slice whose spec is this branch's own spec (so a copy landing it is this same revision)."""
        head = self.approved(**config)
        text = (self.work / "specs/slices/SLICE-001-invite-teammate.md").read_text()
        sys.path.insert(0, str(ROOT / "skills" / "run" / "scripts"))
        import intake
        self.set_cell(product={"slice_id": "SLICE-001", "spec_sha256": intake.text_sha(intake.without_header(text)[0]), "revision": 1})
        return head

    def another_copy_of_everything_lands(self):
        """Another engineer lands the same change as a commit of its own (a squash): everything in this copy is on main."""
        self.another_engineer_lands({})
        other = self.other()
        git(other, "fetch", "-q", str(self.project), "feature/LOCAL-001")
        git(other, "merge", "-q", "--squash", "FETCH_HEAD")
        git(other, "commit", "-q", "-m", "the other copy of SLICE-001")
        git(other, "push", "-q", "origin", "HEAD:main")
        return git(other, "rev-parse", "HEAD").stdout.strip()

    def test_e9_everything_already_on_main_is_closed_out_without_abandoning(self):
        self.slice_cell_like_main(mode="auto")
        landed = self.another_copy_of_everything_lands()
        git(self.project, "pull", "-q", "--no-rebase", "origin", "main")
        refused = self.m_refused("run", "LOCAL-001")  # the Factory merging on its own stops
        self.assertIn("This copy was not merged", refused)
        done = self.m_ok("run", "LOCAL-001", "--by-person")
        self.assertEqual(done["status"], "ALREADY_ON_MAIN")
        self.assertIn("Everything in this copy is already on main", done["reason"])
        self.assertNotIn("abandon", json.dumps(done).lower())
        merged = self.cell_json()["merged"]
        self.assertEqual(merged["already_on_main"][:12], landed[:12])
        code, out, err = capture(cleanup.main, ["--project", str(self.project), "plan", "LOCAL-001"])
        self.assertEqual(code, 0, err)
        plan = json.loads(out)
        self.assertTrue(plan["allowed"], plan["refusals"])
        self.assertEqual(plan["outcome"], "merged")

    def reapprove(self):
        """Stand in for verification and review passing again on the branch as it now is."""
        head = git(self.work, "rev-parse", "HEAD").stdout.strip()
        decision = json.loads((self.cellroot / "review/decision.json").read_text())
        decision.update({"outcome": "APPROVED", "head": head})
        decision.pop("void", None)
        self.put(self.cellroot, {"review/decision.json": json.dumps(decision)})
        self.set_cell(stage="approved", review="APPROVED")

    def test_e9_a_copy_that_still_changes_something_is_reviewed_against_main_once_then_lands_on_top(self):
        self.slice_cell_like_main(mode="manual")
        self.put(self.project, {".factory/config.json": json.dumps({"merge": {"mode": "manual", "revalidate_overlap": False}})})
        text = (self.work / "specs/slices/SLICE-001-invite-teammate.md").read_text()
        landed = self.another_engineer_lands({"specs/slices/SLICE-001-invite-teammate.md": text})
        git(self.project, "pull", "-q", "--no-rebase", "origin", "main")
        code, out, err = self.m("run", "LOCAL-001", "--by-person")
        self.assertEqual(code, 3, err)
        first = json.loads(out)
        self.assertEqual(first["status"], "RECHECK", "voided once, whatever merge.revalidate_overlap says")
        self.assertEqual(self.cell_json()["stage"], "built")
        self.assertEqual(git(self.work, "merge-base", "--is-ancestor", landed, "HEAD").returncode, 0, "main is merged into the copy")
        self.reapprove()
        done = self.m_ok("run", "LOCAL-001", "--by-person")
        self.assertEqual(done["status"], "MERGED")
        record = (self.work / done["change_record"]["path"]).read_text()
        self.assertIn("## Another copy landed first", record)
        self.assertIn(landed[:12], record)

    def test_e9_a_conflict_at_the_meeting_point_routes_to_the_main_conflict_step(self):
        self.slice_cell_like_main(mode="manual")
        changed = [line.split()[-1] for line in git(self.work, "diff", "--name-only", "main", "HEAD").stdout.split()] or []
        target = next(name for name in git(self.work, "diff", "--name-only", "main", "HEAD").stdout.split() if not name.startswith("specs/"))
        text = (self.work / "specs/slices/SLICE-001-invite-teammate.md").read_text()
        self.another_engineer_lands({"specs/slices/SLICE-001-invite-teammate.md": text, target: "something else entirely\n"})
        git(self.project, "pull", "-q", "--no-rebase", "origin", "main")
        err = self.m_refused("run", "LOCAL-001", "--by-person")
        self.assertIn("bringing main into this copy conflicts", err)
        cell = self.cell_json()
        self.assertEqual((cell["stage"], cell["main_conflict"]["during"]), ("built", "meeting"))
        step = run.next_step(run.Project(self.project), "LOCAL-001", False, meet_on_main=True)  # as a person's next --by-person reads it
        self.assertEqual(step["needs"], "main-conflict", "the routing sheet sends it to a person to resolve, never back to the merge")
        self.assertTrue(changed is not None)

    def test_e9_already_on_main_closes_this_copys_own_pull_request(self):
        self.slice_cell_like_main(mode="auto", method="pr")
        with mock.patch.dict(os.environ, {"FAKE_GH_BLOCK": "1"}):
            code, out, _ = self.m("run", "LOCAL-001")
        self.assertEqual(json.loads(out)["status"], "PR_OPEN")
        self.another_copy_of_everything_lands()
        done = self.m_ok("run", "LOCAL-001", "--by-person")
        self.assertEqual(done["status"], "ALREADY_ON_MAIN")
        self.assertIn("pull request (https://github.com/acme/app/pull/12) is closed, with a comment naming that commit", done["reason"])
        self.assertTrue(any(call[:2] == ["pr", "close"] for call in self.calls()))

    def test_e9_a_holderless_merge_by_person_is_refused_while_a_take_over_stands(self):
        self.approved(mode="manual")
        folder = self.cellroot
        C.displace(folder, ["b" * 32], "merge", taker="c" * 32)
        C.write(folder, {"step": "merge", "stage": "approved", "holder": "c" * 32, "at": C.stamp(C.now()), "renewed_at": C.stamp(C.now())})
        err = self.m_refused("run", "LOCAL-001", "--by-person")
        self.assertIn("this call names no holder, so MACH cannot tell it from the worker taken over", err)
        self.assertEqual(self.cell_json()["stage"], "approved")
        self.assertEqual(self.m("run", "LOCAL-001", "--by-person", "--holder", "b" * 32)[0], 1, "and a displaced worker's own holder is refused")

    def test_e9_two_specs_under_one_number_on_main_are_counted_once_and_found_by_their_own_text(self):
        """The 0.20.0 rule lets a Studio slice land beside another spec that carries its number: the allocator still counts the number
        as taken and gives the next one, and intake still finds the slice it follows by its own approved text."""
        self.approved(mode="manual")
        self.another_engineer_lands({"specs/slices/SLICE-001-something-else.md": "# SLICE-001: Something else\n\nAnother slice.\n",
                                     "specs/slices/SLICE-001-invite-a-teammate.md": SPEC})
        git(self.project, "pull", "-q", "--no-rebase", "origin", "main")
        code, out, err = capture(cell_script.main, ["--project", str(self.project), "next-id", "--count", "1"])
        self.assertEqual(code, 0, err)
        self.assertNotEqual(json.loads(out)["next"], ["SLICE-001"])
        sys.path.insert(0, str(ROOT / "skills" / "run" / "scripts"))
        import intake
        found = intake.already_landed(self.project, "SLICE-001", spec_sha(SPEC), ["refs/heads/main"])
        self.assertEqual(found["path"], "specs/slices/SLICE-001-invite-a-teammate.md")

    def test_e9_merge_by_person_is_refused_inside_a_supervised_execution(self):
        self.approved(mode="manual")
        with mock.patch.dict(os.environ, {"MACH_EXECUTION_ID": EXECUTION}):
            err = self.m_refused("run", "LOCAL-001", "--by-person")
        self.assertIn("--by-person is a person's word, and this runs inside a supervised Factory execution", err)
        self.assertEqual(self.cell_json()["stage"], "approved")



    def test_e9_a_slice_number_another_slice_holds_is_renumbered_for_a_person(self):
        self.approved(mode="auto", method="pr")
        self.another_engineer_lands({"specs/slices/SLICE-001-invite-a-teammate.md": SPEC})
        code, out, err = self.m("run", "LOCAL-001", "--by-person")
        self.assertEqual(code, 3, err)
        done = json.loads(out)
        self.assertEqual(done["status"], "RENUMBERED")
        new_id = re.search(r"it is (SLICE-\d{3,}) now", done["reason"]).group(1)
        self.assertNotEqual(new_id, "SLICE-001")
        cell = self.cell_json()
        self.assertTrue(cell["spec_path"].startswith(f"specs/slices/{new_id}-"), cell["spec_path"])
        self.assertEqual(cell["stage"], "built", "the change is verified and reviewed again")
        self.assertIn(new_id, (self.work / cell["spec_path"]).read_text())
        self.assertEqual(self.calls(), [], "nothing pushed, opened or merged in this run")

    def test_e9_the_factorys_own_merge_keeps_its_stop(self):
        self.approved(mode="auto", method="pr")
        self.another_engineer_lands({"specs/slices/SLICE-001-invite-a-teammate.md": SPEC})
        err = self.m_refused("run", "LOCAL-001")
        self.assertIn("two engineers took one slice number", err)


class SupervisorStopTest(unittest.TestCase):
    """The supervisor's own stop for one execution, for a take-over: not parked, no attempt counted, the slice moves to the engineer."""

    def test_a_taken_over_execution_is_not_parked_and_its_slice_moves_to_the_engineer(self):
        import tempfile
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        (root / ".factory" / "local").mkdir(parents=True)
        ledger = {"supervisor": {"executions": {EXECUTION: {"ticket_id": "T-1", "state": "started", "wrapper_pid": 1, "execution_id": EXECUTION}},
                                 "parked": {}, "attempts": {}},
                  "slices": {"SLICE-001": {"ticket_id": "T-1", "owner": "supervisor"}}}

        class Line:
            saved = None

            @contextlib.contextmanager
            def lock(self, name):
                yield

            def ledger(self):
                return ledger

            def save(self, data):
                Line.saved = data

            def emit(self, *args, **kwargs):
                pass

        sup = supervisor_module.Supervisor(root, {}, Line(), next_step=lambda ticket: {}, audit=lambda: {}, git=lambda *a, **k: None,
                                           run_script=root / "run.py", workflow="mach:belt")
        with mock.patch.object(executor, "end_for_takeover", return_value=True) as ended:
            stopped = sup.stop_executions(EXECUTION, reason="taken-over")
        ended.assert_called_once()
        self.assertEqual(stopped[0]["execution_id"], EXECUTION)
        self.assertEqual(ledger["slices"]["SLICE-001"]["owner"], "engineer")
        self.assertEqual(ledger["supervisor"]["parked"], {}, "not parked")
        self.assertIn(executor.TAKEN_OVER, executor.PAUSED, "its end pauses the work: no attempt is counted")

    def test_the_mark_says_how_it_ended(self):
        import tempfile
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        executor.folder(root, EXECUTION).mkdir(parents=True)
        (executor.folder(root, EXECUTION) / executor.TAKEN_OVER_MARK).write_text("now\n")
        self.assertEqual(executor.paused_how(root, EXECUTION), executor.TAKEN_OVER)


class WordsTest(unittest.TestCase):
    """No sentence MACH prints or tells its agents to say sends a person to another person, to another conversation or computer, makes
    them wait for someone, or tells them a worker may not be started because someone else has the work.

    Scanned: every string a Python script under the skills this builder owns can print (docstrings are not printed and are not scanned;
    f-strings are joined with {} for their values), and every sentence of those skills' SKILL.md. The words are the review's list
    (never-block trial, f_scan.py) less those that only name a state or a thing: "already", "refused", "try again", "held", "claimed",
    "release" (release qualification) and "belongs to" (a file belongs to a task). Each allowed sentence below says why it stays."""

    SCRIPTS = ("run", "intent", "build", "merge", "cleanup", "ticket")
    NOT_OURS = ("decide.py", "act.py")  # the decisions and Factory Floor builder's files, scanned by its own tests
    SKILLS = ("run", "intent", "build")
    WORDS = re.compile(r"\bask the|\bwait for|is left to|that conversation|on their computer|do not start|"
                       r"\bask (?:them|him|her|whoever|another|someone|the other)\b|another (?:person|product manager|engineer|pm)\b|"
                       r"\bits owner\b|\bleft alone\b|check with|have someone", re.I)
    ALLOWED = (
        # Words for the very person MACH is talking to, or a rule that names the refusal itself.
        "never ask the person", "ask the person", "never ask the engineer to write mermaid", "ask the engineer, one question at a time",
        "ask the engineer, **one question at a time", "never say you will \"ask the line\"", "ask the script what is next",
        "if a fix needs a business decision, ask the pm", "do not ask the pm to tell you to re-plan", "wait for the person's answer",
        "never refuse because someone else has the work", "the rules that are not about another person",
        "never ask the person to wait, to check with another person, or to have someone release it",  # the rule itself
        "never ask the person to wait or to check with someone else",
        "another person having the work is never a refusal",
        # A worker's own order of work, not another person's hold.
        "a task can only wait for an earlier one", "wait for all of them", "and wait for all.", "you do not start the lanes",
        "do not start stage 2", "do not start anything", "do not try to fix it, and do not start stage 2",
        "then do not start the contract engineer and do not plan it yourself, in either mode",
        # A named owner's decision by design (M14 policy packs), and settings that route a kind of work to a person: not a take-over.
        "waits for its owner", "those wait for an engineer", "changes wait for a person at verification",
        "tickets above this risk tier wait for a person",
        # A file, a worktree or a lane that is left alone (things, not people).
        "the file is left alone", "that worktree is left alone", "nothing is left to",
        # How a person takes work the Factory's own choice did not take, and the walkthrough's own question.
        "when the person then names a ticket the pull left alone",
    )

    def allowed(self, text):
        low = text.lower()
        for phrase in sorted(self.ALLOWED, key=len, reverse=True):  # the longest first, so a short phrase never cuts a long one
            low = low.replace(phrase.lower(), "")
        return not self.WORDS.search(low)

    def strings(self, path):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        docs = set()
        for node in ast.walk(tree):
            if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.body:
                first = node.body[0]
                if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                    docs.add(id(first.value))
        for node in ast.walk(tree):
            if isinstance(node, ast.JoinedStr):
                yield node.lineno, " ".join("".join(v.value if isinstance(v, ast.Constant) else "{}" for v in node.values).split())
            elif isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docs:
                yield node.lineno, " ".join(node.value.split())

    def test_no_printed_sentence_sends_a_person_elsewhere(self):
        found = []
        for folder in self.SCRIPTS:
            for path in sorted((ROOT / "skills" / folder / "scripts").glob("*.py")):
                if path.name in self.NOT_OURS:
                    continue
                for line, text in self.strings(path):
                    if len(text) > 25 and not self.allowed(text):
                        found.append(f"{path.relative_to(ROOT)}:{line}: {text[:160]}")
        self.assertEqual(found, [])

    def test_no_skill_sentence_sends_a_person_elsewhere(self):
        found = []
        for name in self.SKILLS:
            path = ROOT / "skills" / name / "SKILL.md"
            for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                for sentence in re.split(r"(?<=[.!?])\s+", line):
                    if not self.allowed(sentence):
                        found.append(f"{path.relative_to(ROOT)}:{number}: {sentence.strip()[:160]}")
        self.assertEqual(found, [])

    def test_the_skills_state_the_rule_and_keep_no_refusal_for_another_persons_hold(self):
        for name in ("run", "intent"):
            text = (ROOT / "skills" / name / "SKILL.md").read_text(encoding="utf-8")
            self.assertIn("A person's request is carried out", text, name)
            for phrase in ("Do not start a worker", "Never work around a hold", "ask for a yes, and only on that yes dispatch with `--take-over`",
                           "You can wait, or tell me to take over"):
                self.assertNotIn(phrase, text, (name, phrase))
        run_skill = (ROOT / "skills" / "run" / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("never on a look", run_skill, "a status look never passes the person's word")
        self.assertIn("`RUN schedule <a> <b> <c> --named`", run_skill)


if __name__ == "__main__":
    unittest.main()
