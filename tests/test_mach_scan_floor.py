"""M15: a security-scan ticket's risk floor, held by script as product and monitoring work hold theirs.

The labels ticket.py ingest-scan files are the source. cell.py finalize raises a lower tier in the cell and records
`risk_floor` (the record monitoring.py writes); a plan may not lower it again; review.py never seats a panel below it.
Everything runs through the real scripts on a real Git repository."""

import io
import json
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "skills" / "intent" / "scripts"))
sys.path.insert(0, str(ROOT / "skills" / "ticket" / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))
import cell as cell_script  # noqa: E402
import scan  # noqa: E402
import ticket  # noqa: E402
from test_build import INTENT, PLAN, SPEC, SPEC_NAME  # noqa: E402
from test_review import Base as ReviewBase, TICKET  # noqa: E402


def sarif(uri):
    return {"version": "2.1.0", "runs": [{"tool": {"driver": {"name": "Sample Scanner", "rules": []}}, "results": [
        {"ruleId": "R1", "level": "error", "message": {"text": "Something is wrong."},
         "locations": [{"physicalLocation": {"artifactLocation": {"uri": uri}, "region": {"startLine": 3}}}]}]}]}


class Base(ReviewBase):
    def file_scan_ticket(self, uri):
        """File one ticket from a scanner's export with the real ticket station, and give LOCAL-001 the labels it filed."""
        export = Path(self.tmp.name) / "scan.sarif"
        export.write_text(json.dumps(sarif(uri)))
        self.config({"tickets": {"provider": "local"}})
        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(io.StringIO()):
            code = ticket.main(["--project", str(self.project), "ingest-scan", str(export), "--no-sync"])
        self.assertEqual(code, 0, out.getvalue())
        filed = json.loads(out.getvalue())["filed"][0]
        record = json.loads((self.project / ".factory" / "inbox" / f"{filed['ticket_id']}.json").read_text())
        self.assertEqual(record["labels"], filed["labels"])
        self.put(self.project, {f".factory/inbox/{TICKET}.json": json.dumps({**record, "id": TICKET})})
        return filed

    def labelled(self, *labels):
        self.put(self.project, {f".factory/inbox/{TICKET}.json": json.dumps({"id": TICKET, "labels": list(labels)})})

    def finalize(self, tier, *extra):
        info = json.loads(self.cell_cmd("open", TICKET))
        self.put(Path(info["workdir"]), {f"specs/slices/{SPEC_NAME}": SPEC})
        self.put(self.cellroot, {"intent.md": INTENT.replace("- **Tier:** Medium", f"- **Tier:** {tier}")})
        return self.finalized(*extra)

    def finalized(self, *extra):
        """finalize's JSON answer, from among the lines it prints."""
        out = self.cell_cmd("finalize", TICKET, "--spec", f"specs/slices/{SPEC_NAME}", *extra)
        return json.loads(out[out.index('{\n  "status"'):out.index("\nREADY:")])

    def cell_json(self):
        return json.loads((self.cellroot / "cell.json").read_text())

    def spec_risk(self):
        return json.loads((self.cellroot / "spec.json").read_text())["risk"]

    def check_plan(self, tier):
        self.put(self.cellroot, {"plan.md": PLAN.replace("- **Risk tier:** Medium", f"- **Risk tier:** {tier}")})
        with redirect_stdout(io.StringIO()) as out, redirect_stderr(io.StringIO()):
            code = cell_script.main(["--project", str(self.project), "check-plan", TICKET])
        return code, out.getvalue()


class RuleTest(unittest.TestCase):
    def test_the_labels_are_the_source(self):
        self.assertIsNone(scan.risk_floor(["bug", "risk-high"]), "risk-high alone sets no floor: only a scan ticket's labels do")
        self.assertIsNone(scan.risk_floor(None))
        self.assertEqual(scan.risk_floor(["security-scan", "risk-medium"]), "Medium")
        self.assertEqual(scan.risk_floor(["security-scan"]), "Medium", "a scan ticket with no tier label is still never below Medium")
        self.assertEqual(scan.risk_floor(["Security-Scan", "risk-high"]), "High")


