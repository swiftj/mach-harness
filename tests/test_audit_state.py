"""When the readiness audit must run again: skills/intent/scripts/audit_state.py, the one rule run.py (the routing
sheet and status), build.py (the build's start) and audit.py (gate) share.

A Gold or Silver audit stays good when the main branch moves; it is due again when it is older than
audit.max_age_days (30 by default), or a build's tests failed before any change since it ran. A Bronze audit is due
again as soon as the main branch moves."""

import io
import json
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "skills" / "audit" / "scripts"))
from test_run import Base, run  # noqa: E402
from test_build import build, git  # noqa: E402
import audit as audit_script  # noqa: E402
import audit_state  # noqa: E402

FAILING = f"{sys.executable} -c 'raise SystemExit(3)'"


def ago(days=0.0, minutes=0.0):
    return (datetime.now(timezone.utc) - timedelta(days=days, minutes=minutes)).isoformat(timespec="seconds")


class JudgeTest(unittest.TestCase):
    """The rule on its own, on what was read."""

    def report(self, tier="Gold", head="a" * 40, days=0.0):
        return {"readiness_tier": tier, "head": head, "timestamp": ago(days), "blockers": [] if tier != "Bronze" else ["The tests fail."]}

    def test_a_passing_audit_stays_good_when_the_main_branch_moves(self):
        for tier in ("Gold", "Silver"):
            judged = audit_state.judge(self.report(tier), "b" * 40, None, 30)
            self.assertEqual((judged["state"], judged["tier"]), ("ok", tier))
            self.assertIn("aaaaaaaaaa", judged["note"])
            self.assertIn("bbbbbbbbbb", judged["note"])
            self.assertIn("ran at", judged["note"])
        self.assertNotIn("note", audit_state.judge(self.report(), "a" * 40, None, 30))

    def test_too_old(self):
        judged = audit_state.judge(self.report(days=31), "a" * 40, None, 30)
        self.assertEqual((judged["state"], judged["why"]), ("stale", "too-old"))
        self.assertIn("ran 31 days ago, more than audit.max_age_days (30) allows", judged["reason"])
        self.assertEqual(audit_state.judge(self.report(days=29), "a" * 40, None, 30)["state"], "ok")
        undated = self.report()
        del undated["timestamp"]
        self.assertIn("does not say when it ran", audit_state.judge(undated, "a" * 40, None, 30)["reason"])

    def test_a_failed_baseline_after_the_audit(self):
        report = self.report(days=1)
        due = {"at": ago(), "code": "baseline-red", "ticket_id": "LOCAL-001"}
        judged = audit_state.judge(report, "b" * 40, due, 30)
        self.assertEqual((judged["state"], judged["why"]), ("stale", "baseline-failed"))
        self.assertIn("a build's tests failed before any change (LOCAL-001", judged["reason"])
        self.assertEqual(audit_state.judge(self.report(), "b" * 40, {"at": ago(days=2)}, 30)["state"], "ok", "an audit after it clears it")

    def test_bronze_is_due_as_soon_as_main_moves(self):
        self.assertEqual(audit_state.judge(self.report("Bronze"), "a" * 40, None, 30)["state"], "bronze")
        judged = audit_state.judge(self.report("Bronze"), "b" * 40, None, 30)
        self.assertEqual((judged["state"], judged["why"]), ("stale", "bronze-moved"))
        self.assertIn("the repository is at Bronze and the main branch has moved since the audit ran at aaaaaaaaaa", judged["reason"])

    def test_missing_and_settings(self):
        self.assertEqual(audit_state.judge(None, "a" * 40, None, 30)["state"], "missing")
        self.assertEqual(audit_state.max_age_days({}), 30)
        self.assertEqual(audit_state.max_age_days({"audit": {"max_age_days": 7}}), 7)
        self.assertEqual(audit_state.max_age_days({"audit": {"max_age_days": 7}}, 3), 3)
        self.assertEqual(audit_state.state(Path("/nonexistent"), {"build": {"require_audit": False}}), {"state": "off"})


