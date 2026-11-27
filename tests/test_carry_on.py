"""A person carries a stopped ticket on, and a person's start gives every ticket a fresh set of rounds.

The owner's words (2026-11-27): "The suggestion to abandon work that has already been done or give up is not acceptable."
"A targeted fix must be allowed ... so the factory supervisor can continue to move the work forward." And: the rounds a
ticket had "need to reset back to their starting position every time the factory is started or a ticket is pulled into the
factory by hand interactively by the user."

Cells are made by the real stations (test_review's Base), or written directly where a station's own files are enough.
No supervisor, `claude` or `gh` is started.
"""

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
for folder in ("run", "intent", "build", "review", "verify"):
    sys.path.insert(0, str(ROOT / "skills" / folder / "scripts"))
import build  # noqa: E402
import decide  # noqa: E402
import explain  # noqa: E402
import rounds  # noqa: E402
import run  # noqa: E402
from test_review import Base as ReviewBase, TICKET  # noqa: E402


def lifecycle(cellroot: Path):
    path = cellroot / "lifecycle.jsonl"
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()] if path.is_file() else []


class FileCells(unittest.TestCase):
    """Cells written directly: what the stations leave behind when a ticket stops at its last round."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.project = Path(self.tmp.name).resolve()
        (self.project / ".factory").mkdir()
        self.cellroot = self.project / ".factory" / "worktrees" / TICKET

    def write(self, name, data):
        path = self.cellroot / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(data if isinstance(data, str) else json.dumps(data), encoding="utf-8")

    def cell(self):
        return json.loads((self.cellroot / "cell.json").read_text())

    def stopped(self, how):
        """A ticket stopped at round 3 of 3, in one of the three ways a ticket stops."""
        self.write("cell.json", {"ticket_id": TICKET, "stage": "blocked", "risk": "High", "isolation": "none"})
        self.write("build.json", {"loop": 2, "tasks": [{"id": "T01", "status": "done"}]})
        if how == "verify":
            self.write("evidence/findings.md", "# Verification findings\n")
            self.write("evidence/summary.json", {"status": "FAIL_WITH_EVIDENCE", "review_loop": 2, "head": "x",
                                                 "checks": {"AC-03": {"result": "fail", "note": "The retry is not wired."}}})
            return self.cellroot / "evidence/findings.md"
        if how == "review":
            self.write("review/round-3/findings.md", "# Findings\n")
            self.write("review/round-3/votes/general.json", {"reviewer": "general", "vote": "REJECT", "findings": [
                {"severity": "blocker", "title": "R2 not met", "detail": "The queue is never read.", "file": "app/q.py", "line": 3, "rule": "R2"}]})
            self.write("review/decision.json", {"outcome": "ESCALATE", "round": 3, "findings": str(self.cellroot / "review/round-3/findings.md")})
            return self.cellroot / "review/round-3/findings.md"
        self.write("review/round-3/person-findings.md", "# Sent back by a person\n")
        self.write("review/decision.json", {"outcome": "ESCALATE", "round": 3, "rejected_by": "a person",
                                            "human_send_back": {"by": "Dana Smith", "reason": "The error text must name the field."},
                                            "findings": str(self.cellroot / "review/round-3/person-findings.md")})
        return self.cellroot / "review/round-3/person-findings.md"

    def carry_on(self, *extra):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = build.main(["--project", str(self.project), "carry-on", TICKET, "--by", "Dana Smith", *extra])
        self.assertEqual(code, 0, err.getvalue())
        return json.loads(out.getvalue())

    def next(self):
        return run.next_step(run.Project(self.project), TICKET, False)

    def report(self):
        return explain.explain(self.project, TICKET, self.next(), {})[0]

    def decided(self):
        project = run.Project(self.project)
        listing = decide.main([TICKET], self.project, config=project.config, next_step=lambda ticket: run.next_step(project, ticket, False))
        return listing["tickets"][0] if listing["tickets"] else None


class CarryOnTest(FileCells):
    def test_carry_on_from_each_of_the_three_stops_goes_to_the_builders_revision_with_the_findings_and_the_guidance(self):
        for how, station in (("verify", "verify"), ("review", "review"), ("person", "person")):
            with self.subTest(how):
                findings = self.stopped(how)
                item = self.decided()
                self.assertEqual(item["options"][0]["key"], "carry-on")
                self.assertEqual(item["situation"]["stopped"]["station"], station)
                self.assertEqual(item["situation"]["stopped"]["round"], {"used": 3, "max": 3})
                done = self.carry_on("--guidance", "Only R2 is left.\nWire the retry to the queue.")
                self.assertEqual((done["status"], done["round"], done["max_rounds"], done["stopped_at"]), ("CARRIED_ON", 4, 4, station))
                step = self.next()
                self.assertEqual((step["action"], step["stage"]), ("revise", "built"))
                self.assertEqual(step["findings"], str(findings))
                self.assertTrue(step["guidance"].endswith("person-guidance-1.md"))
                self.assertIn("Read it first", step["prompt"])
                self.assertIn("smallest change", step["prompt"])
                text = Path(step["guidance"]).read_text()
                self.assertIn("> Only R2 is left.\n> Wire the retry to the queue.", text, "the person's words, kept as theirs")
                report = self.report()
                self.assertEqual((report["rounds_used"], report["max_rounds"], report["rounds_left"]), (3, 4, 1), "round 4 of 4 is to come, never 4 of 3")
                self.assertEqual(report["carried_on"][0]["by"], "Dana Smith")
                self.tmp.cleanup()
                Path(self.tmp.name).mkdir()
                (self.project / ".factory").mkdir()

    def test_the_telemetry_says_who_carried_it_on_and_the_new_round(self):
        self.stopped("review")
        self.carry_on()
        [event] = [item for item in lifecycle(self.cellroot) if item["type"] == "station.exited"]
        self.assertEqual(event["station"], "build")
        self.assertEqual({key: event["data"][key] for key in ("outcome", "by", "round", "max_rounds", "round_number", "stopped_at", "guidance")},
                         {"outcome": "carried-on-by-person", "by": "person-decision", "round": 4, "max_rounds": 4, "round_number": 4,
                          "stopped_at": "review", "guidance": False})

    def test_without_guidance_the_findings_alone_guide_the_builder(self):
        findings = self.stopped("verify")
        self.carry_on()
        step = self.next()
        self.assertEqual((step["action"], step["findings"], step["guidance"]), ("revise", str(findings), None))

    def test_a_person_is_never_out_of_rounds(self):
        self.stopped("review")
        self.carry_on()
        # The revision round 4 ran and failed again: the build station moves the loop on and stops it at the last round.
        self.write("build.json", {"loop": 3, "tasks": [{"id": "T01", "status": "done"}]})
        self.write("review/round-4/findings.md", "# Findings\n")
        self.write("review/decision.json", {"outcome": "ESCALATE", "round": 4, "findings": str(self.cellroot / "review/round-4/findings.md")})
        info = self.cell()
        info["stage"] = "blocked"
        self.write("cell.json", info)
        self.assertEqual(self.report()["max_rounds"], 4)
        done = self.carry_on("--guidance", "Second try.")
        self.assertEqual((done["round"], done["max_rounds"]), (5, 5))
        self.assertTrue((self.cellroot / "person-guidance-2.md").is_file())
        self.assertTrue((self.cellroot / "person-guidance-1.md").is_file() is False, "no guidance was given the first time")
        self.assertEqual(self.next()["action"], "revise")

    def test_carry_on_is_refused_where_nothing_stopped_and_inside_a_supervised_execution(self):
        self.stopped("review")
        with mock.patch.dict(os.environ, {"MACH_EXECUTION_ID": "x0123456789ab"}):
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                code = build.main(["--project", str(self.project), "carry-on", TICKET, "--by", "Dana Smith"])
        self.assertEqual(code, 1)
        self.assertIn("a person's word", err.getvalue())
        info = self.cell()
        info["stage"] = "building"
        self.write("cell.json", info)
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            self.assertEqual(build.main(["--project", str(self.project), "carry-on", TICKET, "--by", "Dana Smith"]), 1)
        self.assertIn("has not stopped for a person", err.getvalue())

    def test_the_stopped_reason_names_carry_on_and_never_abandoning(self):
        self.stopped("verify")
        step = self.next()
        self.assertEqual((step["action"], step["needs"]), ("stop", "person-to-take-over"))
        self.assertIn("A person can carry it on with a fix", step["reason"])
        self.assertIn("round 3 of 3", step["reason"])
        for text in (step["reason"], run.NEEDS_TEXT["person-to-take-over"]):
            self.assertNotIn("abandon", text.lower())


class FreshRoundsTest(FileCells):
    """A person's start (pull, factory start or resume, naming the ticket) resets the allowance, never the work or the records."""

    def fresh(self, *tickets):
        return run.fresh_rounds(run.Project(self.project), list(tickets) or [TICKET])

    def test_a_stopped_ticket_is_carried_on_with_a_fresh_set(self):
        findings = self.stopped("review")
        done = self.fresh()
        self.assertEqual((done["reset"], done["carried_on"]), ([TICKET], [TICKET]))
        self.assertEqual(done["said"], [f"Ticket {TICKET} had used all its rounds; MACH gave it a fresh set and the builder is carrying on from the last findings."])
        step = self.next()
        self.assertEqual((step["action"], step["findings"]), ("revise", str(findings)))
        report = self.report()
        self.assertEqual((report["rounds_used"], report["max_rounds"], report["rounds_left"]), (0, 3, 3))
        self.assertEqual(self.cell()["rounds_base"], 3)
        self.assertEqual(json.loads((self.cellroot / "build.json").read_text())["loop"], 2, "the loop, and so every file name, goes on")
        # The revision starts: it is round 1 of 3, and its findings copy is named for round 4's revision, after the earlier ones.
        self.write("build.json", {"loop": 3, "tasks": [{"id": "T01", "status": "done"}]})
        self.assertEqual(rounds.used(self.cell(), 3), 1)
        self.assertEqual(rounds.last({}, self.cell()), 6, "the ticket stops again only after round 6, its third counted round")
        [event] = [item for item in lifecycle(self.cellroot) if item["type"] == "station.exited"]
        self.assertEqual((event["data"]["by"], event["data"]["round"], event["data"]["max_rounds"], event["data"]["round_number"]), ("person-start", 1, 3, 4))

    def test_a_ticket_mid_rounds_gets_its_count_reset_and_keeps_going(self):
        self.write("cell.json", {"ticket_id": TICKET, "stage": "building", "isolation": "none"})
        self.write("build.json", {"loop": 1, "tasks": [{"id": "T01", "status": "pending"}]})
        self.assertEqual(self.report()["rounds_used"], 2)
        done = self.fresh()
        self.assertEqual((done["reset"], done["carried_on"]), ([TICKET], []))
        self.assertEqual(self.cell()["stage"], "building", "nothing about the work changes")
        self.assertEqual(self.report()["rounds_used"], 1)
        self.assertEqual(self.fresh()["reset"], [], "once per start: already fresh")

    def test_the_supervisor_alone_never_resets_the_rounds(self):
        self.stopped("review")
        with mock.patch.dict(os.environ, {"MACH_EXECUTION_ID": "x0123456789ab"}):
            self.assertEqual(self.fresh()["reset"], [])
        self.assertEqual(self.cell()["stage"], "blocked")
        self.assertNotIn("rounds_base", self.cell())

    def test_a_stop_that_is_not_about_rounds_is_not_changed(self):
        self.write("cell.json", {"ticket_id": TICKET, "stage": "awaiting-human", "isolation": "none"})
        self.write("build.json", {"loop": 0, "tasks": [{"id": "T01", "status": "done"}]})
        self.fresh()
        self.assertEqual(self.cell()["stage"], "awaiting-human")
        self.write("cell.json", {"ticket_id": TICKET, "stage": "sideways", "isolation": "none"})
        self.assertEqual(self.fresh()["reset"], [])

    def test_the_supervisors_hold_and_attempts_are_cleared_but_a_risk_hold_stays(self):
        self.stopped("review")
        ledger = self.project / ".factory" / "intake" / "ledger.json"
        ledger.parent.mkdir(parents=True)
        ledger.write_text(json.dumps({"slices": {}, "supervisor": {"parked": {TICKET: {"reason": "3 execution(s) ended without moving it past 'blocked'."}},
                                                                   "attempts": {TICKET: {"count": 3}}, "executions": {}}}))
        with mock.patch.object(run, "factory", return_value=(None, FakeLine(ledger))):
            self.fresh()
        held = json.loads(ledger.read_text())["supervisor"]
        self.assertEqual((held["parked"], held["attempts"]), ({}, {}))
        self.assertEqual(self.next()["action"], "revise", "the supervisor picks it up again from the revision")

    def test_naming_a_ticket_and_a_pull_give_fresh_rounds(self):
        self.stopped("verify")
        with mock.patch.object(run, "claim_step", side_effect=lambda project, found, *a, **k: found):
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                code = run.main(["--project", str(self.project), "next", TICKET, "--by-person"])
        self.assertEqual(code, 0, err.getvalue())
        shown = json.loads(out.getvalue())
        self.assertEqual(shown["action"], "revise")
        self.assertIn("MACH gave it a fresh set", " ".join(shown["warnings"]))
        calls = []
        with mock.patch.object(run, "fresh_rounds", side_effect=lambda project, tickets, via="terminal": calls.append(list(tickets)) or {"reset": [], "carried_on": [], "said": []}), \
                mock.patch.object(run, "factory", return_value=(mock.Mock(IntakeError=RuntimeError), mock.Mock())), \
                mock.patch.object(run, "factory_context", return_value=mock.Mock()):
            import pull
            with mock.patch.object(pull, "pull", return_value={"in_words": []}):
                with redirect_stdout(io.StringIO()):
                    run.main(["--project", str(self.project), "pull"])
        self.assertEqual(calls, [[TICKET]], "a pull starts every ticket in the line afresh")