class GroomingTest(Base):
    def test_a_scan_ticket_groomed_low_is_raised_to_medium_and_a_plan_cannot_lower_it(self):
        filed = self.file_scan_ticket("src/report.py")
        self.assertEqual((filed["risk"], scan.risk_floor(filed["labels"])), ("Medium", "Medium"))
        ready = self.finalize("Low")
        self.assertEqual((ready["status"], ready["risk"]), ("READY", "Medium"))
        floor = {"from": "Low", "to": "Medium", "why": "a security-scan ticket is never groomed or reviewed below Medium"}
        self.assertEqual(ready["risk_floor"], floor)
        self.assertEqual((self.cell_json()["risk"], self.cell_json()["risk_floor"]), ("Medium", floor))
        self.assertEqual(self.spec_risk(), "Medium")
        code, out = self.check_plan("Low")
        self.assertEqual(code, 1)
        self.assertIn("a plan may raise the tier, never lower it", out)
        self.assertEqual(self.check_plan("Medium")[0], 0)

    def test_risk_high_holds_the_ticket_at_high(self):
        filed = self.file_scan_ticket("app/auth/session.py")
        self.assertIn("risk-high", filed["labels"])
        ready = self.finalize("Medium")
        self.assertEqual(ready["risk"], "High")
        self.assertEqual(self.cell_json()["risk_floor"]["from"], "Medium")
        self.assertEqual(self.check_plan("Medium")[0], 1)

    def test_a_tier_at_or_above_the_floor_is_kept_and_an_old_record_is_dropped(self):
        self.labelled("security-scan", "risk-medium")
        self.finalize("Low", "--no-commit")
        self.assertIn("risk_floor", self.cell_json())
        self.put(self.cellroot, {"intent.md": INTENT.replace("- **Tier:** Medium", "- **Tier:** High")})
        ready = self.finalized("--no-commit")
        self.assertEqual(ready["risk"], "High", "grooming may raise the tier")
        self.assertNotIn("risk_floor", ready)
        self.assertNotIn("risk_floor", self.cell_json(), "the record goes once grooming reaches the floor itself")

    def test_other_tickets_are_untouched(self):
        self.labelled("bug", "risk-high")
        ready = self.finalize("Low")
        self.assertEqual(ready["risk"], "Low")
        self.assertNotIn("risk_floor", ready)
        self.assertNotIn("risk_floor", self.cell_json())

    def test_another_floor_record_is_left_alone(self):
        self.finalize("Medium", "--no-commit")
        self.edit_json("cell.json", risk_floor={"from": "Low", "to": "Medium", "why": "monitoring requests are never reviewed below Medium"})
        self.labelled("security-scan")
        self.cell_cmd("finalize", TICKET, "--spec", f"specs/slices/{SPEC_NAME}", "--no-commit")
        self.assertEqual(self.cell_json()["risk_floor"]["why"], "monitoring requests are never reviewed below Medium")


class ReviewTest(Base):
    def setUp(self):
        super().setUp()
        self.verified()

    def test_review_never_seats_a_scan_ticket_below_its_floor(self):
        self.labelled("security-scan", "risk-medium")
        self.edit_json("cell.json", risk="Low")  # groomed before the rule, or changed by hand
        started = self.r_ok("start", TICKET)
        self.assertEqual((started["risk"], started["approvals_needed"], len(started["panel"])), ("Medium", 2, 3))
        packet = json.loads((self.round / "packet.json").read_text())
        self.assertEqual(packet["risk_floor"], {"from": "Low", "to": "Medium", "why": "a security-scan ticket is never groomed or reviewed below Medium"})

    def test_risk_high_is_reviewed_at_high_with_a_person(self):
        self.labelled("security-scan", "risk-high")
        started = self.r_ok("start", TICKET)
        self.assertEqual((started["risk"], started["approvals_needed"], started["human_approval_required"]), ("High", 3, True))

    def test_a_tier_above_the_floor_and_other_tickets_are_as_before(self):
        self.labelled("security-scan", "risk-medium")
        self.edit_json("cell.json", risk="High")
        self.assertEqual(self.r_ok("start", TICKET)["risk"], "High")
        self.assertNotIn("risk_floor", json.loads((self.round / "packet.json").read_text()))
        self.labelled("bug")
        self.edit_json("cell.json", risk="Low")
        self.assertEqual(self.r_ok("start", TICKET)["risk"], "Low")
        self.assertNotIn("risk_floor", json.loads((self.round / "packet.json").read_text()))


if __name__ == "__main__":
    unittest.main()
