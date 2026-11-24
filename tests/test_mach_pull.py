"""Tests for run.py pull (pull.py): take in what is ready and hand the batch to the Factory, in one engineer's command.

Pull composes steps that exist already: intake's reconcile, the schedule's rule and intake's guarded dispatch,
and the hand-over (activation.HandOver). These tests use the product intake tests' fixture: slices are GitHub
issues marked ready in the stand-in for gh (or ready folders), and nothing reaches the network. The line is
stood in for by editing cell.json and plan.md, as the schedule tests do.

No test starts a supervisor: the detached start (service.start_detached) is replaced for every test with a
recorder, and the banner's runner (notify.run_osascript) with one that shows nothing. In the fixture the
readiness audit has not run, so the batch runs in the conversation unless a test switches the audit gate off
and puts a stand-in for Claude Code on the PATH (HandOverTest).
"""

import hashlib
import io
import json
import os
import subprocess
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "skills" / "run" / "scripts"))
import intake  # noqa: E402
import notify  # noqa: E402
import policy  # noqa: E402
import run  # noqa: E402
import service  # noqa: E402
import supervisor  # noqa: E402
from test_mach_product_intake import Base  # noqa: E402
from test_mach_product_issues import git, spec_for  # noqa: E402
from test_mach_schedule import plan_md  # noqa: E402


def tree(root):
    """Every file under a folder with a digest of its content."""
    if not root.exists():
        return {}
    return {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest() for path in root.rglob("*") if path.is_file()}


FAKE_PID = 424242


class PullBase(Base):
    def setUp(self):
        super().setUp()
        self.detached = []  # every supervisor a pull would have started: (project, run.py)
        self.how = {}  # how the last one was started: its lifetime, its session, who started it
        self.session = 777001  # the Claude Code session's process, as the stand-in for its lookup gives it
        os.environ[service.NO_START_ENV] = "1"  # a subprocess a test runs can never start one either

        def start_detached(root, run_script, **how):
            self.detached.append((Path(root), Path(run_script)))
            self.how = how
            return FAKE_PID

        for target, attribute, value in ((service, "start_detached", start_detached), (notify, "run_osascript", lambda argv, timeout: (True, None)),
                                         (service, "find_session_pid", lambda start=None: self.session)):
            patcher = mock.patch.object(target, attribute, value)
            patcher.start()
            self.addCleanup(patcher.stop)

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
        self.assertEqual(report["start_now"], [{"ticket_id": str(number), "slice_id": "SLICE-001", "how": "dispatched", "until": "build", "by": "here"}])
        # The readiness audit has not run in this fixture: the batch runs here, and the report says why in the check's own words.
        self.assertEqual((report["factory"]["handed_over"], report["factory"]["supervisor"]), (False, "none"))
        self.assertIn("readiness audit", report["factory"]["why_not"])
        self.assertIn("This batch runs here, in the conversation: " + report["factory"]["why_not"], report["in_words"])
        self.assertEqual((self.detached, report["first_time"], report["factory_started"]), ([], False, False))
        self.assertFalse((self.eng / ".factory/local/runner.json").exists())

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
        self.assertEqual((dry["factory"]["handed_over"], dry["factory"]["why_not"]), (False, "This was a dry run: nothing was handed to the Factory."))
        real = self.pull()
        self.assertEqual((self.started(real, "dispatched"), real["run"], sorted(self.waiting(real))), (self.started(dry), dry["run"], sorted(self.waiting(dry))))

    def test_a_dry_run_of_a_ready_folder_shows_it_without_a_ticket(self):
        self.first()
        dry = self.pull("--dry-run")
        self.assertEqual((dry["start_now"], dry["run"]), ([{"ticket_id": None, "slice_id": "SLICE-001", "how": "would be dispatched", "until": "build", "by": "here"}], []))
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
        # "Needs you" is decide's own list, and the report leads with its count.
        self.assertEqual([item["ticket_id"] for item in report["needs_you"]], [str(a)])
        self.assertTrue(report["in_words"][0].startswith("Needs you: 1."), report["in_words"][0])

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


