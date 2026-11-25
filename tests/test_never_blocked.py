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

    def test_e1_without_the_marker_a_person_still_takes_it_over(self):
        self.cell()
        self.put_claim(holder=OTHER)
        step = self.next("T-1", "--holder", MINE)
        self.assertEqual((step["action"], step["claim"]["holder"]), ("plan", MINE))
        self.assertTrue(step["warnings"])

    def test_e1_the_displaced_driver_stops_at_its_next_step_and_a_person_can_take_it_back(self):
        self.cell()
        self.put_claim(holder=OTHER)
        self.next("T-1", "--holder", MINE)
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
            step = self.next("T-1", "--holder", MINE)
        self.assertEqual(calls, [(EXECUTION, "taken-over")])
        self.assertTrue(any("MACH stopped it" in line for line in step["warnings"]), step["warnings"])

    def test_e3_cell_claim_takes_over_for_a_person_and_refuses_for_the_factory(self):
        self.cell()
        self.put_claim(holder=OTHER)
        code, out, err = self.cell_claim("T-1", "plan", "--holder", MINE)
        self.assertEqual(code, 0, err)
        self.assertIn("You have taken it over", json.loads(out)["warnings"][0])
        self.cell("T-2")
        self.put_claim("T-2", holder=OTHER)
        with mock.patch.dict(os.environ, {"MACH_EXECUTION_ID": EXECUTION}):
            code, _, err = self.cell_claim("T-2", "plan", "--holder", MINE)
        self.assertNotEqual(code, 0)
        self.assertIn("a supervised execution never takes a step over", err)

    def test_e4_a_persons_schedule_starts_a_claimed_ticket_and_a_supervised_one_holds_it(self):
        self.cell("T-1")
        self.put_claim("T-1", holder=OTHER)
        code, out, err = self.run_cmd("schedule", "T-1", "--holder", MINE)
        self.assertEqual(code, 0, err)
        report = json.loads(out)
        self.assertEqual([item["ticket_id"] for item in report["start"]], ["T-1"])
        self.assertIn("This run takes it over when it starts T-1", report["warnings"][0])
        self.supervise("T-1")
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
            step = self.next("T-1", "--holder", MINE)
        self.assertTrue(any("refs/mach/cell-files/T-1/taken-over-1" in line for line in step["warnings"]), step["warnings"])
        self.assertEqual(git(work, "status", "--porcelain").stdout, "", "the new worker starts from the last commit")
        self.assertEqual(git(work, "show", "refs/mach/cell-files/T-1/taken-over-1:half.py").stdout, "half written\n")


class LanesTest(LanesBase):
    """E2: lanes another driver's builders hold."""

    def test_e2_a_person_takes_live_lanes_over_and_the_old_lane_builder_stops(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.next_step("--holder", HOLDER)
        self.assertEqual(self.lanes_start()["status"], "OPEN")
        taken = self.next_step("--holder", LANE_OTHER)
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
        code, out, err = self.run2("product", "dispatch", str(number))
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
        done = self.product("dispatch", "SLICE-001", "SLICE-002")
        self.assertEqual(len(done["tickets"]), 2, done)
        said = " ".join(done["warnings"])
        self.assertIn("SLICE-002 depends on", said)
        self.assertIn("which is not merged yet: its build may fail", said)
        self.assertIn("SLICE-002 is one more than the 1 at once this project's settings allow.", said)

    def test_e6_a_slice_not_taken_in_yet_is_taken_in_first(self):
        number = self.ready("SLICE-001", self.epic())
        done = self.product("dispatch", "SLICE-001")
        self.assertEqual(done["tickets"], [str(number)])
        self.assertIn("MACH took in what is marked ready first", done["warnings"][0])

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

    def test_e9_a_copy_that_still_changes_something_lands_on_top_with_its_record_saying_so(self):
        self.slice_cell_like_main(mode="manual")
        text = (self.work / "specs/slices/SLICE-001-invite-teammate.md").read_text()
        self.another_engineer_lands({"specs/slices/SLICE-001-invite-teammate.md": text})
        git(self.project, "pull", "-q", "--no-rebase", "origin", "main")
        code, out, err = self.m("run", "LOCAL-001", "--by-person")
        if code == 0:
            done = json.loads(out)
            self.assertEqual(done["status"], "MERGED")
            record = (self.work / done["change_record"]["path"]).read_text()
            self.assertIn("## Another copy landed first", record)
        else:  # the normal merge path's own checks (tests, landed overlap) send it back: never the landed-elsewhere stop
            self.assertNotIn("was already shipped from another Factory", err)
        self.assertEqual(self.cell_json()["landed_first"]["slice_id"], "SLICE-001")

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
    """No sentence the stations print sends a person to another person, or to another conversation, or tells them a worker may not
    be started. Docstrings and comments are not printed and are not scanned."""

    FOLDERS = ("run", "intent", "build", "merge", "cleanup", "ticket")
    FORBIDDEN = (r"\bask the\b", r"\bthat conversation\b", r"\bdo not start another worker\b", r"\bdo not start a worker\b",
                 r"\bwait for the other worker\b")
    # Allowed: asking the person MACH is talking to is not sending them to someone else.
    ALLOWED = (r"\bask the (person|user) you\b",)

    def strings(self, path):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        docs = set()
        for node in ast.walk(tree):
            if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.body:
                first = node.body[0]
                if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                    docs.add(id(first.value))
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docs:
                yield node.lineno, " ".join(node.value.lower().split())

    def test_no_printed_sentence_sends_a_person_elsewhere(self):
        found = []
        for folder in self.FOLDERS:
            for path in sorted((ROOT / "skills" / folder / "scripts").glob("*.py")):
                for line, text in self.strings(path):
                    cleaned = text
                    for allowed in self.ALLOWED:
                        cleaned = re.sub(allowed, "", cleaned)
                    for pattern in self.FORBIDDEN:
                        if re.search(pattern, cleaned):
                            found.append(f"{path.relative_to(ROOT)}:{line}: {pattern}: {text[:120]}")
        self.assertEqual(found, [])

    def test_the_skills_state_the_rule_and_keep_no_refusal_for_another_persons_hold(self):
        for name in ("run", "intent"):
            text = (ROOT / "skills" / name / "SKILL.md").read_text(encoding="utf-8")
            self.assertIn("A person's request is carried out", text, name)
            for phrase in ("Do not start a worker", "Never work around a hold", "ask for a yes, and only on that yes dispatch with `--take-over`",
                           "You can wait, or tell me to take over"):
                self.assertNotIn(phrase, text, (name, phrase))


if __name__ == "__main__":
    unittest.main()