class ProjectBase(Base):
    def main_commit(self, n=1):
        for i in range(n):
            self.put(self.project, {f"app/moved_{i}.py": f"X = {i}\n"})
            git(self.project, "add", "-A")
            git(self.project, "commit", "-q", "-m", f"main moves {i}")
        return git(self.project, "rev-parse", "HEAD").stdout.strip()

    def config(self, **sections):
        self.put(self.project, {".factory/config.json": json.dumps(sections)})

    def status(self):
        code, out, err = self.run_cmd("status")
        self.assertEqual(code, 0, err)
        return json.loads(out)["audit"]


class RoutingTest(ProjectBase):
    """run.py's routing sheet and status."""

    def test_a_gold_or_silver_audit_is_still_good_after_main_moves(self):
        self.groom()
        audited = git(self.project, "rev-parse", "HEAD").stdout.strip()
        self.audit_report("Gold")
        self.main_commit()
        self.assertEqual(self.next()["action"], "build", "one commit")
        head = self.main_commit(4)
        self.assertEqual(self.next()["action"], "build", "many commits")
        shown = self.status()
        self.assertEqual((shown["state"], shown["tier"], shown["ran_at_commit"], shown["head"]), ("ok", "Gold", audited, head))
        self.assertIn(f"on commit {audited[:10]}", shown["note"])
        self.assertIn(shown["ran_at"], shown["note"])
        self.audit_report("Silver", head=audited)
        self.assertEqual(self.next()["action"], "build")

    def test_due_after_max_age_days(self):
        self.groom()
        self.audit_report("Gold", timestamp=ago(days=29))
        self.assertEqual(self.next()["action"], "build", "30 days by default")
        self.audit_report("Gold", timestamp=ago(days=31))
        step = self.next()
        self.assertEqual((step["action"], step["audit_due"]), ("audit", "too-old"))
        self.assertIn("The readiness audit must run again: it ran 31 days ago, more than audit.max_age_days (30) allows.", step["reason"])
        self.assertEqual(self.status()["why"], "too-old")
        self.config(audit={"max_age_days": 60})
        self.assertEqual(self.next()["action"], "build", "the setting is kept")

    def test_bronze_is_due_as_soon_as_main_moves(self):
        self.groom()
        self.audit_report("Bronze")
        self.assertEqual(self.next()["needs"], "repository-hardening")
        self.main_commit()
        step = self.next()
        self.assertEqual((step["action"], step["audit_due"]), ("audit", "bronze-moved"))
        self.assertIn("the repository is at Bronze and the main branch has moved since the audit ran", step["reason"])

    def test_missing_and_switched_off(self):
        self.groom()
        step = self.next()
        self.assertEqual(step["action"], "audit")
        self.assertIn("There is no readiness audit report yet. Building is gated on it.", step["reason"])
        self.config(build={"require_audit": False})
        self.assertEqual(self.next()["action"], "build")
        self.assertEqual(self.status(), {"state": "off"})


class BuildStartTest(ProjectBase):
    """build.py start: the same rule."""

    def test_a_gold_or_silver_audit_lets_the_build_start_after_main_moves(self):
        self.groom()
        self.audit_report("Silver")
        self.main_commit(3)
        started = self.ok("start", "LOCAL-001")
        self.assertEqual(started["status"], "STARTED")
        self.assertTrue(started["audit"]["human_review_required"])

    def test_one_commit_gold(self):
        self.groom()
        self.audit_report("Gold")
        self.main_commit()
        self.assertEqual(self.ok("start", "LOCAL-001")["status"], "STARTED")

    def test_refusals_say_why(self):
        self.groom()
        self.audit_report("Gold", timestamp=ago(days=31))
        self.assertIn("it ran 31 days ago, more than audit.max_age_days (30) allows", self.refused("start", "LOCAL-001"))
        self.audit_report("Bronze")
        self.main_commit()
        self.assertIn("the repository is at Bronze and the main branch has moved", self.refused("start", "LOCAL-001"))

    def test_a_failed_baseline_makes_the_audit_due_until_the_next_audit(self):
        self.groom()
        self.audit_report("Gold", timestamp=ago(minutes=5))
        self.config(build={"commands": {"test": FAILING}})
        refusal = self.refused("start", "LOCAL-001")
        self.assertIn("already fail in the cell", refusal)
        self.assertIn("the readiness audit is marked due", refusal)
        step = self.next()
        self.assertEqual((step["action"], step["audit_due"]), ("audit", "baseline-failed"))
        self.assertIn("a build's tests failed before any change (LOCAL-001", step["reason"])
        self.assertIn("a build's tests failed before any change", self.refused("start", "LOCAL-001"))
        self.audit_report("Gold", timestamp=ago(minutes=-1))
        self.assertEqual(self.next()["action"], "build", "good again after the next audit")
        self.config()
        self.assertEqual(self.ok("start", "LOCAL-001")["status"], "STARTED")

    def test_switched_off_records_nothing(self):
        self.groom()
        self.config(build={"require_audit": False, "commands": {"test": FAILING}})
        self.assertIn("already fail in the cell", self.refused("start", "LOCAL-001"))
        self.assertFalse((self.project / ".factory" / "audit-due.json").exists())


