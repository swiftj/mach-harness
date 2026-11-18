"""Tests for run.py pull (pull.py): take in what is ready and start the next batch, in one engineer's command.

Pull composes steps that exist already: intake's reconcile, the schedule's rule and intake's guarded dispatch.
These tests use the product intake tests' fixture: slices are GitHub issues marked ready in the stand-in for gh
(or ready folders), and nothing reaches the network. The line is stood in for by editing cell.json and plan.md,
as the schedule tests do.
"""

import hashlib
import io
import json
import os
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "skills" / "run" / "scripts"))
import intake  # noqa: E402
import run  # noqa: E402
from test_mach_product_intake import Base  # noqa: E402
from test_mach_schedule import plan_md  # noqa: E402


def tree(root):
    """Every file under a folder with a digest of its content."""
    if not root.exists():
        return {}
    return {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest() for path in root.rglob("*") if path.is_file()}


class PullBase(Base):
    def run_pull(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = run.main(["--project", str(self.eng), "pull", *argv])
        return code, out.getvalue(), err.getvalue()

    def pull(self, *argv):
        code, out, err = self.run_pull("--json", *argv)
        self.assertEqual(code, 0, err + out)
        return json.loads(out)

    def settings(self, **factory):
        (self.eng / ".factory/config.json").write_text(json.dumps({"tickets": {"provider": "local"}, "factory": factory}))

    def issues(self, count):
        """`count` independent slices, each its own issue in one epic, marked ready in order."""
        epic = self.epic()
        return [self.ready(f"SLICE-{n:03d}", epic) for n in range(1, count + 1)]

    def started(self, report, how=None):
        return [item["ticket_id"] for item in report["start_now"] if how is None or item["how"] == how]

    def waiting(self, report):
        return {item["slice_id"] or item["ticket_id"]: item for item in report["waits"]}

    def in_line(self, ticket, stage="planned", risk="Medium", files=("a.py",)):
        """Stand in for the stations: the ticket's cell is at `stage` with a plan touching `files`."""
        self.set_cell(ticket, stage=stage, risk=risk)
        (self.eng / ".factory/worktrees" / ticket / "plan.md").write_text(plan_md(*files))

    def scheduled(self):
        return [event for event in self.events() if event["type"] == "work.scheduled"]


class NothingReadyTest(PullBase):
    def test_nothing_ready_says_so_and_what_could_be_done(self):
        report = self.pull()
        self.assertEqual((report["run"], report["start_now"], report["nothing_to_run"], report["factory_started"]), ([], [], True, False))
        self.assertIn("Nothing is ready.", report["in_words"][-1])
        self.assertIn("marks a finished slice ready in Product Studio", report["in_words"][-1])
        self.assertFalse((self.eng / ".factory/worktrees").exists())
        code, out, _ = self.run_pull()
        self.assertEqual(code, 0)
        self.assertIn("Nothing is ready.", out)  # without --json, the same report in plain words
        self.assertFalse(out.lstrip().startswith("{"))


class BatchTest(PullBase):
    def test_several_ready_within_and_beyond_the_ceiling(self):
        self.settings(max_parallel=2)
        numbers = self.issues(3)
        report = self.pull()
        self.assertEqual([item["slice_id"] for item in report["taken_in"]["created"]], ["SLICE-001", "SLICE-002", "SLICE-003"])
        self.assertEqual(self.started(report, "dispatched"), [str(numbers[0]), str(numbers[1])])
        self.assertEqual(report["run"], [str(numbers[0]), str(numbers[1])])
        self.assertEqual(report["workflow_args"], {"tickets": report["run"]})
        third = self.waiting(report)["SLICE-003"]
        self.assertEqual((third["rule"], third["in_this_run"], third["then"]), ("ceiling", False, "is dispatched by a later pull"))
        self.assertIn("waiting for a free place: 2 of 2", third["why"])
        for number in numbers[:2]:
            self.assertEqual(self.cell(str(number))["stage"], "spec-ready")
        self.assertFalse((self.eng / ".factory/worktrees" / str(numbers[2])).exists())
        self.assertEqual(self.labels_of(numbers[0]), ["mach:building", "mach:slice"])
        self.assertIn(f"To run: {numbers[0]}, {numbers[1]}.", report["in_words"])
        self.assertFalse((self.eng / ".factory/intake/lock").exists())

    def test_all_ready_within_the_ceiling_start_and_one_is_driven_alone(self):
        (number,) = self.issues(1)
        report = self.pull()
        self.assertEqual((report["run"], report["run_one"]), ([str(number)], f"{run.skill('run')} {number}"))
        self.assertEqual(report["start_now"], [{"ticket_id": str(number), "slice_id": "SLICE-001", "how": "dispatched", "until": "build"}])

    def test_limit_and_sequential_lower_the_ceiling(self):
        numbers = self.issues(3)
        report = self.pull("--limit", "1", "--dry-run")
        self.assertEqual((report["ceiling"]["in_force"], self.started(report)), (1, [str(numbers[0])]))
        report = self.pull("--sequential", "--dry-run")
        self.assertEqual((report["ceiling"]["in_force"], self.started(report)), (1, [str(numbers[0])]))
        report = self.pull("--limit", "9", "--dry-run")
        self.assertEqual((report["ceiling"]["in_force"], report["ceiling"]["clamped_from"]), (3, 9))
        self.assertIn("--limit 9 is above the settings ceiling of 3", report["in_words"][0])
        code, _, err = self.run_pull("--limit", "0")
        self.assertEqual(code, 1)
        self.assertIn("--limit must be a whole number of at least 1", err)
        report = self.pull("--limit", "2")
        self.assertEqual((self.started(report, "dispatched"), report["workflow_args"]), ([str(numbers[0]), str(numbers[1])], {"tickets": report["run"], "limit": 2}))
        report = self.pull("--sequential")
        self.assertEqual(report["workflow_args"]["sequential"], True)
        self.assertEqual(self.started(report, "dispatched"), [])  # one at a time, and one of the two in the line goes first
        self.assertEqual(self.started(report, "carried on"), [str(numbers[0])])
        self.assertEqual(report["run"], [str(numbers[0]), str(numbers[1])])  # the other starts when the first is done, in this run
        self.assertEqual(self.waiting(report)["SLICE-003"]["then"], "is dispatched by a later pull")

    def test_a_dry_run_changes_nothing_and_says_the_same(self):
        self.settings(max_parallel=2)
        numbers = self.issues(3)
        before, gh_before = tree(self.eng / ".factory"), json.dumps(self.gh()["issues"], sort_keys=True)
        dry = self.pull("--dry-run")
        self.assertEqual(tree(self.eng / ".factory"), before)
        self.assertEqual(json.dumps(self.gh()["issues"], sort_keys=True), gh_before)
        self.assertEqual((dry["dry_run"], self.started(dry, "would be dispatched"), dry["run"]), (True, [str(numbers[0]), str(numbers[1])], [str(numbers[0]), str(numbers[1])]))
        self.assertEqual(dry["in_words"][-1], "Nothing was changed: this was a dry run.")
        real = self.pull()
        self.assertEqual((self.started(real, "dispatched"), real["run"], sorted(self.waiting(real))), (self.started(dry), dry["run"], sorted(self.waiting(dry))))

    def test_a_dry_run_of_a_ready_folder_shows_it_without_a_ticket(self):
        self.first()
        dry = self.pull("--dry-run")
        self.assertEqual((dry["start_now"], dry["run"]), ([{"ticket_id": None, "slice_id": "SLICE-001", "how": "would be dispatched", "until": "build"}], []))
        self.assertIn("A slice from a ready folder gets its ticket when it is taken in.", dry["in_words"])
        self.assertFalse(dry["nothing_to_run"])
        self.assertEqual(self.tickets(), [])
        real = self.pull()
        self.assertEqual((self.started(real, "dispatched"), real["run"]), (["LOCAL-001"], ["LOCAL-001"]))


class RulesTest(PullBase):
    def test_a_dependency_not_merged_waits(self):
        epic = self.epic()
        first = self.ready("SLICE-001", epic)
        self.ready("SLICE-002", epic, depends=[first])
        report = self.pull()
        self.assertEqual(self.started(report, "dispatched"), [str(first)])
        second = self.waiting(report)["SLICE-002"]
        self.assertEqual((second["rule"], second["after"], second["in_this_run"]), ("blocked", ["SLICE-001"], False))
        self.assertIn(f"It waits for #{first} (SLICE-001) to be merged", second["why"])

    def test_the_high_risk_limit_holds_a_ticket_in_the_line_for_later_in_this_run(self):
        a, b = self.issues(2)
        self.pull()
        self.in_line(str(a), risk="High", files=["a.py"])
        self.in_line(str(b), risk="High", files=["b.py"])
        report = self.pull()
        self.assertEqual(self.started(report, "carried on"), [str(a)])
        held = self.waiting(report)["SLICE-002"]
        self.assertEqual((held["rule"], held["after"], held["in_this_run"]), ("high-risk", [str(a)], True))
        self.assertEqual(report["run"], [str(a), str(b)])

    def test_file_overlap_holds_a_ticket(self):
        a, b = self.issues(2)
        self.pull()
        self.in_line(str(a), files=["app/x.py"])
        self.in_line(str(b), files=["app/x.py", "app/y.py"])
        report = self.pull()
        held = self.waiting(report)["SLICE-002"]
        self.assertEqual((held["rule"], held["why"]), ("overlap", f"it shares files with {a}: app/x.py"))
        self.assertEqual(report["run"], [str(a), str(b)])

    def test_a_claimed_ticket_is_left_to_its_worker(self):
        a, b = self.issues(2)
        self.pull()
        C = run.claims()
        C.take(self.eng / ".factory/worktrees" / str(a), "plan", C.new_holder(), C.minutes({}))
        report = self.pull()
        held = self.waiting(report)["SLICE-001"]
        self.assertEqual((held["rule"], held["in_this_run"], held["then"]), ("claimed", False, "left to the worker on it"))
        self.assertEqual(report["run"], [str(b)])

    def test_a_not_accepted_issue_is_reported_and_never_built(self):
        state = self.gh()
        state["accounts"]["rae-reader"] = {"id": 3009, "role": "read"}
        self.write_state(state)
        epic = self.epic()
        bad = self.ready("SLICE-001", epic, by="rae-reader")
        good = self.ready("SLICE-002", epic)
        report = self.pull()
        (refused,) = report["not_accepted"]
        self.assertEqual(refused["issue"], bad)
        self.assertIn("without the triage, write, maintain or admin role", refused["reason"])
        self.assertTrue(any(line.startswith(f"Not accepted, never built: Issue #{bad}: ") for line in report["in_words"]))
        self.assertEqual(report["run"], [str(good)])
        self.assertFalse((self.eng / ".factory/worktrees" / str(bad)).exists())


class LineTest(PullBase):
    def test_a_repeated_pull_takes_nothing_in_twice_and_dispatches_nothing_twice(self):
        a, b = self.issues(2)
        first = self.pull()
        self.assertEqual(self.started(first, "dispatched"), [str(a), str(b)])
        comments = (len(self.comments_on(a)), len(self.comments_on(b)))
        again = self.pull()
        self.assertEqual((again["taken_in"]["created"], self.started(again, "dispatched"), self.started(again, "carried on")), ([], [], [str(a), str(b)]))
        self.assertEqual(again["run"], [str(a), str(b)])
        self.assertEqual(len(self.scheduled()), 2)
        self.assertEqual((len(self.comments_on(a)), len(self.comments_on(b))), comments)

    def test_tickets_in_the_line_count_against_the_ceiling_and_new_work_waits(self):
        self.settings(max_parallel=2)
        a, b = self.issues(2)
        self.pull()
        self.ready("SLICE-003", self.epic_number())
        report = self.pull()
        self.assertEqual((self.started(report, "carried on"), self.started(report, "dispatched")), ([str(a), str(b)], []))
        self.assertEqual(self.waiting(report)["SLICE-003"]["rule"], "ceiling")

    def test_tickets_stopped_for_a_person_are_listed_not_started(self):
        a, b = self.issues(2)
        self.pull()
        self.set_cell(str(a), stage="awaiting-human")
        report = self.pull()
        (person,) = report["for_a_person"]
        self.assertEqual((person["ticket_id"], person["slice_id"], person["needs"]), (str(a), "SLICE-001", "human-approval"))
        self.assertEqual(person["why"], "The review panel approved, and a person must approve before merge.")
        self.assertEqual(report["run"], [str(b)])
        self.assertIn(f"Waits for a person: {a} (SLICE-001): {person['why']}", report["in_words"])

    def test_any_stop_is_a_persons_even_one_this_version_does_not_know(self):
        a, b = self.issues(2)
        self.pull()
        real = run.next_step

        def answer(project, ticket_id, headless):
            if ticket_id == str(a):
                return run.step(ticket_id, "spec-ready", "stop", "Planning waits for the architecture decisions this project requires.", needs="adr-baseline")
            return real(project, ticket_id, headless)

        with mock.patch.object(run, "next_step", answer):
            report = self.pull()
        (person,) = report["for_a_person"]
        self.assertEqual((person["ticket_id"], person["needs"], person["why"]), (str(a), "adr-baseline", "Planning waits for the architecture decisions this project requires."))
        self.assertEqual(report["run"], [str(b)])

    def test_finished_tickets_are_left_alone(self):
        (a,) = self.issues(1)
        self.pull()
        self.integrate(str(a), cleanup=True)
        report = self.pull()
        self.assertEqual((report["run"], report["for_a_person"], report["waits"]), ([], [], []))


class RefusalTest(PullBase):
    def test_refused_inside_a_supervised_execution(self):
        self.issues(1)
        ledger = self.eng / ".factory/intake/ledger.json"
        ledger.parent.mkdir(parents=True, exist_ok=True)
        ledger.write_text(json.dumps({"supervisor": {"executions": {"x0123456789ab": {"ticket_id": "LOCAL-001"}}}}))
        before = tree(self.eng / ".factory")
        with mock.patch.dict(os.environ, {run.EXECUTION_ENV: "x0123456789ab"}):
            code, out, err = self.run_pull("--json")
        self.assertEqual((code, out), (1, ""))
        self.assertIn("engineer's command", err)
        self.assertEqual(tree(self.eng / ".factory"), before)

    def test_it_reads_no_machine_local_authorization_and_starts_nothing(self):
        source = (ROOT / "skills/run/scripts/pull.py").read_text()
        for word in ("runner.json", "read_local_policy", "policy", "subprocess", "Popen", "os.system", "claude -p", "\"factory_started\": True", "authorize"):
            self.assertNotIn(word, source, word)
        self.assertIn("schedule.main(", source)
        self.assertIn("line.reconcile()", source)

    def test_one_writer_at_a_time(self):
        self.issues(1)
        (self.eng / ".factory/intake").mkdir(parents=True, exist_ok=True)
        (self.eng / ".factory/intake/lock").write_text(json.dumps({"pid": os.getpid(), "host": __import__("platform").node(), "at": intake.now(), "purpose": "dispatch"}))
        code, _, err = self.run_pull()
        self.assertEqual(code, 1)
        self.assertIn("Another dispatch is running on this Factory", err)
        self.assertFalse((self.eng / ".factory/worktrees").exists())


if __name__ == "__main__":
    unittest.main()