class FakeLine:
    def __init__(self, path):
        self.path = path

    def lock(self, purpose):
        import contextlib
        return contextlib.nullcontext()

    def ledger(self):
        return json.loads(self.path.read_text())

    def save(self, data):
        self.path.write_text(json.dumps(data))


class RealRoundsTest(ReviewBase):
    """The real stations: review escalates at round 3 of 3, a person carries it on, and the build station revises in round 4 of 4."""

    def test_escalated_by_review_then_carried_on_then_revised(self):
        self.verified()
        self.edit_json("build-report.json", review_loop=2)
        self.edit_json("build.json", loop=2)
        self.put(self.cellroot, {"review/round-2/findings.md": "# earlier findings\n"})
        self.r_ok("start", TICKET)
        self.cast(rejecting=("architecture", "product"))
        code, done = self.tally()
        self.assertEqual((code, done["outcome"]), (1, "ESCALATE"))
        self.assertNotIn("abandon", done["next"].lower())
        carried = self.ok("carry-on", TICKET, "--by", "Dana Smith", "--guidance", "Name the field in the error.")
        self.assertEqual((carried["round"], carried["max_rounds"]), (4, 4))
        step = run.next_step(run.Project(self.project), TICKET, False)
        self.assertEqual(step["action"], "revise")
        revised = self.ok("revise", TICKET, "--findings", step["findings"])
        self.assertEqual((revised["status"], revised["round"], revised["max_rounds"], revised["rounds_left"]), ("REVISING", 4, 4, 0))
        self.assertTrue(revised["guidance"].endswith("person-guidance-1.md"))
        self.assertIn("Read it first", revised["next"])
        self.assertIn("Keep everything already proven", revised["next"])
        self.assertTrue((self.cellroot / "review-findings-3.md").is_file(), "the revision's findings copy is named for its own loop")


if __name__ == "__main__":
    unittest.main()