class AgreeTest(ProjectBase):
    """The routing sheet, the build's start gate and audit.py gate give the same answer on every case."""

    def gate(self):
        try:
            result = build.audit_gate(build.Cell(self.project, "LOCAL-001"))
        except build.BuildError as exc:
            return {"audit-missing": "missing", "audit-stale": "stale", "audit-bronze": "bronze"}[exc.code], str(exc)
        return ("off" if result["tier"] is None else "ok"), ""

    def audit_gate(self):
        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(io.StringIO()):
            code = audit_script.main(["--project", str(self.project), "gate"])
        return code, json.loads(out.getvalue())

    def test_every_case(self):
        self.groom()
        first = git(self.project, "rev-parse", "HEAD").stdout.strip()
        moved = self.main_commit()
        # (name, tier or None, report head, days old, failed baseline: None, "before" or "after", settings, routing state, why)
        table = [
            ("gold here", "Gold", moved, 0, None, {}, "ok", None),
            ("gold, main moved", "Gold", first, 0, None, {}, "ok", None),
            ("silver, main moved", "Silver", first, 0, None, {}, "ok", None),
            ("gold, 29 days", "Gold", first, 29, None, {}, "ok", None),
            ("gold, 31 days", "Gold", moved, 31, None, {}, "stale", "too-old"),
            ("gold, 8 days, limit 7", "Gold", first, 8, None, {"audit": {"max_age_days": 7}}, "stale", "too-old"),
            ("gold, baseline failed since", "Gold", first, 1, "after", {}, "stale", "baseline-failed"),
            ("gold, baseline failed before it", "Gold", first, 1, "before", {}, "ok", None),
            ("bronze here", "Bronze", moved, 0, None, {}, "bronze", None),
            ("bronze, main moved", "Bronze", first, 0, None, {}, "stale", "bronze-moved"),
            ("missing", None, None, 0, None, {}, "missing", None),
            ("switched off", "Bronze", first, 99, "after", {"build": {"require_audit": False}}, "off", None),
        ]
        due_path = self.project / audit_state.DUE
        for name, tier, head, days, failed, settings, state, why in table:
            with self.subTest(name):
                report_path = self.project / audit_state.REPORT
                if report_path.exists():
                    report_path.unlink()
                if due_path.exists():
                    due_path.unlink()
                if tier:
                    self.audit_report(tier, head=head, timestamp=ago(days=days))
                if failed:
                    self.put(self.project, {audit_state.DUE: json.dumps({"at": ago(days=days + 1 if failed == "before" else 0), "ticket_id": "LOCAL-001"})})
                self.config(**settings)
                routed = run.Project(self.project).audit()
                self.assertEqual((routed["state"], routed.get("why") if state == "stale" else None), (state, why))
                gated, words = self.gate()
                self.assertEqual(gated, state)
                if state == "stale":
                    self.assertIn(routed["reason"], words)
                    step = self.next()
                    self.assertEqual(step["action"], "audit")
                    self.assertIn(routed["reason"], step["reason"])
                if state != "off":
                    code, shown = self.audit_gate()
                    self.assertEqual(shown["allowed"], state == "ok")
                    self.assertEqual(code, 0 if state == "ok" else 1)
                    if state == "stale":
                        self.assertEqual(shown["reason"], routed["reason"])


if __name__ == "__main__":
    unittest.main()
