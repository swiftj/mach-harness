"""Tests for the per-ticket claim (M9 design section 5): one worker per ticket.

The claim is .factory/worktrees/<ticket_id>/claim.json, written by the shared helper claim.py. These tests cover
every row of the table in 5.2 (run.py next with a holder, with none, with --take-over; cell.py claim; run.py
schedule --holder; run.py status), freshness by stage and by time (times are written into the file or the clock
is patched; nothing sleeps), the atomic write, that nothing else writes a claim, and that a claim never changes a
station's result.
"""

import io
import json
import os
import re
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "skills" / "run" / "scripts"))
sys.path.insert(0, str(ROOT / "skills" / "intent" / "scripts"))
import cell as cell_script  # noqa: E402
import run  # noqa: E402
from test_build import Base as BuildBase, INTENT, PLAN, SPEC, SPEC_NAME  # noqa: E402

C = run.claims()  # the helper exactly as run.py loads it
MINE = "a" * 32
OTHER = "b" * 32
HEX32 = re.compile(r"^[0-9a-f]{32}$")


def ago(minutes):
    return C.stamp(datetime.now(timezone.utc) - timedelta(minutes=minutes))


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve() / "project"
        (self.root / ".factory").mkdir(parents=True)
        self.env = mock.patch.dict(os.environ, {}, clear=False)
        self.env.start()
        self.addCleanup(self.env.stop)
        os.environ.pop(run.EXECUTION_ENV, None)

    def cell(self, ticket="T-1", stage="spec-ready", **extra):
        folder = self.root / ".factory" / "worktrees" / ticket
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "cell.json").write_text(json.dumps({"ticket_id": ticket, "stage": stage, **extra}))
        return folder

    def path(self, ticket="T-1"):
        return self.root / ".factory" / "worktrees" / ticket / "claim.json"

    def put_claim(self, ticket="T-1", step="plan", stage="spec-ready", holder=OTHER, at=None, renewed_at=None):
        at = at or ago(5)
        self.path(ticket).write_text(json.dumps({"step": step, "stage": stage, "holder": holder, "at": at, "renewed_at": renewed_at or at}))

    def saved(self, ticket="T-1"):
        return json.loads(self.path(ticket).read_text())

    def run_cmd(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = run.main(["--project", str(self.root), *argv])
        return code, out.getvalue(), err.getvalue()

    def next(self, ticket="T-1", *extra):
        code, out, err = self.run_cmd("next", ticket, *extra)
        self.assertEqual(code, 0, err)
        return json.loads(out)

    def cell_claim(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = cell_script.main(["--project", str(self.root), "claim", *argv])
        return code, out.getvalue(), err.getvalue()

    def config(self, **factory):
        (self.root / ".factory" / "config.json").write_text(json.dumps({"factory": factory}))


class HelperTest(Base):
    def test_the_helper_is_the_intent_stations_file(self):
        self.assertEqual(Path(C.__file__).resolve(), ROOT / "skills" / "intent" / "scripts" / "claim.py")

    def test_new_holders_are_random_hex(self):
        first, second = C.new_holder(), C.new_holder()
        self.assertRegex(first, HEX32)
        self.assertNotEqual(first, second)
        for bad in ("new", "", "ABCDEF12", "a" * 7, "a" * 65, "zz" * 8, None, 7):
            self.assertFalse(C.valid_holder(bad), bad)

    def test_claim_minutes_from_the_settings(self):
        self.assertEqual(C.minutes({}), 90)
        self.assertEqual(C.minutes({"factory": {"claim_minutes": 5}}), 5)
        for bad in (0, -1, "10", 2.5, True, None):
            self.assertEqual(C.minutes({"factory": {"claim_minutes": bad}}), 90, bad)

    def test_fresh_by_stage_and_by_time(self):
        moment = datetime(2026, 11, 16, 12, 0, tzinfo=timezone.utc)
        claim = {"step": "plan", "stage": "spec-ready", "holder": MINE, "at": C.stamp(moment), "renewed_at": C.stamp(moment)}
        self.assertTrue(C.fresh(claim, "spec-ready", 90, moment + timedelta(minutes=89)))
        self.assertFalse(C.fresh(claim, "spec-ready", 90, moment + timedelta(minutes=90)), "made 90 minutes ago: stale")
        self.assertFalse(C.fresh(claim, "planned", 90, moment), "the stage moved on: stale")
        renewed = dict(claim, renewed_at=C.stamp(moment + timedelta(minutes=60)))
        self.assertTrue(C.fresh(renewed, "spec-ready", 90, moment + timedelta(minutes=120)), "renewed 60 minutes ago")
        self.assertEqual(C.lapses_at(renewed, 90), C.stamp(moment + timedelta(minutes=150)))
        ahead = dict(claim, at=C.stamp(moment + timedelta(days=30)), renewed_at=C.stamp(moment + timedelta(days=30)))
        self.assertFalse(C.fresh(ahead, "spec-ready", 90, moment), "a time far in the future is not believed")

    def test_a_malformed_claim_counts_for_nothing(self):
        folder = self.cell()
        for text in ("not json", "[]", json.dumps({"step": "deploy", "stage": "spec-ready", "holder": OTHER, "at": ago(1)}),
                     json.dumps({"step": "plan", "stage": "spec-ready", "holder": "x", "at": ago(1)}),
                     json.dumps({"step": "plan", "stage": "spec-ready", "holder": OTHER, "at": "yesterday"})):
            self.path().write_text(text)
            self.assertIsNone(C.current(folder, 90), text)
            self.assertEqual(self.next("T-1", "--holder", MINE)["claim"]["holder"], MINE)

    def test_the_write_is_atomic(self):
        folder = self.cell()
        self.put_claim(holder=OTHER)
        before = self.path().read_text()
        with mock.patch.object(C.os, "replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                C.write(folder, {"step": "plan", "stage": "spec-ready", "holder": MINE, "at": ago(0), "renewed_at": ago(0)})
        self.assertEqual(self.path().read_text(), before, "a failed write leaves the old claim whole")
        self.assertEqual(sorted(path.name for path in folder.iterdir()), ["cell.json", "claim.json"], "no temporary file is left behind")
        with mock.patch.object(C.os, "fsync", wraps=os.fsync) as synced:
            C.write(folder, {"step": "plan", "stage": "spec-ready", "holder": MINE, "at": ago(0), "renewed_at": ago(0), "extra": "dropped"})
        self.assertTrue(synced.called, "the file is flushed to disk before it replaces the old one")
        self.assertEqual(set(self.saved()), {"step", "stage", "holder", "at", "renewed_at"})
        self.assertEqual(sorted(path.name for path in folder.iterdir()), ["cell.json", "claim.json"])


class NextWithHolderTest(Base):
    """Row 1: run.py next <ticket> --holder H naming a work step."""

    def test_claims_the_step_and_shows_it(self):
        self.cell()
        step = self.next("T-1", "--holder", MINE)
        self.assertEqual((step["action"], step["stop"]), ("plan", False))
        claim = step["claim"]
        self.assertEqual((claim["step"], claim["stage"], claim["holder"]), ("plan", "spec-ready", MINE))
        self.assertEqual(claim["lapses_at"], C.stamp(C.parse(claim["renewed_at"]) + timedelta(minutes=90)))
        self.assertEqual(self.saved(), {key: claim[key] for key in ("step", "stage", "holder", "at", "renewed_at")})
        self.assertNotIn("holder", {key for key in step if key != "claim"}, "a holder that was passed in is not printed again")
        self.assertIn(f"--holder {MINE}", step["prompt"], "the planner is told which holder to claim the plan step with")

    def test_renews_its_own_claim(self):
        self.cell()
        start = datetime(2026, 11, 16, 9, 0, tzinfo=timezone.utc)
        with mock.patch.object(C, "now", return_value=start):
            first = self.next("T-1", "--holder", MINE)["claim"]
        with mock.patch.object(C, "now", return_value=start + timedelta(minutes=80)):
            second = self.next("T-1", "--holder", MINE)["claim"]
        self.assertEqual((second["at"], second["renewed_at"]), (first["at"], C.stamp(start + timedelta(minutes=80))))
        self.assertEqual(second["lapses_at"], C.stamp(start + timedelta(minutes=170)))

    def test_another_holders_fresh_claim_stops_it_without_showing_that_holder(self):
        self.cell()
        self.put_claim(holder=OTHER, at=ago(10))
        before = self.path().read_text()
        code, out, err = self.run_cmd("next", "T-1", "--holder", MINE)
        self.assertEqual(code, 0, err)
        self.assertNotIn(OTHER, out)
        step = json.loads(out)
        self.assertEqual((step["action"], step["stop"], step["needs"]), ("stop", True, "worker-in-cell"))
        other = step["other_claim"]
        self.assertEqual(set(other), {"step", "stage", "at", "renewed_at", "lapses_at"})
        for text in ("plan step", other["at"], other["lapses_at"], "take over"):
            self.assertIn(text, step["reason"])
        self.assertNotIn("claim", step)
        self.assertEqual(step["digest"]["needs_person"], run.NEEDS_TEXT["worker-in-cell"])
        self.assertEqual(self.path().read_text(), before, "a refusal writes nothing")

    def test_holder_new_makes_and_returns_a_holder(self):
        self.cell()
        step = self.next("T-1", "--holder", "new")
        self.assertRegex(step["holder"], HEX32)
        self.assertEqual(step["claim"]["holder"], step["holder"])
        self.assertEqual(self.saved()["holder"], step["holder"])
        again = self.next("T-1", "--holder", step["holder"])
        self.assertEqual(again["claim"]["at"], step["claim"]["at"])
        refused = self.next("T-1", "--holder", "new")
        self.assertEqual(refused["needs"], "worker-in-cell")
        self.assertNotIn(step["holder"], json.dumps(refused))
        self.assertNotEqual(refused["holder"], step["holder"], "a refused caller still gets its own new holder")

    def test_an_unusable_holder_is_refused(self):
        self.cell()
        for bad in ("ABC", "nothex!", "a" * 100):
            code, _, err = self.run_cmd("next", "T-1", "--holder", bad)
            self.assertEqual(code, 1)
            self.assertIn("--holder", err)
        self.assertFalse(self.path().exists())

    def test_a_stop_is_never_claimed(self):
        self.cell(stage="awaiting-human")
        step = self.next("T-1", "--holder", "new")
        self.assertEqual((step["action"], step["needs"]), ("stop", "human-approval"))
        self.assertNotIn("claim", step)
        self.assertFalse(self.path().exists())
        self.cell(stage="blocked")
        self.assertNotIn("claim", self.next("T-1", "--holder", MINE))
        self.assertFalse(self.path().exists())

    def test_a_ticket_with_no_cell_has_nothing_to_claim(self):
        step = self.next("T-9", "--holder", "new")
        self.assertEqual(step["action"], "groom")
        self.assertRegex(step["holder"], HEX32)
        self.assertNotIn("claim", step)
        self.assertFalse((self.root / ".factory" / "worktrees" / "T-9").exists(), "no cell folder is made for a claim")

    def test_each_work_step_is_claimed_at_its_stage(self):
        for stage, action in (("interview", "groom"), ("spec-ready", "plan"), ("planned", "audit"), ("building", "build"),
                              ("built", "verify"), ("verified", "review"), ("merged", "cleanup")):
            self.cell(stage=stage)
            step = self.next("T-1", "--holder", MINE)
            self.assertEqual((step["action"], step["claim"]["step"], step["claim"]["stage"]), (action, action, stage))

    def test_a_claim_that_cannot_be_written_hands_nothing_out(self):
        self.cell()
        with mock.patch.object(C, "write", side_effect=OSError("read-only")):
            code, out, err = self.run_cmd("next", "T-1", "--holder", MINE)
        self.assertEqual((code, out), (1, ""))
        self.assertIn("not handed out", err)
        self.assertFalse(self.path().exists())


class FreshnessTest(Base):
    def test_a_new_stage_makes_the_claim_stale(self):
        self.cell(stage="spec-ready")
        self.put_claim(holder=OTHER)
        self.assertEqual(self.next("T-1", "--holder", MINE)["needs"], "worker-in-cell")
        self.cell(stage="planned")
        step = self.next("T-1", "--holder", MINE)
        self.assertEqual((step["action"], step["claim"]["holder"], step["claim"]["stage"]), ("audit", MINE, "planned"))

    def test_an_old_claim_is_stale(self):
        self.cell()
        self.put_claim(holder=OTHER, at=ago(91))
        self.assertEqual(self.next("T-1", "--holder", MINE)["claim"]["holder"], MINE)
        self.assertEqual(self.saved()["holder"], MINE)

    def test_a_renewed_claim_stays_fresh(self):
        self.cell()
        self.put_claim(holder=OTHER, at=ago(200), renewed_at=ago(30))
        self.assertEqual(self.next("T-1", "--holder", MINE)["needs"], "worker-in-cell")

    def test_claim_minutes_is_read_from_the_settings(self):
        self.cell()
        self.config(claim_minutes=5)
        self.put_claim(holder=OTHER, at=ago(6))
        self.assertEqual(self.next("T-1", "--holder", MINE)["claim"]["holder"], MINE)
        self.assertEqual(self.next("T-1", "--holder", MINE)["claim"]["lapses_at"],
                         C.stamp(C.parse(self.saved()["renewed_at"]) + timedelta(minutes=5)))
        self.put_claim(holder=OTHER, at=ago(4))
        self.assertEqual(self.next("T-1", "--holder", MINE)["needs"], "worker-in-cell")


class NextWithoutHolderTest(Base):
    """Row 2: run.py next <ticket> with no holder."""

    def test_never_writes_and_answers_as_before(self):
        self.cell()
        first = self.next("T-1")
        self.assertFalse(self.path().exists())
        self.assertEqual((first["action"], "claim" in first, "holder" in first), ("plan", False, False))
        self.assertNotIn("--holder", first["prompt"])

    def test_refused_while_any_claim_is_fresh(self):
        self.cell()
        self.put_claim(holder=OTHER)
        before = self.path().read_text()
        code, out, _ = self.run_cmd("next", "T-1")
        self.assertNotIn(OTHER, out)
        step = json.loads(out)
        self.assertEqual((code, step["action"], step["needs"]), (0, "stop", "worker-in-cell"))
        self.assertEqual(self.path().read_text(), before)
        self.put_claim(holder=OTHER, at=ago(95))
        self.assertEqual(self.next("T-1")["action"], "plan", "a stale claim counts for nothing")


class TakeOverTest(Base):
    """Row 3: run.py next <ticket> --take-over, only on a person's explicit word."""

    def test_replaces_a_fresh_claim_and_says_whose_step(self):
        self.cell()
        at = ago(20)
        self.put_claim(holder=OTHER, at=at)
        code, out, err = self.run_cmd("next", "T-1", "--holder", MINE, "--take-over")
        self.assertEqual(code, 0, err)
        self.assertNotIn(OTHER, out)
        step = json.loads(out)
        self.assertEqual((step["action"], step["claim"]["holder"]), ("plan", MINE))
        self.assertEqual((step["took_over"]["step"], step["took_over"]["at"]), ("plan", at))
        self.assertNotIn("holder", step["took_over"])
        self.assertIn("Taken over", step["reason"])
        self.assertEqual(self.saved()["holder"], MINE)

    def test_without_a_holder_a_new_one_is_made(self):
        self.cell()
        self.put_claim(holder=OTHER)
        step = self.next("T-1", "--take-over")
        self.assertRegex(step["holder"], HEX32)
        self.assertEqual((step["claim"]["holder"], self.saved()["holder"]), (step["holder"], step["holder"]))

    def test_harmless_without_a_fresh_claim(self):
        self.cell()
        step = self.next("T-1", "--holder", MINE, "--take-over")
        self.assertEqual((step["action"], step["claim"]["holder"]), ("plan", MINE))
        self.assertNotIn("took_over", step)
        self.cell(stage="awaiting-human")
        self.assertEqual(self.next("T-1", "--take-over")["needs"], "human-approval")


class CellClaimTest(Base):
    """Row 4: cell.py claim <ticket> <step> [--holder H], for a station that starts a worker itself."""

    def test_claims_and_prints_the_holder(self):
        self.cell()
        code, out, err = self.cell_claim("T-1", "plan")
        self.assertEqual(code, 0, err)
        shown = json.loads(out)
        self.assertRegex(shown["holder"], HEX32)
        self.assertEqual((shown["step"], shown["stage"], self.saved()["holder"]), ("plan", "spec-ready", shown["holder"]))
        code, out, _ = self.cell_claim("T-1", "plan", "--holder", shown["holder"])
        self.assertEqual((code, json.loads(out)["at"]), (0, shown["at"]), "the same holder renews")

    def test_refuses_another_holders_fresh_claim(self):
        self.cell()
        self.put_claim(holder=OTHER, at=ago(15))
        code, out, err = self.cell_claim("T-1", "plan", "--holder", MINE)
        self.assertNotEqual(code, 0)
        self.assertEqual(out, "")
        self.assertNotIn(OTHER, err)
        lapses = C.lapses_at(self.saved(), 90)
        for text in ("plan step", self.saved()["at"], lapses, "take over"):
            self.assertIn(text, err)
        self.assertEqual(self.saved()["holder"], OTHER)

    def test_the_belts_holder_lets_its_own_planner_claim(self):
        self.cell()
        step = self.next("T-1", "--holder", "new")
        code, _, err = self.cell_claim("T-1", "plan", "--holder", step["holder"])
        self.assertEqual(code, 0, err)
        code, _, _ = self.cell_claim("T-1", "plan")
        self.assertNotEqual(code, 0, "a planner without the holder is refused while the belt's claim is fresh")

    def test_refuses_no_cell_a_bad_step_or_a_bad_holder(self):
        code, _, err = self.cell_claim("T-1", "plan")
        self.assertNotEqual(code, 0)
        self.assertIn("No cell", err)
        self.cell()
        for argv in (("T-1", "deploy"), ("T-1", "plan", "--holder", "XYZ")):
            code, _, _ = self.cell_claim(*argv)
            self.assertNotEqual(code, 0, argv)
        self.assertFalse(self.path().exists())

    def test_a_cell_claim_is_seen_by_run_next(self):
        self.cell()
        self.cell_claim("T-1", "plan")
        self.assertEqual(self.next("T-1", "--holder", MINE)["needs"], "worker-in-cell")
        self.assertEqual(self.next("T-1")["needs"], "worker-in-cell")


class ScheduleTest(Base):
    """Row 5: run.py schedule ... --holder H."""

    def schedule(self, *argv):
        code, out, err = self.run_cmd("schedule", *argv)
        self.assertEqual(code, 0, err)
        return json.loads(out)

    def test_another_holders_claim_holds_the_ticket_before_the_ceiling(self):
        self.cell("T-1")
        self.cell("T-2")
        self.cell("T-3")
        self.put_claim("T-1", holder=OTHER, at=ago(10))
        report = self.schedule("T-1", "T-2", "T-3", "--running", "R-1", "--limit", "1", "--holder", MINE)
        self.assertNotIn(OTHER, json.dumps(report))
        held = {item["ticket_id"]: item for item in report["held"]}
        self.assertEqual((held["T-1"]["rule"], held["T-1"]["after"]), ("claimed", []))
        for text in ("plan step", self.saved("T-1")["at"], C.lapses_at(self.saved("T-1"), 90)):
            self.assertIn(text, held["T-1"]["why"])
        self.assertEqual((held["T-2"]["rule"], held["T-3"]["rule"]), ("ceiling", "ceiling"))
        self.assertFalse(report["started"])

    def test_own_claims_do_not_hold_and_no_holder_holds_any(self):
        self.cell("T-1")
        self.put_claim("T-1", holder=MINE)
        self.assertEqual([item["ticket_id"] for item in self.schedule("T-1", "--holder", MINE)["start"]], ["T-1"])
        self.assertEqual(self.schedule("T-1")["held"][0]["rule"], "claimed")
        self.put_claim("T-1", holder=MINE, stage="interview")
        self.assertEqual([item["ticket_id"] for item in self.schedule("T-1")["start"]], ["T-1"], "a stale claim holds nothing")

    def test_a_running_ticket_is_skipped_not_held(self):
        self.cell("T-1")
        self.put_claim("T-1", holder=OTHER)
        report = self.schedule("T-1", "--running", "T-1", "--holder", MINE)
        self.assertEqual((report["held"], report["skipped_as_running"]), ([], ["T-1"]))

    def test_an_unusable_holder_is_refused(self):
        self.cell("T-1")
        code, _, err = self.run_cmd("schedule", "T-1", "--holder", "new")
        self.assertEqual(code, 1)
        self.assertIn("--holder", err)

    def test_the_pure_rule_holds_a_claimed_ticket_first(self):
        import schedule
        claimed = {"step": "build", "at": "2026-11-16T09:00:00+00:00", "lapses_at": "2026-11-16T10:30:00+00:00"}
        tickets = [{"ticket_id": "A", "phase": "line", "risk": "Low", "files": ["a"], "waits_for": ["Z"], "claimed": claimed}]
        decided = schedule.decide(tickets, [{"ticket_id": "R", "phase": "line", "risk": "High", "files": None, "waits_for": []}], 1, 1)
        self.assertEqual([(item["ticket_id"], item["rule"], item["after"]) for item in decided["held"]], [("A", "claimed", [])])


class StatusTest(Base):
    """Row 6: run.py status shows a fresh claim: the step and since when, never the holder."""

    def test_rows_show_a_fresh_claim_and_it_is_not_ready_to_run(self):
        self.cell("T-1")
        self.cell("T-2")
        self.cell("T-3")
        self.put_claim("T-1", holder=OTHER, at=ago(12))
        self.put_claim("T-3", holder=OTHER, at=ago(500))
        code, out, err = self.run_cmd("status", "--headless")
        self.assertEqual(code, 0, err)
        self.assertNotIn(OTHER, out)
        board = json.loads(out)
        rows = {row["ticket_id"]: row for row in board["tickets"]}
        self.assertEqual(set(rows["T-1"]["claim"]), {"step", "stage", "at", "renewed_at", "lapses_at"})
        self.assertEqual((rows["T-1"]["claim"]["step"], rows["T-1"]["claim"]["at"]), ("plan", self.saved("T-1")["at"]))
        self.assertNotIn("claim", rows["T-2"])
        self.assertNotIn("claim", rows["T-3"], "a stale claim is not shown")
        self.assertEqual((board["ready_to_run"], board["being_worked_on"]), (["T-2", "T-3"], ["T-1"]))
        self.assertIn("1 with a worker on it now", board["digest"]["where"])


class NothingElseWritesTest(Base):
    def test_reading_commands_write_no_claim(self):
        self.cell("T-1")
        self.cell("T-2", stage="verified")
        for argv in (("next", "T-1"), ("next", "T-1", "--headless"), ("status",), ("status", "--headless"), ("explain", "T-1", "--json"),
                     ("schedule", "T-1", "T-2"), ("schedule", "T-1", "T-2", "--dry-run", "--holder", MINE), ("where",)):
            code, _, err = self.run_cmd(*argv)
            self.assertEqual(code, 0, (argv, err))
            self.assertFalse(self.path("T-1").exists() or self.path("T-2").exists(), argv)

    def test_where_prints_a_new_holder_each_time(self):
        first = json.loads(self.run_cmd("where")[1])["holder"]
        second = json.loads(self.run_cmd("where")[1])["holder"]
        self.assertRegex(first, HEX32)
        self.assertNotEqual(first, second)

    def test_only_next_and_cell_claim_write_a_claim(self):
        """Over the repository: the helper's take() and write() are called from run.py's next and cell.py's claim only."""
        callers = {}
        for path in sorted((ROOT / "skills").rglob("*.py")) + [ROOT / "workflows" / "belt.js"]:
            if path.name == "claim.py":
                continue
            text = path.read_text(encoding="utf-8")
            if re.search(r"\b(?:C|claims|claims\(\))\.(?:take|write)\(", text):
                callers[str(path.relative_to(ROOT))] = text
            # Reading a claim is allowed anywhere; writing claim.json other than through the helper is not.
            self.assertNotRegex(text, r"claim\.json[^\n]*\.(?:write_text|write_bytes|open\()", path.name)
        self.assertEqual(sorted(callers), ["skills/intent/scripts/cell.py", "skills/run/scripts/run.py"])
        self.assertEqual(len(re.findall(r"\bclaims\.take\(", callers["skills/intent/scripts/cell.py"])), 1)
        run_text = callers["skills/run/scripts/run.py"]
        self.assertEqual(len(re.findall(r"\bC\.take\(", run_text)), 1)
        self.assertIn("def claim_step(", run_text)
        self.assertNotRegex(run_text, r"\b(?:C|claims\(\))\.write\(")

    def test_the_supervisor_and_intake_use_the_unclaimed_next_step(self):
        for name in ("supervisor.py", "intake.py", "explain.py", "doctor.py", "schedule.py", "executor.py", "monitoring.py"):
            text = (ROOT / "skills" / "run" / "scripts" / name).read_text(encoding="utf-8")
            self.assertNotIn("claim_step", text, name)
            self.assertNotRegex(text, r"\.take\(", name)


class SupervisedTest(Base):
    def test_inside_a_supervised_execution_it_behaves_the_same(self):
        self.cell("T-1")
        (self.root / ".factory" / "intake").mkdir()
        (self.root / ".factory" / "intake" / "ledger.json").write_text(json.dumps(
            {"supervisor": {"executions": {"x0123456789ab": {"ticket_id": "T-1", "state": "started"}}}}))
        os.environ[run.EXECUTION_ENV] = "x0123456789ab"
        step = self.next("T-1", "--holder", MINE)
        self.assertEqual(step["claim"]["holder"], MINE)
        self.assertEqual(self.next("T-1", "--holder", OTHER)["needs"], "worker-in-cell")
        self.assertEqual(self.next("T-1")["needs"], "worker-in-cell")


class NoStationResultChangesTest(Base):
    def test_the_routing_answer_without_a_holder_is_unchanged_by_a_stale_or_absent_claim(self):
        for stage in ("interview", "spec-ready", "planned", "building", "built", "verified", "awaiting-human", "merged", "blocked"):
            self.cell(stage=stage)
            if self.path().exists():
                self.path().unlink()
            plain = self.next("T-1")
            self.put_claim(stage="another", holder=OTHER)
            self.assertEqual(self.next("T-1"), plain, stage)

    def test_next_step_itself_never_reads_a_claim(self):
        """The supervisor and intake call next_step directly: a fresh claim changes nothing there."""
        for stage in ("spec-ready", "planned", "built", "verified"):
            self.cell(stage=stage)
            if self.path().exists():
                self.path().unlink()
            project = run.Project(self.root)
            before = run.next_step(project, "T-1", True)
            self.put_claim(stage=stage, holder=OTHER)
            self.assertEqual(run.next_step(project, "T-1", True), before, stage)



class StationsIgnoreTheClaimTest(BuildBase):
    def test_grooming_planning_and_building_run_the_same_with_a_claim_in_the_cell(self):
        info = json.loads(self.cell_cmd("open", "LOCAL-001"))
        self.put(Path(info["workdir"]), {f"specs/slices/{SPEC_NAME}": SPEC})
        self.put(self.cellroot, {"intent.md": INTENT})
        self.cell_cmd("finalize", "LOCAL-001", "--spec", f"specs/slices/{SPEC_NAME}")
        claimed = json.loads(self.cell_cmd("claim", "LOCAL-001", "plan"))
        self.put(self.cellroot, {"plan.md": PLAN})
        self.cell_cmd("check-plan", "LOCAL-001")  # another holder's claim is no gate on the station itself
        self.assertEqual(json.loads((self.cellroot / "cell.json").read_text())["stage"], "planned")
        self.audit_report()
        (self.cellroot / "claim.json").write_text(json.dumps(dict(claimed, stage="planned", step="build")))
        self.ok("start", "LOCAL-001")
        self.build_through("T01")
        self.assertEqual(json.loads((self.cellroot / "claim.json").read_text())["holder"], claimed["holder"], "no station touches the claim")


if __name__ == "__main__":
    unittest.main()
