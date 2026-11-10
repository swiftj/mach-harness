"""Tests for review.py: start gates, the panel, findings and votes, the tally, and a person's sign-off."""

import io
import json
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "skills" / "review" / "scripts"))
sys.path.insert(0, str(ROOT / "skills" / "verify" / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))
import review  # noqa: E402
import verify  # noqa: E402
from test_build import Base as BuildBase, git  # noqa: E402

TICKET = "LOCAL-001"
TARGETS = ["AC-01", "AC-02", "AC-03", "R1", "R2", "R3", "R4", "R5"]
NOTE = "Called invite() as a consumer and observed the expected outcome and unchanged seat count."
SUMMARY = "Read the whole diff against the spec and the evidence, and checked every rule in the review guide."
DETAIL = "The function ignores its argument; validate the address before sending anything."
PANEL = ["architecture", "security", "product"]


class Base(BuildBase):
    def setUp(self):
        super().setUp()
        self.evidence = self.cellroot / "evidence"
        self.round = self.cellroot / "review" / "round-1"
        self.count = 0

    # --- getting a cell to the review station -------------------------------------------------

    def built(self):
        self.ready()
        self.ok("start", TICKET)
        self.build_through("T05")
        self.ok("finish", TICKET)

    def run_verify(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = verify.main(["--project", str(self.project), *argv])
        self.assertEqual(code, 0, err.getvalue() + out.getvalue())
        return json.loads(out.getvalue())

    def verified(self):
        self.built()
        self.run_verify("start", TICKET)
        (self.evidence / "consumer-run.log").write_text("AC-01 ok\n")
        for target in TARGETS:
            self.run_verify("record", TICKET, target, "--result", "pass", "--evidence", "consumer-run.log", "--note", NOTE)
        self.assertEqual(self.run_verify("finish", TICKET)["status"], "PASS")

    # --- driving review.py --------------------------------------------------------------------

    def run_review(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = review.main(["--project", str(self.project), *argv])
        return code, out.getvalue(), err.getvalue()

    def r_ok(self, *argv):
        code, out, err = self.run_review(*argv)
        self.assertEqual(code, 0, err + out)
        return json.loads(out)

    def r_refused(self, *argv):
        code, out, err = self.run_review(*argv)
        self.assertEqual(code, 1, out)
        self.assertIn("refused:", err)
        return err

    def cell_json(self):
        return json.loads((self.cellroot / "cell.json").read_text())

    def edit_json(self, name, **changes):
        path = self.cellroot / name
        data = json.loads(path.read_text())
        data.update(changes)
        path.write_text(json.dumps(data))

    def config(self, data):
        self.put(self.project, {".factory/config.json": json.dumps(data)})

    def commit_in_cell(self):
        self.put(self.work, {"late.txt": "added after the fact\n"})
        git(self.work, "add", "-A")
        git(self.work, "commit", "-q", "-m", "late change")

    # --- findings and votes -------------------------------------------------------------------

    @staticmethod
    def blocker(**changes):
        finding = {"severity": "blocker", "title": "Email is never validated", "detail": DETAIL, "file": "app/invite.py", "line": 2, "rule": "FR-01"}
        finding.update(changes)
        return {key: value for key, value in finding.items() if value is not None}

    @staticmethod
    def note(**changes):
        finding = {"severity": "note", "title": "README could say more", "detail": "Consider one more sentence on what an admin sees afterwards."}
        finding.update(changes)
        return finding

    def findings_file(self, *findings, summary=SUMMARY, raw=None):
        self.count += 1
        path = Path(self.tmp.name) / f"findings-{self.count}.json"
        path.write_text(raw if raw is not None else json.dumps({"summary": summary, "findings": list(findings)}))
        return str(path)

    def submit(self, role, *findings, **kwargs):
        return self.run_review("submit", TICKET, "--reviewer", role, "--findings", self.findings_file(*findings, **kwargs))

    def vote(self, role, *findings):
        code, out, err = self.submit(role, *findings)
        self.assertEqual(code, 0, err + out)
        return json.loads(out)

    def bad(self, *findings, role="architecture", **kwargs):
        code, out, err = self.submit(role, *findings, **kwargs)
        self.assertEqual(code, 1, out)
        self.assertFalse((self.round / "votes" / f"{role}.json").exists(), "a refused submission records no vote")
        return err

    def cast(self, rejecting=(), roles=PANEL):
        for role in roles:
            self.vote(role, *([self.blocker()] if role in rejecting else []))

    def tally(self):
        code, out, err = self.run_review("tally", TICKET)
        self.assertTrue(out, err)
        return code, json.loads(out)


class StartGateTest(Base):
    def test_only_a_verified_cell_can_be_reviewed(self):
        self.assertIn("No cell for LOCAL-001", self.r_refused("start", TICKET))
        self.built()
        self.assertIn("The cell's stage is 'built'. Only a verified cell can be reviewed", self.r_refused("start", TICKET))
        self.assertFalse((self.cellroot / "review").exists())
        self.assertIn("Review has not started", self.r_refused("tally", TICKET))
        self.assertIn("Review has not started", self.r_refused("submit", TICKET, "--reviewer", "product", "--findings", self.findings_file()))

    def test_changed_code_missing_evidence_and_failed_verification_refuse(self):
        self.verified()
        self.put(self.work, {"stray.txt": "x"})
        self.assertIn("uncommitted changes", self.r_refused("start", TICKET))
        (self.work / "stray.txt").unlink()
        (self.evidence / "consumer-run.log").unlink()
        self.assertIn("Evidence listed in the verification summary is missing: consumer-run.log", self.r_refused("start", TICKET))
        (self.evidence / "consumer-run.log").write_text("back\n")
        self.commit_in_cell()
        self.assertIn("code changed after it was built or verified", self.r_refused("start", TICKET))
        self.edit_json("evidence/summary.json", status="FAIL_WITH_EVIDENCE")
        self.assertIn("no passing verification", self.r_refused("start", TICKET))
        self.assertFalse((self.cellroot / "review").exists())


class PanelTest(Base):
    def setUp(self):
        super().setUp()
        self.verified()

    def test_medium_start_writes_the_packet_and_the_diff(self):
        started = self.r_ok("start", TICKET)
        self.assertEqual((started["status"], started["round"], started["max_rounds"], started["risk"]), ("STARTED", 1, 3, "Medium"))
        self.assertEqual((started["approvals_needed"], started["human_approval_required"]), (2, False))
        self.assertEqual([(seat["role"], seat["model"]) for seat in started["panel"]], [(role, "sonnet") for role in PANEL])
        packet = json.loads((self.round / "packet.json").read_text())
        self.assertEqual(started["packet"], str(self.round / "packet.json"))
        self.assertEqual((packet["ticket_id"], packet["slice_id"], packet["branch"]), (TICKET, "SLICE-001", "feature/LOCAL-001"))
        self.assertEqual(packet["head"], git(self.work, "rev-parse", "HEAD").stdout.strip())
        self.assertEqual(packet["baseline"], json.loads((self.cellroot / "build-report.json").read_text())["baseline"])
        self.assertEqual(sorted(packet["files_changed"]), ["README.md", "app/invite.py", "tests/test_invite.py", "tests/test_scenarios.py"])
        self.assertIn("4 files changed", packet["diff_stat"])
        self.assertEqual(packet["paths"]["workdir"], str(self.work))
        self.assertEqual(packet["paths"]["earlier_findings"], [])
        self.assertIsNone(packet["paths"]["review_rules"])
        diff = (self.round / "diff.patch").read_text()
        self.assertEqual(packet["paths"]["diff"], str(self.round / "diff.patch"))
        self.assertIn("+def release():", diff)
        self.assertIn("tests/test_scenarios.py", diff)
        self.assertEqual(self.cell_json()["stage"], "verified", "start does not move the cell")

    def test_panel_follows_the_risk_tier(self):
        self.edit_json("cell.json", risk="High")
        started = self.r_ok("start", TICKET)
        self.assertEqual((started["risk"], started["approvals_needed"], started["human_approval_required"]), ("High", 3, True))
        self.assertEqual([(seat["role"], seat["model"]) for seat in started["panel"]], [(role, "opus") for role in PANEL])
        self.edit_json("cell.json", risk="Low")
        started = self.r_ok("start", TICKET)
        self.assertEqual((started["risk"], started["approvals_needed"], started["human_approval_required"]), ("Low", 1, False))
        self.assertEqual([(seat["role"], seat["model"]) for seat in started["panel"]], [("general", "sonnet")])
        self.edit_json("cell.json", risk="Trivial")
        started = self.r_ok("start", TICKET)
        self.assertEqual((started["risk"], len(started["panel"]), started["human_approval_required"]), ("High", 3, True), "an unknown tier is treated as High")
        self.edit_json("cell.json", risk="Medium", human_review_required=True)
        started = self.r_ok("start", TICKET)
        self.assertEqual((started["risk"], started["approvals_needed"], started["human_approval_required"]), ("Medium", 2, True))

    def test_config_overrides(self):
        self.config({"review": {"medium": {"approvals": 3, "human_approval": True}, "max_loops": 5}, "models": {"build": "haiku", "contracts": "fable"}})
        started = self.r_ok("start", TICKET)
        self.assertEqual((started["approvals_needed"], started["human_approval_required"], started["max_rounds"]), (3, True, 5))
        self.assertEqual({seat["model"] for seat in started["panel"]}, {"haiku"})
        self.edit_json("cell.json", risk="High")
        self.assertEqual({seat["model"] for seat in self.r_ok("start", TICKET)["panel"]}, {"fable"})
        self.config({"review": {"medium": {"approvals": 9}, "low": {"approvals": 0}}})
        self.edit_json("cell.json", risk="Medium")
        self.assertEqual(self.r_ok("start", TICKET)["approvals_needed"], 3, "approvals never exceed the seats")
        self.edit_json("cell.json", risk="Low")
        self.assertEqual(self.r_ok("start", TICKET)["approvals_needed"], 1, "a non-positive override is ignored")

    def test_restart_clears_the_votes_of_the_round(self):
        self.r_ok("start", TICKET)
        self.vote("security")
        self.r_ok("start", TICKET)
        self.assertEqual(list((self.round / "votes").glob("*.json")), [])
        self.assertEqual(self.r_ok("status", TICKET)["waiting_for"], PANEL)


class SubmitTest(Base):
    def setUp(self):
        super().setUp()
        self.verified()
        self.r_ok("start", TICKET)

    def test_findings_file_must_be_json_with_a_real_summary(self):
        self.assertIn("is missing or is not valid JSON", self.bad(raw="not json {"))
        code, _, err = self.run_review("submit", TICKET, "--reviewer", "architecture", "--findings", str(Path(self.tmp.name) / "nowhere.json"))
        self.assertEqual(code, 1)
        self.assertIn("is missing or is not valid JSON", err)
        shape = "The findings file must be a JSON object"
        self.assertIn(shape, self.bad(raw=json.dumps({"findings": []})))
        self.assertIn(shape, self.bad(summary="Looks good to me."))
        self.assertIn(shape, self.bad(raw=json.dumps({"summary": SUMMARY})))
        self.assertIn(shape, self.bad(raw=json.dumps({"summary": SUMMARY, "findings": "none"})))
        self.assertIn(shape, self.bad(raw=json.dumps([])))

    def test_each_finding_is_checked(self):
        self.assertIn("Finding 1 must be an object", self.bad("a string"))
        self.assertIn("Finding 2: 'severity' must be 'blocker'", self.bad(self.note(), self.blocker(severity="critical")))
        self.assertIn("needs a 'title' and a 'detail'", self.bad(self.note(title=" ")))
        self.assertIn("needs a 'title' and a 'detail'", self.bad(self.note(detail="Fix it.")))
        self.assertIn("a blocker must name the 'rule' it breaks", self.bad(self.blocker(rule=None)))
        self.assertIn("a blocker must name the 'rule' it breaks", self.bad(self.blocker(rule="  ")))
        self.assertIn("a blocker must name the 'file'", self.bad(self.blocker(file=None, line=None)))

    def test_files_and_lines_must_exist(self):
        self.assertIn("file 'app/nothing.py' does not exist in the cell", self.bad(self.blocker(file="app/nothing.py")))
        self.assertIn("file 'app/nothing.py' does not exist in the cell", self.bad(self.note(file="app/nothing.py")), "a note's file is checked too")
        self.assertIn("line 99 is not a line of app/invite.py (it has 6)", self.bad(self.blocker(line=99)))
        self.assertIn("line 0 is not a line of app/invite.py", self.bad(self.blocker(line=0)))
        self.assertIn("is not a line of app/invite.py", self.bad(self.blocker(line="2")))
        self.assertIn("is not a line of app/invite.py", self.bad(self.blocker(line=True)))

    def test_evidence_and_cell_paths_resolve_against_the_cell_folder(self):
        self.assertFalse((self.work / "evidence").exists())
        self.assertIn("file 'evidence/missing.log' does not exist", self.bad(self.blocker(file="evidence/missing.log", line=None)))
        self.assertIn("line 2 is not a line of evidence/consumer-run.log (it has 1)", self.bad(self.blocker(file="evidence/consumer-run.log")))
        recorded = self.vote("product", self.blocker(file="evidence/consumer-run.log", line=1, rule="AC-01"), self.note(file="plan.md", line=3),
                             self.note(file="review/round-1/diff.patch"))
        self.assertEqual((recorded["vote"], recorded["blockers"], recorded["notes"]), ("REJECT", 1, 2))

    def test_a_finding_cannot_cite_a_file_outside_the_cell(self):
        outside = Path(self.tmp.name) / "outside.txt"
        outside.write_text("not part of the cell\n")
        self.assertIn("does not exist in the cell", self.bad(self.blocker(file=str(outside), line=1)))

    def test_seat_must_be_on_the_panel_and_votes_once(self):
        code, out, err = self.submit("general")
        self.assertEqual(code, 1, out)
        self.assertIn("'general' is not a seat on this panel. Seats: architecture, product, security.", err)
        self.assertEqual(self.vote("security")["vote"], "APPROVE")
        code, out, err = self.submit("security", self.blocker())
        self.assertEqual(code, 1, out)
        self.assertIn("The security reviewer has already voted in this round", err)
        self.assertEqual(json.loads((self.round / "votes/security.json").read_text())["vote"], "APPROVE", "the first vote stands")

    def test_the_vote_follows_from_the_findings(self):
        approve = self.vote("architecture", self.note(), self.note(title="Second   note\n here"))
        self.assertEqual(approve, {"status": "RECORDED", "reviewer": "architecture", "vote": "APPROVE", "blockers": 0, "notes": 2})
        reject = self.vote("security", self.note(), self.blocker())
        self.assertEqual((reject["vote"], reject["blockers"], reject["notes"]), ("REJECT", 1, 1))
        self.assertEqual(self.vote("product")["vote"], "APPROVE")
        stored = json.loads((self.round / "votes/security.json").read_text())
        self.assertEqual((stored["reviewer"], stored["vote"], stored["summary"]), ("security", "REJECT", SUMMARY))
        self.assertEqual(stored["head"], git(self.work, "rev-parse", "HEAD").stdout.strip())
        self.assertEqual(stored["findings"][1], {"severity": "blocker", "title": "Email is never validated", "detail": DETAIL,
                                                 "file": "app/invite.py", "line": 2, "rule": "FR-01"})
        self.assertEqual(stored["findings"][0]["file"], None)
        self.assertEqual(json.loads((self.round / "votes/architecture.json").read_text())["findings"][1]["title"], "Second note here")

    def test_a_vote_for_an_older_build_is_refused(self):
        self.commit_in_cell()
        code, out, err = self.submit("security")
        self.assertEqual(code, 1, out)
        self.assertIn("Review has not started for this build", err)


class TallyTest(Base):
    def begin(self, risk=None, **cell_changes):
        self.verified()
        if risk:
            cell_changes["risk"] = risk
        if cell_changes:
            self.edit_json("cell.json", **cell_changes)
        return self.r_ok("start", TICKET)

    def decision(self):
        return json.loads((self.cellroot / "review/decision.json").read_text())

    def test_every_seat_must_vote_first(self):
        self.begin()
        self.assertIn("No vote yet from: architecture, security, product", self.r_refused("tally", TICKET))
        self.vote("architecture")
        self.vote("product")
        self.assertIn("No vote yet from: security. Every seat must submit", self.r_refused("tally", TICKET))
        self.assertEqual(self.cell_json()["stage"], "verified")
        self.assertFalse((self.round / "decision.json").exists())

    def test_medium_majority_approves_and_names_the_overruled_seat(self):
        self.begin()
        self.vote("architecture", self.note())
        self.vote("security", self.blocker())
        self.vote("product")
        code, done = self.tally()
        self.assertEqual((code, done["outcome"], done["round"], done["risk"]), (0, "APPROVED", 1, "Medium"))
        self.assertEqual((done["approvals"], done["approvals_needed"], done["blockers"]), (2, 2, 1))
        self.assertEqual(done["votes"], {"architecture": "APPROVE", "security": "REJECT", "product": "APPROVE"})
        self.assertEqual(done["overruled_blockers_from"], ["security"])
        self.assertIn("feature/LOCAL-001 may be merged", done["next"])
        cell = self.cell_json()
        self.assertEqual((cell["stage"], cell["review"]), ("approved", "APPROVED"))
        findings = (self.round / "findings.md").read_text()
        self.assertEqual(done["findings"], str(self.round / "findings.md"))
        self.assertIn("# Review findings for LOCAL-001, round 1 of 3", findings)
        self.assertIn("Outcome: APPROVED. architecture: APPROVE, security: REJECT, product: APPROVE.", findings)
        self.assertIn("## Blockers: each must be fixed", findings)
        self.assertIn(f"1. **Email is never validated** (security; `app/invite.py:2`). Breaks: FR-01. {DETAIL}", findings)
        self.assertIn("1. **README could say more** (architecture; no file).", findings)
        decision = self.decision()
        self.assertEqual(decision, json.loads((self.round / "decision.json").read_text()))
        self.assertEqual((decision["outcome"], decision["human_approval_required"], decision["human_approval"]), ("APPROVED", False, None))

    def test_medium_rejection_returns_the_cell_to_the_build_station(self):
        self.begin()
        self.cast(rejecting=("architecture", "security"))
        code, done = self.tally()
        self.assertEqual((code, done["outcome"], done["approvals"], done["blockers"]), (1, "REJECTED", 1, 2))
        self.assertEqual(done["overruled_blockers_from"], [])
        self.assertIn(f"build revise LOCAL-001 --findings {self.round / 'findings.md'}", done["next"])
        cell = self.cell_json()
        self.assertEqual((cell["stage"], cell["review"]), ("built", "REJECTED"))
        self.assertEqual(self.decision()["outcome"], "REJECTED")
        revising = self.ok("revise", TICKET, "--findings", done["findings"])
        self.assertEqual((revising["status"], revising["loop"]), ("REVISING", 1))
        self.assertIn("Email is never validated", (self.cellroot / "review-findings-1.md").read_text())
        self.assertIn("Only a verified cell can be reviewed", self.r_refused("start", TICKET))

    def test_high_risk_waits_for_a_person_after_three_approvals(self):
        self.begin("High")
        self.cast()
        code, done = self.tally()
        self.assertEqual((code, done["outcome"], done["approvals"], done["approvals_needed"]), (0, "AWAITING_HUMAN", 3, 3))
        self.assertIn("a person must approve before merge", done["next"])
        cell = self.cell_json()
        self.assertEqual((cell["stage"], cell["review"]), ("awaiting-human", "AWAITING_HUMAN"))
        self.assertTrue(self.decision()["human_approval_required"])

    def test_high_risk_needs_every_seat(self):
        self.begin("High")
        self.cast(rejecting=("product",))
        code, done = self.tally()
        self.assertEqual((code, done["outcome"], done["approvals"], done["approvals_needed"]), (1, "REJECTED", 2, 3))
        self.assertEqual(self.cell_json()["stage"], "built")

    def test_low_risk_single_reviewer(self):
        self.begin("Low")
        self.assertIn("'security' is not a seat on this panel. Seats: general.", self.submit("security")[2])
        self.cast(roles=["general"])
        code, done = self.tally()
        self.assertEqual((code, done["outcome"], done["votes"], done["approvals_needed"]), (0, "APPROVED", {"general": "APPROVE"}, 1))
        self.assertEqual(self.cell_json()["stage"], "approved")

    def test_third_failed_round_escalates(self):
        self.verified()
        self.edit_json("build-report.json", review_loop=2)
        self.put(self.cellroot, {"review/round-2/findings.md": "# earlier findings\n"})
        started = self.r_ok("start", TICKET)
        folder = self.cellroot / "review/round-3"
        self.assertEqual((started["round"], started["max_rounds"], started["packet"]), (3, 3, str(folder / "packet.json")))
        self.assertEqual(json.loads((folder / "packet.json").read_text())["paths"]["earlier_findings"], [str(self.cellroot / "review/round-2/findings.md")])
        self.cast(rejecting=("architecture", "product"))
        code, done = self.tally()
        self.assertEqual((code, done["outcome"], done["round"]), (1, "ESCALATE", 3))
        self.assertIn("blocked-requires-sme", done["next"])
        self.assertIn("Do not send it back to the build station", done["next"])
        cell = self.cell_json()
        self.assertEqual((cell["stage"], cell["review"]), ("blocked", "ESCALATE"))
        self.assertIn("round 3 of 3", (folder / "findings.md").read_text())
        self.assertEqual(self.decision()["outcome"], "ESCALATE")

    def test_a_third_round_can_still_be_approved_and_max_loops_is_configurable(self):
        self.verified()
        self.edit_json("build-report.json", review_loop=1)
        self.config({"review": {"max_loops": 2}})
        self.assertEqual(self.r_ok("start", TICKET)["max_rounds"], 2)
        self.round = self.cellroot / "review/round-2"
        self.cast(rejecting=("security",))
        self.assertEqual(self.tally()[1]["outcome"], "APPROVED", "the last round escalates only when it fails")
        self.assertEqual(self.cell_json()["stage"], "approved")


class HumanApprovalTest(Base):
    def awaiting(self):
        self.verified()
        self.edit_json("cell.json", risk="High")
        self.r_ok("start", TICKET)
        self.cast()
        self.assertEqual(self.tally()[1]["outcome"], "AWAITING_HUMAN")

    def test_refused_unless_the_panel_approved_and_a_person_is_needed(self):
        self.verified()
        waiting = "not waiting for a person's approval"
        self.assertIn(waiting, self.r_refused("approve-human", TICKET, "--by", "Dana Smith"))
        self.r_ok("start", TICKET)
        self.assertIn(waiting, self.r_refused("approve-human", TICKET, "--by", "Dana Smith"))
        self.cast()
        self.assertEqual(self.tally()[1]["outcome"], "APPROVED")
        self.assertIn(waiting, self.r_refused("approve-human", TICKET, "--by", "Dana Smith"))
        self.assertIsNone(json.loads((self.cellroot / "review/decision.json").read_text())["human_approval"])

    def test_sign_off_is_recorded_and_approves_the_cell(self):
        self.awaiting()
        self.assertIn("--by must name the person", self.r_refused("approve-human", TICKET, "--by", " D "))
        self.assertEqual(self.cell_json()["stage"], "awaiting-human")
        done = self.r_ok("approve-human", TICKET, "--by", "  Dana   Smith ", "--note", " Checked the billing path. ")
        self.assertEqual((done["outcome"], done["approved_by"]), ("APPROVED", "Dana Smith"))
        self.assertIn("feature/LOCAL-001 may be merged", done["next"])
        decision = json.loads((self.cellroot / "review/decision.json").read_text())
        self.assertEqual(decision, json.loads((self.round / "decision.json").read_text()))
        self.assertEqual((decision["outcome"], decision["human_approval"]["by"], decision["human_approval"]["note"]), ("APPROVED", "Dana Smith", "Checked the billing path."))
        self.assertTrue(decision["human_approval"]["recorded_at"])
        cell = self.cell_json()
        self.assertEqual((cell["stage"], cell["review"]), ("approved", "APPROVED"))
        self.assertIn("not waiting for a person's approval", self.r_refused("approve-human", TICKET, "--by", "Dana Smith"))

    def test_refused_when_the_code_changed_after_the_vote(self):
        self.awaiting()
        self.commit_in_cell()
        self.assertIn("code changed after the panel voted", self.r_refused("approve-human", TICKET, "--by", "Dana Smith"))
        self.assertEqual(self.cell_json()["stage"], "awaiting-human")


class StatusTest(Base):
    def test_status_follows_the_round(self):
        self.verified()
        self.assertEqual(self.r_ok("status", TICKET), {"ticket_id": TICKET, "stage": "verified", "review": None, "round": 1,
                                                       "panel": [], "voted": {}, "waiting_for": []})
        self.r_ok("start", TICKET)
        self.vote("security", self.blocker())
        status = self.r_ok("status", TICKET)
        self.assertEqual((status["panel"], status["voted"], status["waiting_for"]), (PANEL, {"security": "REJECT"}, ["architecture", "product"]))
        self.vote("architecture")
        self.vote("product")
        self.tally()
        status = self.r_ok("status", TICKET)
        self.assertEqual((status["stage"], status["review"], status["waiting_for"]), ("approved", "APPROVED", []))
        self.assertEqual(status["voted"], {"architecture": "APPROVE", "security": "REJECT", "product": "APPROVE"})
        self.assertIn("'bad id!' is not a usable ticket ID", self.r_refused("status", "bad id!"))


if __name__ == "__main__":
    unittest.main()