class HandOffOnOneComputerTest(PullBase):
    """The product manager and the Factory on one computer: the Product Studio draft of a slice, under the name it was started
    with, sits beside the Factory's copy that intake names from the spec's title. They are one slice, never a duplicate."""

    DRAFT = ".factory/studio/draft/specs/slices/SLICE-001-invite.md"

    def studio_draft(self):
        path = self.eng / self.DRAFT
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(spec_for("SLICE-001"))

    def test_the_draft_of_the_slice_handed_over_is_not_a_duplicate(self):
        (number,) = self.issues(1)
        self.studio_draft()
        report = self.pull()
        self.assertEqual(self.started(report, "dispatched"), [str(number)], report["in_words"])
        cell = self.cell(str(number))
        self.assertEqual((cell["stage"], cell["slice_id"], cell["product"]["slice_id"]), ("spec-ready", "SLICE-001", "SLICE-001"))
        self.assertTrue((self.eng / self.DRAFT).is_file())  # the product manager's draft is left as it is

    def test_a_different_slice_with_the_same_id_is_refused_and_says_what_to_do(self):
        (number,) = self.issues(1)
        other = self.eng / ".factory/worktrees/LOCAL-009/repo/specs/slices/SLICE-001-pause-a-plan.md"  # an engineer's own slice
        other.parent.mkdir(parents=True)
        other.write_text(spec_for("SLICE-001").replace("Invite a teammate by email", "Pause a plan"))
        report = self.pull()
        self.assertEqual(self.started(report), [])
        why = " ".join(item["why"] for item in report["waits"])
        self.assertIn("SLICE-001 is already used by SLICE-001-pause-a-plan.md", why)
        self.assertIn("A different slice already uses SLICE-001. One of the two needs a new number", why)

    def cut_short(self, number):
        """What the earlier check left behind: the cell opened, the why and the spec written, the spec refused at finalize."""
        real = intake.Factory.script

        def refusing(factory, station, name, *argv, **kwargs):
            if name == "cell.py" and argv[:1] == ("finalize",):
                return subprocess.CompletedProcess([name], 1, stdout="error: SLICE-001 is already used by SLICE-001-invite.md. [duplicate-slice-id]\n"
                                                                  "FAILED: 1 error(s). Nothing was finalized.\n", stderr="")
            return real(factory, station, name, *argv, **kwargs)

        with mock.patch.object(intake.Factory, "script", refusing):
            report = self.pull()
        self.assertEqual(self.started(report), [])
        root = self.eng / ".factory/worktrees" / str(number)
        self.assertEqual(sorted(path.name for path in root.iterdir()), ["cell.json", "evidence", "intent.md", "lifecycle.jsonl", "repo"])
        cell = self.cell(str(number))
        self.assertEqual((cell["stage"], cell["slice_id"], "product" in cell), ("interview", None, False))
        self.assertEqual(git(root / "repo", "status", "--porcelain").strip(), "?? specs/")  # the spec, untracked
        self.assertIsNone(self.ledger()["slices"]["SLICE-001"]["dispatched_at"])

    def test_a_pull_cut_short_by_the_old_check_carries_on_with_the_next_pull(self):
        (number,) = self.issues(1)
        self.studio_draft()
        self.cut_short(number)
        ticket = str(number)
        # Never groomed again as if it were an engineer's ticket: it waits to be dispatched, and the plan offers it again.
        step = run.next_step(run.Project(self.eng), ticket, True)
        self.assertEqual((step["action"], step["needs"]), ("stop", "dispatch"))
        _, rows = self.plan()
        self.assertEqual((rows["SLICE-001"]["state"], rows["SLICE-001"]["dispatchable"], rows["SLICE-001"]["interrupted"]), ("ready", True, True))
        self.assertIn("was cut short", " ".join(rows["SLICE-001"]["reasons"]))
        dry = self.pull("--dry-run")
        self.assertEqual((dry["start_now"][0]["how"], dry["for_a_person"]), ("would be dispatched", []))
        report = self.pull()  # what the person types next: /mach pull
        self.assertEqual(self.started(report, "dispatched"), [ticket], report["in_words"])
        self.assertEqual((report["for_a_person"], report["run"]), ([], [ticket]))
        cell = self.cell(ticket)
        self.assertEqual((cell["stage"], cell["slice_id"], cell["product"]["slice_id"]), ("spec-ready", "SLICE-001", "SLICE-001"))
        repo = self.eng / ".factory/worktrees" / ticket / "repo"
        self.assertEqual(git(repo, "status", "--porcelain").strip(), "")  # the same spec file, now committed on the ticket's branch
        self.assertEqual(sorted(path.name for path in (repo / "specs/slices").iterdir()), ["SLICE-001-invite-a-teammate-by-email.md"])
        self.assertEqual(len(self.scheduled()), 1)
        again = self.pull()
        self.assertEqual((self.started(again, "dispatched"), self.started(again, "carried on")), ([], [ticket]))


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

    def test_the_authorization_and_the_supervisor_are_the_hand_overs_not_pulls(self):
        """M23: pull hands the batch to the supervisor, but through activation.HandOver only. pull.py itself reads no
        authorization file and starts no process; it starts or wakes the supervisor outside the intake lock."""
        source = (ROOT / "skills/run/scripts/pull.py").read_text()
        for word in ("runner.json", "read_local_policy", "import policy", "import activation", "subprocess", "Popen", "os.system", "claude -p"):
            self.assertNotIn(word, source, word)
        self.assertIn("schedule.main(", source)
        self.assertIn("line.reconcile()", source)
        body = source[source.index("def pull("):source.index("def simulated_intake(")]
        self.assertLess(body.index("with line.lock(\"pull\"):"), body.index("hand.carry_on()"))
        self.assertGreater(body.index("hand.carry_on()"), body.index("reconciled[\"plan\"]"))

    def test_one_writer_at_a_time(self):
        self.issues(1)
        (self.eng / ".factory/intake").mkdir(parents=True, exist_ok=True)
        (self.eng / ".factory/intake/lock").write_text(json.dumps({"pid": os.getpid(), "host": __import__("platform").node(), "at": intake.now(), "purpose": "dispatch"}))
        code, _, err = self.run_pull()
        self.assertEqual(code, 1)
        self.assertIn("Another dispatch is running on this Factory", err)
        self.assertFalse((self.eng / ".factory/worktrees").exists())


FAKE_CLAUDE = "#!/bin/sh\necho 'a stand-in for Claude Code: pull never runs it' >&2\nexit 3\n"


class HandOverTest(PullBase):
    """M23 2: /mach pull takes in, chooses, and hands the batch to the supervisor, which it starts detached (here: recorded only)."""

    def setUp(self):
        super().setUp()
        claude = self.root / "bin" / "claude"
        claude.write_text(FAKE_CLAUDE)
        claude.chmod(0o755)
        self.settings(max_parallel=3)
        data = json.loads((self.eng / ".factory/config.json").read_text())
        data["build"] = {"require_audit": False}
        (self.eng / ".factory/config.json").write_text(json.dumps(data))

    def runner(self):
        return policy.read(self.eng)

    def owners(self):
        return {key: entry.get("owner") for key, entry in self.ledger()["slices"].items()}

    def test_the_first_pull_writes_the_authorization_hands_over_and_starts_the_supervisor(self):
        a, b = self.issues(2)
        report = self.pull()
        factory = report["factory"]
        self.assertEqual((factory["handed_over"], factory["supervisor"], factory["pid"], factory["why_not"], factory["tickets"]),
                         (True, "started", FAKE_PID, None, [str(a), str(b)]))
        self.assertEqual((report["first_time"], report["factory_started"], report["run"]), (True, True, []))
        self.assertEqual(self.detached, [(self.eng, ROOT / "skills/run/scripts/run.py")])
        self.assertEqual([item["by"] for item in report["start_now"]], ["factory", "factory"])
        self.assertEqual(report["in_words"][0], f"The Factory has started on {a} and {b} and carries on in the background while this Claude Code "
                                                "session is open. Closing Claude Code pauses it; the next /mach pull carries on where it left off.")
        # M23 2.4 (as the owner changed it): a pull's supervisor belongs to this Claude Code session.
        self.assertEqual(self.how, {"lifetime": "session", "session_pid": self.session, "started_by": "pull"})
        self.assertEqual(report["factory"]["lifetime"], "session")
        self.assertEqual(report["in_words"][1], "Agents now build here on their own: they run this repository's tests and scripts as you, "
                                                "with no operating-system sandbox. /mach stop stops them.")
        self.assertEqual(self.owners(), {"SLICE-001": "supervisor", "SLICE-002": "supervisor"})
        # The authorization: supervised, merging as the project allows, High at most, the default tools, no spending limit, by pull.
        pol = self.runner()
        self.assertEqual((pol["source"], pol["enabled"], pol["autonomy"], pol["allow_merge"], pol["max_risk"], pol["enabled_by"], pol["allowed_tools"]),
                         ("local-file", True, "supervised", True, "High", "pull", policy.default_tools()))
        self.assertEqual(pol["limits"], {"max_execution_minutes": 120, "max_attempts": 2, "poll_seconds": 300})
        self.assertNotIn("execution_risk_accepted", json.loads((self.eng / ".factory/local/runner.json").read_text()))
        scheduled = [event for event in self.events() if event["type"] == "work.scheduled"]
        self.assertEqual({event["data"]["by"] for event in scheduled}, {"supervisor"})
        activated = [event for event in self.events() if event["type"] == "factory.activated"]
        self.assertEqual([(event["data"]["by"], event["data"]["via"]) for event in activated], [("pull", "pull")])
        # The next pull says nothing about a first time, and carries the same tickets on through the supervisor.
        again = self.pull()
        self.assertEqual((again["first_time"], again["factory"]["handed_over"], again["factory"]["tickets"], again["run"]), (False, True, [str(a), str(b)], []))
        self.assertEqual(len(self.activated()), 1)

    def activated(self):
        return [event for event in self.events() if event["type"] == "factory.activated"]

    def test_a_live_supervisor_is_woken_not_started_again(self):
        self.issues(1)
        self.pull()
        lease = self.eng / ".factory/local/supervisor.json"
        lease.write_text(json.dumps({"instance": "running", "runner_id": "r", "pid": os.getpid(), "host": supervisor.platform.node(),
                                     "started_at": "2026-11-24T08:00:00Z", "heartbeat_at": "x", "expires_at": "2099-01-01T00:00:00Z",
                                     "lifetime": "background", "session_pid": None, "started_by": "factory start"}))
        before = len(self.detached)
        self.ready("SLICE-002", self.epic_number())
        self.session = None  # no session is needed to hand a batch to a supervisor already running
        report = self.pull()
        self.assertEqual((report["factory"]["handed_over"], report["factory"]["supervisor"], report["factory"]["pid"]), (True, "woken", os.getpid()))
        self.assertEqual(report["factory"]["already_running"],
                         {"lifetime": "background", "since": "2026-11-24T08:00:00Z", "pid": os.getpid(), "started_by": "factory start"})
        self.assertEqual(report["in_words"][0], "A Factory is already running here in the background (started 2026-11-24T08:00:00Z). "
                                                "It has taken this batch. /mach factory stop stops it.")
        self.assertEqual(len(self.detached), before)
        self.assertEqual(json.loads((self.eng / ".factory/local/wake").read_text())["event"], "carry-on")
        # One started from another Claude Code session that is still open is handed the batch the same way.
        data = json.loads(lease.read_text())
        data.update(lifetime="session", session_pid=12345, started_by="pull")
        lease.write_text(json.dumps(data))
        self.ready("SLICE-003", self.epic_number())
        report = self.pull()
        self.assertEqual((report["factory"]["supervisor"], report["factory"]["already_running"]["lifetime"]), ("woken", "session"))
        self.assertIn("It stops when that session ends; /mach factory start keeps it running in the background.", report["in_words"][0])

    def test_without_a_session_to_tie_it_to_the_batch_runs_here(self):
        self.issues(1)
        self.session = None
        report = self.pull()
        self.runs_here(report, "could not find the Claude Code session")
        self.assertIn("/mach factory start runs the Factory in the background instead", report["factory"]["why_not"])

    def test_tickets_in_the_line_that_no_worker_holds_are_given_to_the_supervisor(self):
        a, b = self.issues(2)
        here = self.pull("--here")  # an engineer's batch, in the conversation
        self.assertEqual((here["factory"]["handed_over"], here["run"]), (False, [str(a), str(b)]))
        self.assertIn("This batch runs here, in the conversation: You asked for this batch to run here (--here).", here["in_words"])
        self.assertEqual(self.owners(), {"SLICE-001": "engineer", "SLICE-002": "engineer"})
        self.assertEqual(self.detached, [])
        self.assertFalse((self.eng / ".factory/local/runner.json").exists(), "--here writes no authorization")
        C = run.claims()
        C.take(self.eng / ".factory/worktrees" / str(a), "plan", C.new_holder(), C.minutes({}))  # a worker is on it now
        report = self.pull()
        self.assertEqual((report["factory"]["handed_over"], report["factory"]["tickets"]), (True, [str(b)]))
        self.assertEqual(self.owners(), {"SLICE-001": "engineer", "SLICE-002": "supervisor"})
        self.assertEqual(self.waiting(report)["SLICE-001"]["then"], "left to the worker on it")

    def test_an_engineers_own_ticket_stays_in_the_conversation(self):
        (a,) = self.issues(1)
        self.pull()
        own = self.eng / ".factory/worktrees/LOCAL-900"
        own.mkdir(parents=True)
        (own / "cell.json").write_text(json.dumps({"ticket_id": "LOCAL-900", "stage": "planned", "risk": "Low"}))
        (own / "plan.md").write_text(plan_md("own.py"))
        real = run.next_step

        def answer(project, ticket_id, headless):
            if ticket_id == "LOCAL-900":
                return run.step(ticket_id, "planned", "build", "Build the plan.")
            return real(project, ticket_id, headless)

        with mock.patch.object(run, "next_step", answer):
            report = self.pull()
        self.assertEqual((report["factory"]["tickets"], report["run"]), ([str(a)], ["LOCAL-900"]))
        self.assertIn("To run here: LOCAL-900.", report["in_words"])

    def runs_here(self, report, words):
        """Not handed over: the reason in one line, with what changes it, and the batch runs in the conversation."""
        self.assertFalse(report["factory"]["handed_over"])
        self.assertIn(words, report["factory"]["why_not"])
        self.assertTrue(report["run"], "the batch runs in the conversation")
        self.assertIn("This batch runs here, in the conversation: " + report["factory"]["why_not"], report["in_words"])
        self.assertEqual(self.detached, [])
        self.assertFalse((self.eng / ".factory/local/runner.json").exists())
        self.assertEqual(set(self.owners().values()), {"engineer"})

    def test_a_project_that_forbids_a_supervisor_runs_its_batch_here(self):
        self.issues(1)
        data = json.loads((self.eng / ".factory/config.json").read_text())
        data["factory"]["supervisor"] = False
        (self.eng / ".factory/config.json").write_text(json.dumps(data))
        self.runs_here(self.pull(), "factory.supervisor is false")

    def test_a_failing_check_is_the_reason_in_its_own_words(self):
        self.issues(1)
        data = json.loads((self.eng / ".factory/config.json").read_text())
        data["build"] = {"require_audit": True}
        (self.eng / ".factory/config.json").write_text(json.dumps(data))
        self.runs_here(self.pull(), "There is no readiness audit report.")

    def test_without_claude_code_the_batch_runs_here(self):
        self.issues(1)
        (self.root / "bin" / "claude").unlink()
        with mock.patch.dict(os.environ, {"PATH": str(self.root / "bin") + os.pathsep + "/usr/bin:/bin"}):
            report = self.pull()
        self.runs_here(report, "Claude Code (the 'claude' command) is not on the PATH")
        self.assertIn("then pull again", report["factory"]["why_not"])

    def test_a_persons_disable_sticks(self):
        self.issues(1)
        self.pull()
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(run.main(["--project", str(self.eng), "factory", "disable"]), 0)
        self.ready("SLICE-002", self.epic_number())
        report = self.pull()
        self.assertFalse(report["factory"]["handed_over"])
        self.assertEqual(report["factory"]["why_not"], "A person turned the Factory off on this machine. /mach factory start turns it back on.")
        self.assertEqual(self.runner()["enabled"], False)
        self.assertEqual(len(self.detached), 1, "only the first pull started a supervisor")
        self.assertEqual(report["run"], [item["ticket_id"] for item in report["start_now"]])

    def test_a_dry_run_hands_nothing_over(self):
        self.issues(2)
        report = self.pull("--dry-run")
        self.assertEqual((report["factory"]["handed_over"], report["first_time"], self.detached), (False, False, []))
        self.assertFalse((self.eng / ".factory/local").exists())


if __name__ == "__main__":
    unittest.main()
